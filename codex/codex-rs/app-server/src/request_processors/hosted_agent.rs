use super::*;
use codex_app_server_protocol::AgentPatchArtifactMetadata;
use codex_app_server_protocol::AgentPatchAvailableNotification;
use codex_core::HostedAgentPatchAvailable;

impl ThreadRequestProcessor {
    pub(crate) async fn hosted_patch_apply(
        &self,
        params: codex_app_server_protocol::AgentPatchApplyParams,
    ) -> Result<codex_app_server_protocol::AgentPatchApplyResponse, JSONRPCErrorError> {
        let owner = ThreadId::from_string(&params.thread_id)
            .map_err(|_| invalid_request("invalid owner thread ID"))?;
        let child = ThreadId::from_string(&params.agent_id)
            .map_err(|_| invalid_request("invalid child thread ID"))?;
        let result = self
            .thread_manager
            .apply_hosted_agent_patch(owner, child, &params.artifact_id)
            .await
            .map_err(|error| invalid_request(error.to_string()))?;
        // Both boundaries use the same tagged contract; the public API omits the
        // internal checkpoint returned on success.
        let value =
            serde_json::to_value(result).map_err(|error| internal_error(error.to_string()))?;
        serde_json::from_value(value).map_err(|error| internal_error(error.to_string()))
    }

    pub(crate) fn hosted_patch_receiver(&self) -> broadcast::Receiver<HostedAgentPatchAvailable> {
        self.thread_manager.subscribe_hosted_agent_patch_available()
    }

    pub(crate) async fn hosted_patch_available(&self, available: HostedAgentPatchAvailable) {
        let connections = self
            .thread_state_manager
            .subscribed_connection_ids(available.owner_thread_id)
            .await;
        let artifact = available.artifact;
        ThreadScopedOutgoingMessageSender::new(
            Arc::clone(&self.outgoing),
            connections,
            available.owner_thread_id,
        )
        .send_server_notification(ServerNotification::AgentPatchAvailable(
            AgentPatchAvailableNotification {
                thread_id: available.owner_thread_id.to_string(),
                artifact: AgentPatchArtifactMetadata {
                    artifact_id: artifact.artifact_id,
                    agent_id: artifact.agent_id.to_string(),
                    base_snapshot_id: artifact.base_snapshot_id,
                    checksum: artifact.checksum,
                    changed_files: artifact.changed_files,
                    size_bytes: artifact.size_bytes,
                },
            },
        ))
        .await;
    }
}
