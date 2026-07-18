use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use codex_tools::ToolExecutionDomainKind;
use codex_utils_path_uri::PathUri;

use crate::AgentCheckpoint;
use crate::AgentCheckpointRequest;
use crate::AgentPatchApplyRequest;
use crate::AgentPatchArtifact;
use crate::AgentPatchExportRequest;
use crate::AgentProvisionRequest;
use crate::AgentReconnectRequest;
use crate::AgentReleaseRequest;
use crate::AgentToolPolicy;
use crate::HostedAgentError;
use crate::HostedAgentErrorCategory;
use crate::HostedAgentService;
use crate::HostedEnvironmentConnection;
use crate::PatchApplyResult;
use crate::ProjectSnapshotSource;
use crate::ProvisionedAgent;
use crate::types::Result;

#[derive(Clone, Default)]
pub struct FakeHostedAgentService {
    state: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    next_environment_id: Option<String>,
    provisions: HashMap<String, (AgentProvisionRequest, ProvisionedAgent)>,
    leases: HashMap<String, Lease>,
    snapshots: HashMap<String, Snapshot>,
    reconnects: HashMap<String, (AgentReconnectRequest, ProvisionedAgent)>,
    checkpoints: HashMap<String, (AgentCheckpointRequest, AgentCheckpoint)>,
    checkpoint_failure: Option<HostedAgentError>,
    exports: HashMap<String, (AgentPatchExportRequest, AgentPatchArtifact)>,
    export_failure: Option<HostedAgentError>,
    artifacts: HashMap<String, AgentPatchArtifact>,
    applies: HashMap<String, (AgentPatchApplyRequest, PatchApplyResult)>,
    releases: HashMap<String, AgentReleaseRequest>,
    release_failure: Option<HostedAgentError>,
    conflicts: HashMap<String, Vec<PathUri>>,
}

#[derive(Clone)]
struct Lease {
    provisioned: ProvisionedAgent,
    latest_snapshot_id: String,
    released: bool,
}

#[derive(Clone)]
struct Snapshot {
    cwd: PathUri,
    workspace_roots: Vec<PathUri>,
}

impl FakeHostedAgentService {
    /// Overrides the environment ID returned by the next new provision request.
    pub fn set_next_environment_id(&self, environment_id: impl Into<String>) {
        self.lock().next_environment_id = Some(environment_id.into());
    }

    pub fn provisioned_lease_id(&self, idempotency_key: &str) -> Option<String> {
        self.lock()
            .provisions
            .get(idempotency_key)
            .map(|(_, provisioned)| provisioned.lease_id.clone())
    }

    /// Returns the request recorded for a provision idempotency key.
    pub fn provision_request(&self, idempotency_key: &str) -> Option<AgentProvisionRequest> {
        self.lock()
            .provisions
            .get(idempotency_key)
            .map(|(request, _)| request.clone())
    }

    pub fn set_patch_conflict(&self, artifact_id: impl Into<String>, paths: Vec<PathUri>) {
        self.lock().conflicts.insert(artifact_id.into(), paths);
    }

    pub fn clear_patch_conflict(&self, artifact_id: &str) {
        self.lock().conflicts.remove(artifact_id);
    }

    pub fn latest_snapshot_id(&self, lease_id: &str) -> Option<String> {
        self.lock()
            .leases
            .get(lease_id)
            .map(|lease| lease.latest_snapshot_id.clone())
    }

    pub fn active_lease_count(&self) -> usize {
        self.lock()
            .leases
            .values()
            .filter(|lease| !lease.released)
            .count()
    }

    pub fn provisioned_environment_ids(&self) -> Vec<String> {
        self.lock()
            .provisions
            .values()
            .map(|(_, provisioned)| provisioned.environment_id.clone())
            .collect()
    }

    /// Configures a service error returned before any checkpoint mutation.
    pub fn set_checkpoint_failure(&self, error: Option<HostedAgentError>) {
        self.lock().checkpoint_failure = error;
    }

    /// Configures a service error returned before any patch export mutation.
    pub fn set_export_failure(&self, error: Option<HostedAgentError>) {
        self.lock().export_failure = error;
    }

    /// Configures a service error returned before any release mutation.
    pub fn set_release_failure(&self, error: Option<HostedAgentError>) {
        self.lock().release_failure = error;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl State {
    fn id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}-{}", self.next_id)
    }

    fn active_lease(&self, lease_id: &str) -> Result<&Lease> {
        self.leases
            .get(lease_id)
            .filter(|lease| !lease.released)
            .ok_or_else(|| {
                HostedAgentError::new(
                    HostedAgentErrorCategory::LeaseMissing,
                    "lease is not active",
                )
            })
    }

    fn active_lease_mut(&mut self, lease_id: &str) -> Result<&mut Lease> {
        self.leases
            .get_mut(lease_id)
            .filter(|lease| !lease.released)
            .ok_or_else(|| {
                HostedAgentError::new(
                    HostedAgentErrorCategory::LeaseMissing,
                    "lease is not active",
                )
            })
    }
}

impl HostedAgentService for FakeHostedAgentService {
    async fn provision(&self, request: AgentProvisionRequest) -> Result<ProvisionedAgent> {
        let mut state = self.lock();
        if let Some((previous_request, provisioned)) =
            state.provisions.get(&request.idempotency_key)
        {
            return if previous_request == &request {
                Ok(provisioned.clone())
            } else {
                Err(HostedAgentError::invalid_response(
                    "idempotency key was reused with a different request",
                ))
            };
        }
        if request.sandbox_template.trim().is_empty() {
            return Err(HostedAgentError::new(
                HostedAgentErrorCategory::InvalidTemplate,
                "sandbox template is empty",
            ));
        }

        let source = match &request.source {
            ProjectSnapshotSource::RootWorkspace {
                cwd,
                workspace_roots,
            } => Snapshot {
                cwd: cwd.clone(),
                workspace_roots: workspace_roots.clone(),
            },
            ProjectSnapshotSource::AgentEnvironment { owner_lease_id } => {
                let owner = state.active_lease(owner_lease_id)?;
                state
                    .snapshots
                    .get(&owner.latest_snapshot_id)
                    .cloned()
                    .ok_or_else(|| {
                        HostedAgentError::new(
                            HostedAgentErrorCategory::SnapshotMissing,
                            "owner snapshot is missing",
                        )
                    })?
            }
            ProjectSnapshotSource::DurableSnapshot { snapshot_id } => {
                state.snapshots.get(snapshot_id).cloned().ok_or_else(|| {
                    HostedAgentError::new(
                        HostedAgentErrorCategory::SnapshotMissing,
                        "durable snapshot is missing",
                    )
                })?
            }
        };

        let lease_id = state.id("lease");
        let environment_id = state
            .next_environment_id
            .take()
            .unwrap_or_else(|| state.id("environment"));
        let base_snapshot_id = state.id("snapshot");
        state
            .snapshots
            .insert(base_snapshot_id.clone(), source.clone());
        let provisioned = ProvisionedAgent {
            lease_id: lease_id.clone(),
            environment_id: environment_id.clone(),
            connection: HostedEnvironmentConnection::try_new(format!(
                "wss://fake.invalid/{environment_id}?token=secret"
            ))?,
            cwd: source.cwd,
            workspace_roots: source.workspace_roots,
            base_snapshot_id: base_snapshot_id.clone(),
            tool_policy: AgentToolPolicy {
                allowed_domains: [
                    ToolExecutionDomainKind::AgentEnvironment,
                    ToolExecutionDomainKind::ControlPlane,
                ]
                .into_iter()
                .collect(),
                allowed_tools: Default::default(),
            },
        };
        state.leases.insert(
            lease_id,
            Lease {
                provisioned: provisioned.clone(),
                latest_snapshot_id: base_snapshot_id,
                released: false,
            },
        );
        state.provisions.insert(
            request.idempotency_key.clone(),
            (request, provisioned.clone()),
        );
        Ok(provisioned)
    }

    async fn reconnect(&self, request: AgentReconnectRequest) -> Result<ProvisionedAgent> {
        let mut state = self.lock();
        if let Some((previous_request, provisioned)) =
            state.reconnects.get(&request.idempotency_key)
        {
            return if previous_request == &request {
                Ok(provisioned.clone())
            } else {
                Err(HostedAgentError::invalid_response(
                    "idempotency key was reused with a different request",
                ))
            };
        }
        let provisioned = state.active_lease(&request.lease_id)?.provisioned.clone();
        state.reconnects.insert(
            request.idempotency_key.clone(),
            (request, provisioned.clone()),
        );
        Ok(provisioned)
    }

    async fn checkpoint(&self, request: AgentCheckpointRequest) -> Result<AgentCheckpoint> {
        let mut state = self.lock();
        if let Some(error) = &state.checkpoint_failure {
            return Err(error.clone());
        }
        if let Some((previous_request, checkpoint)) =
            state.checkpoints.get(&request.idempotency_key)
        {
            return if previous_request == &request {
                Ok(checkpoint.clone())
            } else {
                Err(HostedAgentError::invalid_response(
                    "idempotency key was reused with a different request",
                ))
            };
        }
        let lease = state.active_lease(&request.lease_id)?.clone();
        let source = state
            .snapshots
            .get(&lease.latest_snapshot_id)
            .cloned()
            .ok_or_else(|| {
                HostedAgentError::new(
                    HostedAgentErrorCategory::SnapshotMissing,
                    "lease snapshot is missing",
                )
            })?;
        let snapshot_id = state.id("snapshot");
        state.snapshots.insert(snapshot_id.clone(), source);
        state
            .active_lease_mut(&request.lease_id)?
            .latest_snapshot_id = snapshot_id.clone();
        let checkpoint = AgentCheckpoint { snapshot_id };
        state.checkpoints.insert(
            request.idempotency_key.clone(),
            (request, checkpoint.clone()),
        );
        Ok(checkpoint)
    }

    async fn export_patch(&self, request: AgentPatchExportRequest) -> Result<AgentPatchArtifact> {
        let mut state = self.lock();
        if let Some(error) = &state.export_failure {
            return Err(error.clone());
        }
        if let Some((previous_request, artifact)) = state.exports.get(&request.idempotency_key) {
            return if previous_request == &request {
                Ok(artifact.clone())
            } else {
                Err(HostedAgentError::invalid_response(
                    "idempotency key was reused with a different request",
                ))
            };
        }
        state.active_lease(&request.lease_id)?;
        if !state.snapshots.contains_key(&request.base_snapshot_id) {
            return Err(HostedAgentError::new(
                HostedAgentErrorCategory::SnapshotMissing,
                "base snapshot is missing",
            ));
        }
        let artifact_id = state.id("artifact");
        let artifact = AgentPatchArtifact {
            artifact_id: artifact_id.clone(),
            agent_id: request.agent_id,
            base_snapshot_id: request.base_snapshot_id.clone(),
            checksum: format!("fake-checksum-{artifact_id}"),
            changed_files: 0,
            size_bytes: 0,
        };
        state.artifacts.insert(artifact_id, artifact.clone());
        state
            .exports
            .insert(request.idempotency_key.clone(), (request, artifact.clone()));
        Ok(artifact)
    }

    async fn apply_patch(&self, request: AgentPatchApplyRequest) -> Result<PatchApplyResult> {
        let mut state = self.lock();
        if let Some((previous_request, result)) = state.applies.get(&request.idempotency_key) {
            return if previous_request == &request {
                Ok(result.clone())
            } else {
                Err(HostedAgentError::invalid_response(
                    "idempotency key was reused with a different request",
                ))
            };
        }
        state.active_lease(&request.target_lease_id)?;
        if !state.artifacts.contains_key(&request.artifact_id) {
            let result = PatchApplyResult::Rejected {
                reason: "artifact is missing".to_string(),
            };
            state
                .applies
                .insert(request.idempotency_key.clone(), (request, result.clone()));
            return Ok(result);
        }
        let result = match state.conflicts.get(&request.artifact_id) {
            Some(paths) => PatchApplyResult::Conflict {
                paths: paths.clone(),
            },
            None => {
                let snapshot_id = state.id("snapshot");
                let lease = state.active_lease(&request.target_lease_id)?.clone();
                let snapshot = state
                    .snapshots
                    .get(&lease.latest_snapshot_id)
                    .cloned()
                    .ok_or_else(|| {
                        HostedAgentError::new(
                            HostedAgentErrorCategory::SnapshotMissing,
                            "target snapshot is missing",
                        )
                    })?;
                state.snapshots.insert(snapshot_id.clone(), snapshot);
                let lease = state.active_lease_mut(&request.target_lease_id)?;
                lease.latest_snapshot_id = snapshot_id.clone();
                PatchApplyResult::Applied {
                    checkpoint: AgentCheckpoint { snapshot_id },
                }
            }
        };
        state
            .applies
            .insert(request.idempotency_key.clone(), (request, result.clone()));
        Ok(result)
    }

    async fn release(&self, request: AgentReleaseRequest) -> Result<()> {
        let mut state = self.lock();
        if let Some(error) = &state.release_failure {
            return Err(error.clone());
        }
        if let Some(previous_request) = state.releases.get(&request.idempotency_key) {
            return if previous_request == &request {
                Ok(())
            } else {
                Err(HostedAgentError::invalid_response(
                    "idempotency key was reused with a different request",
                ))
            };
        }
        let lease = state.leases.get_mut(&request.lease_id).ok_or_else(|| {
            HostedAgentError::new(HostedAgentErrorCategory::LeaseMissing, "lease is missing")
        })?;
        lease.released = true;
        state
            .releases
            .insert(request.idempotency_key.clone(), request);
        Ok(())
    }
}
