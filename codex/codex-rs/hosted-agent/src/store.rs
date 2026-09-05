//! Private, versioned lifecycle journal. Never contains credentials or connection URLs.
use std::fs::File;
use std::fs::OpenOptions;
use std::fs::{self};
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use codex_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;

use crate::AgentProvisionRequest;
use crate::HostedAgentError;
use crate::HostedAgentErrorCategory;
use crate::HostedAgentRuntimeRecord;
use crate::types::Result;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CompletionMode {
    Publish,
    #[default]
    Finalize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Journal {
    pub version: u32,
    pub request: AgentProvisionRequest,
    pub record: Option<HostedAgentRuntimeRecord>,
    pub sequence: u64,
    pub pending: Option<String>,
    pub finalization: Option<String>,
    #[serde(default)]
    pub completion_mode: CompletionMode,
    #[serde(default)]
    pub handoff_snapshot_id: Option<String>,
    pub deleting: bool,
    pub deleted: bool,
}

pub(crate) struct Store {
    root: PathBuf,
}

pub(crate) fn failure(message: &str) -> HostedAgentError {
    HostedAgentError::new(HostedAgentErrorCategory::Unavailable, message)
}

/// Refuse legacy hosted SQLite state before upstream opens its colliding migrations.
/// This is a read-only compatibility gate, not a migration or a reset.
pub fn reject_legacy_state(home: &Path) -> Result<()> {
    // Legacy SQLx versions 41/42 collide with upstream. Do not let a fresh private
    // store disguise an unmigrated old installation. Read only: never open SQLite
    // through SQLx, modify its migration table, or discard its thread records.
    if home.exists() {
        for entry in fs::read_dir(home).map_err(|_| failure("cannot inspect hosted state"))? {
            let path = entry
                .map_err(|_| failure("cannot inspect hosted state"))?
                .path();
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.starts_with("state")
                && (name.ends_with(".sqlite") || name.ends_with(".sqlite-wal"))
            {
                let mut file =
                    File::open(path).map_err(|_| failure("cannot inspect legacy hosted state"))?;
                let mut tail = Vec::new();
                let mut chunk = [0u8; 65536];
                loop {
                    let n = file
                        .read(&mut chunk)
                        .map_err(|_| failure("cannot inspect legacy hosted state"))?;
                    if n == 0 {
                        break;
                    }
                    tail.extend_from_slice(&chunk[..n]);
                    if [
                        b"hosted_runtime_json".as_slice(),
                        b"thread_deletion_outbox".as_slice(),
                    ]
                    .iter()
                    .any(|needle| tail.windows(needle.len()).any(|s| s == *needle))
                    {
                        return Err(failure(
                            "legacy hosted SQLite state requires explicit migration before use; existing state was not modified",
                        ));
                    }
                    tail = tail[tail.len().saturating_sub(128)..].to_vec();
                }
            }
        }
    }
    Ok(())
}

impl Store {
    pub fn open(home: &Path, scope: &str) -> Result<Self> {
        reject_legacy_state(home)?;
        let root = home.join("hosted-runtime-v1");
        if let Ok(meta) = fs::symlink_metadata(&root)
            && (!meta.is_dir() || meta.file_type().is_symlink())
        {
            return Err(failure("unsafe hosted state directory"));
        }
        fs::create_dir_all(&root).map_err(|_| failure("cannot create hosted state directory"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| failure("cannot protect hosted state"))?;
        }
        let scope_path = root.join("service-scope");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&scope_path) {
            Ok(mut file) => {
                file.write_all(scope.as_bytes())
                    .and_then(|()| file.sync_all())
                    .map_err(|_| failure("cannot persist hosted service identity"))?;
                File::open(&root)
                    .and_then(|file| file.sync_all())
                    .map_err(|_| failure("cannot commit hosted service identity"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let meta = fs::symlink_metadata(&scope_path)
                    .map_err(|_| failure("cannot inspect hosted service identity"))?;
                if !meta.is_file()
                    || meta.file_type().is_symlink()
                    || meta.len() > 4096
                    || fs::read_to_string(&scope_path)
                        .map_err(|_| failure("cannot read hosted service identity"))?
                        != scope
                {
                    return Err(failure(
                        "hosted state belongs to another service or tenant; explicit migration is required",
                    ));
                }
            }
            Err(_) => return Err(failure("cannot establish hosted service identity")),
        }
        Ok(Self { root })
    }

    pub fn lock(&self, id: ThreadId) -> Result<File> {
        self.lock_file(&format!("{id}.lock"))
    }

    pub fn session_lock(&self, id: ThreadId) -> Result<File> {
        self.lock_file(&format!("{id}.session.lock"))
    }

    fn lock_file(&self, name: &str) -> Result<File> {
        let path = self.root.join(name);
        if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err(failure("unsafe hosted lock file"));
        }
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .map_err(|_| failure("cannot open hosted lock"))?;
        file.try_lock()
            .map_err(|_| failure("hosted thread is in use by another process"))?;
        Ok(file)
    }

    pub fn read(&self, id: ThreadId) -> Result<Option<Journal>> {
        let path = self.root.join(format!("{id}.json"));
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(failure("cannot inspect hosted journal")),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 * 1024
        {
            return Err(failure("unsafe hosted journal"));
        }
        let bytes = fs::read(path).map_err(|_| failure("cannot read hosted journal"))?;
        let journal: Journal =
            serde_json::from_slice(&bytes).map_err(|_| failure("invalid hosted journal"))?;
        if journal.version != 1 || journal.request.agent_id != id {
            return Err(failure("unsupported hosted journal identity or version"));
        }
        Ok(Some(journal))
    }

    pub fn write(&self, journal: &Journal) -> Result<()> {
        let bytes =
            serde_json::to_vec(journal).map_err(|_| failure("cannot encode hosted journal"))?;
        if bytes.len() > 1024 * 1024 {
            return Err(failure("hosted journal exceeds size limit"));
        }
        let temporary = self.root.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| failure("cannot create hosted journal"))?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(
                &temporary,
                self.root.join(format!("{}.json", journal.request.agent_id)),
            )?;
            File::open(&self.root)?.sync_all()
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|_: std::io::Error| failure("cannot commit hosted journal"))
    }

    pub fn ids(&self) -> Result<Vec<ThreadId>> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|_| failure("cannot list hosted journals"))? {
            let path = entry
                .map_err(|_| failure("cannot list hosted journals"))?
                .path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                let name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| failure("invalid hosted journal name"))?;
                ids.push(
                    ThreadId::from_string(name)
                        .map_err(|_| failure("invalid hosted journal name"))?,
                );
            }
        }
        Ok(ids)
    }
}
