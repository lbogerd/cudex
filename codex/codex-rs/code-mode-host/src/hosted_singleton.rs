//! A kernel-owned lock prevents an uncertain old host and a new host from
//! concurrently owning the same sandbox. The lock file must never be unlinked.

use std::fs::File;

pub(super) fn acquire(identity: &str) -> anyhow::Result<File> {
    #[cfg(unix)]
    {
        acquire_at(identity, std::path::Path::new("/run/cudex"))
    }
    #[cfg(not(unix))]
    {
        let _ = identity;
        anyhow::bail!("hosted code mode requires a Unix sandbox")
    }
}

#[cfg(unix)]
fn acquire_at(identity: &str, directory: &std::path::Path) -> anyhow::Result<File> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if identity.is_empty() || identity.len() > 4096 || identity.chars().any(char::is_control) {
        anyhow::bail!("invalid hosted runtime identity");
    }
    let open = || {
        let mut options = std::fs::OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        options
    };
    let lock = open().open(directory.join("code-mode.lock"))?;
    lock.try_lock()
        .map_err(|_| anyhow::anyhow!("another hosted code-mode runtime owns this sandbox"))?;
    let mut identity_file = open()
        .truncate(true)
        .open(directory.join("code-mode.identity"))?;
    writeln!(
        identity_file,
        "pid={}\nidentity={identity}",
        std::process::id()
    )?;
    identity_file.sync_all()?;
    Ok(lock)
}

#[cfg(all(test, unix))]
#[path = "hosted_singleton_tests.rs"]
mod tests;
