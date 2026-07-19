use super::*;
use crate::runtime::test_support::test_thread_metadata;
use crate::runtime::test_support::unique_temp_dir;
use pretty_assertions::assert_eq;
use serde_json::json;

#[tokio::test]
async fn deletion_outbox_is_grouped_durable_and_ready_only_after_local_deletion()
-> anyhow::Result<()> {
    let codex_home = unique_temp_dir();
    let runtime = StateRuntime::init(codex_home.clone(), "test-provider".to_string()).await?;
    let root = ThreadId::from_string("00000000-0000-0000-0000-000000000820")?;
    let child = ThreadId::from_string("00000000-0000-0000-0000-000000000821")?;
    for thread_id in [root, child] {
        runtime
            .upsert_thread(&test_thread_metadata(
                &codex_home,
                thread_id,
                codex_home.clone(),
            ))
            .await?;
    }
    runtime
        .set_thread_hosted_runtime_json(
            child,
            &json!({"leaseId": "lease-child", "referenceRevision": 7}),
        )
        .await?;

    let entries = runtime
        .enqueue_thread_deletion(root, &[root, child])
        .await?;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].lease_id, None);
    assert_eq!(entries[1].lease_id.as_deref(), Some("lease-child"));
    assert_eq!(entries[1].expected_revision, Some(7));
    assert!(runtime.ready_thread_deletion_batches(10).await?.is_empty());

    runtime.delete_thread(child).await?;
    assert!(runtime.ready_thread_deletion_batches(10).await?.is_empty());
    runtime.delete_thread(root).await?;
    assert_eq!(
        runtime.thread_deletion_outbox_members(root).await?,
        vec![root, child]
    );
    assert_eq!(
        runtime
            .enqueue_thread_deletion(root, &[child, root])
            .await?,
        entries
    );
    assert!(
        runtime
            .enqueue_thread_deletion(root, &[root])
            .await
            .is_err()
    );

    let ready = runtime.ready_thread_deletion_batches(10).await?;
    assert_eq!(ready, vec![entries]);
    assert_eq!(runtime.complete_thread_deletion_outbox(root).await?, 2);
    assert!(
        runtime
            .thread_deletion_outbox_members(root)
            .await?
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn deletion_outbox_rejects_hosted_runtime_without_a_revision() -> anyhow::Result<()> {
    let codex_home = unique_temp_dir();
    let runtime = StateRuntime::init(codex_home.clone(), "test-provider".to_string()).await?;
    let thread_id = ThreadId::from_string("00000000-0000-0000-0000-000000000822")?;
    runtime
        .upsert_thread(&test_thread_metadata(
            &codex_home,
            thread_id,
            codex_home.clone(),
        ))
        .await?;
    runtime
        .set_thread_hosted_runtime_json(thread_id, &json!({"leaseId": "lease-legacy"}))
        .await?;

    assert!(
        runtime
            .enqueue_thread_deletion(thread_id, &[thread_id])
            .await
            .is_err()
    );
    assert!(
        runtime
            .thread_deletion_outbox_members(thread_id)
            .await?
            .is_empty()
    );
    assert!(runtime.get_thread(thread_id).await?.is_some());
    Ok(())
}

#[tokio::test]
async fn failed_deletion_batch_moves_behind_other_ready_work() -> anyhow::Result<()> {
    let codex_home = unique_temp_dir();
    let runtime = StateRuntime::init(codex_home, "test-provider".to_string()).await?;
    let first = ThreadId::from_string("00000000-0000-0000-0000-000000000823")?;
    let second = ThreadId::from_string("00000000-0000-0000-0000-000000000824")?;
    runtime.enqueue_thread_deletion(first, &[first]).await?;
    runtime.enqueue_thread_deletion(second, &[second]).await?;

    assert_eq!(
        runtime.ready_thread_deletion_batches(1).await?[0][0].thread_id,
        first
    );
    assert_eq!(runtime.defer_thread_deletion_outbox(first).await?, 1);
    assert_eq!(
        runtime.ready_thread_deletion_batches(1).await?[0][0].thread_id,
        second
    );
    Ok(())
}
