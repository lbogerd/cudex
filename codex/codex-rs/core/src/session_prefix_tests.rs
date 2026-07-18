use codex_protocol::AgentPath;
use codex_protocol::ThreadId;
use codex_protocol::protocol::AgentStatus;
use codex_utils_output_truncation::approx_token_count;

use super::COMPLETION_MESSAGE_MAX_TOKENS;
use super::ERROR_NEXT_ACTION;
use super::append_hosted_patch_metadata;
use super::format_inter_agent_completion_message;

#[test]
fn error_completion_message_stays_below_manual_review_threshold() {
    let message = format_inter_agent_completion_message(
        AgentPath::root(),
        AgentPath::try_from("/root/worker").expect("valid agent path"),
        &AgentStatus::Errored("stream disconnected ".repeat(1_000)),
    )
    .expect("error status should produce a completion message");

    assert!(approx_token_count(&message) < COMPLETION_MESSAGE_MAX_TOKENS);
    assert!(message.contains(ERROR_NEXT_ACTION));
}

#[test]
fn hosted_patch_metadata_is_appended_to_completion_message() {
    let agent_id = ThreadId::new();
    let mut message = Some("done".to_string());

    append_hosted_patch_metadata(
        &mut message,
        &codex_hosted_agent::AgentPatchArtifact {
            artifact_id: "artifact-1".to_string(),
            agent_id,
            base_snapshot_id: "base-1".to_string(),
            checksum: "checksum-1".to_string(),
            changed_files: 3,
            size_bytes: 42,
        },
    );

    assert_eq!(
        message,
        Some(format!(
            "done\n\nHosted patch available: agent_id={agent_id}; artifact_id=artifact-1; changed_files=3; size_bytes=42"
        ))
    );
}

#[test]
fn hosted_patch_metadata_skips_oversized_artifact_ids() {
    let mut message = Some("done".to_string());

    append_hosted_patch_metadata(
        &mut message,
        &codex_hosted_agent::AgentPatchArtifact {
            artifact_id: "a".repeat(codex_hosted_agent::MAX_OPAQUE_ID_BYTES + 1),
            agent_id: ThreadId::new(),
            base_snapshot_id: "base-1".to_string(),
            checksum: "checksum-1".to_string(),
            changed_files: 3,
            size_bytes: 42,
        },
    );

    assert_eq!(message, Some("done".to_string()));
}
