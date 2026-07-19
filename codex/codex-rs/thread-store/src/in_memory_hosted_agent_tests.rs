use codex_hosted_agent::HostedAgentLifecycleState;
use codex_hosted_agent::HostedAgentRuntimeRecord;
use codex_protocol::ThreadId;
use codex_protocol::protocol::ThreadMemoryMode;
use pretty_assertions::assert_eq;

use super::InMemoryThreadStore;
use crate::ResumeThreadParams;
use crate::ThreadPersistenceMetadata;
use crate::ThreadStore;
use crate::ThreadStoreError;

fn runtime_record() -> HostedAgentRuntimeRecord {
    HostedAgentRuntimeRecord {
        owner_agent_id: Some(ThreadId::new()),
        agent_type: "reviewer".to_string(),
        sandbox_template: "review-v2".to_string(),
        lease_id: "lease-1".to_string(),
        environment_id: "environment-1".to_string(),
        connection_generation: 0,
        base_snapshot_id: "snapshot-base".to_string(),
        latest_snapshot_id: Some("snapshot-latest".to_string()),
        last_exported_patch: None,
        reference_revision: Some(1),
        lifecycle_state: HostedAgentLifecycleState::Active,
    }
}

async fn resume_thread(store: &InMemoryThreadStore, thread_id: ThreadId) {
    store
        .resume_thread(ResumeThreadParams {
            thread_id,
            rollout_path: None,
            history: None,
            include_archived: false,
            metadata: ThreadPersistenceMetadata {
                cwd: None,
                model_provider: "test-provider".to_string(),
                memory_mode: ThreadMemoryMode::Enabled,
            },
        })
        .await
        .expect("resume thread");
}

#[tokio::test]
async fn hosted_agent_runtime_round_trips_without_affecting_non_hosted_threads() {
    let store = InMemoryThreadStore::default();
    let hosted_thread_id = ThreadId::new();
    let local_thread_id = ThreadId::new();
    resume_thread(&store, hosted_thread_id).await;
    resume_thread(&store, local_thread_id).await;

    assert_eq!(
        store
            .get_hosted_agent_runtime(local_thread_id)
            .await
            .expect("read local thread runtime"),
        None
    );
    let record = runtime_record();
    store
        .set_hosted_agent_runtime(hosted_thread_id, record.clone())
        .await
        .expect("persist hosted runtime");

    assert_eq!(
        store
            .get_hosted_agent_runtime(hosted_thread_id)
            .await
            .expect("read hosted runtime"),
        Some(record)
    );
    assert_eq!(
        store
            .get_hosted_agent_runtime(local_thread_id)
            .await
            .expect("reread local thread runtime"),
        None
    );
}

#[tokio::test]
async fn hosted_agent_runtime_rejects_missing_threads() {
    let store = InMemoryThreadStore::default();
    let thread_id = ThreadId::new();

    assert!(matches!(
        store
            .get_hosted_agent_runtime(thread_id)
            .await
            .expect_err("missing thread should fail"),
        ThreadStoreError::ThreadNotFound { thread_id: missing } if missing == thread_id
    ));
    assert!(matches!(
        store
            .set_hosted_agent_runtime(thread_id, runtime_record())
            .await
            .expect_err("missing thread should fail"),
        ThreadStoreError::ThreadNotFound { thread_id: missing } if missing == thread_id
    ));
}
