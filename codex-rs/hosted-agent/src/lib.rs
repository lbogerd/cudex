//! Service contract and test provisioner for independently hosted Codex agents.

mod fake;
mod http;
mod types;

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
pub use types::AgentReleaseRequest;
pub use types::AgentToolPolicy;
pub use types::HostedAgentError;
pub use types::HostedAgentErrorCategory;
pub use types::HostedAgentService;
pub use types::HostedEnvironmentConnection;
pub use types::PatchApplyResult;
pub use types::ProjectSnapshotSource;
pub use types::ProvisionedAgent;

pub use codex_tools::ToolExecutionDomain;
pub use codex_tools::ToolExecutionDomainKind;

#[cfg(test)]
#[path = "hosted_agent_tests.rs"]
mod tests;
