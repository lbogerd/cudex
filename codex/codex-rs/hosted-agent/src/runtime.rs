//! Hosted lifecycle coordination, independent of Codex turns and upstream SQLite.
//!
//! Callers must quiesce workspace-mutating execution before capture/finalization.
//! The identity-bound code-mode host may remain alive: its delegated mutations
//! are independently fenced by the service interaction ledger. No local fallback
//! exists here: failures leave replayable journal entries rather than success.
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use codex_protocol::ThreadId;
use codex_protocol::ToolName;
use tokio::sync::Semaphore;

use crate::store::Journal;
use crate::store::Store;
use crate::store::failure;
use crate::types::Result;
use crate::*;

#[derive(Clone, Debug)]
pub struct PrepareRequest {
    pub agent_id: ThreadId,
    pub owner_agent_id: Option<ThreadId>,
    pub agent_type: String,
    pub sandbox_template: String,
    pub source: ProjectSnapshotSource,
}

/// Immutable policy and connection identity for exactly one environment binding.
#[derive(Debug)]
pub struct RuntimeBinding {
    pub agent_id: ThreadId,
    pub owner_agent_id: Option<ThreadId>,
    pub provisioned: ProvisionedAgent,
    // Held while the binding is active, released on revocation even if a retired
    // session still holds an Arc. Another app-server cannot rotate a live lease.
    session_guard: Mutex<Option<std::fs::File>>,
    active: AtomicBool,
}

impl RuntimeBinding {
    pub fn authorize(&self, name: &ToolName, domain: ToolExecutionDomainKind) -> bool {
        self.active.load(Ordering::Acquire)
            && !matches!(
                domain,
                ToolExecutionDomainKind::OrchestratorProcess
                    | ToolExecutionDomainKind::AmbientMcp
                    | ToolExecutionDomainKind::ClientCallback
                    | ToolExecutionDomainKind::Extension
            )
            && self
                .provisioned
                .tool_policy
                .allowed_domains
                .contains(&domain)
            && self
                .provisioned
                .tool_policy
                .allowed_tools
                .iter()
                .any(|allowed| {
                    allowed.name == name.name
                        && (allowed.namespace == name.namespace
                            || (allowed.is_default_namespace() && name.is_default_namespace()))
                })
    }

    /// Full-domain authorization additionally fences nested remote calls against
    /// being redirected into another registered environment.
    pub fn authorize_domain(&self, name: &ToolName, domain: &ToolExecutionDomain) -> bool {
        let environment_matches = match domain {
            ToolExecutionDomain::EnvironmentBoundMcp { environment_id, .. }
            | ToolExecutionDomain::EnvironmentBoundCodeMode { environment_id } => {
                environment_id == &self.provisioned.environment_id
            }
            _ => true,
        };
        environment_matches && self.authorize(name, domain.kind())
    }
}

pub struct HostedRuntimeManager<S = HttpHostedAgentService> {
    pub(super) service: S,
    pub(super) store: Store,
    locks: Mutex<HashMap<ThreadId, Arc<Semaphore>>>,
    bindings: Mutex<HashMap<ThreadId, Arc<RuntimeBinding>>>,
}

impl HostedRuntimeManager {
    pub fn from_config(service_url: &str, state_dir: &Path) -> Result<Self> {
        Self::with_service(HttpHostedAgentService::from_env(service_url)?, state_dir)
    }
}

impl<S: HostedAgentService> HostedRuntimeManager<S> {
    pub fn with_service(service: S, state_dir: &Path) -> Result<Self> {
        let store = Store::open(state_dir, &service.state_scope())?;
        Ok(Self {
            service,
            store,
            locks: Mutex::new(HashMap::new()),
            bindings: Mutex::new(HashMap::new()),
        })
    }

    pub(super) fn lock_for(&self, id: ThreadId) -> Arc<Semaphore> {
        self.locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(id)
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone()
    }

    pub fn binding(&self, id: ThreadId) -> Option<Arc<RuntimeBinding>> {
        self.bindings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&id)
            .cloned()
    }

    pub(super) fn forget(&self, id: ThreadId) {
        if let Some(binding) = self
            .bindings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id)
        {
            binding.active.store(false, Ordering::Release);
            binding
                .session_guard
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
        }
    }

    pub fn record(&self, id: ThreadId) -> Result<Option<HostedAgentRuntimeRecord>> {
        Ok(self.store.read(id)?.and_then(|journal| journal.record))
    }

    pub(super) fn journal(&self, id: ThreadId) -> Result<Journal> {
        self.store
            .read(id)?
            .filter(|j| !j.deleted)
            .ok_or_else(|| failure("hosted thread is unavailable or deleted"))
    }

    pub(super) fn begin(&self, journal: &mut Journal, operation: &str) -> Result<String> {
        if let Some(pending) = &journal.pending {
            if pending != operation {
                return Err(failure("another hosted operation requires recovery"));
            }
        } else {
            journal.sequence = journal
                .sequence
                .checked_add(1)
                .ok_or_else(|| failure("hosted operation sequence exhausted"))?;
            journal.pending = Some(operation.to_string());
            self.store.write(journal)?;
        }
        Ok(format!(
            "cudex-{}-{}",
            journal.request.agent_id, journal.sequence
        ))
    }

    pub(super) fn finish(&self, journal: &mut Journal) -> Result<()> {
        journal.pending = None;
        self.store.write(journal)
    }

    pub fn source_for_child(&self, owner: ThreadId) -> Result<ProjectSnapshotSource> {
        let journal = self.journal(owner)?;
        let record = journal
            .record
            .ok_or_else(|| failure("owner provisioning is incomplete"))?;
        if journal.deleting || record.lifecycle_state != HostedAgentLifecycleState::Active {
            return Err(failure("owner is not active"));
        }
        Ok(ProjectSnapshotSource::AgentEnvironment {
            owner_lease_id: record.lease_id,
        })
    }

    pub async fn prepare(&self, request: PrepareRequest) -> Result<Arc<RuntimeBinding>> {
        let id = request.agent_id;
        let mutex = self.lock_for(id);
        let _guard = mutex
            .acquire_owned()
            .await
            .map_err(|_| failure("hosted operation gate closed"))?;
        let _file = self.store.lock(id)?;
        let mut journal = match self.store.read(id)? {
            Some(journal) => {
                if journal.deleted
                    || journal.deleting
                    || journal.request.owner_agent_id != request.owner_agent_id
                    || journal.request.agent_type != request.agent_type
                    || journal.request.sandbox_template != request.sandbox_template
                    || (request.owner_agent_id.is_none()
                        && journal.request.source != request.source)
                {
                    return Err(failure(
                        "hosted resume identity does not match its durable owner, role, or source",
                    ));
                }
                journal
            }
            None => {
                if let Some(owner) = request.owner_agent_id {
                    let expected = self.source_for_child(owner)?;
                    if request.source != expected {
                        return Err(failure("child source does not match its owner"));
                    }
                } else if matches!(
                    request.source,
                    ProjectSnapshotSource::AgentEnvironment { .. }
                ) {
                    return Err(failure("root cannot inherit an unowned environment"));
                }
                let journal = Journal {
                    version: 1,
                    request: AgentProvisionRequest {
                        agent_id: id,
                        owner_agent_id: request.owner_agent_id,
                        agent_type: request.agent_type,
                        sandbox_template: request.sandbox_template,
                        source: request.source,
                        idempotency_key: format!("cudex-provision-{id}"),
                    },
                    record: None,
                    binding_identity: None,
                    sequence: 0,
                    pending: None,
                    finalization: None,
                    completion_mode: crate::store::CompletionMode::Finalize,
                    handoff_snapshot_id: None,
                    deleting: false,
                    deleted: false,
                };
                self.store.write(&journal)?;
                journal
            }
        };
        if journal.handoff_snapshot_id.take().is_some() {
            self.store.write(&journal)?;
        }
        if journal.pending.as_deref() == Some("retain") {
            self.retain(&mut journal).await?;
        }
        if let Some(binding) = self.binding(id)
            && journal.pending.is_none()
            && journal
                .record
                .as_ref()
                .is_some_and(|r| r.lifecycle_state == HostedAgentLifecycleState::Active)
        {
            return Ok(binding);
        }
        let session_guard = self.store.session_lock(id)?;
        if journal.finalization.is_some() {
            self.finalize_locked(&mut journal).await?;
        }
        if journal.pending.as_deref() == Some("checkpoint") {
            self.capture(&mut journal).await?;
            self.retain(&mut journal).await?;
        }
        if let Some(artifact) = journal
            .pending
            .as_deref()
            .and_then(|op| op.strip_prefix("apply:"))
            .map(str::to_owned)
        {
            self.apply_locked(&mut journal, &artifact).await?;
        }
        let provisioned = if let Some(record) = &journal.record {
            if matches!(
                record.lifecycle_state,
                HostedAgentLifecycleState::PendingFinalization
                    | HostedAgentLifecycleState::ReleasePending
            ) {
                return Err(failure(
                    "hosted thread requires finalization or cleanup before resume",
                ));
            }
            let lease_id = record.lease_id.clone();
            if record.lifecycle_state == HostedAgentLifecycleState::Released
                || journal.pending.as_deref() == Some("restore")
            {
                self.restore(&mut journal).await?
            } else {
                let key = self.begin(&mut journal, "reconnect")?;
                match self
                    .service
                    .reconnect(AgentReconnectRequest {
                        lease_id,
                        idempotency_key: key,
                    })
                    .await
                {
                    Ok(value) => {
                        let record = live_record(&journal)?;
                        let identity = journal.binding_identity.as_ref().ok_or_else(|| {
                            failure("hosted journal has no immutable binding identity; explicit migration is required")
                        })?;
                        if value.lease_id != record.lease_id
                            || value.environment_id != record.environment_id
                            || value.connection_generation < record.connection_generation
                            || value.cwd != identity.cwd
                            || value.workspace_roots != identity.workspace_roots
                            || value.base_snapshot_id != identity.base_snapshot_id
                        {
                            return Err(failure(
                                "hosted reconnect changed durable environment identity",
                            ));
                        }
                        value
                    }
                    Err(error) if error.category == HostedAgentErrorCategory::LeaseMissing => {
                        // Only definitive missing-lease responses allow replacement. A
                        // transient network failure must not allocate a second sandbox.
                        journal.pending = None;
                        live_record_mut(&mut journal)?.lifecycle_state =
                            HostedAgentLifecycleState::Released;
                        self.store.write(&journal)?;
                        self.restore(&mut journal).await?
                    }
                    Err(error) => return Err(error),
                }
            }
        } else {
            self.service.provision(journal.request.clone()).await?
        };
        validate_binding(&provisioned)?;
        if self
            .bindings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .any(|(other, b)| {
                *other != id
                    && (b.provisioned.environment_id == provisioned.environment_id
                        || b.provisioned.lease_id == provisioned.lease_id)
            })
        {
            return Err(failure(
                "hosting service reused another agent's environment",
            ));
        }
        journal.binding_identity = Some(crate::store::BindingIdentity {
            cwd: provisioned.cwd.clone(),
            workspace_roots: provisioned.workspace_roots.clone(),
            base_snapshot_id: provisioned.base_snapshot_id.clone(),
        });
        journal.record = Some(HostedAgentRuntimeRecord {
            owner_agent_id: journal.request.owner_agent_id,
            agent_type: journal.request.agent_type.clone(),
            sandbox_template: journal.request.sandbox_template.clone(),
            lease_id: provisioned.lease_id.clone(),
            environment_id: provisioned.environment_id.clone(),
            connection_generation: provisioned.connection_generation,
            base_snapshot_id: journal
                .record
                .as_ref()
                .map(|r| r.base_snapshot_id.clone())
                .unwrap_or_else(|| provisioned.base_snapshot_id.clone()),
            latest_snapshot_id: journal
                .record
                .as_ref()
                .filter(|r| r.lease_id == provisioned.lease_id)
                .and_then(|r| r.latest_snapshot_id.clone())
                .or_else(|| Some(provisioned.base_snapshot_id.clone())),
            last_exported_patch: journal
                .record
                .as_ref()
                .and_then(|r| r.last_exported_patch.clone()),
            reference_revision: journal.record.as_ref().and_then(|r| r.reference_revision),
            lifecycle_state: HostedAgentLifecycleState::Active,
        });
        self.finish(&mut journal)?;
        self.retain(&mut journal).await?;
        let binding = Arc::new(RuntimeBinding {
            agent_id: id,
            owner_agent_id: journal.request.owner_agent_id,
            provisioned,
            session_guard: Mutex::new(Some(session_guard)),
            active: AtomicBool::new(true),
        });
        self.bindings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id, Arc::clone(&binding));
        Ok(binding)
    }

    pub(super) async fn restore(&self, journal: &mut Journal) -> Result<ProvisionedAgent> {
        let record = live_record(journal)?;
        let snapshot_id = record
            .latest_snapshot_id
            .clone()
            .ok_or_else(|| failure("hosted runtime has no durable restore snapshot"))?;
        let old_lease = record.lease_id.clone();
        let old_environment = record.environment_id.clone();
        let idempotency_key = self.begin(journal, "restore")?;
        let value = self
            .service
            .provision(AgentProvisionRequest {
                source: ProjectSnapshotSource::DurableSnapshot { snapshot_id },
                idempotency_key,
                ..journal.request.clone()
            })
            .await?;
        if value.lease_id == old_lease || value.environment_id == old_environment {
            return Err(failure("restored runtime reused the retired environment"));
        }
        Ok(value)
    }
}

pub(super) fn live_record(journal: &Journal) -> Result<&HostedAgentRuntimeRecord> {
    journal
        .record
        .as_ref()
        .ok_or_else(|| failure("hosted provisioning is incomplete"))
}
pub(super) fn live_record_mut(journal: &mut Journal) -> Result<&mut HostedAgentRuntimeRecord> {
    journal
        .record
        .as_mut()
        .ok_or_else(|| failure("hosted provisioning is incomplete"))
}
pub(super) fn ensure_active(journal: &Journal) -> Result<()> {
    if journal.deleting
        || live_record(journal)?.lifecycle_state != HostedAgentLifecycleState::Active
    {
        return Err(failure("hosted runtime is not active"));
    }
    Ok(())
}
pub(super) fn validate_binding(value: &ProvisionedAgent) -> Result<()> {
    value.connection.validate()?;
    if [
        &value.lease_id,
        &value.environment_id,
        &value.base_snapshot_id,
    ]
    .iter()
    .any(|id| id.trim().is_empty() || id.len() > MAX_OPAQUE_ID_BYTES)
        || value.workspace_roots.is_empty()
        || value.workspace_roots.len() > 8
        || !value
            .workspace_roots
            .iter()
            .any(|root| value.cwd.starts_with(root))
        || value
            .workspace_roots
            .iter()
            .any(|root| root.to_url().scheme() != "file")
    {
        return Err(failure(
            "hosting service returned invalid environment identity",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod policy_tests;
