use codex_hosted_agent::AgentPatchArtifact;
use codex_hosted_agent::HostedAgentLifecycleState;
use codex_protocol::ThreadId;
use codex_protocol::error::CodexErr;
use codex_protocol::error::Result as CodexResult;
use std::sync::Arc;
use tracing::warn;

use super::HostedAgentRuntimeEntry;
use super::ThreadManagerState;

/// A durable patch that became available for an owning thread.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedAgentPatchAvailable {
    pub owner_thread_id: ThreadId,
    pub artifact: AgentPatchArtifact,
}

impl ThreadManagerState {
    /// Retries an interrupted finalization from the runtime's durable owner and state.
    pub(crate) async fn retry_pending_hosted_finalization(
        &self,
        agent_id: ThreadId,
    ) -> CodexResult<HostedAgentLifecycleState> {
        let runtime = self
            .hosted_agent_runtimes
            .read()
            .await
            .get(&agent_id)
            .cloned()
            .ok_or_else(|| {
                CodexErr::Fatal(format!(
                    "pending hosted runtime {agent_id} is not registered"
                ))
            })?;
        let value = runtime.snapshot();
        if value.lifecycle_state != HostedAgentLifecycleState::PendingFinalization {
            return Ok(value.lifecycle_state);
        }
        let owner_thread_id = value.owner_agent_id.ok_or_else(|| {
            CodexErr::Fatal(format!(
                "pending hosted runtime {agent_id} has no durable owner"
            ))
        })?;
        self.finalize_hosted_runtime(agent_id, owner_thread_id)
            .await?;
        Ok(runtime.snapshot().lifecycle_state)
    }

    /// Finalizes an owned hosted agent without applying its patch to the owner.
    ///
    /// An `Ok(Some(_))` result means the artifact was durably persisted. Cleanup failures leave
    /// the runtime in `ReleasePending` but do not turn a durable completion into a failure.
    pub(crate) async fn finalize_hosted_runtime(
        &self,
        agent_id: ThreadId,
        owner_thread_id: ThreadId,
    ) -> CodexResult<Option<AgentPatchArtifact>> {
        let Some(runtime) = self
            .hosted_agent_runtimes
            .read()
            .await
            .get(&agent_id)
            .cloned()
        else {
            return Ok(None);
        };
        let _operation_permit = Arc::clone(&runtime.operation_lock)
            .acquire_owned()
            .await
            .map_err(|_| {
                CodexErr::Fatal(format!(
                    "hosted runtime operation coordination closed for thread {agent_id}"
                ))
            })?;
        let provisioner = match &self.hosted_agent_provisioner {
            Ok(Some(provisioner)) => provisioner,
            Ok(None) => {
                return Err(CodexErr::Fatal(
                    "hosted-agent provisioner is unavailable during finalization".to_string(),
                ));
            }
            Err(error) => {
                return Err(CodexErr::Fatal(format!(
                    "failed to initialize hosted-agent service: {error}"
                )));
            }
        };

        let mut value = runtime.snapshot();
        if value.owner_agent_id != Some(owner_thread_id) {
            return Err(CodexErr::InvalidRequest(format!(
                "thread {owner_thread_id} does not own hosted agent {agent_id}"
            )));
        }
        let artifact = match value.lifecycle_state {
            HostedAgentLifecycleState::Active | HostedAgentLifecycleState::PendingFinalization => {
                if value.lifecycle_state == HostedAgentLifecycleState::Active {
                    value.lifecycle_state = HostedAgentLifecycleState::PendingFinalization;
                    self.persist_finalization_state(agent_id, &runtime, &value)
                        .await?;
                }
                let checkpoint = provisioner
                    .checkpoint_for_completion(agent_id, &value)
                    .await
                    .map_err(|error| CodexErr::Fatal(error.to_string()))?;
                value.latest_snapshot_id = Some(checkpoint.snapshot_id.clone());
                self.persist_finalization_state(agent_id, &runtime, &value)
                    .await?;
                let artifact = provisioner
                    .export_patch(agent_id, &checkpoint.snapshot_id, &value)
                    .await
                    .map_err(|error| CodexErr::Fatal(error.to_string()))?;
                value.last_exported_patch = Some(artifact.clone());
                value.lifecycle_state = HostedAgentLifecycleState::Completed;
                self.persist_finalization_state(agent_id, &runtime, &value)
                    .await?;
                artifact
            }
            HostedAgentLifecycleState::Completed
            | HostedAgentLifecycleState::ReleasePending
            | HostedAgentLifecycleState::Released => {
                value.last_exported_patch.clone().ok_or_else(|| {
                    CodexErr::Fatal(format!(
                        "hosted runtime {agent_id} is finalized without a patch artifact"
                    ))
                })?
            }
        };

        if value.lifecycle_state == HostedAgentLifecycleState::Released {
            self.record_active_hosted_lease_count().await;
            return Ok(Some(artifact));
        }
        let retained = provisioner
            .retain(agent_id, &value)
            .await
            .map_err(|error| CodexErr::Fatal(error.to_string()))?;
        if value.reference_revision != Some(retained.revision) {
            value.reference_revision = Some(retained.revision);
            self.persist_finalization_state(agent_id, &runtime, &value)
                .await?;
        }
        let _ = self.patch_available_tx.send(HostedAgentPatchAvailable {
            owner_thread_id,
            artifact: artifact.clone(),
        });

        match provisioner.release(agent_id, value.clone()).await {
            Ok(()) => {
                value.lifecycle_state = HostedAgentLifecycleState::Released;
                if let Err(error) = self
                    .persist_finalization_state(agent_id, &runtime, &value)
                    .await
                {
                    runtime.replace(value);
                    warn!(%error, %agent_id, "failed to persist released hosted runtime");
                }
            }
            Err(error) => {
                value.lifecycle_state = HostedAgentLifecycleState::ReleasePending;
                if let Err(persistence_error) = self
                    .persist_finalization_state(agent_id, &runtime, &value)
                    .await
                {
                    runtime.replace(value);
                    warn!(
                        %persistence_error,
                        %agent_id,
                        "failed to persist hosted runtime pending release"
                    );
                }
                warn!(%error, %agent_id, "hosted agent completed with cleanup pending");
            }
        }
        self.record_active_hosted_lease_count().await;
        Ok(Some(artifact))
    }

    async fn persist_finalization_state(
        &self,
        agent_id: ThreadId,
        runtime: &HostedAgentRuntimeEntry,
        value: &crate::hosted_agent_runtime::HostedAgentRuntime,
    ) -> CodexResult<()> {
        self.thread_store
            .set_hosted_agent_runtime(agent_id, value.durable_record())
            .await
            .map_err(|error| {
                CodexErr::Fatal(format!(
                    "failed to persist hosted-agent finalization for thread {agent_id}: {error}"
                ))
            })?;
        runtime.replace(value.clone());
        Ok(())
    }
}
