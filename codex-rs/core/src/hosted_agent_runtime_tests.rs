use std::sync::Arc;

use codex_exec_server::EnvironmentManager;
use codex_hosted_agent::AgentProvisionRequest;
use codex_hosted_agent::AgentReconnectRequest;
use codex_hosted_agent::FakeHostedAgentService;
use codex_hosted_agent::HostedAgentService;
use codex_hosted_agent::ProjectSnapshotSource;
use codex_protocol::ThreadId;
use codex_utils_path_uri::PathUri;
use pretty_assertions::assert_eq;

use super::HostedAgentProvisioner;

fn request(agent_id: ThreadId) -> AgentProvisionRequest {
    AgentProvisionRequest {
        agent_id,
        owner_agent_id: None,
        agent_type: "default".to_string(),
        sandbox_template: "general-v1".to_string(),
        source: ProjectSnapshotSource::RootWorkspace {
            cwd: PathUri::parse("file:///workspace").expect("valid cwd URI"),
            workspace_roots: vec![
                PathUri::parse("file:///workspace").expect("valid workspace root URI"),
            ],
        },
        idempotency_key: format!("hosted-agent:{agent_id}:provision"),
    }
}

#[tokio::test]
async fn provision_registers_exactly_one_pending_environment() {
    let service = Arc::new(FakeHostedAgentService::default());
    let environment_manager = Arc::new(EnvironmentManager::without_environments());
    let provisioner =
        HostedAgentProvisioner::new(Arc::clone(&service), Arc::clone(&environment_manager));
    let agent_id = ThreadId::new();

    let pending = provisioner
        .provision(request(agent_id))
        .await
        .expect("provision hosted runtime");
    let environment_id = pending.environment_selection().environment_id.clone();
    assert_eq!(
        environment_manager.default_environment_ids(),
        Vec::<String>::new()
    );
    assert!(
        environment_manager
            .get_environment(&environment_id)
            .is_some()
    );
    assert_eq!(
        pending.environment_selection().workspace_roots,
        vec![PathUri::parse("file:///workspace").expect("valid workspace root URI")]
    );

    let runtime = pending.commit();
    assert_eq!(runtime.environment_id, environment_id);
    assert_eq!(runtime.agent_type, "default");
    assert_eq!(runtime.sandbox_template, "general-v1");
    assert_eq!(runtime.latest_snapshot_id, runtime.base_snapshot_id);
}

#[tokio::test]
async fn rollback_unregisters_environment_and_releases_lease() {
    let service = Arc::new(FakeHostedAgentService::default());
    let environment_manager = Arc::new(EnvironmentManager::without_environments());
    let provisioner =
        HostedAgentProvisioner::new(Arc::clone(&service), Arc::clone(&environment_manager));
    let agent_id = ThreadId::new();
    let pending = provisioner
        .provision(request(agent_id))
        .await
        .expect("provision hosted runtime");
    let environment_id = pending.environment_selection().environment_id.clone();
    let lease_id = pending.runtime.lease_id.clone();

    pending.rollback().await.expect("roll back hosted runtime");

    assert!(
        environment_manager
            .get_environment(&environment_id)
            .is_none()
    );
    let reconnect_error = service
        .reconnect(AgentReconnectRequest {
            lease_id,
            idempotency_key: format!("hosted-agent:{agent_id}:reconnect-after-rollback"),
        })
        .await
        .expect_err("released lease must not reconnect");
    assert_eq!(
        reconnect_error.message(),
        "lease is not active",
        "rollback must release the remote lease"
    );
}

#[tokio::test]
async fn registration_collision_releases_new_lease_without_replacing_environment() {
    let environment_manager = Arc::new(EnvironmentManager::without_environments());
    environment_manager
        .register_environment(
            "collision".to_string(),
            "wss://existing.invalid/connection".to_string(),
            None,
        )
        .expect("register existing environment");
    let existing_environment = environment_manager
        .get_environment("collision")
        .expect("existing environment");
    let service = Arc::new(FakeHostedAgentService::default());
    service.set_next_environment_id("collision");
    let provisioner =
        HostedAgentProvisioner::new(Arc::clone(&service), Arc::clone(&environment_manager));
    let agent_id = ThreadId::new();
    let request = request(agent_id);
    let provision_key = request.idempotency_key.clone();
    let error = match provisioner.provision(request).await {
        Ok(_) => panic!("duplicate registration must fail"),
        Err(error) => error,
    };

    assert_eq!(
        error.to_string(),
        "failed to register hosted environment `collision`: exec-server protocol error: environment `collision` is already registered"
    );
    assert!(Arc::ptr_eq(
        &existing_environment,
        &environment_manager
            .get_environment("collision")
            .expect("existing environment must remain registered")
    ));
    let lease_id = service
        .provisioned_lease_id(&provision_key)
        .expect("provisioned lease ID");
    service
        .reconnect(AgentReconnectRequest {
            lease_id,
            idempotency_key: format!("hosted-agent:{agent_id}:collision-reconnect"),
        })
        .await
        .expect_err("registration collision must release the new lease");
}
