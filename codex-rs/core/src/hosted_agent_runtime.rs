use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use codex_exec_server::EnvironmentManager;
use codex_exec_server::ExecServerError;
use codex_hosted_agent::AgentProvisionRequest;
use codex_hosted_agent::AgentReleaseRequest;
use codex_hosted_agent::AgentToolPolicy;
use codex_hosted_agent::HostedAgentError;
use codex_hosted_agent::HostedAgentService;
use codex_hosted_agent::ProvisionedAgent;
use codex_protocol::protocol::TurnEnvironmentSelection;
use thiserror::Error;

const HOSTED_ENVIRONMENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Durable, non-secret state owned by one thread using a hosted environment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostedAgentRuntime {
    pub(crate) lease_id: String,
    pub(crate) environment_id: String,
    pub(crate) agent_type: String,
    pub(crate) sandbox_template: String,
    pub(crate) base_snapshot_id: String,
    pub(crate) latest_snapshot_id: String,
    pub(crate) tool_policy: AgentToolPolicy,
}

type HostedServiceFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, HostedAgentError>> + Send + 'a>>;

/// Object-safe bridge used to retain any hosted service implementation in the thread manager.
///
/// Implementations delegate to the public native-RPITIT service contract and must preserve its
/// idempotency and secret-handling guarantees.
trait ErasedHostedAgentService: Send + Sync {
    fn provision(
        &self,
        request: AgentProvisionRequest,
    ) -> HostedServiceFuture<'_, ProvisionedAgent>;

    fn release(&self, request: AgentReleaseRequest) -> HostedServiceFuture<'_, ()>;
}

impl<Service> ErasedHostedAgentService for Service
where
    Service: HostedAgentService,
{
    fn provision(
        &self,
        request: AgentProvisionRequest,
    ) -> HostedServiceFuture<'_, ProvisionedAgent> {
        Box::pin(HostedAgentService::provision(self, request))
    }

    fn release(&self, request: AgentReleaseRequest) -> HostedServiceFuture<'_, ()> {
        Box::pin(HostedAgentService::release(self, request))
    }
}

/// Coordinates hosted service leases with dynamic exec-server registrations.
pub(crate) struct HostedAgentProvisioner {
    service: Arc<dyn ErasedHostedAgentService>,
    environment_manager: Arc<EnvironmentManager>,
}

impl HostedAgentProvisioner {
    pub(crate) fn new<Service>(
        service: Arc<Service>,
        environment_manager: Arc<EnvironmentManager>,
    ) -> Self
    where
        Service: HostedAgentService + 'static,
    {
        Self {
            service,
            environment_manager,
        }
    }

    /// Provisions and registers one environment, returning a pending startup transaction.
    ///
    /// The caller must either commit after thread startup succeeds or roll back on failure.
    pub(crate) async fn provision(
        &self,
        request: AgentProvisionRequest,
    ) -> Result<PendingHostedAgentRuntime, HostedAgentRuntimeError> {
        let agent_type = request.agent_type.clone();
        let sandbox_template = request.sandbox_template.clone();
        let agent_id = request.agent_id;
        let provisioned = self
            .service
            .provision(request)
            .await
            .map_err(HostedAgentRuntimeError::Provision)?;
        let runtime = HostedAgentRuntime {
            lease_id: provisioned.lease_id,
            environment_id: provisioned.environment_id,
            agent_type,
            sandbox_template,
            base_snapshot_id: provisioned.base_snapshot_id.clone(),
            latest_snapshot_id: provisioned.base_snapshot_id,
            tool_policy: provisioned.tool_policy,
        };
        let environment_selection = TurnEnvironmentSelection {
            environment_id: runtime.environment_id.clone(),
            cwd: provisioned.cwd,
            workspace_roots: provisioned.workspace_roots,
        };

        if let Err(source) = provisioned.connection.register(
            self.environment_manager.as_ref(),
            runtime.environment_id.clone(),
            HOSTED_ENVIRONMENT_CONNECT_TIMEOUT,
        ) {
            let release_result = self
                .service
                .release(AgentReleaseRequest {
                    lease_id: runtime.lease_id.clone(),
                    idempotency_key: release_idempotency_key(agent_id, &runtime.lease_id),
                })
                .await;
            if let Err(release_error) = release_result {
                tracing::warn!(
                    error = %release_error,
                    agent_id = %agent_id,
                    "failed to release hosted lease after environment registration failed"
                );
            }
            return Err(HostedAgentRuntimeError::Register {
                environment_id: runtime.environment_id,
                source,
            });
        }

        Ok(PendingHostedAgentRuntime {
            agent_id,
            runtime,
            environment_selection,
            service: Arc::clone(&self.service),
            environment_manager: Arc::clone(&self.environment_manager),
        })
    }

    /// Unregisters and releases a runtime committed to a thread.
    pub(crate) async fn release(
        &self,
        agent_id: codex_protocol::ThreadId,
        runtime: HostedAgentRuntime,
    ) -> Result<(), HostedAgentRuntimeError> {
        cleanup_runtime(
            agent_id,
            runtime,
            self.environment_manager.as_ref(),
            self.service.as_ref(),
        )
        .await
    }
}

/// A registered lease that has not yet been committed to a successfully started thread.
pub(crate) struct PendingHostedAgentRuntime {
    agent_id: codex_protocol::ThreadId,
    runtime: HostedAgentRuntime,
    environment_selection: TurnEnvironmentSelection,
    service: Arc<dyn ErasedHostedAgentService>,
    environment_manager: Arc<EnvironmentManager>,
}

impl PendingHostedAgentRuntime {
    pub(crate) fn environment_selection(&self) -> &TurnEnvironmentSelection {
        &self.environment_selection
    }

    pub(crate) fn commit(self) -> HostedAgentRuntime {
        self.runtime
    }

    pub(crate) async fn rollback(self) -> Result<(), HostedAgentRuntimeError> {
        cleanup_runtime(
            self.agent_id,
            self.runtime,
            self.environment_manager.as_ref(),
            self.service.as_ref(),
        )
        .await
    }
}

#[derive(Debug, Error)]
pub(crate) enum HostedAgentRuntimeError {
    #[error("hosted-agent provisioning failed: {0}")]
    Provision(HostedAgentError),
    #[error("failed to register hosted environment `{environment_id}`: {source}")]
    Register {
        environment_id: String,
        #[source]
        source: ExecServerError,
    },
    #[error("failed to unregister hosted environment `{environment_id}`: {source}")]
    Unregister {
        environment_id: String,
        #[source]
        source: ExecServerError,
    },
    #[error("failed to release hosted-agent lease: {0}")]
    Release(HostedAgentError),
}

async fn cleanup_runtime(
    agent_id: codex_protocol::ThreadId,
    runtime: HostedAgentRuntime,
    environment_manager: &EnvironmentManager,
    service: &dyn ErasedHostedAgentService,
) -> Result<(), HostedAgentRuntimeError> {
    let release_idempotency_key = release_idempotency_key(agent_id, &runtime.lease_id);
    let unregister_result = environment_manager
        .remove_environment(&runtime.environment_id)
        .await;
    let release_result = service
        .release(AgentReleaseRequest {
            lease_id: runtime.lease_id,
            idempotency_key: release_idempotency_key,
        })
        .await;

    match (unregister_result, release_result) {
        (Err(source), _) => Err(HostedAgentRuntimeError::Unregister {
            environment_id: runtime.environment_id,
            source,
        }),
        (Ok(_), Err(error)) => Err(HostedAgentRuntimeError::Release(error)),
        (Ok(_), Ok(())) => Ok(()),
    }
}

fn release_idempotency_key(agent_id: codex_protocol::ThreadId, lease_id: &str) -> String {
    format!("hosted-agent:{agent_id}:lease:{lease_id}:release")
}

#[cfg(test)]
#[path = "hosted_agent_runtime_tests.rs"]
mod tests;
