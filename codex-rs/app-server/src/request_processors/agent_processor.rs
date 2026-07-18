use std::sync::Arc;

use codex_app_server_protocol::AgentPatchApplyParams;
use codex_app_server_protocol::AgentPatchApplyResponse;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::MAX_AGENT_PATCH_CONFLICT_PATHS;
use codex_core::HostedAgentPatchApplyResult;
use codex_core::ThreadManager;
use codex_protocol::ThreadId;
use codex_protocol::error::CodexErr;

use crate::error_code::internal_error;
use crate::error_code::invalid_request;

#[derive(Clone)]
pub(crate) struct AgentRequestProcessor {
    thread_manager: Arc<ThreadManager>,
}

impl AgentRequestProcessor {
    pub(crate) fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self { thread_manager }
    }

    pub(crate) async fn patch_apply(
        &self,
        params: AgentPatchApplyParams,
    ) -> Result<AgentPatchApplyResponse, JSONRPCErrorError> {
        let requesting_agent_id = ThreadId::from_string(&params.thread_id)
            .map_err(|error| invalid_request(format!("invalid thread id: {error}")))?;
        let source_agent_id = ThreadId::from_string(&params.agent_id)
            .map_err(|error| invalid_request(format!("invalid agent id: {error}")))?;
        let result = self
            .thread_manager
            .apply_hosted_agent_patch(
                requesting_agent_id,
                source_agent_id,
                params.artifact_id.as_str(),
            )
            .await
            .map_err(|error| match error {
                CodexErr::InvalidRequest(message) => invalid_request(message),
                error => internal_error(format!("failed to apply hosted-agent patch: {error}")),
            })?;
        map_patch_apply_result(result)
    }
}

fn map_patch_apply_result(
    result: HostedAgentPatchApplyResult,
) -> Result<AgentPatchApplyResponse, JSONRPCErrorError> {
    match result {
        HostedAgentPatchApplyResult::Applied => Ok(AgentPatchApplyResponse::Applied),
        HostedAgentPatchApplyResult::Conflict { paths } => {
            if paths.len() > MAX_AGENT_PATCH_CONFLICT_PATHS {
                return Err(internal_error(
                    "hosted-agent service returned too many patch conflicts",
                ));
            }
            Ok(AgentPatchApplyResponse::Conflict { paths })
        }
        HostedAgentPatchApplyResult::Rejected { reason } => {
            Ok(AgentPatchApplyResponse::Rejected { reason })
        }
    }
}

#[cfg(test)]
#[path = "agent_processor_tests.rs"]
mod tests;
