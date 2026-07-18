use std::sync::Arc;

use codex_hosted_agent::HostedAgentLifecycleState;
use codex_hosted_agent::PatchApplyResult;
use codex_protocol::ThreadId;
use codex_protocol::error::CodexErr;
use codex_protocol::error::Result as CodexResult;
use codex_thread_store::ThreadStoreError;
use codex_tools::ToolExecutionDomain;
use codex_tools::ToolName;
use codex_utils_path_uri::PathUri;

use crate::hosted_agent_runtime::HostedToolAuthorization;

use super::ThreadManager;
use super::ThreadManagerState;

pub(crate) const HOSTED_AGENT_PATCH_APPLY_TOOL_NAME: &str = "apply_agent_patch";

const UNAVAILABLE_PATCH_REASON: &str = "patch is not available to the requesting agent";
const INACTIVE_TARGET_REASON: &str = "requesting thread has no active hosted sandbox";
const UNAUTHORIZED_TOOL_REASON: &str = "hosted sandbox policy does not allow patch application";
const MAX_PATCH_CONFLICT_PATHS: usize = 256;

/// Result of applying a completed hosted agent's patch to its owner's current sandbox.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostedAgentPatchApplyResult {
    Applied,
    Conflict { paths: Vec<PathUri> },
    Rejected { reason: String },
}

impl HostedAgentPatchApplyResult {
    fn rejected(reason: &str) -> Self {
        Self::Rejected {
            reason: reason.to_string(),
        }
    }
}

impl ThreadManager {
    /// Applies a finalized descendant's durable patch to the requesting agent's current sandbox.
    pub async fn apply_hosted_agent_patch(
        &self,
        requesting_agent_id: ThreadId,
        source_agent_id: ThreadId,
        artifact_id: &str,
    ) -> CodexResult<HostedAgentPatchApplyResult> {
        if requesting_agent_id == source_agent_id {
            return Ok(HostedAgentPatchApplyResult::rejected(
                UNAVAILABLE_PATCH_REASON,
            ));
        }
        let owned_thread_ids = self
            .list_agent_subtree_thread_ids(requesting_agent_id)
            .await?;
        if !owned_thread_ids.contains(&source_agent_id)
            && !self
                .state
                .is_hosted_agent_descendant(requesting_agent_id, source_agent_id)
                .await?
        {
            return Ok(HostedAgentPatchApplyResult::rejected(
                UNAVAILABLE_PATCH_REASON,
            ));
        }
        self.state
            .apply_hosted_agent_patch(requesting_agent_id, source_agent_id, artifact_id)
            .await
    }
}

impl ThreadManagerState {
    pub(crate) async fn is_hosted_agent_descendant(
        &self,
        requesting_agent_id: ThreadId,
        mut source_agent_id: ThreadId,
    ) -> CodexResult<bool> {
        let mut seen = std::collections::HashSet::new();
        while seen.insert(source_agent_id) {
            let durable_owner_agent_id = match self
                .thread_store
                .get_hosted_agent_runtime(source_agent_id)
                .await
            {
                Ok(record) => record.and_then(|record| record.owner_agent_id),
                Err(ThreadStoreError::ThreadNotFound { .. }) => None,
                Err(error) => {
                    return Err(CodexErr::Fatal(format!(
                        "failed to load hosted-agent ownership for thread {source_agent_id}: {error}"
                    )));
                }
            };
            let owner_agent_id = match durable_owner_agent_id {
                Some(owner_agent_id) => Some(owner_agent_id),
                None => self
                    .hosted_agent_runtimes
                    .read()
                    .await
                    .get(&source_agent_id)
                    .and_then(|runtime| runtime.snapshot().owner_agent_id),
            };
            match owner_agent_id {
                Some(owner_agent_id) if owner_agent_id == requesting_agent_id => return Ok(true),
                Some(owner_agent_id) => source_agent_id = owner_agent_id,
                None => return Ok(false),
            }
        }
        Ok(false)
    }

    pub(crate) async fn apply_hosted_agent_patch(
        &self,
        requesting_agent_id: ThreadId,
        source_agent_id: ThreadId,
        artifact_id: &str,
    ) -> CodexResult<HostedAgentPatchApplyResult> {
        let Some(target_runtime) = self
            .hosted_agent_runtimes
            .read()
            .await
            .get(&requesting_agent_id)
            .cloned()
        else {
            return Ok(HostedAgentPatchApplyResult::rejected(
                INACTIVE_TARGET_REASON,
            ));
        };
        let _operation_permit = Arc::clone(&target_runtime.operation_lock)
            .acquire_owned()
            .await
            .map_err(|_| {
                CodexErr::Fatal(format!(
                    "hosted runtime operation coordination closed for thread {requesting_agent_id}"
                ))
            })?;
        let target = target_runtime.snapshot();
        if target.lifecycle_state != HostedAgentLifecycleState::Active {
            return Ok(HostedAgentPatchApplyResult::rejected(
                INACTIVE_TARGET_REASON,
            ));
        }
        let authorization =
            HostedToolAuthorization::new(target.environment_id.clone(), target.tool_policy.clone());
        if !authorization.allows(
            &ToolName::plain(HOSTED_AGENT_PATCH_APPLY_TOOL_NAME),
            &ToolExecutionDomain::ControlPlane,
        ) {
            return Ok(HostedAgentPatchApplyResult::rejected(
                UNAUTHORIZED_TOOL_REASON,
            ));
        }

        let source = self
            .thread_store
            .get_hosted_agent_runtime(source_agent_id)
            .await
            .map_err(|error| {
                CodexErr::Fatal(format!(
                    "failed to load hosted-agent patch metadata for thread {source_agent_id}: {error}"
                ))
            })?;
        let Some(source) = source else {
            return Ok(HostedAgentPatchApplyResult::rejected(
                UNAVAILABLE_PATCH_REASON,
            ));
        };
        if !matches!(
            source.lifecycle_state,
            HostedAgentLifecycleState::Completed
                | HostedAgentLifecycleState::ReleasePending
                | HostedAgentLifecycleState::Released
        ) {
            return Ok(HostedAgentPatchApplyResult::rejected(
                UNAVAILABLE_PATCH_REASON,
            ));
        }
        let Some(artifact) = source.last_exported_patch else {
            return Ok(HostedAgentPatchApplyResult::rejected(
                UNAVAILABLE_PATCH_REASON,
            ));
        };
        if artifact_id.is_empty()
            || artifact.artifact_id != artifact_id
            || artifact.agent_id != source_agent_id
            || artifact.base_snapshot_id != source.base_snapshot_id
        {
            return Ok(HostedAgentPatchApplyResult::rejected(
                UNAVAILABLE_PATCH_REASON,
            ));
        }

        let provisioner = match &self.hosted_agent_provisioner {
            Ok(Some(provisioner)) => provisioner,
            Ok(None) => {
                return Err(CodexErr::Fatal(
                    "hosted-agent provisioner is unavailable during patch application".to_string(),
                ));
            }
            Err(error) => {
                return Err(CodexErr::Fatal(format!(
                    "failed to initialize hosted-agent service: {error}"
                )));
            }
        };
        match provisioner
            .apply_patch(requesting_agent_id, artifact_id, &target)
            .await
            .map_err(|error| CodexErr::Fatal(error.to_string()))?
        {
            PatchApplyResult::Applied { checkpoint } => {
                let mut record = target.durable_record();
                record.latest_snapshot_id = Some(checkpoint.snapshot_id.clone());
                self.thread_store
                    .set_hosted_agent_runtime(requesting_agent_id, record)
                    .await
                    .map_err(|error| {
                        CodexErr::Fatal(format!(
                            "failed to persist hosted-agent patch checkpoint for thread {requesting_agent_id}: {error}"
                        ))
                    })?;
                target_runtime.set_latest_snapshot_id(checkpoint.snapshot_id);
                Ok(HostedAgentPatchApplyResult::Applied)
            }
            PatchApplyResult::Conflict { paths } if paths.len() <= MAX_PATCH_CONFLICT_PATHS => {
                crate::hosted_agent_telemetry::record_patch_conflict(paths.len());
                Ok(HostedAgentPatchApplyResult::Conflict { paths })
            }
            PatchApplyResult::Conflict { .. } => Err(CodexErr::Fatal(
                "hosted-agent service returned too many patch conflicts".to_string(),
            )),
            PatchApplyResult::Rejected { reason } => {
                Ok(HostedAgentPatchApplyResult::Rejected { reason })
            }
        }
    }
}
