use std::collections::BTreeSet;
use std::fmt;
use std::time::Duration;

use codex_exec_server::EnvironmentManager;
use codex_exec_server::ExecServerError;
use codex_protocol::ThreadId;
use codex_protocol::ToolName;
use codex_tools::ToolExecutionDomainKind;
use codex_utils_path_uri::PathUri;
use serde::Deserialize;
use serde::Serialize;

pub type Result<T> = std::result::Result<T, HostedAgentError>;

/// Maximum UTF-8 byte length for opaque service identifiers retained by Codex.
pub const MAX_OPAQUE_ID_BYTES: usize = 512;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvisionRequest {
    pub agent_id: ThreadId,
    pub owner_agent_id: Option<ThreadId>,
    pub agent_type: String,
    pub sandbox_template: String,
    pub source: ProjectSnapshotSource,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ProjectSnapshotSource {
    RootWorkspace {
        cwd: PathUri,
        workspace_roots: Vec<PathUri>,
    },
    SourceSnapshot {
        source_snapshot_id: String,
        checksum: String,
    },
    AgentEnvironment {
        owner_lease_id: String,
    },
    DurableSnapshot {
        snapshot_id: String,
    },
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostedEnvironmentConnection {
    exec_server_url: String,
}

impl HostedEnvironmentConnection {
    pub fn try_new(exec_server_url: impl Into<String>) -> Result<Self> {
        let connection = Self {
            exec_server_url: exec_server_url.into(),
        };
        connection.validate()?;
        Ok(connection)
    }

    /// Registers this transient connection with the execution environment manager.
    ///
    /// The connection endpoint remains encapsulated and must not be persisted.
    pub fn register(
        &self,
        manager: &EnvironmentManager,
        environment_id: impl Into<String>,
        timeout: Duration,
    ) -> std::result::Result<(), ExecServerError> {
        self.validate()
            .map_err(|error| ExecServerError::Protocol(error.to_string()))?;
        manager.register_environment(
            environment_id.into(),
            self.exec_server_url.clone(),
            Some(timeout),
        )
    }

    pub(crate) fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.exec_server_url)
            .map_err(|_| HostedAgentError::invalid_response("invalid connection endpoint"))?;
        if url.scheme() != "wss" || url.host_str().is_none() {
            return Err(HostedAgentError::invalid_response(
                "invalid connection endpoint",
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for HostedEnvironmentConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HostedEnvironmentConnection")
            .field("exec_server_url", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionedAgent {
    pub lease_id: String,
    pub environment_id: String,
    pub connection: HostedEnvironmentConnection,
    pub cwd: PathUri,
    pub workspace_roots: Vec<PathUri>,
    pub base_snapshot_id: String,
    pub tool_policy: AgentToolPolicy,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolPolicy {
    pub allowed_domains: BTreeSet<ToolExecutionDomainKind>,
    pub allowed_tools: BTreeSet<ToolName>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReconnectRequest {
    pub lease_id: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheckpointRequest {
    pub lease_id: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheckpoint {
    pub snapshot_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatchExportRequest {
    pub lease_id: String,
    pub agent_id: ThreadId,
    pub base_snapshot_id: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatchApplyRequest {
    pub target_lease_id: String,
    pub artifact_id: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReleaseRequest {
    pub lease_id: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRetentionRequest {
    pub agent_id: ThreadId,
    pub lease_id: String,
    pub base_snapshot_id: String,
    pub latest_snapshot_id: String,
    pub artifact_id: Option<String>,
    pub expected_revision: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRetention {
    pub revision: u64,
    pub desired_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatchArtifact {
    pub artifact_id: String,
    pub agent_id: ThreadId,
    pub base_snapshot_id: String,
    pub checksum: String,
    pub changed_files: u32,
    pub size_bytes: u64,
}

/// Durable lifecycle state for a hosted-agent runtime.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostedAgentLifecycleState {
    Active,
    PendingFinalization,
    Completed,
    ReleasePending,
    Released,
}

/// Durable, non-secret metadata needed to restore and finalize a hosted agent.
///
/// Transient connection data, service credentials, and tool policy are
/// intentionally excluded and must be reacquired from the hosting service.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedAgentRuntimeRecord {
    /// The owning agent used for lifecycle and patch authorization.
    ///
    /// Older persisted records predate durable ownership, so a missing field is
    /// treated as an unowned root runtime.
    #[serde(default)]
    pub owner_agent_id: Option<ThreadId>,
    pub agent_type: String,
    pub sandbox_template: String,
    pub lease_id: String,
    pub environment_id: String,
    pub base_snapshot_id: String,
    pub latest_snapshot_id: Option<String>,
    pub last_exported_patch: Option<AgentPatchArtifact>,
    #[serde(default)]
    pub reference_revision: Option<u64>,
    pub lifecycle_state: HostedAgentLifecycleState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum PatchApplyResult {
    Applied { checkpoint: AgentCheckpoint },
    Conflict { paths: Vec<PathUri> },
    Rejected { reason: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostedAgentErrorCategory {
    Unavailable,
    Unauthorized,
    InvalidTemplate,
    LeaseMissing,
    SnapshotMissing,
    QuotaExceeded,
    ConnectionFailed,
    PatchConflict,
    InvalidResponse,
}

#[derive(Clone, Debug, thiserror::Error, Eq, PartialEq)]
#[error("hosted-agent service {category:?}: {message}")]
pub struct HostedAgentError {
    pub category: HostedAgentErrorCategory,
    message: String,
}

impl HostedAgentError {
    pub fn new(category: HostedAgentErrorCategory, message: impl Into<String>) -> Self {
        Self {
            category,
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn invalid_response(message: impl Into<String>) -> Self {
        Self::new(HostedAgentErrorCategory::InvalidResponse, message)
    }
}

/// Provides isolated environments and durable snapshots for hosted agents.
///
/// Implementations must make every operation idempotent using the supplied key
/// and must never persist connection material or service credentials.
pub trait HostedAgentService: Send + Sync {
    /// Creates a unique environment from the requested project snapshot.
    fn provision(
        &self,
        request: AgentProvisionRequest,
    ) -> impl Future<Output = Result<ProvisionedAgent>> + Send;
    /// Reacquires transient connection material for an active lease.
    fn reconnect(
        &self,
        request: AgentReconnectRequest,
    ) -> impl Future<Output = Result<ProvisionedAgent>> + Send;
    /// Creates a durable snapshot of the lease's current state.
    fn checkpoint(
        &self,
        request: AgentCheckpointRequest,
    ) -> impl Future<Output = Result<AgentCheckpoint>> + Send;
    /// Exports a durable patch relative to the immutable base snapshot.
    fn export_patch(
        &self,
        request: AgentPatchExportRequest,
    ) -> impl Future<Output = Result<AgentPatchArtifact>> + Send;
    /// Atomically applies an exported patch to a target lease.
    fn apply_patch(
        &self,
        request: AgentPatchApplyRequest,
    ) -> impl Future<Output = Result<PatchApplyResult>> + Send;
    /// Synchronizes the exact durable snapshot and artifact set retained by Codex.
    fn retain(
        &self,
        request: AgentRetentionRequest,
    ) -> impl Future<Output = Result<AgentRetention>> + Send;
    /// Releases the service resources associated with a lease.
    fn release(&self, request: AgentReleaseRequest) -> impl Future<Output = Result<()>> + Send;
}
