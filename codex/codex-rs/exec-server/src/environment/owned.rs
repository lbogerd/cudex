//! Strict lifecycle ownership for environments registered by hosted leases.

use std::sync::Arc;

use super::Environment;
use super::EnvironmentManager;
use super::validate_environment_id;
use super::validate_remote_exec_server_url;
use crate::ExecServerError;
use crate::client_api::DEFAULT_REMOTE_EXEC_SERVER_CONNECT_TIMEOUT;
use crate::client_api::ExecServerTransportParams;

impl EnvironmentManager {
    /// Registers a lease-owned environment without replacing any existing identity.
    pub fn register_environment(
        &self,
        environment_id: String,
        exec_server_url: String,
        connect_timeout: Option<std::time::Duration>,
    ) -> Result<(), ExecServerError> {
        validate_environment_id(&environment_id)?;
        let exec_server_url = validate_remote_exec_server_url(exec_server_url)?;
        let environment = Arc::new(Environment::remote_with_transport(
            ExecServerTransportParams::websocket_url(
                exec_server_url,
                connect_timeout.unwrap_or(DEFAULT_REMOTE_EXEC_SERVER_CONNECT_TIMEOUT),
            ),
            self.local_runtime_paths.clone(),
            self.http_client_factory.clone(),
        ));
        let mut environments = self
            .environments
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if environments.contains_key(&environment_id) {
            return Err(ExecServerError::Protocol(format!(
                "environment `{environment_id}` is already registered"
            )));
        }
        self.owned_environment_ids
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(environment_id.clone());
        environments.insert(environment_id, Arc::clone(&environment));
        drop(environments);
        environment.start_connecting();
        Ok(())
    }

    /// Removes only lease-owned environments and permanently retires retained handles.
    /// This closes transport access; callers must confirm process quiescence first.
    pub async fn remove_environment(&self, environment_id: &str) -> Result<bool, ExecServerError> {
        let environment = {
            let mut environments = self
                .environments
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !environments.contains_key(environment_id) {
                return Ok(false);
            }
            if !self
                .owned_environment_ids
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(environment_id)
            {
                return Err(ExecServerError::Protocol(format!(
                    "environment `{environment_id}` is not lease-owned"
                )));
            }
            environments.remove(environment_id)
        };
        if let Some(environment) = environment
            && let Some(client) = &environment.remote_client
        {
            client.retire_environment().await;
        }
        Ok(true)
    }
}
