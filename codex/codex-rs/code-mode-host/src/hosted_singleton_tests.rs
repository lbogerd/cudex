use super::acquire_at;

#[test]
fn collision_does_not_replace_identity_and_drop_releases_lock() -> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    let owner = acquire_at("first", directory.path())?;
    let identity = std::fs::read(directory.path().join("code-mode.identity"))?;
    assert!(acquire_at("second", directory.path()).is_err());
    pretty_assertions::assert_eq!(
        std::fs::read(directory.path().join("code-mode.identity"))?,
        identity
    );
    drop(owner);
    let _replacement = acquire_at("second", directory.path())?;
    Ok(())
}

#[test]
fn refuses_symlink_lock() -> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    std::os::unix::fs::symlink("target", directory.path().join("code-mode.lock"))?;
    assert!(acquire_at("first", directory.path()).is_err());
    Ok(())
}
