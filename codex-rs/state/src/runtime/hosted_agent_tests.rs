use super::*;
use crate::runtime::test_support::test_thread_metadata;
use crate::runtime::test_support::unique_temp_dir;
use pretty_assertions::assert_eq;
use serde_json::json;

#[tokio::test]
async fn hosted_runtime_json_round_trips() -> anyhow::Result<()> {
    let codex_home = unique_temp_dir();
    let runtime = StateRuntime::init(codex_home.clone(), "test-provider".to_string()).await?;
    let thread_id = ThreadId::from_string("00000000-0000-0000-0000-000000000810")?;
    runtime
        .upsert_thread(&test_thread_metadata(
            &codex_home,
            thread_id,
            codex_home.clone(),
        ))
        .await?;
    let record = json!({
        "leaseId": "lease-1",
        "latestSnapshotId": "snapshot-2",
        "lifecycleState": "active",
    });

    assert!(
        runtime
            .set_thread_hosted_runtime_json(thread_id, &record)
            .await?
    );
    assert_eq!(
        runtime.get_thread_hosted_runtime_json(thread_id).await?,
        Some(record)
    );
    Ok(())
}

#[tokio::test]
async fn thread_metadata_upsert_preserves_hosted_runtime_json() -> anyhow::Result<()> {
    let codex_home = unique_temp_dir();
    let runtime = StateRuntime::init(codex_home.clone(), "test-provider".to_string()).await?;
    let thread_id = ThreadId::from_string("00000000-0000-0000-0000-000000000811")?;
    let mut metadata = test_thread_metadata(&codex_home, thread_id, codex_home.clone());
    runtime.upsert_thread(&metadata).await?;
    let record = json!({"leaseId": "lease-1"});
    runtime
        .set_thread_hosted_runtime_json(thread_id, &record)
        .await?;

    metadata.title = "updated title".to_string();
    runtime.upsert_thread(&metadata).await?;

    assert_eq!(
        runtime.get_thread_hosted_runtime_json(thread_id).await?,
        Some(record)
    );
    Ok(())
}

#[tokio::test]
async fn deleting_thread_deletes_hosted_runtime_json() -> anyhow::Result<()> {
    let codex_home = unique_temp_dir();
    let runtime = StateRuntime::init(codex_home.clone(), "test-provider".to_string()).await?;
    let thread_id = ThreadId::from_string("00000000-0000-0000-0000-000000000812")?;
    runtime
        .upsert_thread(&test_thread_metadata(
            &codex_home,
            thread_id,
            codex_home.clone(),
        ))
        .await?;
    runtime
        .set_thread_hosted_runtime_json(thread_id, &json!({"leaseId": "lease-1"}))
        .await?;

    assert_eq!(runtime.delete_thread(thread_id).await?, 1);
    assert_eq!(
        runtime.get_thread_hosted_runtime_json(thread_id).await?,
        None
    );
    Ok(())
}
