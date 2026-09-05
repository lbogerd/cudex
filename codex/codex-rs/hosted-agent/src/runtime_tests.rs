use std::fs;

use codex_protocol::ThreadId;
use codex_utils_path_uri::PathUri;
use pretty_assertions::assert_eq;

use crate::*;

fn request() -> PrepareRequest {
    PrepareRequest {
        agent_id: ThreadId::new(),
        owner_agent_id: None,
        agent_type: "root".into(),
        sandbox_template: "template".into(),
        source: ProjectSnapshotSource::RootWorkspace {
            cwd: PathUri::parse("file:///workspace").expect("cwd"),
            workspace_roots: vec![PathUri::parse("file:///workspace").expect("root")],
        },
    }
}

#[tokio::test]
async fn concurrent_prepare_is_one_lease_and_restart_reconnects_without_secrets() {
    let home = tempfile::tempdir().expect("home");
    let service = FakeHostedAgentService::default();
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("manager");
    let request = request();
    let (a, b) = tokio::join!(
        manager.prepare(request.clone()),
        manager.prepare(request.clone())
    );
    let a = a.expect("first");
    let b = b.expect("second");
    assert_eq!(a.provisioned, b.provisioned);
    assert_eq!(service.active_lease_count(), 1);
    let before = manager.record(request.agent_id).expect("record");
    let lease_id = a.provisioned.lease_id.clone();
    drop(a);
    drop(b);
    drop(manager);
    let bytes = fs::read_to_string(
        home.path()
            .join("hosted-runtime-v1")
            .join(format!("{}.json", request.agent_id)),
    )
    .expect("journal");
    for secret in ["execServerUrl", "wss://", "toolPolicy", "Bearer "] {
        assert!(!bytes.contains(secret));
    }
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("reopened");
    let resumed = manager.prepare(request.clone()).await.expect("resume");
    assert_eq!(resumed.provisioned.lease_id, lease_id);
    let after = manager.record(request.agent_id).expect("record");
    assert_eq!(
        before.as_ref().map(|r| &r.base_snapshot_id),
        after.as_ref().map(|r| &r.base_snapshot_id)
    );
    assert_eq!(service.active_lease_count(), 1);
}

#[tokio::test]
async fn finalized_child_patch_applies_and_released_root_restores_original_lineage() {
    let home = tempfile::tempdir().expect("home");
    let service = FakeHostedAgentService::default();
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("manager");
    let root_request = request();
    let root_id = root_request.agent_id;
    let root = manager.prepare(root_request.clone()).await.expect("root");
    let child_request = PrepareRequest {
        owner_agent_id: Some(root_id),
        source: manager.source_for_child(root_id).expect("source"),
        ..request()
    };
    let child_id = child_request.agent_id;
    let child = manager.prepare(child_request).await.expect("child");
    assert_ne!(
        child.provisioned.environment_id,
        root.provisioned.environment_id
    );
    let path = PathUri::parse("file:///workspace/result.txt").expect("path");
    service
        .write_lease_file(
            &child.provisioned.lease_id,
            path.clone(),
            b"child result".to_vec(),
        )
        .expect("write");
    let artifact = manager.finalize(child_id).await.expect("finalize");
    assert_eq!(manager.finalize(child_id).await.expect("replay"), artifact);
    assert!(matches!(
        manager
            .apply_patch(root_id, &artifact.artifact_id)
            .await
            .expect("apply"),
        PatchApplyResult::Applied { .. }
    ));
    assert_eq!(
        service
            .read_lease_file(&root.provisioned.lease_id, &path)
            .expect("read"),
        Some(b"child result".to_vec())
    );
    let root_artifact = manager.finalize(root_id).await.expect("root finalize");
    let old_lease = root.provisioned.lease_id.clone();
    drop(root);
    manager.release(root_id).await.expect("release");
    drop(manager);
    let manager = HostedRuntimeManager::with_service(service.clone(), home.path()).expect("reopen");
    let restored = manager.prepare(root_request).await.expect("restore");
    assert_ne!(restored.provisioned.lease_id, old_lease);
    assert_eq!(
        service
            .read_lease_file(&restored.provisioned.lease_id, &path)
            .expect("restored"),
        Some(b"child result".to_vec())
    );
    let record = manager.record(root_id).expect("read").expect("record");
    assert_eq!(record.base_snapshot_id, root_artifact.base_snapshot_id);
}

#[tokio::test]
async fn failed_finalization_replays_after_restart_and_delete_outage_is_durable() {
    let home = tempfile::tempdir().expect("home");
    let service = FakeHostedAgentService::default();
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("manager");
    let request = request();
    let id = request.agent_id;
    manager.prepare(request.clone()).await.expect("root");
    service.set_export_failure(Some(HostedAgentError::new(
        HostedAgentErrorCategory::Unavailable,
        "outage",
    )));
    assert!(manager.finalize(id).await.is_err());
    let before = manager.record(id).expect("read").expect("record");
    drop(manager);
    service.set_export_failure(None);
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("manager");
    manager.finalize(id).await.expect("retry export");
    let after = manager.record(id).expect("read").expect("record");
    assert_eq!(before.latest_snapshot_id, after.latest_snapshot_id);
    service.set_release_failure(Some(HostedAgentError::new(
        HostedAgentErrorCategory::Unavailable,
        "outage",
    )));
    assert!(manager.delete(id).await.is_err());
    assert!(manager.prepare(request.clone()).await.is_err());
    drop(manager);
    service.set_release_failure(None);
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("manager");
    manager.retry_deletions().await.expect("drain outbox");
    manager.delete(id).await.expect("idempotent delete");
    assert_eq!(service.active_lease_count(), 0);
    assert!(manager.prepare(request).await.is_err());
}

#[tokio::test]
async fn changed_owner_or_role_cannot_resume_or_borrow_a_lease() {
    let home = tempfile::tempdir().expect("home");
    let service = FakeHostedAgentService::default();
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("manager");
    let request = request();
    manager.prepare(request.clone()).await.expect("root");
    let mut changed = request.clone();
    changed.owner_agent_id = Some(ThreadId::new());
    assert!(manager.prepare(changed).await.is_err());
    let mut changed = request.clone();
    changed.agent_type = "administrator".into();
    assert!(manager.prepare(changed).await.is_err());
    let mut child = request.clone();
    child.agent_id = ThreadId::new();
    child.source = manager.source_for_child(request.agent_id).expect("source");
    assert!(manager.prepare(child).await.is_err());
    assert_eq!(service.active_lease_count(), 1);
}

#[test]
fn legacy_gate_does_not_modify_existing_state_and_scans_wal() {
    let home = tempfile::tempdir().expect("home");
    let path = home.path().join("state_5.sqlite-wal");
    let bytes = b"SQLite migration thread_deletion_outbox old state";
    fs::write(&path, bytes).expect("fixture");
    assert!(reject_legacy_state(home.path()).is_err());
    assert_eq!(fs::read(path).expect("preserved"), bytes);
}

#[test]
fn private_store_rejects_different_service_or_tenant() {
    let home = tempfile::tempdir().expect("home");
    let first =
        HttpHostedAgentService::new("https://service.invalid/", "first-token").expect("service");
    HostedRuntimeManager::with_service(first, home.path()).expect("initial");
    let second =
        HttpHostedAgentService::new("https://service.invalid/", "second-token").expect("service");
    assert!(HostedRuntimeManager::with_service(second, home.path()).is_err());
}

#[tokio::test]
async fn another_manager_cannot_reconnect_or_delete_a_live_session() {
    let home = tempfile::tempdir().expect("home");
    let service = FakeHostedAgentService::default();
    let first = HostedRuntimeManager::with_service(service.clone(), home.path()).expect("first");
    let request = request();
    let binding = first.prepare(request.clone()).await.expect("prepare");
    let second = HostedRuntimeManager::with_service(service.clone(), home.path()).expect("second");
    assert!(second.prepare(request.clone()).await.is_err());
    assert!(second.delete(request.agent_id).await.is_err());
    drop(binding);
    drop(first);
    second
        .prepare(request)
        .await
        .expect("previous session ended");
    assert_eq!(service.active_lease_count(), 1);
}

#[tokio::test]
async fn publication_preserves_live_child_for_followups_and_exports_original_base() {
    let home = tempfile::tempdir().expect("home");
    let service = FakeHostedAgentService::default();
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("manager");
    let request = request();
    let id = request.agent_id;
    let binding = manager.prepare(request.clone()).await.expect("prepare");
    let path = PathUri::parse("file:///workspace/result.txt").expect("path");
    service
        .write_lease_file(
            &binding.provisioned.lease_id,
            path.clone(),
            b"first".to_vec(),
        )
        .expect("write");
    let first = manager.publish_patch(id).await.expect("first publish");
    assert_eq!(
        manager
            .record(id)
            .expect("read")
            .expect("record")
            .lifecycle_state,
        HostedAgentLifecycleState::Active
    );
    assert!(std::sync::Arc::ptr_eq(
        &binding,
        &manager.prepare(request).await.expect("same live session")
    ));
    service
        .write_lease_file(&binding.provisioned.lease_id, path, b"second".to_vec())
        .expect("followup");
    let second = manager.publish_patch(id).await.expect("second publish");
    assert_ne!(first.artifact_id, second.artifact_id);
    assert_eq!(first.base_snapshot_id, second.base_snapshot_id);
    manager.finalize(id).await.expect("terminal finalize");
    assert!(manager.binding(id).is_none());
}

#[tokio::test]
async fn retired_binding_held_by_old_session_does_not_block_durable_deletion() {
    let home = tempfile::tempdir().expect("home");
    let service = FakeHostedAgentService::default();
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("manager");
    let request = request();
    let id = request.agent_id;
    let old_session_binding = manager.prepare(request).await.expect("prepare");
    manager.finalize(id).await.expect("finalize");
    manager.release(id).await.expect("release");
    manager
        .delete(id)
        .await
        .expect("delete while old session retains Arc");
    assert_eq!(old_session_binding.agent_id, id);
    assert_eq!(service.active_lease_count(), 0);
}

#[tokio::test]
async fn root_handoff_marker_requires_successful_capture_and_is_revoked_before_resume() {
    let home = tempfile::tempdir().expect("home");
    let service = FakeHostedAgentService::default();
    let manager =
        HostedRuntimeManager::with_service(service.clone(), home.path()).expect("manager");
    let request = request();
    let id = request.agent_id;
    manager.prepare(request.clone()).await.expect("prepare");
    let checkpoint = manager.checkpoint_for_handoff(id).await.expect("handoff");
    let path = home
        .path()
        .join("hosted-runtime-v1")
        .join(format!("{id}.json"));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("read")).expect("json");
    assert_eq!(journal["handoffSnapshotId"], checkpoint.snapshot_id);
    manager.prepare(request).await.expect("resume");
    service.set_checkpoint_failure(Some(HostedAgentError::new(
        HostedAgentErrorCategory::Unavailable,
        "outage",
    )));
    assert!(manager.checkpoint_for_handoff(id).await.is_err());
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(path).expect("read")).expect("json");
    assert_eq!(journal["handoffSnapshotId"], serde_json::Value::Null);
}
