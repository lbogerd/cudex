use std::fs::File;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::path::PathBuf;

const HOSTED_LOCK_PATH: &str = "/run/cudex/code-mode.lock";
const HOSTED_IDENTITY_PATH: &str = "/run/cudex/code-mode.identity";

struct HostedSingleton {
    _lock: File,
    identity_path: PathBuf,
}

impl HostedSingleton {
    fn acquire(identity: &str) -> anyhow::Result<Self> {
        Self::acquire_at(
            identity,
            Path::new(HOSTED_LOCK_PATH),
            Path::new(HOSTED_IDENTITY_PATH),
        )
    }

    fn acquire_at(identity: &str, lock_path: &Path, identity_path: &Path) -> anyhow::Result<Self> {
        if identity.is_empty() || identity.len() > 4096 || identity.contains('\n') {
            anyhow::bail!("hosted runtime identity is invalid");
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(lock_path)?;
        // SAFETY: flock only observes the valid descriptor owned by `lock`.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            anyhow::bail!("another hosted code-mode runtime owns this sandbox");
        }
        let mut identity_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(identity_path)?;
        writeln!(identity_file, "pid={}", std::process::id())?;
        writeln!(identity_file, "identity={identity}")?;
        identity_file.sync_all()?;
        Ok(Self {
            _lock: lock,
            identity_path: identity_path.to_path_buf(),
        })
    }
}

impl Drop for HostedSingleton {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.identity_path);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;

    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::HostedSingleton;

    struct SingletonPaths {
        _directory: TempDir,
        lock: std::path::PathBuf,
        identity: std::path::PathBuf,
    }

    impl SingletonPaths {
        fn new() -> Self {
            let directory = tempfile::tempdir().expect("create singleton test directory");
            Self {
                lock: directory.path().join("code-mode.lock"),
                identity: directory.path().join("code-mode.identity"),
                _directory: directory,
            }
        }

        fn acquire(&self, identity: &str) -> anyhow::Result<HostedSingleton> {
            HostedSingleton::acquire_at(identity, &self.lock, &self.identity)
        }
    }

    #[test]
    fn singleton_writes_identity_and_removes_it_on_clean_exit() {
        let paths = SingletonPaths::new();
        let singleton = paths.acquire("runtime-1").expect("acquire singleton");

        assert_eq!(
            fs::read_to_string(&paths.identity).expect("read identity file"),
            format!("pid={}\nidentity=runtime-1\n", std::process::id())
        );

        drop(singleton);
        assert!(!paths.identity.exists());
    }

    #[test]
    fn singleton_collision_refuses_without_disturbing_the_owner() {
        let paths = SingletonPaths::new();
        let owner = paths.acquire("runtime-owner").expect("acquire owner");

        let error = paths
            .acquire("runtime-collider")
            .err()
            .expect("second runtime must be refused");
        assert_eq!(
            error.to_string(),
            "another hosted code-mode runtime owns this sandbox"
        );
        assert_eq!(
            fs::read_to_string(&paths.identity).expect("owner identity remains"),
            format!("pid={}\nidentity=runtime-owner\n", std::process::id())
        );

        drop(owner);
    }

    #[test]
    fn singleton_lock_is_released_when_the_owner_is_dropped() {
        let paths = SingletonPaths::new();
        let owner = paths.acquire("runtime-1").expect("acquire first owner");
        drop(owner);

        let replacement = paths
            .acquire("runtime-2")
            .expect("kernel releases the lock with its file descriptor");
        assert_eq!(
            fs::read_to_string(&paths.identity).expect("replacement identity"),
            format!("pid={}\nidentity=runtime-2\n", std::process::id())
        );
        drop(replacement);
    }

    #[test]
    fn invalid_identity_is_rejected_before_creating_runtime_files() {
        for invalid in ["", "line\nbreak"] {
            let paths = SingletonPaths::new();
            let error = paths
                .acquire(invalid)
                .err()
                .expect("invalid identity must fail");
            assert_eq!(error.to_string(), "hosted runtime identity is invalid");
            assert!(!paths.lock.exists());
            assert!(!paths.identity.exists());
        }

        let paths = SingletonPaths::new();
        let oversized = "x".repeat(4097);
        let error = paths
            .acquire(&oversized)
            .err()
            .expect("oversized identity must fail");
        assert_eq!(error.to_string(), "hosted runtime identity is invalid");
        assert!(!paths.lock.exists());
        assert!(!paths.identity.exists());
    }

    #[test]
    fn singleton_refuses_symlinked_runtime_files() {
        let paths = SingletonPaths::new();
        let target = paths
            .identity
            .parent()
            .expect("identity parent")
            .join("target");
        fs::write(&target, "do-not-overwrite").expect("write target");
        symlink(&target, &paths.identity).expect("create identity symlink");

        let _error = paths
            .acquire("runtime-1")
            .err()
            .expect("symlinked identity must fail");
        assert_eq!(
            fs::read_to_string(target).expect("read target"),
            "do-not-overwrite"
        );
    }
}

fn usage() {
    println!("Usage: codex-code-mode-host [--hosted-singleton --identity ID]");
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let mut hosted_singleton = false;
    let mut identity = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                usage();
                return Ok(());
            }
            "--hosted-singleton" => hosted_singleton = true,
            "--identity" => identity = args.next(),
            _ => anyhow::bail!("unknown argument: {arg}"),
        }
    }
    let _singleton = if hosted_singleton {
        Some(HostedSingleton::acquire(identity.as_deref().ok_or_else(
            || anyhow::anyhow!("--identity is required in hosted singleton mode"),
        )?)?)
    } else {
        if identity.is_some() {
            anyhow::bail!("--identity requires --hosted-singleton");
        }
        None
    };
    codex_code_mode_host::run_stdio().await
}
