use std::sync::Arc;

use codex_app_server_protocol::AgentPatchArtifactMetadata;
use codex_app_server_protocol::AgentPatchAvailableNotification;
use codex_app_server_protocol::ServerNotification;
use codex_core::HostedAgentPatchAvailable;

use crate::outgoing_message::OutgoingMessageSender;
use crate::outgoing_message::ThreadScopedOutgoingMessageSender;
use crate::thread_state::ThreadStateManager;

pub(crate) async fn send_hosted_agent_patch_available(
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
    available: HostedAgentPatchAvailable,
) {
    let connection_ids = thread_state_manager
        .subscribed_connection_ids(available.owner_thread_id)
        .await;
    let artifact = available.artifact;
    ThreadScopedOutgoingMessageSender::new(outgoing, connection_ids, available.owner_thread_id)
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

#[cfg(test)]
#[path = "hosted_agent_patch_notifications_tests.rs"]
mod tests;
