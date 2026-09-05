use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use pretty_assertions::assert_eq;

#[tokio::test]
async fn confirmation_stops_background_group_after_leader_exit() -> anyhow::Result<()> {
    let mut child = crate::spawn_pipe_process(
        "/bin/sh",
        &[
            "-c".to_string(),
            "sleep 60 </dev/null >/dev/null 2>&1 & echo $!".to_string(),
        ],
        Path::new("."),
        &HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]),
        &None,
        &[],
    )
    .await?;
    let output = tokio::time::timeout(Duration::from_secs(5), child.stdout_rx.recv())
        .await?
        .ok_or_else(|| anyhow::anyhow!("missing background pid"))?;
    let background: u32 = std::str::from_utf8(&output)?.trim().parse()?;
    tokio::time::timeout(Duration::from_secs(5), &mut child.exit_rx).await??;
    assert_eq!(unsafe { libc::kill(background as libc::pid_t, 0) }, 0);
    assert!(child.session.terminate_confirmed().await?);
    // Confirmation is idempotent even when the child's wait handle has completed.
    assert!(child.session.terminate_confirmed().await?);
    Ok(())
}

#[test]
fn invalid_group_identity_cannot_confirm_quiescence() {
    assert_eq!(
        crate::process_group::process_group_is_quiescent(0)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::InvalidInput
    );
}
