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
use crate::AgentRetention;
use crate::AgentRetentionRequest;
use crate::AgentToolPolicy;
use crate::HostedAgentError;
use crate::HostedAgentErrorCategory;
use crate::HostedAgentService;
use crate::HostedEnvironmentConnection;
use crate::PatchApplyResult;
use crate::ProjectSnapshotSource;
use crate::ProvisionedAgent;
use crate::types::Result;

const MAX_FAKE_FILES: usize = 1_024;
const MAX_FAKE_FILE_BYTES: usize = 1024 * 1024;
const MAX_FAKE_TOTAL_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct FakeHostedAgentService {
    state: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    next_environment_id: Option<String>,
    provision_failure: Option<HostedAgentError>,
    provisions: HashMap<String, (AgentProvisionRequest, ProvisionedAgent)>,
    leases: HashMap<String, Lease>,
    snapshots: HashMap<String, Snapshot>,
    reconnects: HashMap<String, (AgentReconnectRequest, ProvisionedAgent)>,
    checkpoints: HashMap<String, (AgentCheckpointRequest, AgentCheckpoint)>,
    checkpoint_failure: Option<HostedAgentError>,
    exports: HashMap<String, (AgentPatchExportRequest, AgentPatchArtifact)>,
    export_failure: Option<HostedAgentError>,
    artifacts: HashMap<String, Artifact>,
    applies: HashMap<String, (AgentPatchApplyRequest, PatchApplyResult)>,
    retained: HashMap<String, RetainedState>,
    releases: HashMap<String, AgentReleaseRequest>,
    release_failure: Option<HostedAgentError>,
    conflicts: HashMap<String, Vec<PathUri>>,
    source_snapshots: HashMap<(String, String), Snapshot>,
}

#[derive(Clone)]
struct Lease {
    provisioned: ProvisionedAgent,
    latest_snapshot_id: String,
    files: HashMap<PathUri, Vec<u8>>,
    released: bool,
}

#[derive(Clone)]
struct Snapshot {
    cwd: PathUri,
    workspace_roots: Vec<PathUri>,
    files: HashMap<PathUri, Vec<u8>>,
}

#[derive(Clone)]
struct Artifact {
    metadata: AgentPatchArtifact,
    changes: Vec<FileChange>,
}

#[derive(Clone)]
struct RetainedState {
    request: AgentRetentionRequest,
    revision: u64,
}

#[derive(Clone)]
struct FileChange {
    path: PathUri,
    base: Option<Vec<u8>>,
    current: Option<Vec<u8>>,
}

impl FakeHostedAgentService {
    /// Overrides the environment ID returned by the next new provision request.
    pub fn set_next_environment_id(&self, environment_id: impl Into<String>) {
        self.lock().next_environment_id = Some(environment_id.into());
    }

    /// Configures a service error returned before any provisioning mutation.
    pub fn set_provision_failure(&self, error: Option<HostedAgentError>) {
        self.lock().provision_failure = error;
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

    pub fn register_source_snapshot(
        &self,
        source_snapshot_id: impl Into<String>,
        checksum: impl Into<String>,
        cwd: PathUri,
        workspace_roots: Vec<PathUri>,
    ) {
        self.lock().source_snapshots.insert(
            (source_snapshot_id.into(), checksum.into()),
            Snapshot {
                cwd,
                workspace_roots,
                files: HashMap::new(),
            },
        );
    }

    pub fn set_patch_conflict(&self, artifact_id: impl Into<String>, paths: Vec<PathUri>) {
        self.lock().conflicts.insert(artifact_id.into(), paths);
    }

    pub fn clear_patch_conflict(&self, artifact_id: &str) {
        self.lock().conflicts.remove(artifact_id);
    }

    /// Registers durable patch metadata for lifecycle recovery tests.
    pub fn register_patch_artifact(&self, artifact: AgentPatchArtifact) {
        self.lock().artifacts.insert(
            artifact.artifact_id.clone(),
            Artifact {
                metadata: artifact,
                changes: Vec::new(),
            },
        );
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

    /// Replaces one file in an active fake lease's mutable sandbox state.
    pub fn write_lease_file(
        &self,
        lease_id: &str,
        path: PathUri,
        contents: impl Into<Vec<u8>>,
    ) -> Result<()> {
        let contents = contents.into();
        let mut state = self.lock();
        let lease = state.active_lease_mut(lease_id)?;
        validate_fake_file_write(&lease.files, &path, contents.len())?;
        lease.files.insert(path, contents);
        Ok(())
    }

    /// Removes one file from an active fake lease's mutable sandbox state.
    pub fn remove_lease_file(&self, lease_id: &str, path: &PathUri) -> Result<()> {
        self.lock().active_lease_mut(lease_id)?.files.remove(path);
        Ok(())
    }

    /// Reads one file from an active fake lease's mutable sandbox state.
    pub fn read_lease_file(&self, lease_id: &str, path: &PathUri) -> Result<Option<Vec<u8>>> {
        Ok(self.lock().active_lease(lease_id)?.files.get(path).cloned())
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

fn validate_fake_file_write(
    files: &HashMap<PathUri, Vec<u8>>,
    path: &PathUri,
    content_bytes: usize,
) -> Result<()> {
    let file_count = files.len() + usize::from(!files.contains_key(path));
    let replaced_bytes = files.get(path).map_or(0, Vec::len);
    let total_bytes = files
        .values()
        .map(Vec::len)
        .sum::<usize>()
        .saturating_sub(replaced_bytes)
        .saturating_add(content_bytes);
    if file_count > MAX_FAKE_FILES
        || content_bytes > MAX_FAKE_FILE_BYTES
        || total_bytes > MAX_FAKE_TOTAL_BYTES
    {
        return Err(HostedAgentError::new(
            HostedAgentErrorCategory::QuotaExceeded,
            "fake sandbox file limit exceeded",
        ));
    }
    Ok(())
}

fn validate_fake_files(files: &HashMap<PathUri, Vec<u8>>) -> Result<()> {
    if files.len() > MAX_FAKE_FILES
        || files
            .values()
            .any(|contents| contents.len() > MAX_FAKE_FILE_BYTES)
        || files.values().map(Vec::len).sum::<usize>() > MAX_FAKE_TOTAL_BYTES
    {
        return Err(HostedAgentError::new(
            HostedAgentErrorCategory::QuotaExceeded,
            "fake sandbox file limit exceeded",
        ));
    }
    Ok(())
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
        if let Some(error) = &state.provision_failure {
            return Err(error.clone());
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
                files: HashMap::new(),
            },
            ProjectSnapshotSource::SourceSnapshot {
                source_snapshot_id,
                checksum,
            } => state
                .source_snapshots
                .get(&(source_snapshot_id.clone(), checksum.clone()))
                .cloned()
                .ok_or_else(|| {
                    HostedAgentError::new(
                        HostedAgentErrorCategory::SnapshotMissing,
                        "source snapshot is unavailable in the in-memory fake",
                    )
                })?,
            ProjectSnapshotSource::AgentEnvironment { owner_lease_id } => {
                let owner = state.active_lease(owner_lease_id)?.clone();
                let mut source = state
                    .snapshots
                    .get(&owner.latest_snapshot_id)
                    .cloned()
                    .ok_or_else(|| {
                        HostedAgentError::new(
                            HostedAgentErrorCategory::SnapshotMissing,
                            "owner snapshot is missing",
                        )
                    })?;
                source.files = owner.files;
                source
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
                files: source.files,
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
        let mut source = state
            .snapshots
            .get(&lease.latest_snapshot_id)
            .cloned()
            .ok_or_else(|| {
                HostedAgentError::new(
                    HostedAgentErrorCategory::SnapshotMissing,
                    "lease snapshot is missing",
                )
            })?;
        source.files = lease.files;
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
        let lease = state.active_lease(&request.lease_id)?.clone();
        let base = state
            .snapshots
            .get(&request.base_snapshot_id)
            .cloned()
            .ok_or_else(|| {
                HostedAgentError::new(
                    HostedAgentErrorCategory::SnapshotMissing,
                    "base snapshot is missing",
                )
            })?;
        let current = state
            .snapshots
            .get(&lease.latest_snapshot_id)
            .cloned()
            .ok_or_else(|| {
                HostedAgentError::new(
                    HostedAgentErrorCategory::SnapshotMissing,
                    "current snapshot is missing",
                )
            })?;
        let mut paths = base
            .files
            .keys()
            .chain(current.files.keys())
            .cloned()
            .collect::<Vec<_>>();
        paths.sort_by_key(ToString::to_string);
        paths.dedup();
        let changes = paths
            .into_iter()
            .filter_map(|path| {
                let base_contents = base.files.get(&path).cloned();
                let current_contents = current.files.get(&path).cloned();
                (base_contents != current_contents).then_some(FileChange {
                    path,
                    base: base_contents,
                    current: current_contents,
                })
            })
            .collect::<Vec<_>>();
        let artifact_id = state.id("artifact");
        let artifact = AgentPatchArtifact {
            artifact_id: artifact_id.clone(),
            agent_id: request.agent_id,
            base_snapshot_id: request.base_snapshot_id.clone(),
            checksum: format!("fake-checksum-{artifact_id}"),
            changed_files: u32::try_from(changes.len()).unwrap_or(u32::MAX),
            size_bytes: changes
                .iter()
                .filter_map(|change| change.current.as_ref())
                .map(|contents| u64::try_from(contents.len()).unwrap_or(u64::MAX))
                .sum(),
        };
        state.artifacts.insert(
            artifact_id,
            Artifact {
                metadata: artifact.clone(),
                changes,
            },
        );
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
        let Some(artifact) = state.artifacts.get(&request.artifact_id).cloned() else {
            let result = PatchApplyResult::Rejected {
                reason: "artifact is missing".to_string(),
            };
            state
                .applies
                .insert(request.idempotency_key.clone(), (request, result.clone()));
            return Ok(result);
        };
        debug_assert_eq!(artifact.metadata.artifact_id, request.artifact_id);
        let result = match state.conflicts.get(&request.artifact_id) {
            Some(paths) => PatchApplyResult::Conflict {
                paths: paths.clone(),
            },
            None => {
                let lease = state.active_lease(&request.target_lease_id)?.clone();
                let mut snapshot = state
                    .snapshots
                    .get(&lease.latest_snapshot_id)
                    .cloned()
                    .ok_or_else(|| {
                        HostedAgentError::new(
                            HostedAgentErrorCategory::SnapshotMissing,
                            "target snapshot is missing",
                        )
                    })?;
                let mut conflict_paths = artifact
                    .changes
                    .iter()
                    .filter_map(|change| {
                        let target = lease.files.get(&change.path).cloned();
                        (target != change.base && target != change.current)
                            .then(|| change.path.clone())
                    })
                    .collect::<Vec<_>>();
                if !conflict_paths.is_empty() {
                    conflict_paths.sort_by_key(ToString::to_string);
                    PatchApplyResult::Conflict {
                        paths: conflict_paths,
                    }
                } else {
                    let mut files = lease.files;
                    for change in artifact.changes {
                        match change.current {
                            Some(contents) => {
                                files.insert(change.path, contents);
                            }
                            None => {
                                files.remove(&change.path);
                            }
                        }
                    }
                    validate_fake_files(&files)?;
                    snapshot.files = files.clone();
                    let snapshot_id = state.id("snapshot");
                    state.snapshots.insert(snapshot_id.clone(), snapshot);
                    let lease = state.active_lease_mut(&request.target_lease_id)?;
                    lease.files = files;
                    lease.latest_snapshot_id = snapshot_id.clone();
                    PatchApplyResult::Applied {
                        checkpoint: AgentCheckpoint { snapshot_id },
                    }
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

    async fn retain(&self, request: AgentRetentionRequest) -> Result<AgentRetention> {
        let mut state = self.lock();
        let lease = state.leases.get(&request.lease_id).ok_or_else(|| {
            HostedAgentError::new(HostedAgentErrorCategory::LeaseMissing, "lease is missing")
        })?;
        if lease.provisioned.lease_id != request.lease_id
            || !state.snapshots.contains_key(&request.base_snapshot_id)
            || !state.snapshots.contains_key(&request.latest_snapshot_id)
            || request
                .artifact_id
                .as_ref()
                .is_some_and(|id| !state.artifacts.contains_key(id))
        {
            return Err(HostedAgentError::new(
                HostedAgentErrorCategory::SnapshotMissing,
                "retained durable state is missing",
            ));
        }
        let key = request.agent_id.to_string();
        let revision = match state.retained.get(&key) {
            None if request.expected_revision.is_none() => 1,
            None => {
                return Err(HostedAgentError::invalid_response(
                    "initial retention revision must be absent",
                ));
            }
            Some(previous) => {
                let same_desired = previous.request.lease_id == request.lease_id
                    && previous.request.base_snapshot_id == request.base_snapshot_id
                    && previous.request.latest_snapshot_id == request.latest_snapshot_id
                    && previous.request.artifact_id == request.artifact_id;
                if same_desired && request.expected_revision.unwrap_or(0) <= previous.revision {
                    previous.revision
                } else if !same_desired && request.expected_revision == Some(previous.revision) {
                    previous.revision.saturating_add(1)
                } else {
                    return Err(HostedAgentError::invalid_response(
                        "retention revision is stale",
                    ));
                }
            }
        };
        state
            .retained
            .insert(key, RetainedState { request, revision });
        Ok(AgentRetention {
            revision,
            desired_hash: "0".repeat(64),
        })
    }
}
