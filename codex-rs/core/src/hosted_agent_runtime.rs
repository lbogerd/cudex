use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use codex_exec_server::EnvironmentManager;
use codex_exec_server::ExecServerError;
use codex_hosted_agent::AgentCheckpoint;
use codex_hosted_agent::AgentCheckpointRequest;
use codex_hosted_agent::AgentProvisionRequest;
use codex_hosted_agent::AgentReconnectRequest;
use codex_hosted_agent::AgentReleaseRequest;
use codex_hosted_agent::AgentToolPolicy;
use codex_hosted_agent::HostedAgentError;
use codex_hosted_agent::HostedAgentLifecycleState;
use codex_hosted_agent::HostedAgentRuntimeRecord;
use codex_hosted_agent::HostedAgentService;
use codex_hosted_agent::ProvisionedAgent;
use codex_protocol::protocol::TurnEnvironmentSelection;
use codex_tools::ToolExecutionDomain;
use codex_tools::ToolName;
use thiserror::Error;

const HOSTED_ENVIRONMENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Stable model-facing diagnostic for hosted service and authorization denials.
pub(crate) const HOSTED_EXTERNAL_SANDBOX_DENIAL_MESSAGE: &str =
    "external sandbox denied: operation rejected by the hosted environment";

/// Durable, non-secret state owned by one thread using a hosted environment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostedAgentRuntime {
    pub(crate) lease_id: String,
    pub(crate) environment_id: String,
    pub(crate) agent_type: String,
    pub(crate) sandbox_template: String,
    pub(crate) base_snapshot_id: String,
    pub(crate) latest_snapshot_id: Option<String>,
    pub(crate) last_exported_patch: Option<codex_hosted_agent::AgentPatchArtifact>,
    pub(crate) lifecycle_state: HostedAgentLifecycleState,
    pub(crate) tool_policy: AgentToolPolicy,
}

/// Immutable tool authorization returned with a hosted thread's lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostedToolAuthorization {
    environment_id: String,
    policy: AgentToolPolicy,
}

impl HostedToolAuthorization {
    pub(crate) fn new(environment_id: String, policy: AgentToolPolicy) -> Self {
        Self {
            environment_id,
            policy,
        }
    }

    pub(crate) fn allows(&self, tool_name: &ToolName, domain: &ToolExecutionDomain) -> bool {
        let environment_matches = match domain {
            ToolExecutionDomain::EnvironmentBoundMcp { environment_id, .. } => {
                environment_id == &self.environment_id
            }
            ToolExecutionDomain::AmbientMcp { .. } => false,
            ToolExecutionDomain::AgentEnvironment
            | ToolExecutionDomain::ControlPlane
            | ToolExecutionDomain::ProviderHosted
            | ToolExecutionDomain::ClientCallback
            | ToolExecutionDomain::Extension
            | ToolExecutionDomain::OrchestratorProcess => true,
        };
        environment_matches
            && self.policy.allowed_domains.contains(&domain.kind())
            && self.policy.allowed_tools.contains(tool_name)
    }
}

impl HostedAgentRuntime {
    pub(crate) fn durable_record(&self) -> HostedAgentRuntimeRecord {
        HostedAgentRuntimeRecord {
            agent_type: self.agent_type.clone(),
            sandbox_template: self.sandbox_template.clone(),
            lease_id: self.lease_id.clone(),
            environment_id: self.environment_id.clone(),
            base_snapshot_id: self.base_snapshot_id.clone(),
            latest_snapshot_id: self.latest_snapshot_id.clone(),
            last_exported_patch: self.last_exported_patch.clone(),
            lifecycle_state: self.lifecycle_state,
        }
    }
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

    fn reconnect(
        &self,
        request: AgentReconnectRequest,
    ) -> HostedServiceFuture<'_, ProvisionedAgent>;

    fn checkpoint(
        &self,
        request: AgentCheckpointRequest,
    ) -> HostedServiceFuture<'_, AgentCheckpoint>;

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

    fn reconnect(
        &self,
        request: AgentReconnectRequest,
    ) -> HostedServiceFuture<'_, ProvisionedAgent> {
        Box::pin(HostedAgentService::reconnect(self, request))
    }

    fn checkpoint(
        &self,
        request: AgentCheckpointRequest,
    ) -> HostedServiceFuture<'_, AgentCheckpoint> {
        Box::pin(HostedAgentService::checkpoint(self, request))
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
            latest_snapshot_id: Some(provisioned.base_snapshot_id),
            last_exported_patch: None,
            lifecycle_state: HostedAgentLifecycleState::Active,
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
            rollback: PendingRuntimeRollback::ReleaseLease,
        })
    }

    /// Reconnects an active lease, restoring it from its latest durable snapshot only when the
    /// service reports that the lease is missing.
    pub(crate) async fn reconnect_or_restore(
        &self,
        agent_id: codex_protocol::ThreadId,
        owner_agent_id: Option<codex_protocol::ThreadId>,
        record: HostedAgentRuntimeRecord,
    ) -> Result<PendingHostedAgentRuntime, HostedAgentRuntimeError> {
        let reconnect = self
            .service
            .reconnect(AgentReconnectRequest {
                lease_id: record.lease_id.clone(),
                idempotency_key: format!(
                    "hosted-agent:{agent_id}:lease:{}:reconnect",
                    record.lease_id
                ),
            })
            .await;
        let (provisioned, rollback) = match reconnect {
            Ok(provisioned) => {
                if provisioned.lease_id != record.lease_id {
                    return Err(HostedAgentRuntimeError::Reconnect(HostedAgentError::new(
                        codex_hosted_agent::HostedAgentErrorCategory::InvalidResponse,
                        "reconnect returned a different lease",
                    )));
                }
                (provisioned, PendingRuntimeRollback::KeepLease)
            }
            Err(error)
                if error.category == codex_hosted_agent::HostedAgentErrorCategory::LeaseMissing =>
            {
                let latest_snapshot_id = record.latest_snapshot_id.clone().ok_or_else(|| {
                    HostedAgentRuntimeError::RestoreUnavailable(
                        "hosted-agent runtime has no durable snapshot".to_string(),
                    )
                })?;
                let request = AgentProvisionRequest {
                    agent_id,
                    owner_agent_id,
                    agent_type: record.agent_type.clone(),
                    sandbox_template: record.sandbox_template.clone(),
                    source: codex_hosted_agent::ProjectSnapshotSource::DurableSnapshot {
                        snapshot_id: latest_snapshot_id.clone(),
                    },
                    idempotency_key: format!(
                        "hosted-agent:{agent_id}:snapshot:{latest_snapshot_id}:restore"
                    ),
                };
                (
                    self.service
                        .provision(request)
                        .await
                        .map_err(HostedAgentRuntimeError::Provision)?,
                    PendingRuntimeRollback::ReleaseLease,
                )
            }
            Err(error) => return Err(HostedAgentRuntimeError::Reconnect(error)),
        };
        let runtime = HostedAgentRuntime {
            lease_id: provisioned.lease_id,
            environment_id: provisioned.environment_id,
            agent_type: record.agent_type,
            sandbox_template: record.sandbox_template,
            base_snapshot_id: record.base_snapshot_id,
            latest_snapshot_id: record.latest_snapshot_id,
            last_exported_patch: record.last_exported_patch,
            lifecycle_state: record.lifecycle_state,
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
            if rollback == PendingRuntimeRollback::ReleaseLease {
                let _ = self
                    .service
                    .release(AgentReleaseRequest {
                        lease_id: runtime.lease_id.clone(),
                        idempotency_key: release_idempotency_key(agent_id, &runtime.lease_id),
                    })
                    .await;
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
            rollback,
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

    /// Creates a durable snapshot for one successfully completed turn.
    pub(crate) async fn checkpoint(
        &self,
        agent_id: codex_protocol::ThreadId,
        turn_id: &str,
        runtime: &HostedAgentRuntime,
    ) -> Result<AgentCheckpoint, HostedAgentRuntimeError> {
        self.service
            .checkpoint(AgentCheckpointRequest {
                lease_id: runtime.lease_id.clone(),
                idempotency_key: format!("hosted-agent:{agent_id}:turn:{turn_id}:checkpoint"),
            })
            .await
            .map_err(HostedAgentRuntimeError::Checkpoint)
    }
}

/// A registered lease that has not yet been committed to a successfully started thread.
pub(crate) struct PendingHostedAgentRuntime {
    agent_id: codex_protocol::ThreadId,
    runtime: HostedAgentRuntime,
    environment_selection: TurnEnvironmentSelection,
    service: Arc<dyn ErasedHostedAgentService>,
    environment_manager: Arc<EnvironmentManager>,
    rollback: PendingRuntimeRollback,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PendingRuntimeRollback {
    KeepLease,
    ReleaseLease,
}

impl PendingHostedAgentRuntime {
    pub(crate) fn environment_selection(&self) -> &TurnEnvironmentSelection {
        &self.environment_selection
    }

    pub(crate) fn tool_authorization(&self) -> HostedToolAuthorization {
        HostedToolAuthorization::new(
            self.runtime.environment_id.clone(),
            self.runtime.tool_policy.clone(),
        )
    }

    pub(crate) fn commit(self) -> HostedAgentRuntime {
        self.runtime
    }

    pub(crate) fn durable_record(&self) -> HostedAgentRuntimeRecord {
        self.runtime.durable_record()
    }

    pub(crate) async fn rollback(self) -> Result<(), HostedAgentRuntimeError> {
        match self.rollback {
            PendingRuntimeRollback::KeepLease => self
                .environment_manager
                .remove_environment(&self.runtime.environment_id)
                .await
                .map(|_| ())
                .map_err(|source| HostedAgentRuntimeError::Unregister {
                    environment_id: self.runtime.environment_id,
                    source,
                }),
            PendingRuntimeRollback::ReleaseLease => {
                cleanup_runtime(
                    self.agent_id,
                    self.runtime,
                    self.environment_manager.as_ref(),
                    self.service.as_ref(),
                )
                .await
            }
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum HostedAgentRuntimeError {
    #[error("hosted-agent provisioning failed: {0}")]
    Provision(HostedAgentError),
    #[error("hosted-agent reconnect failed: {0}")]
    Reconnect(HostedAgentError),
    #[error("hosted-agent restore unavailable: {0}")]
    RestoreUnavailable(String),
    #[error("failed to register hosted environment `{environment_id}`: {source}")]
    Register {
        environment_id: String,
        #[source]
        source: ExecServerError,
    },
    #[error("failed to checkpoint hosted-agent lease: {0}")]
    Checkpoint(HostedAgentError),
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
