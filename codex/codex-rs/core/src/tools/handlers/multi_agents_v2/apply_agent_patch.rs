use super::*;
use crate::thread_manager::HostedAgentPatchApplyResult;
use crate::tools::handlers::multi_agents_spec::create_apply_agent_patch_tool;
use codex_protocol::ThreadId;
use codex_tools::ToolSpec;

pub(crate) struct Handler;

impl ToolExecutor<ToolInvocation> for Handler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("apply_agent_patch")
    }

    fn spec(&self) -> ToolSpec {
        create_apply_agent_patch_tool()
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        Box::pin(async move {
            handle_apply_agent_patch(invocation)
                .await
                .map(boxed_tool_output)
        })
    }
}

async fn handle_apply_agent_patch(
    invocation: ToolInvocation,
) -> Result<ApplyAgentPatchResult, FunctionCallError> {
    let ToolInvocation {
        session, payload, ..
    } = invocation;
    let arguments = function_arguments(payload)?;
    let args: ApplyAgentPatchArgs = parse_arguments(&arguments)?;
    let source_agent_id = ThreadId::from_string(&args.agent_id).map_err(|error| {
        FunctionCallError::RespondToModel(format!("invalid agent id {}: {error:?}", args.agent_id))
    })?;

    session
        .services
        .agent_control
        .apply_hosted_agent_patch(session.thread_id, source_agent_id, &args.artifact_id)
        .await
        .map(ApplyAgentPatchResult::from)
        .map_err(|error| collab_agent_error(source_agent_id, error))
}

impl CoreToolRuntime for Handler {
    fn matches_kind(&self, payload: &ToolPayload) -> bool {
        matches!(payload, ToolPayload::Function { .. })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyAgentPatchArgs {
    agent_id: String,
    artifact_id: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ApplyAgentPatchResult {
    Applied,
    Conflict {
        paths: Vec<codex_utils_path_uri::PathUri>,
    },
    Rejected {
        reason: String,
    },
}

impl From<HostedAgentPatchApplyResult> for ApplyAgentPatchResult {
    fn from(result: HostedAgentPatchApplyResult) -> Self {
        match result {
            HostedAgentPatchApplyResult::Applied => Self::Applied,
            HostedAgentPatchApplyResult::Conflict { paths } => Self::Conflict { paths },
            HostedAgentPatchApplyResult::Rejected { reason } => Self::Rejected { reason },
        }
    }
}

impl ToolOutput for ApplyAgentPatchResult {
    fn log_preview(&self) -> String {
        tool_output_json_text(self, "apply_agent_patch")
    }

    fn success_for_logging(&self) -> bool {
        true
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        tool_output_response_item(call_id, payload, self, Some(true), "apply_agent_patch")
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        tool_output_code_mode_result(self, "apply_agent_patch")
    }
}
