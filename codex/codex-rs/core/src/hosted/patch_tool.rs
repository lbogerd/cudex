use std::sync::Arc;

use codex_extension_api::ExtensionData;
use codex_extension_api::ToolContributor;
use codex_tools::FunctionCallError;
use codex_tools::JsonToolOutput;
use codex_tools::ResponsesApiTool;
use codex_tools::ToolCall;
use codex_tools::ToolExecutor;
use codex_tools::ToolExecutorFuture;
use codex_tools::ToolName;
use codex_tools::ToolOutput;
use codex_tools::ToolPayload;
use codex_tools::ToolSpec;
use codex_tools::parse_tool_input_schema;
use serde::Deserialize;
use serde_json::json;

use super::HostedThread;

pub(crate) struct HostedTools;

impl ToolContributor for HostedTools {
    fn tools(
        &self,
        _session: &ExtensionData,
        thread: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        thread
            .get::<HostedThread>()
            .filter(|hosted| {
                hosted.binding.authorize(
                    &ToolName::plain("apply_agent_patch"),
                    codex_hosted_agent::ToolExecutionDomainKind::ControlPlane,
                )
            })
            .map(|hosted| {
                vec![Arc::new(ApplyAgentPatch(hosted))
                    as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>]
            })
            .unwrap_or_default()
    }
}

struct ApplyAgentPatch(Arc<HostedThread>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    agent_id: codex_protocol::ThreadId,
    artifact_id: String,
}

impl<'call> ToolExecutor<ToolCall<'call>> for ApplyAgentPatch {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("apply_agent_patch")
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: "apply_agent_patch".into(),
            description: "Apply an owned child agent's durable patch to this agent's workspace using a three-way merge. Conflicts leave the workspace unchanged.".into(),
            strict: false,
            parameters: parse_tool_input_schema(&json!({
                "type": "object", "properties": {"agent_id": {"type": "string"}, "artifact_id": {"type": "string"}},
                "required": ["agent_id", "artifact_id"], "additionalProperties": false
            })).unwrap_or_else(|error| panic!("invalid hosted patch tool schema: {error}")),
            output_schema: None,
            defer_loading: None,
        })
    }

    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        'call: 'a,
    {
        Box::pin(async move {
            let ToolPayload::Function { arguments } = call.payload else {
                return Err(FunctionCallError::RespondToModel(
                    "expected patch arguments".into(),
                ));
            };
            let arguments: Arguments = serde_json::from_str(&arguments)
                .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
            if arguments.artifact_id.len() > codex_hosted_agent::MAX_OPAQUE_ID_BYTES {
                return Err(FunctionCallError::RespondToModel(
                    "artifact ID is too long".into(),
                ));
            }
            let result = self
                .0
                .apply_patch(arguments.agent_id, &arguments.artifact_id)
                .await
                .map_err(FunctionCallError::RespondToModel)?;
            let value = serde_json::to_value(result)
                .map_err(|error| FunctionCallError::Fatal(error.to_string()))?;
            Ok(Box::new(JsonToolOutput::new(value)) as Box<dyn ToolOutput>)
        })
    }
}
