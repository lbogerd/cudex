use std::sync::Arc;

use codex_analytics::AnalyticsEventsClient;
use codex_app_server_protocol::AgentPatchArtifactMetadata;
use codex_app_server_protocol::AgentPatchAvailableNotification;
use codex_app_server_protocol::ServerNotification;
use codex_core::HostedAgentPatchAvailable;
use codex_protocol::ThreadId;
use pretty_assertions::assert_eq;
use serde_json::json;
use tokio::sync::mpsc;

use super::send_hosted_agent_patch_available;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::OutgoingEnvelope;
use crate::outgoing_message::OutgoingMessage;
use crate::outgoing_message::OutgoingMessageSender;
use crate::thread_state::ConnectionCapabilities;
use crate::thread_state::ThreadStateManager;

fn available_patch(owner_thread_id: ThreadId) -> HostedAgentPatchAvailable {
    HostedAgentPatchAvailable {
        owner_thread_id,
        artifact: serde_json::from_value(json!({
            "artifactId": "artifact-1",
            "agentId": ThreadId::new(),
            "baseSnapshotId": "snapshot-base",
            "checksum": "sha256:abc",
            "changedFiles": 3,
            "sizeBytes": 42,
        }))
        .expect("valid hosted patch artifact"),
    }
}

#[tokio::test]
async fn patch_available_is_scoped_to_owner_thread_subscribers() {
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel(2);
    let outgoing = Arc::new(OutgoingMessageSender::new(
        outgoing_tx,
        AnalyticsEventsClient::disabled(),
    ));
    let thread_state_manager = ThreadStateManager::new();
    let owner_thread_id = ThreadId::new();
    let other_thread_id = ThreadId::new();
    let owner_connection_id = ConnectionId(1);
    let other_connection_id = ConnectionId(2);
    for connection_id in [owner_connection_id, other_connection_id] {
        thread_state_manager
            .connection_initialized(
                connection_id,
                ConnectionCapabilities {
                    request_attestation: false,
                },
            )
            .await;
    }
    thread_state_manager
        .try_ensure_connection_subscribed(
            owner_thread_id,
            owner_connection_id,
            /*experimental_raw_events*/ false,
        )
        .await
        .expect("owner connection should subscribe");
    thread_state_manager
        .try_ensure_connection_subscribed(
            other_thread_id,
            other_connection_id,
            /*experimental_raw_events*/ false,
        )
        .await
        .expect("other connection should subscribe");

    let available = available_patch(owner_thread_id);
    let expected = AgentPatchAvailableNotification {
        thread_id: owner_thread_id.to_string(),
        artifact: AgentPatchArtifactMetadata {
            artifact_id: available.artifact.artifact_id.clone(),
            agent_id: available.artifact.agent_id.to_string(),
            base_snapshot_id: available.artifact.base_snapshot_id.clone(),
            checksum: available.artifact.checksum.clone(),
            changed_files: available.artifact.changed_files,
            size_bytes: available.artifact.size_bytes,
        },
    };
    send_hosted_agent_patch_available(
        Arc::clone(&outgoing),
        thread_state_manager.clone(),
        available,
    )
    .await;

    let envelope = outgoing_rx
        .try_recv()
        .expect("owner subscriber should receive the patch notification");
    let OutgoingEnvelope::ToConnection {
        connection_id,
        message,
        ..
    } = envelope
    else {
        panic!("patch notification must not be broadcast");
    };
    assert_eq!(connection_id, owner_connection_id);
    let OutgoingMessage::AppServerNotification(envelope) = message else {
        panic!("expected app-server notification");
    };
    let ServerNotification::AgentPatchAvailable(notification) = envelope.notification else {
        panic!("expected agent/patchAvailable notification");
    };
    assert_eq!(notification, expected);
    assert!(
        outgoing_rx.try_recv().is_err(),
        "unrelated subscribers should not receive the notification"
    );
}

#[tokio::test]
async fn patch_available_without_owner_subscribers_is_not_broadcast() {
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel(1);
    let outgoing = Arc::new(OutgoingMessageSender::new(
        outgoing_tx,
        AnalyticsEventsClient::disabled(),
    ));

    send_hosted_agent_patch_available(
        outgoing,
        ThreadStateManager::new(),
        available_patch(ThreadId::new()),
    )
    .await;

    assert!(outgoing_rx.try_recv().is_err());
}
