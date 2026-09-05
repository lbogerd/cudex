#![allow(clippy::unwrap_used)]

use super::*;
use pretty_assertions::assert_eq;

fn identity() -> HostedCodeModeRuntimeIdentity {
    HostedCodeModeRuntimeIdentity {
        lease_id: "lease-1".into(),
        environment_id: "environment-1".into(),
        connection_generation: 7,
    }
}

#[test]
fn process_identity_matches_control_plane_hash_and_changes_with_generation() {
    let current = identity();
    assert_eq!(
        current.process_id(),
        ProcessId::new("hosted-code-mode-a092c8a427aba2d5e7d0978bc68d004f")
    );
    let replacement = HostedCodeModeRuntimeIdentity {
        connection_generation: 8,
        ..current.clone()
    };
    assert_ne!(current.process_id(), replacement.process_id());
}

#[tokio::test]
async fn local_environment_is_rejected_without_spawning_a_host() {
    let provider = HostedEnvironmentCodeModeSessionProvider::new(
        identity(),
        Arc::new(Environment::default_for_tests()),
        AbsolutePathBuf::from_absolute_path(std::env::current_exe().unwrap()).unwrap(),
        AbsolutePathBuf::from_absolute_path(std::env::current_dir().unwrap()).unwrap(),
    );
    assert_eq!(
        provider.ready().await,
        Err("hosted code mode requires a remote environment".into())
    );
}

#[tokio::test]
async fn shutdown_before_start_is_terminal_and_idempotent() {
    let provider = HostedEnvironmentCodeModeSessionProvider::new(
        identity(),
        Arc::new(Environment::default_for_tests()),
        AbsolutePathBuf::from_absolute_path(std::env::current_exe().unwrap()).unwrap(),
        AbsolutePathBuf::from_absolute_path(std::env::current_dir().unwrap()).unwrap(),
    );
    provider.shutdown().await.unwrap();
    provider.shutdown().await.unwrap();
    assert_eq!(
        provider.ready().await,
        Err("hosted code-mode runtime was shut down".into())
    );
    assert!(provider.availability().is_err());
}
