//! Narrow Cudex adapter: provision before session startup, authorize at dispatch,
//! and retain the transport binding in upstream's thread extension store.
mod config;
mod lifecycle;
mod patch_tool;
mod policy;

#[cfg(test)]
#[path = "hosted_tests.rs"]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use codex_code_mode::HostedCodeModeRuntimeIdentity;
use codex_code_mode::HostedEnvironmentCodeModeSessionProvider;
use codex_exec_server::EnvironmentManager;
use codex_hosted_agent::HostedRuntimeManager;
use codex_hosted_agent::PrepareRequest;
use codex_hosted_agent::ProjectSnapshotSource;
use codex_hosted_agent::RuntimeBinding;
use codex_protocol::ThreadId;
use codex_protocol::protocol::EnvironmentConfigState;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::protocol::TurnEnvironmentSelection;
use codex_utils_absolute_path::AbsolutePathBuf;
use tokio::sync::Mutex;
use tokio::sync::broadcast;

use crate::config::Config;

pub(crate) use lifecycle::before_event;
pub(crate) use lifecycle::shutdown;
pub(crate) use patch_tool::HostedTools;
pub(crate) use policy::authorize;

pub(crate) fn validate_config(config: &Config) -> Result<(), String> {
    config::Settings::resolve(config).map(|_| ())
}

pub(crate) fn enabled(config: &Config) -> Result<bool, String> {
    config::Settings::resolve(config).map(|settings| settings.is_some())
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct HostedConfigurationError(pub String);

pub fn is_hosted_configuration_error(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|source| source.downcast_ref::<HostedConfigurationError>().is_some())
}

pub(crate) struct HostedManagers {
    managers: Mutex<HashMap<(String, std::path::PathBuf), Arc<HostedRuntimeManager>>>,
    pub patch_tx: broadcast::Sender<HostedAgentPatchAvailable>,
}

#[derive(Clone, Debug)]
pub struct HostedAgentPatchAvailable {
    pub owner_thread_id: ThreadId,
    pub artifact: codex_hosted_agent::AgentPatchArtifact,
}

impl Default for HostedManagers {
    fn default() -> Self {
        Self {
            managers: Mutex::default(),
            patch_tx: broadcast::channel(128).0,
        }
    }
}

pub(crate) struct HostedThread {
    pub manager: Arc<HostedRuntimeManager>,
    pub binding: Arc<RuntimeBinding>,
    pub code_mode: Arc<HostedEnvironmentCodeModeSessionProvider>,
    pub environments: Arc<EnvironmentManager>,
    pub patch_tx: broadcast::Sender<HostedAgentPatchAvailable>,
    pub active: std::sync::atomic::AtomicBool,
}

impl HostedManagers {
    pub async fn delete(&self, id: ThreadId, config: &Config) -> Result<(), String> {
        let Some(settings) = config::Settings::resolve(config)? else {
            if codex_hosted_agent::has_hosted_thread(
                config.codex_home.join("cudex-runtime").as_path(),
                id,
            )
            .map_err(|error| error.to_string())?
            {
                return Err("hosted thread cleanup requires its hosted configuration".into());
            }
            return Ok(());
        };
        let state_dir = config.codex_home.join("cudex-runtime");
        let key = (settings.hosted.service_url.clone(), state_dir.to_path_buf());
        let manager = {
            let mut managers = self.managers.lock().await;
            if let Some(manager) = managers.get(&key) {
                Arc::clone(manager)
            } else {
                let manager = Arc::new(
                    HostedRuntimeManager::from_config(
                        &settings.hosted.service_url,
                        state_dir.as_path(),
                    )
                    .map_err(|error| error.to_string())?,
                );
                managers.insert(key, Arc::clone(&manager));
                manager
            }
        };
        manager.delete(id).await.map_err(|error| error.to_string())
    }

    pub async fn prepare(
        &self,
        config: &Config,
        thread_id: ThreadId,
        parent_id: Option<ThreadId>,
        forked_from: Option<ThreadId>,
        session_source: &SessionSource,
        environments: Arc<EnvironmentManager>,
    ) -> Result<Option<HostedThread>, String> {
        let Some(settings) = config::Settings::resolve(config)? else {
            if codex_hosted_agent::has_hosted_thread(
                config.codex_home.join("cudex-runtime").as_path(),
                thread_id,
            )
            .map_err(|error| error.to_string())?
            {
                return Err("resuming a hosted thread requires its hosted configuration".into());
            }
            return Ok(None);
        };
        if config.ephemeral {
            return Err("hosted agents require durable thread persistence".into());
        }
        // Internal helpers must not acquire an implicit local execution fallback.
        let (owner_agent_id, role) = match session_source {
            SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id,
                agent_role,
                ..
            }) => (Some(*parent_thread_id), agent_role.as_deref()),
            _ => (parent_id, None),
        };
        if owner_agent_id.is_none() && forked_from.is_some() {
            return Err("independent hosted thread forks are not supported by the control-plane source contract".into());
        }
        let role = role.unwrap_or(&settings.hosted.default_agent_type);
        let template = settings
            .templates
            .get(role)
            .ok_or_else(|| format!("hosted role {role} has no sandbox_template"))?;
        let state_dir = config.codex_home.join("cudex-runtime");
        let key = (settings.hosted.service_url.clone(), state_dir.to_path_buf());
        let manager = {
            let mut managers = self.managers.lock().await;
            if let Some(manager) = managers.get(&key) {
                Arc::clone(manager)
            } else {
                let manager = Arc::new(
                    HostedRuntimeManager::from_config(
                        &settings.hosted.service_url,
                        state_dir.as_path(),
                    )
                    .map_err(|error| error.to_string())?,
                );
                managers.insert(key, Arc::clone(&manager));
                manager
            }
        };
        manager
            .retry_deletions()
            .await
            .map_err(|error| error.to_string())?;
        let source = match owner_agent_id {
            Some(owner) => manager
                .source_for_child(owner)
                .map_err(|error| error.to_string())?,
            None => ProjectSnapshotSource::SourceSnapshot {
                source_snapshot_id: settings.hosted.source_snapshot.source_snapshot_id,
                checksum: settings.hosted.source_snapshot.checksum,
            },
        };
        let binding = manager
            .prepare(PrepareRequest {
                agent_id: thread_id,
                owner_agent_id,
                agent_type: role.to_owned(),
                sandbox_template: template.clone(),
                source,
            })
            .await
            .map_err(|error| error.to_string())?;
        let result = Self::connect(
            Arc::clone(&manager),
            binding,
            environments,
            self.patch_tx.clone(),
        )
        .await;
        if result.is_err()
            && let Err(error) = manager.startup_failed(thread_id).await
        {
            tracing::warn!(%error, %thread_id, "hosted startup cleanup remains pending");
        }
        result.map(Some)
    }

    async fn connect(
        manager: Arc<HostedRuntimeManager>,
        binding: Arc<RuntimeBinding>,
        environments: Arc<EnvironmentManager>,
        patch_tx: broadcast::Sender<HostedAgentPatchAvailable>,
    ) -> Result<HostedThread, String> {
        let provisioned = &binding.provisioned;
        provisioned
            .connection
            .register(
                &environments,
                provisioned.environment_id.clone(),
                Duration::from_secs(30),
            )
            .map_err(|_| "failed to register hosted environment".to_owned())?;
        let environment = environments
            .get_environment(&provisioned.environment_id)
            .ok_or("registered hosted environment is missing")?;
        let ready =
            match tokio::time::timeout(Duration::from_secs(30), environment.wait_until_ready())
                .await
            {
                Ok(result) => result.map_err(|_| "hosted environment readiness failed".to_owned()),
                Err(_) => Err("hosted environment readiness timed out".to_owned()),
            };
        if let Err(error) = ready {
            let _ = environments
                .remove_environment(&provisioned.environment_id)
                .await;
            return Err(error);
        }
        let code_mode = Arc::new(HostedEnvironmentCodeModeSessionProvider::new(
            HostedCodeModeRuntimeIdentity {
                lease_id: provisioned.lease_id.clone(),
                environment_id: provisioned.environment_id.clone(),
                connection_generation: provisioned.connection_generation,
            },
            environment,
            AbsolutePathBuf::try_from("/usr/local/bin/codex-code-mode-host")
                .map_err(|error| error.to_string())?,
            provisioned
                .cwd
                .to_abs_path()
                .map_err(|error| error.to_string())?,
        ));
        if code_mode.ready().await.is_err() {
            let _ = environments
                .remove_environment(&provisioned.environment_id)
                .await;
            return Err("hosted code-mode runtime readiness failed".into());
        }
        Ok(HostedThread {
            manager,
            binding,
            code_mode,
            environments,
            patch_tx,
            active: std::sync::atomic::AtomicBool::new(true),
        })
    }
}

impl HostedThread {
    pub fn configure(&self, config: &mut Config) -> Result<(), String> {
        // Ambient contributors can start processes before model tool dispatch.
        // Until they expose an audited environment binding, do not enable them.
        for feature in [
            codex_features::Feature::CodexHooks,
            codex_features::Feature::PluginHooks,
            codex_features::Feature::Plugins,
            codex_features::Feature::Apps,
        ] {
            config
                .features
                .disable(feature)
                .map_err(|error| error.to_string())?;
        }
        config.permissions.approval_policy =
            crate::config::Constrained::allow_only(codex_protocol::protocol::AskForApproval::Never);
        // Provider-native search never reaches our tool authorization boundary.
        config.web_search_mode = crate::config::Constrained::allow_only(
            codex_protocol::config_types::WebSearchMode::Disabled,
        );
        config
            .permissions
            .replace_permission_profile_from_session_snapshot(
                crate::config::PermissionProfileSnapshot::legacy(
                    codex_protocol::models::PermissionProfile::External {
                        network: codex_protocol::permissions::NetworkSandboxPolicy::Enabled,
                    },
                ),
            )
            .map_err(|error| error.to_string())?;
        config.permissions.network = None;
        Ok(())
    }

    pub async fn apply_patch(
        &self,
        child: ThreadId,
        artifact: &str,
    ) -> Result<codex_hosted_agent::PatchApplyResult, String> {
        let record = self
            .manager
            .record(child)
            .map_err(|error| error.to_string())?
            .ok_or("hosted child record is missing")?;
        if !self.active.load(std::sync::atomic::Ordering::Acquire)
            || !self.binding.authorize(
                &codex_tools::ToolName::plain("apply_agent_patch"),
                codex_hosted_agent::ToolExecutionDomainKind::ControlPlane,
            )
            || record.owner_agent_id != Some(self.binding.agent_id)
            || record
                .last_exported_patch
                .as_ref()
                .is_none_or(|patch| patch.artifact_id != artifact)
        {
            return Err("external sandbox denied: patch is not owned by this active agent".into());
        }
        self.manager
            .apply_patch(self.binding.agent_id, artifact)
            .await
            .map_err(|error| error.to_string())
    }

    pub fn selection(&self) -> TurnEnvironmentSelection {
        let provisioned = &self.binding.provisioned;
        TurnEnvironmentSelection {
            environment_id: provisioned.environment_id.clone(),
            cwd: provisioned.cwd.clone(),
            workspace_roots: provisioned.workspace_roots.clone(),
            config: EnvironmentConfigState::FromThread,
        }
    }

    pub async fn startup_failed(&self) {
        let _ = self.code_mode.shutdown().await;
        let _ = self
            .environments
            .remove_environment(&self.binding.provisioned.environment_id)
            .await;
        if let Err(error) = self.manager.startup_failed(self.binding.agent_id).await {
            tracing::warn!(%error, "hosted startup cleanup remains pending");
        }
    }
}
