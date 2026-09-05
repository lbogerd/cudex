//! Lease-scoped placement over exec-server's authenticated stdio transport.

use sha2::Digest;
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use codex_exec_server::Environment;
use codex_exec_server::ExecEnvPolicy;
use codex_exec_server::ExecParams;
use codex_exec_server::ExecProcess;
use codex_exec_server::ProcessId;
use codex_protocol::config_types::ShellEnvironmentPolicyInherit;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;

use super::CodeModeSessionCellExecutionLimits;
use super::CodeModeSessionDelegate;
use super::CodeModeSessionProvider;
use super::CodeModeSessionProviderFuture;
use super::OwnedCodeModeHost;
use super::connection::Connection;
use super::create_host_session;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedCodeModeRuntimeIdentity {
    pub lease_id: String,
    pub environment_id: String,
    pub connection_generation: u64,
}

impl HostedCodeModeRuntimeIdentity {
    fn process_id(&self) -> ProcessId {
        let mut hash = Sha256::new();
        hash.update(b"hosted-code-mode-v1\0");
        hash.update(self.lease_id.as_bytes());
        hash.update(b"\0");
        hash.update(self.environment_id.as_bytes());
        hash.update(b"\0");
        hash.update(self.connection_generation.to_le_bytes());
        ProcessId::new(format!(
            "hosted-code-mode-{}",
            &format!("{:x}", hash.finalize())[..32]
        ))
    }
}

/// One host per lease binding. No local fallback or automatic process restart.
pub struct HostedEnvironmentCodeModeSessionProvider {
    identity: HostedCodeModeRuntimeIdentity,
    environment: Arc<Environment>,
    host_program: AbsolutePathBuf,
    cwd: AbsolutePathBuf,
    binding: tokio::sync::OnceCell<Result<HostedBinding, String>>,
    closed: AtomicBool,
    quiesced: AtomicBool,
    lifecycle: tokio::sync::Mutex<()>,
}

struct HostedBinding {
    host: Arc<OwnedCodeModeHost>,
    process: Arc<dyn ExecProcess>,
}

impl HostedEnvironmentCodeModeSessionProvider {
    pub fn new(
        identity: HostedCodeModeRuntimeIdentity,
        environment: Arc<Environment>,
        host_program: AbsolutePathBuf,
        cwd: AbsolutePathBuf,
    ) -> Self {
        Self {
            identity,
            environment,
            host_program,
            cwd,
            binding: tokio::sync::OnceCell::new(),
            closed: AtomicBool::new(false),
            quiesced: AtomicBool::new(false),
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }

    pub fn identity(&self) -> &HostedCodeModeRuntimeIdentity {
        &self.identity
    }

    pub async fn ready(&self) -> Result<(), String> {
        self.host().await.map(drop)
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "serialize host startup with terminal shutdown so a late process cannot escape cleanup"
    )]
    async fn host(&self) -> Result<Arc<OwnedCodeModeHost>, String> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err("hosted code-mode runtime was shut down".into());
        }
        let binding = self
            .binding
            .get_or_init(|| async {
                if !self.environment.is_remote() {
                    return Err("hosted code mode requires a remote environment".into());
                }
                let started = self
                    .environment
                    .get_exec_backend()
                    .start(ExecParams {
                        process_id: self.identity.process_id(),
                        argv: vec![
                            self.host_program.to_string_lossy().into_owned(),
                            "--hosted-singleton".into(),
                            "--identity".into(),
                            format!(
                                "{}:{}:{}",
                                self.identity.lease_id,
                                self.identity.environment_id,
                                self.identity.connection_generation
                            ),
                        ],
                        cwd: PathUri::from_abs_path(&self.cwd),
                        env_policy: Some(ExecEnvPolicy {
                            inherit: ShellEnvironmentPolicyInherit::None,
                            ignore_default_excludes: false,
                            exclude: Vec::new(),
                            r#set: HashMap::new(),
                            include_only: Vec::new(),
                        }),
                        shell_snapshot: None,
                        env: HashMap::new(),
                        tty: false,
                        pipe_stdin: true,
                        arg0: None,
                        sandbox: None,
                        enforce_managed_network: false,
                        managed_network: None,
                        network_proxy: None,
                    })
                    .await
                    .map_err(|_| {
                        "failed to start hosted code-mode process through its lease transport"
                            .to_string()
                    })?;
                let process = started.process;
                let connection = Arc::new(
                    Connection::from_exec_process(Arc::clone(&process))
                        .await
                        .map_err(|error| error.to_string())?,
                );
                let mut host = OwnedCodeModeHost::new(self.host_program.to_path_buf());
                host.hosted = true;
                *host
                    .connection
                    .get_mut()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(connection);
                Ok(HostedBinding {
                    host: Arc::new(host),
                    process,
                })
            })
            .await;
        let binding = binding.as_ref().map_err(Clone::clone)?;
        if self.closed.load(Ordering::Acquire) {
            let _ = binding.process.terminate().await;
            return Err("hosted code-mode runtime was shut down".into());
        }
        Ok(Arc::clone(&binding.host))
    }

    /// Termination is complete only when the executor confirms process-group
    /// quiescence. Unknown/old peers and disconnected transports fail closed.
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "shutdown must wait for in-flight startup before confirming the owned process group"
    )]
    pub async fn shutdown(&self) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.closed.store(true, Ordering::Release);
        if self.quiesced.load(Ordering::Acquire) {
            return Ok(());
        }
        let Some(binding) = self.binding.get() else {
            return Ok(());
        };
        let binding = binding.as_ref().map_err(Clone::clone)?;
        tokio::time::timeout(Duration::from_secs(35), async {
            binding
                .process
                .terminate()
                .await
                .map_err(|error| error.to_string())?;
            loop {
                let response = binding
                    .process
                    .read(None, Some(0), Some(100))
                    .await
                    .map_err(|error| error.to_string())?;
                if response.quiesced {
                    self.quiesced.store(true, Ordering::Release);
                    return Ok(());
                }
                if let Some(failure) = response.failure {
                    return Err(failure);
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| "hosted code-mode process-group quiescence was not confirmed".to_string())?
    }
}

impl CodeModeSessionProvider for HostedEnvironmentCodeModeSessionProvider {
    fn availability(&self) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            Err("hosted code-mode runtime was shut down".into())
        } else if !self.environment.is_remote() {
            Err("hosted code mode requires a remote environment".into())
        } else if let Some(Err(error)) = self.binding.get() {
            Err(error.clone())
        } else {
            Ok(())
        }
    }
    fn create_session<'a>(
        &'a self,
        delegate: Arc<dyn CodeModeSessionDelegate>,
    ) -> CodeModeSessionProviderFuture<'a> {
        self.create_session_with_limits(delegate, CodeModeSessionCellExecutionLimits::default())
    }
    fn create_session_with_limits<'a>(
        &'a self,
        delegate: Arc<dyn CodeModeSessionDelegate>,
        limits: CodeModeSessionCellExecutionLimits,
    ) -> CodeModeSessionProviderFuture<'a> {
        Box::pin(async move { create_host_session(delegate, self.host().await?, limits).await })
    }
}

impl Drop for HostedEnvironmentCodeModeSessionProvider {
    fn drop(&mut self) {
        if let Some(Ok(binding)) = self.binding.get()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let process = Arc::clone(&binding.process);
            runtime.spawn(async move {
                let _ = process.terminate().await;
            });
        }
    }
}

#[cfg(test)]
#[path = "hosted_tests.rs"]
mod tests;
