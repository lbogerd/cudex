use codex_hosted_agent::HostedAgentRuntimeRecord;
use codex_protocol::ThreadId;

use super::LocalThreadStore;
use crate::ThreadStoreError;
use crate::ThreadStoreResult;

pub(super) async fn get_hosted_agent_runtime(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<Option<HostedAgentRuntimeRecord>> {
    let state_db = store
        .state_db
        .as_ref()
        .ok_or(ThreadStoreError::Unsupported {
            operation: "get_hosted_agent_runtime",
        })?;
    if let Some(value) = state_db
        .get_thread_hosted_runtime_json(thread_id)
        .await
        .map_err(|err| ThreadStoreError::Internal {
            message: format!("failed to read hosted-agent runtime for thread {thread_id}: {err}"),
        })?
    {
        return serde_json::from_value(value)
            .map(Some)
            .map_err(|err| ThreadStoreError::Internal {
                message: format!(
                    "failed to deserialize hosted-agent runtime for thread {thread_id}: {err}"
                ),
            });
    }

    match state_db.get_thread(thread_id).await {
        Ok(Some(_)) => Ok(None),
        Ok(None) => Err(ThreadStoreError::ThreadNotFound { thread_id }),
        Err(err) => Err(ThreadStoreError::Internal {
            message: format!("failed to read thread {thread_id}: {err}"),
        }),
    }
}

pub(super) async fn set_hosted_agent_runtime(
    store: &LocalThreadStore,
    thread_id: ThreadId,
    record: HostedAgentRuntimeRecord,
) -> ThreadStoreResult<()> {
    let state_db = store
        .state_db
        .as_ref()
        .ok_or(ThreadStoreError::Unsupported {
            operation: "set_hosted_agent_runtime",
        })?;
    let value = serde_json::to_value(record).map_err(|err| ThreadStoreError::Internal {
        message: format!("failed to serialize hosted-agent runtime for thread {thread_id}: {err}"),
    })?;
    let updated = state_db
        .set_thread_hosted_runtime_json(thread_id, &value)
        .await
        .map_err(|err| ThreadStoreError::Internal {
            message: format!("failed to write hosted-agent runtime for thread {thread_id}: {err}"),
        })?;
    if !updated {
        return Err(ThreadStoreError::ThreadNotFound { thread_id });
    }
    Ok(())
}

#[cfg(test)]
#[path = "hosted_agent_tests.rs"]
mod tests;
