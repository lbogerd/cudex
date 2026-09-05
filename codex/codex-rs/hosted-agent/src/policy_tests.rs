use super::*;
use codex_utils_path_uri::PathUri;

#[tokio::test]
async fn default_namespaces_match_but_custom_namespaces_domains_and_revocation_are_fenced() {
    let id = ThreadId::new();
    let service = FakeHostedAgentService::default();
    let mut provisioned = service
        .provision(AgentProvisionRequest {
            agent_id: id,
            owner_agent_id: None,
            agent_type: "root".into(),
            sandbox_template: "template".into(),
            idempotency_key: "policy".into(),
            source: ProjectSnapshotSource::RootWorkspace {
                cwd: PathUri::parse("file:///workspace").expect("cwd"),
                workspace_roots: vec![PathUri::parse("file:///workspace").expect("root")],
            },
        })
        .await
        .expect("provision");
    provisioned.tool_policy.allowed_tools = [
        ToolName::plain("exec_command"),
        ToolName::namespaced("collaboration", "spawn_agent"),
    ]
    .into();
    provisioned.tool_policy.allowed_domains = [
        ToolExecutionDomainKind::AgentEnvironment,
        ToolExecutionDomainKind::ControlPlane,
        ToolExecutionDomainKind::OrchestratorProcess,
        ToolExecutionDomainKind::EnvironmentBoundCodeMode,
    ]
    .into();
    let binding = RuntimeBinding {
        agent_id: id,
        owner_agent_id: None,
        provisioned,
        active: AtomicBool::new(true),
        session_guard: Mutex::new(None),
    };
    for name in [
        ToolName::plain("exec_command"),
        ToolName::namespaced("functions", "exec_command"),
    ] {
        assert!(binding.authorize(&name, ToolExecutionDomainKind::AgentEnvironment));
        assert!(!binding.authorize(&name, ToolExecutionDomainKind::OrchestratorProcess));
    }
    assert!(!binding.authorize(
        &ToolName::namespaced("untrusted", "exec_command"),
        ToolExecutionDomainKind::AgentEnvironment
    ));
    assert!(binding.authorize(
        &ToolName::namespaced("collaboration", "spawn_agent"),
        ToolExecutionDomainKind::ControlPlane
    ));
    assert!(!binding.authorize(
        &ToolName::plain("spawn_agent"),
        ToolExecutionDomainKind::ControlPlane
    ));
    assert!(!binding.authorize_domain(
        &ToolName::plain("exec_command"),
        &ToolExecutionDomain::EnvironmentBoundCodeMode {
            environment_id: "another-environment".into(),
        }
    ));
    binding.active.store(false, Ordering::Release);
    assert!(!binding.authorize(
        &ToolName::plain("exec_command"),
        ToolExecutionDomainKind::AgentEnvironment
    ));
}
