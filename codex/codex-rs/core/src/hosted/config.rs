use std::collections::BTreeMap;

use codex_features::Feature;
use serde::Deserialize;

use crate::config::Config;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HostedConfig {
    pub enabled: bool,
    pub service_url: String,
    pub default_agent_type: String,
    pub source_snapshot: SourceSnapshot,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SourceSnapshot {
    pub source_snapshot_id: String,
    pub checksum: String,
}

pub(super) struct Settings {
    pub hosted: HostedConfig,
    pub templates: BTreeMap<String, String>,
}

impl Settings {
    pub fn resolve(config: &Config) -> Result<Option<Self>, String> {
        let effective = config.config_layer_stack.effective_config();
        let feature_enabled = config.features.enabled(Feature::HostedAgents);
        let Some(value) = effective.get("hosted_agents") else {
            return if feature_enabled {
                Err("hosted_agents feature requires hosted_agents configuration".into())
            } else {
                Ok(None)
            };
        };
        let hosted: HostedConfig = value
            .clone()
            .try_into()
            .map_err(|error| format!("invalid hosted_agents configuration: {error}"))?;
        if hosted.enabled != feature_enabled {
            return Err("hosted_agents.enabled and features.hosted_agents must agree".into());
        }
        if !hosted.enabled {
            return Ok(None);
        }
        hosted.validate()?;
        if !config.mcp_servers.get().is_empty()
            || effective.get("hooks").is_some()
            || effective.get("plugins").is_some()
        {
            return Err(
                "hosted agents do not permit unaudited ambient MCP, hooks, or plugins".into(),
            );
        }
        let templates = effective
            .get("agents")
            .and_then(toml::Value::as_table)
            .into_iter()
            .flat_map(|roles| roles.iter())
            .filter_map(|(name, role)| {
                role.get("sandbox_template")
                    .map(|template| (name, template))
            })
            .map(|(name, value)| {
                let template = value
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        format!("agents.{name}.sandbox_template must be a nonempty string")
                    })?;
                Ok((name.clone(), template.to_owned()))
            })
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        if !templates.contains_key(&hosted.default_agent_type) {
            return Err("hosted default role must define sandbox_template".into());
        }
        Ok(Some(Self { hosted, templates }))
    }
}

impl HostedConfig {
    pub(super) fn validate(&self) -> Result<(), String> {
        let url = url::Url::parse(&self.service_url)
            .map_err(|_| "hosted service URL must be an absolute HTTPS URL")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "hosted service URL must be HTTPS without credentials, query, or fragment".into(),
            );
        }
        let valid_hex = |value: &str, prefix: &str, len: usize| {
            value.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.len() == len
                    && suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        };
        if !valid_hex(&self.source_snapshot.source_snapshot_id, "source_", 32)
            || !valid_hex(&self.source_snapshot.checksum, "sha256:", 64)
        {
            return Err(
                "hosted source snapshot requires a validated source ID and SHA-256 checksum".into(),
            );
        }
        if self.default_agent_type.trim().is_empty() {
            return Err("hosted default role cannot be blank".into());
        }
        Ok(())
    }
}
