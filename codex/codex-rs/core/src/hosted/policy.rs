use codex_hosted_agent::ToolExecutionDomainKind;

use crate::function_tool::FunctionCallError;
use crate::tools::context::ToolInvocation;

use super::HostedThread;

/// The service allowlist is necessary but not sufficient: only audited runtime
/// locations may execute. New upstream tools remain denied until classified.
pub(crate) fn authorize(invocation: &ToolInvocation) -> Result<(), FunctionCallError> {
    let Some(hosted) = invocation
        .session
        .services
        .thread_extension_data
        .get::<HostedThread>()
    else {
        return Ok(());
    };
    let denied = || {
        FunctionCallError::RespondToModel(
            "external sandbox denied: operation rejected by the hosted environment".into(),
        )
    };
    let selections = invocation.step_context.environments.to_selections();
    let provisioned = &hosted.binding.provisioned;
    let identity = hosted.code_mode.identity();
    if identity.lease_id != provisioned.lease_id
        || identity.environment_id != provisioned.environment_id
        || identity.connection_generation != provisioned.connection_generation
    {
        return Err(denied());
    }
    if let crate::tools::context::ToolPayload::Function { arguments } = &invocation.payload {
        let arguments: serde_json::Value = serde_json::from_str(arguments).map_err(|_| denied())?;
        if let Some(id) = arguments
            .get("environment_id")
            .or_else(|| arguments.get("environmentId"))
            && !id.is_null()
            && id.as_str() != Some(provisioned.environment_id.as_str())
        {
            return Err(denied());
        }
    }
    if !hosted.active.load(std::sync::atomic::Ordering::Acquire)
        || selections.len() != 1
        || selections[0].environment_id != provisioned.environment_id
        || selections[0].cwd != provisioned.cwd
        || selections[0].workspace_roots != provisioned.workspace_roots
    {
        return Err(denied());
    }
    let name = &invocation.tool_name;
    let domain = if name.is_default_namespace() {
        match name.name.as_str() {
            "exec_command" | "write_stdin" | "shell" | "shell_command" | "apply_patch"
            | "view_image" => ToolExecutionDomainKind::AgentEnvironment,
            "exec" | "wait" => ToolExecutionDomainKind::EnvironmentBoundCodeMode,
            "apply_agent_patch" | "update_plan" => ToolExecutionDomainKind::ControlPlane,
            _ => return Err(denied()),
        }
    } else if name.namespace.as_deref() == Some("collaboration") {
        match name.name.as_str() {
            "spawn_agent" | "send_message" | "wait_agent" | "close_agent" | "resume_agent"
            | "list_agents" | "followup_task" | "interrupt_agent" => {
                ToolExecutionDomainKind::ControlPlane
            }
            _ => return Err(denied()),
        }
    } else {
        return Err(denied());
    };
    if hosted.binding.authorize(name, domain) {
        Ok(())
    } else {
        Err(denied())
    }
}
