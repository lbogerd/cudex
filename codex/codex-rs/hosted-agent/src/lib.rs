//! Service contract and test provisioner for independently hosted Codex agents.

mod fake;
mod http;
mod lifecycle;
mod runtime;
mod store;
mod types;

pub use runtime::HostedRuntimeManager;
pub use runtime::PrepareRequest;
pub use runtime::RuntimeBinding;
pub use store::has_hosted_thread;
pub use store::reject_legacy_state;

pub use fake::FakeHostedAgentService;
pub use http::CODEX_HOSTED_AGENT_TOKEN_ENV_VAR;
pub use http::HttpHostedAgentService;
pub use types::AgentCheckpoint;
pub use types::AgentCheckpointRequest;
pub use types::AgentPatchApplyRequest;
pub use types::AgentPatchArtifact;
pub use types::AgentPatchExportRequest;
pub use types::AgentProvisionRequest;
pub use types::AgentReconnectRequest;
pub use types::AgentReferenceClearRequest;
pub use types::AgentReleaseRequest;
pub use types::AgentRetention;
pub use types::AgentRetentionRequest;
pub use types::AgentToolPolicy;
pub use types::HostedAgentError;
pub use types::HostedAgentErrorCategory;
pub use types::HostedAgentLifecycleState;
pub use types::HostedAgentRuntimeRecord;
pub use types::HostedAgentService;
pub use types::HostedEnvironmentConnection;
pub use types::MAX_OPAQUE_ID_BYTES;
pub use types::PatchApplyResult;
pub use types::ProjectSnapshotSource;
pub use types::ProvisionedAgent;

mod domain;
pub use domain::ToolExecutionDomain;
pub use domain::ToolExecutionDomainKind;

#[cfg(test)]
#[path = "hosted_agent_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod runtime_tests;
