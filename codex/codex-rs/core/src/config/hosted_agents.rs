use super::AgentRoleConfig;
use codex_config::config_toml::ConfigToml;
use codex_features::Feature;
use codex_features::Features;
use std::collections::BTreeMap;

const DEFAULT_HOSTED_AGENT_TYPE: &str = "default";

/// Effective settings for the experimental hosted full-agent runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedAgentsConfig {
    /// Whether both the feature gate and runtime configuration enable hosted agents.
    pub enabled: bool,
    /// Base URL of the hosted-agent service.
    pub service_url: Option<String>,
    /// Agent role selected when a caller omits an agent type.
    pub default_agent_type: String,
    /// Trusted immutable source used instead of client-host paths for root agents.
    pub source_snapshot: Option<HostedSourceSnapshotConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedSourceSnapshotConfig {
    pub source_snapshot_id: String,
    pub checksum: String,
}

impl Default for HostedAgentsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            service_url: None,
            default_agent_type: DEFAULT_HOSTED_AGENT_TYPE.to_string(),
            source_snapshot: None,
        }
    }
}

pub(super) fn resolve(
    cfg: &ConfigToml,
    features: &Features,
    agent_roles: &BTreeMap<String, AgentRoleConfig>,
) -> std::io::Result<HostedAgentsConfig> {
    let configured = cfg.hosted_agents.as_ref();
    let enabled = features.enabled(Feature::HostedAgents)
        && configured
            .and_then(|hosted| hosted.enabled)
            .unwrap_or(false);
    let service_url = configured
        .and_then(|hosted| hosted.service_url.as_deref())
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(ToOwned::to_owned);
    let configured_default_agent_type = configured
        .and_then(|hosted| hosted.default_agent_type.as_deref())
        .map(str::trim);
    if enabled && configured_default_agent_type == Some("") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "hosted_agents.default_agent_type cannot be blank",
        ));
    }
    let default_agent_type = configured_default_agent_type
        .filter(|agent_type| !agent_type.is_empty())
        .unwrap_or(DEFAULT_HOSTED_AGENT_TYPE)
        .to_string();
    let source_snapshot = configured
        .and_then(|hosted| hosted.source_snapshot.as_ref())
        .map(|source| {
            let id_suffix = source.source_snapshot_id.strip_prefix("source_");
            if !id_suffix.is_some_and(|suffix| {
                suffix.len() == 32
                    && suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "hosted_agents.source_snapshot.source_snapshot_id must be source_ followed by 32 lowercase hex characters",
                ));
            }
            let checksum_suffix = source.checksum.strip_prefix("sha256:");
            if !checksum_suffix.is_some_and(|suffix| {
                suffix.len() == 64
                    && suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "hosted_agents.source_snapshot.checksum must be a lowercase SHA-256 checksum",
                ));
            }
            Ok(HostedSourceSnapshotConfig {
                source_snapshot_id: source.source_snapshot_id.clone(),
                checksum: source.checksum.clone(),
            })
        })
        .transpose()?;

    if enabled {
        let service_url = service_url.as_deref().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "hosted_agents.service_url must be set when hosted agents are enabled",
            )
        })?;
        let parsed_url = url::Url::parse(service_url).map_err(|err| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("hosted_agents.service_url must be a valid URL: {err}"),
            )
        })?;
        if parsed_url.scheme() != "https" || parsed_url.host_str().is_none() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "hosted_agents.service_url must be an absolute https URL",
            ));
        }
        if !parsed_url.username().is_empty() || parsed_url.password().is_some() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "hosted_agents.service_url must not contain credentials",
            ));
        }
        if parsed_url.fragment().is_some() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "hosted_agents.service_url must not contain a fragment",
            ));
        }
        if parsed_url.query().is_some() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "hosted_agents.service_url must not contain a query string",
            ));
        }

        for (role_name, role) in agent_roles {
            if role.sandbox_template.is_none() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!(
                        "agent role `{role_name}` must define sandbox_template when hosted agents are enabled"
                    ),
                ));
            }
        }
        if !agent_roles.contains_key(&default_agent_type) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "hosted_agents.default_agent_type `{default_agent_type}` must name a configured agent role with sandbox_template"
                ),
            ));
        }
    }

    Ok(HostedAgentsConfig {
        enabled,
        service_url,
        default_agent_type,
        source_snapshot,
    })
}
