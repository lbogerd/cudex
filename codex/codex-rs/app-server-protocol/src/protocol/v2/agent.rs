use codex_utils_path_uri::PathUri;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Maximum number of conflicting paths returned by `agent/patchApply`.
pub const MAX_AGENT_PATCH_CONFLICT_PATHS: usize = 256;

/// Applies one completed hosted agent's exported patch to its owner's sandbox.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPatchApplyParams {
    /// The requesting owner's thread and patch target.
    pub thread_id: String,
    /// The hosted child agent that produced the artifact.
    pub agent_id: String,
    /// The exported artifact to apply.
    pub artifact_id: String,
}

/// Result of an atomic hosted-agent patch application.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase", export_to = "v2/")]
pub enum AgentPatchApplyResponse {
    /// The patch was applied and the target sandbox was checkpointed.
    Applied,
    /// The patch conflicted and the target sandbox was left unchanged.
    Conflict {
        /// Canonical file URIs for conflicting paths, capped by the protocol limit.
        #[schemars(length(max = 256))]
        paths: Vec<PathUri>,
    },
    /// The patch could not be applied, for example because it was stale or unauthorized.
    Rejected { reason: String },
}

/// Durable, non-secret metadata for an exported hosted-agent patch.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPatchArtifactMetadata {
    pub artifact_id: String,
    pub agent_id: String,
    pub base_snapshot_id: String,
    pub checksum: String,
    pub changed_files: u32,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

/// Notifies an owner that a completed hosted agent has a patch ready to inspect or apply.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPatchAvailableNotification {
    /// The owner thread whose sandbox is the eligible patch target.
    pub thread_id: String,
    pub artifact: AgentPatchArtifactMetadata,
}
