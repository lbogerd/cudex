use chrono::Utc;
use codex_hosted_agent::HostedAgentLifecycleState;
use codex_hosted_agent::HostedAgentRuntimeRecord;
use codex_protocol::ThreadId;
use codex_protocol::protocol::SessionSource;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::LocalThreadStore;
use crate::ThreadStore;
use crate::ThreadStoreError;
use crate::local::test_support::test_config;

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

async fn store_with_thread() -> (
    TempDir,
    LocalThreadStore,
    codex_rollout::StateDbHandle,
    ThreadId,
) {
    let home = TempDir::new().expect("temp dir");
    let config = test_config(home.path());
    let runtime = codex_state::StateRuntime::init(
        config.sqlite_home.clone(),
        config.default_model_provider_id.clone(),
    )
    .await
    .expect("state db should initialize");
    let thread_id = ThreadId::new();
    let mut builder = codex_state::ThreadMetadataBuilder::new(
        thread_id,
        home.path().join(format!("rollout-{thread_id}.jsonl")),
        Utc::now(),
        SessionSource::Cli,
    );
    builder.model_provider = Some(config.default_model_provider_id.clone());
    builder.cwd = home.path().to_path_buf();
    builder.cli_version = Some("test-version".to_string());
    runtime
        .upsert_thread(&builder.build(config.default_model_provider_id.as_str()))
        .await
        .expect("persist thread metadata");
    let store = LocalThreadStore::new(config, Some(runtime.clone()));
    (home, store, runtime, thread_id)
}

#[tokio::test]
async fn hosted_agent_runtime_round_trips_without_affecting_non_hosted_threads() {
    let (_home, store, runtime, hosted_thread_id) = store_with_thread().await;
    let local_thread_id = ThreadId::new();
    let hosted_metadata = runtime
        .get_thread(hosted_thread_id)
        .await
        .expect("read hosted thread")
        .expect("hosted thread metadata");
    let mut local_metadata = hosted_metadata;
    local_metadata.id = local_thread_id;
    local_metadata.rollout_path = local_metadata
        .rollout_path
        .with_file_name(format!("rollout-{local_thread_id}.jsonl"));
    runtime
        .upsert_thread(&local_metadata)
        .await
        .expect("persist local thread metadata");

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
    let (_home, store, _runtime, _existing_thread_id) = store_with_thread().await;
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
