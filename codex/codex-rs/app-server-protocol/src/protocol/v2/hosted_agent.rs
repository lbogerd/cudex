use crate::JsonSchema;
use crate::TS;
use codex_utils_path_uri::PathUri;
use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPatchApplyParams {
    pub thread_id: String,
    pub agent_id: String,
    pub artifact_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase", export_to = "v2/")]
pub enum AgentPatchApplyResponse {
    Applied,
    Conflict { paths: Vec<PathUri> },
    Rejected { reason: String },
}

/// Non-secret, durable metadata for a hosted workspace patch.
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

/// Delivered only to subscribers of the owner eligible to apply this patch.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPatchAvailableNotification {
    pub thread_id: String,
    pub artifact: AgentPatchArtifactMetadata,
}
