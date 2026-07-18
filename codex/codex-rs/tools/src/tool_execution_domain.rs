use serde::Deserialize;
use serde::Serialize;

/// Identifies the runtime boundary in which a tool executes.
///
/// This is authorization metadata and is deliberately independent of whether a
/// tool is directly exposed to the model.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ToolExecutionDomain {
    AgentEnvironment,
    ControlPlane,
    ProviderHosted,
    EnvironmentBoundMcp {
        server: String,
        environment_id: String,
    },
    AmbientMcp {
        server: String,
    },
    ClientCallback,
    Extension,
    OrchestratorProcess,
}

impl ToolExecutionDomain {
    /// Returns the coarse domain kind used by hosted-agent policy grants.
    pub fn kind(&self) -> ToolExecutionDomainKind {
        match self {
            Self::AgentEnvironment => ToolExecutionDomainKind::AgentEnvironment,
            Self::ControlPlane => ToolExecutionDomainKind::ControlPlane,
            Self::ProviderHosted => ToolExecutionDomainKind::ProviderHosted,
            Self::EnvironmentBoundMcp { .. } => ToolExecutionDomainKind::EnvironmentBoundMcp,
            Self::AmbientMcp { .. } => ToolExecutionDomainKind::AmbientMcp,
            Self::ClientCallback => ToolExecutionDomainKind::ClientCallback,
            Self::Extension => ToolExecutionDomainKind::Extension,
            Self::OrchestratorProcess => ToolExecutionDomainKind::OrchestratorProcess,
        }
    }
}

/// Coarse execution boundary granted by a hosted-agent tool policy.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolExecutionDomainKind {
    AgentEnvironment,
    ControlPlane,
    ProviderHosted,
    EnvironmentBoundMcp,
    AmbientMcp,
    ClientCallback,
    Extension,
    OrchestratorProcess,
}
