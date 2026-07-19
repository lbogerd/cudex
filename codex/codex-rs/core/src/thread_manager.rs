use crate::CodexAppsToolsCache;
use crate::SkillsService;
use crate::agent::AgentControl;
use crate::attestation::AttestationProvider;
use crate::codex_thread::CodexThread;
use crate::config::Config;
use crate::config::Constrained;
use crate::config::PermissionProfileSnapshot;
use crate::config::ThreadStoreConfig;
use crate::current_time::TimeProvider;
use crate::environment_selection::TurnEnvironmentSnapshot;
use crate::environment_selection::default_thread_environment_selections;
use crate::hosted_agent_runtime::HostedAgentProvisioner;
use crate::hosted_agent_runtime::HostedAgentRuntime;
use crate::hosted_agent_runtime::PendingHostedAgentRuntime;
use crate::mcp::McpManager;
use crate::rollout::truncation;
use crate::session::INITIAL_SUBMIT_ID;
use crate::session::SessionIo;
use crate::session::SessionSpawnArgs;
use crate::session::resolve_multi_agent_version;
use crate::session::session::Session;
use crate::tasks::InterruptedTurnHistoryMarker;
use crate::tasks::interrupted_turn_history_marker;
use codex_agent_graph_store::AgentGraphStore;
use codex_agent_graph_store::LocalAgentGraphStore;
use codex_analytics::AnalyticsEventsClient;
use codex_app_server_protocol::ThreadHistoryBuilder;
use codex_app_server_protocol::TurnStatus;
use codex_code_mode::CodeModeRuntimePlacement;
use codex_code_mode::CodeModeSessionProvider;
use codex_code_mode::InProcessCodeModeSessionProvider;
use codex_code_mode::ProcessOwnedCodeModeSessionProvider;
use codex_core_plugins::PluginsManager;
use codex_exec_server::EnvironmentManager;
use codex_extension_api::ExtensionDataInit;
use codex_extension_api::ExtensionRegistry;
use codex_extension_api::LoadedUserInstructions;
use codex_extension_api::UserInstructionsProvider;
use codex_extension_api::empty_extension_registry;
use codex_features::Feature;
use codex_hosted_agent::AgentProvisionRequest;
use codex_hosted_agent::HostedAgentError;
use codex_hosted_agent::HostedAgentErrorCategory;
use codex_hosted_agent::HttpHostedAgentService;
use codex_hosted_agent::ProjectSnapshotSource;
use codex_login::AuthManager;
use codex_login::CodexAuth;
use codex_login::default_client::CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR;
use codex_login::default_client::originator;
use codex_model_provider::create_model_provider;
use codex_model_provider_info::ModelProviderInfo;
use codex_model_provider_info::OPENAI_PROVIDER_ID;
use codex_models_manager::manager::RefreshStrategy;
use codex_models_manager::manager::SharedModelsManager;
use codex_protocol::ThreadId;
use codex_protocol::config_types::CollaborationModeMask;
use codex_protocol::error::CodexErr;
use codex_protocol::error::Result as CodexResult;
use codex_protocol::models::PermissionProfile;
use codex_protocol::openai_models::ModelPreset;
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_protocol::protocol::AskForApproval;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::InitialHistory;
use codex_protocol::protocol::MultiAgentVersion;
use codex_protocol::protocol::Op;
use codex_protocol::protocol::ResumedHistory;
use codex_protocol::protocol::RolloutItem;
use codex_protocol::protocol::SessionConfiguredEvent;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::protocol::ThreadHistoryMode;
use codex_protocol::protocol::ThreadSource;
use codex_protocol::protocol::TurnAbortReason;
use codex_protocol::protocol::TurnAbortedEvent;
use codex_protocol::protocol::TurnEnvironmentSelection;
use codex_protocol::protocol::W3cTraceContext;
use codex_rollout::state_db::StateDbHandle;
use codex_thread_store::InMemoryThreadStore;
use codex_thread_store::LoadThreadHistoryParams;
use codex_thread_store::LocalThreadStore;
use codex_thread_store::LocalThreadStoreConfig;
use codex_thread_store::ReadThreadByRolloutPathParams;
use codex_thread_store::ReadThreadParams;
use codex_thread_store::StoredModelContext;
use codex_thread_store::StoredThread;
use codex_thread_store::ThreadMetadataPatch;
use codex_thread_store::ThreadStore;
use codex_thread_store::ThreadStoreError;
use codex_thread_store::UpdateThreadMetadataParams;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use futures::StreamExt;
use futures::future::join_all;
use futures::stream::FuturesUnordered;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::sync::Semaphore;
use tokio::sync::broadcast;
use tracing::instrument;
use tracing::warn;

const THREAD_CREATED_CHANNEL_CAPACITY: usize = 1024;
const PATCH_AVAILABLE_CHANNEL_CAPACITY: usize = 1024;

mod hosted_agent_lifecycle;
mod hosted_agent_patch_apply;
pub use hosted_agent_lifecycle::HostedAgentPatchAvailable;
pub use hosted_agent_patch_apply::HostedAgentPatchApplyResult;
/// Test-only override for enabling thread-manager behaviors used by integration
/// tests.
///
/// In production builds this value should remain at its default (`false`) and
/// must not be toggled.
static FORCE_TEST_THREAD_MANAGER_BEHAVIOR: AtomicBool = AtomicBool::new(false);

type CapturedOps = Vec<(ThreadId, Op)>;
type SharedCapturedOps = Arc<std::sync::Mutex<CapturedOps>>;

struct HostedAgentRuntimeEntry {
    runtime: std::sync::Mutex<HostedAgentRuntime>,
    code_mode_provider: Option<Arc<codex_code_mode::HostedEnvironmentCodeModeSessionProvider>>,
    operation_lock: Arc<Semaphore>,
}

impl HostedAgentRuntimeEntry {
    fn new(
        runtime: HostedAgentRuntime,
        code_mode_provider: Option<Arc<codex_code_mode::HostedEnvironmentCodeModeSessionProvider>>,
    ) -> Self {
        Self {
            runtime: std::sync::Mutex::new(runtime),
            code_mode_provider,
            operation_lock: Arc::new(Semaphore::new(1)),
        }
    }

    fn snapshot(&self) -> HostedAgentRuntime {
        self.runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn replace(&self, runtime: HostedAgentRuntime) {
        *self
            .runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = runtime;
    }
}

type SharedHostedAgentRuntime = Arc<HostedAgentRuntimeEntry>;

pub(crate) fn set_thread_manager_test_mode_for_tests(enabled: bool) {
    FORCE_TEST_THREAD_MANAGER_BEHAVIOR.store(enabled, Ordering::Relaxed);
}

fn should_use_test_thread_manager_behavior() -> bool {
    FORCE_TEST_THREAD_MANAGER_BEHAVIOR.load(Ordering::Relaxed)
}

struct TempCodexHomeGuard {
    path: PathBuf,
}

impl Drop for TempCodexHomeGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Represents a newly created Codex thread (formerly called a conversation), including the first event
/// (which is [`EventMsg::SessionConfigured`]).
pub struct NewThread {
    pub thread_id: ThreadId,
    pub thread: Arc<CodexThread>,
    pub session_configured: SessionConfiguredEvent,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct HostedAgentProvisioningLineage {
    owner_agent_id: Option<ThreadId>,
    snapshot_source_thread_id: Option<ThreadId>,
}

impl HostedAgentProvisioningLineage {
    pub(crate) fn owned_by(owner_agent_id: ThreadId) -> Self {
        Self {
            owner_agent_id: Some(owner_agent_id),
            snapshot_source_thread_id: Some(owner_agent_id),
        }
    }

    fn forked_from(snapshot_source_thread_id: Option<ThreadId>) -> Self {
        Self {
            owner_agent_id: None,
            snapshot_source_thread_id,
        }
    }

    fn for_subagent(
        session_source: &SessionSource,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
    ) -> Self {
        let owner_agent_id = match session_source {
            SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id, ..
            }) => Some(*parent_thread_id),
            _ => parent_thread_id,
        };
        Self {
            owner_agent_id,
            snapshot_source_thread_id: forked_from_thread_id.or(owner_agent_id),
        }
    }
}

// TODO(ccunningham): Add an explicit non-interrupting live-turn snapshot once
// core can represent sampling boundaries directly instead of relying on
// whichever items happened to be persisted mid-turn.
//
// Two likely future variants:
// - `TruncateToLastSamplingBoundary` for callers that want a coherent fork from
//   the last stable model boundary without synthesizing an interrupt.
// - `WaitUntilNextSamplingBoundary` (or similar) for callers that prefer to
//   fork after the next sampling boundary rather than interrupting immediately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForkSnapshot {
    /// Fork a committed prefix ending strictly before the nth user message.
    ///
    /// When `n` is within range, this cuts before that 0-based user-message
    /// boundary. When `n` is out of range and the source thread is currently
    /// mid-turn, this instead cuts before the active turn's opening boundary
    /// so the fork drops the unfinished turn suffix. When `n` is out of range
    /// and the source thread is already at a turn boundary, this returns the
    /// full committed history unchanged.
    TruncateBeforeNthUserMessage(usize),

    /// Fork the current persisted history as if the source thread had been
    /// interrupted now.
    ///
    /// If the persisted snapshot ends mid-turn, this appends the same
    /// `<turn_aborted>` marker produced by a real interrupt. If the snapshot is
    /// already at a turn boundary, this returns the current persisted history
    /// unchanged.
    Interrupted,
}

/// Preserve legacy `fork_thread(usize, ...)` callsites by mapping them to the
/// existing truncate-before-nth-user-message snapshot mode.
impl From<usize> for ForkSnapshot {
    fn from(value: usize) -> Self {
        Self::TruncateBeforeNthUserMessage(value)
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ThreadShutdownReport {
    pub completed: Vec<ThreadId>,
    pub submit_failed: Vec<ThreadId>,
    pub timed_out: Vec<ThreadId>,
}

enum ShutdownOutcome {
    Complete,
    SubmitFailed,
    TimedOut,
}

/// [`ThreadManager`] is responsible for creating threads and maintaining
/// them in memory.
pub struct ThreadManager {
    state: Arc<ThreadManagerState>,
    _test_codex_home_guard: Option<TempCodexHomeGuard>,
}

pub struct StartThreadOptions {
    pub config: Config,
    pub allow_provider_model_fallback: bool,
    pub initial_history: InitialHistory,
    pub history_mode: Option<ThreadHistoryMode>,
    pub session_source: Option<SessionSource>,
    pub thread_source: Option<ThreadSource>,
    pub dynamic_tools: Vec<codex_protocol::dynamic_tools::DynamicToolSpec>,
    pub metrics_service_name: Option<String>,
    pub parent_trace: Option<W3cTraceContext>,
    pub environments: Vec<TurnEnvironmentSelection>,
    pub thread_extension_init: ExtensionDataInit,
    pub supports_openai_form_elicitation: bool,
}

fn originator_from_service_name(service_name: Option<&str>) -> Option<String> {
    let service_name = service_name?.trim();
    for originator in [
        "codex_work_desktop",
        "codex_work_web",
        "codex_work_mobile",
        "codex_work_cca",
        "chatgpt_cca",
    ] {
        if service_name.eq_ignore_ascii_case(originator) {
            return Some(originator.to_string());
        }
    }
    None
}

fn effective_originator_value(
    metrics_service_name: Option<&str>,
    env_originator: Option<String>,
    persisted_originator: Option<String>,
    inherited_originator: Option<String>,
    default_originator: String,
) -> String {
    originator_from_service_name(metrics_service_name)
        .or(persisted_originator)
        .or(inherited_originator)
        .or(env_originator)
        .unwrap_or(default_originator)
}

fn thread_id_for_initial_history(initial_history: &InitialHistory) -> ThreadId {
    match initial_history {
        InitialHistory::Resumed(resumed) => resumed.conversation_id,
        InitialHistory::New | InitialHistory::Cleared | InitialHistory::Forked(_) => {
            ThreadId::new()
        }
    }
}

pub(crate) struct ResumeThreadWithHistoryOptions {
    pub(crate) config: Config,
    pub(crate) initial_history: InitialHistory,
    pub(crate) agent_control: AgentControl,
    pub(crate) session_source: SessionSource,
    pub(crate) parent_thread_id: Option<ThreadId>,
    pub(crate) inherited_environments: Option<TurnEnvironmentSnapshot>,
    pub(crate) inherited_exec_policy: Option<Arc<crate::exec_policy::ExecPolicyManager>>,
}

/// Shared, `Arc`-owned state for [`ThreadManager`]. This `Arc` is required to have a single
/// `Arc` reference that can be downgraded to by `AgentControl` while preventing every single
/// function to require an `Arc<&Self>`.
pub(crate) struct ThreadManagerState {
    threads: Arc<RwLock<HashMap<ThreadId, Arc<CodexThread>>>>,
    thread_created_tx: broadcast::Sender<ThreadId>,
    patch_available_tx: broadcast::Sender<HostedAgentPatchAvailable>,
    auth_manager: Arc<AuthManager>,
    models_manager: SharedModelsManager,
    environment_manager: Arc<EnvironmentManager>,
    skills_service: Arc<SkillsService>,
    plugins_manager: Arc<PluginsManager>,
    mcp_manager: Arc<McpManager>,
    code_mode_session_provider: Arc<dyn CodeModeSessionProvider>,
    extensions: Arc<ExtensionRegistry<Config>>,
    user_instructions_provider: Arc<dyn UserInstructionsProvider>,
    thread_store: Arc<dyn ThreadStore>,
    agent_graph_store: Option<Arc<dyn AgentGraphStore>>,
    attestation_provider: Option<Arc<dyn AttestationProvider>>,
    external_time_provider: Option<Arc<dyn TimeProvider>>,
    session_source: SessionSource,
    installation_id: String,
    analytics_events_client: Option<AnalyticsEventsClient>,
    hosted_agent_provisioner: Result<Option<Arc<HostedAgentProvisioner>>, HostedAgentError>,
    hosted_agent_runtimes: RwLock<HashMap<ThreadId, SharedHostedAgentRuntime>>,
    // Captures submitted ops for testing purpose when test mode is enabled.
    ops_log: Option<SharedCapturedOps>,
}

pub fn build_models_manager(
    config: &Config,
    auth_manager: Arc<AuthManager>,
) -> SharedModelsManager {
    let provider = create_model_provider(config.model_provider.clone(), Some(auth_manager));
    provider.models_manager(
        config.codex_home.to_path_buf(),
        config.model_catalog.clone(),
    )
}

pub fn thread_store_from_config(
    config: &Config,
    state_db: Option<StateDbHandle>,
) -> Arc<dyn ThreadStore> {
    match &config.experimental_thread_store {
        ThreadStoreConfig::Local => {
            if config
                .features
                .enabled(Feature::LocalThreadStoreCompression)
            {
                codex_rollout::spawn_rollout_compression_worker(config.codex_home.to_path_buf());
            }
            Arc::new(LocalThreadStore::new(
                LocalThreadStoreConfig::from_config(config),
                state_db,
            ))
        }
        ThreadStoreConfig::InMemory { id } => InMemoryThreadStore::for_id(id),
    }
}

fn hosted_agent_provisioner(
    config: &Config,
    environment_manager: Arc<EnvironmentManager>,
) -> Result<Option<Arc<HostedAgentProvisioner>>, HostedAgentError> {
    if !config.hosted_agents.enabled {
        return Ok(None);
    }
    let service_url = config.hosted_agents.service_url.as_deref().ok_or_else(|| {
        HostedAgentError::new(
            HostedAgentErrorCategory::ConnectionFailed,
            "enabled hosted-agent config has no service URL",
        )
    })?;
    let service = Arc::new(HttpHostedAgentService::from_env(service_url)?);
    Ok(Some(Arc::new(HostedAgentProvisioner::new(
        service,
        environment_manager,
    ))))
}

/// Construct the default SQLite-backed agent graph store when local state is available.
pub fn local_agent_graph_store_from_state_db(
    state_db: Option<&StateDbHandle>,
) -> Option<Arc<dyn AgentGraphStore>> {
    state_db.map(|state_db| {
        Arc::new(LocalAgentGraphStore::new(Arc::clone(state_db))) as Arc<dyn AgentGraphStore>
    })
}

impl ThreadManager {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: &Config,
        auth_manager: Arc<AuthManager>,
        models_manager: SharedModelsManager,
        codex_apps_tools_cache: CodexAppsToolsCache,
        session_source: SessionSource,
        environment_manager: Arc<EnvironmentManager>,
        extensions: Arc<ExtensionRegistry<Config>>,
        user_instructions_provider: Arc<dyn UserInstructionsProvider>,
        analytics_events_client: Option<AnalyticsEventsClient>,
        thread_store: Arc<dyn ThreadStore>,
        agent_graph_store: Option<Arc<dyn AgentGraphStore>>,
        installation_id: String,
        attestation_provider: Option<Arc<dyn AttestationProvider>>,
        external_time_provider: Option<Arc<dyn TimeProvider>>,
    ) -> Self {
        let codex_home = config.codex_home.clone();
        let restriction_product = session_source.restriction_product();
        let (thread_created_tx, _) = broadcast::channel(THREAD_CREATED_CHANNEL_CAPACITY);
        let (patch_available_tx, _) = broadcast::channel(PATCH_AVAILABLE_CHANNEL_CAPACITY);
        let plugins_manager = Arc::new(PluginsManager::new_with_options(
            codex_home.to_path_buf(),
            restriction_product,
            auth_manager.get_api_auth_mode(),
        ));
        let mcp_manager = Arc::new(McpManager::new_with_extensions(
            Arc::clone(&plugins_manager),
            Arc::clone(&extensions),
            codex_apps_tools_cache,
        ));
        let skills_service = Arc::new(SkillsService::new_with_restriction_product(
            codex_home,
            config.bundled_skills_enabled(),
            restriction_product,
        ));
        let hosted_agent_provisioner =
            hosted_agent_provisioner(config, Arc::clone(&environment_manager));
        Self {
            state: Arc::new(ThreadManagerState {
                threads: Arc::new(RwLock::new(HashMap::new())),
                thread_created_tx,
                patch_available_tx,
                models_manager,
                environment_manager,
                skills_service,
                plugins_manager,
                mcp_manager,
                code_mode_session_provider: if config.features.enabled(Feature::CodeModeHost) {
                    Arc::new(ProcessOwnedCodeModeSessionProvider::default())
                } else {
                    Arc::new(InProcessCodeModeSessionProvider)
                },
                extensions,
                user_instructions_provider,
                thread_store,
                agent_graph_store,
                attestation_provider,
                external_time_provider,
                auth_manager,
                session_source,
                installation_id,
                analytics_events_client,
                hosted_agent_provisioner,
                hosted_agent_runtimes: RwLock::new(HashMap::new()),
                ops_log: should_use_test_thread_manager_behavior()
                    .then(|| Arc::new(std::sync::Mutex::new(Vec::new()))),
            }),
            _test_codex_home_guard: None,
        }
    }

    pub(crate) fn with_code_mode_host_program_for_tests(mut self, host_program: PathBuf) -> Self {
        let Some(state) = Arc::get_mut(&mut self.state) else {
            unreachable!("new thread manager state should not be shared");
        };
        state.code_mode_session_provider = Arc::new(
            ProcessOwnedCodeModeSessionProvider::with_host_program(host_program),
        );
        self
    }

    /// Construct with a dummy AuthManager containing the provided CodexAuth.
    /// Used for integration tests: should not be used by ordinary business logic.
    pub(crate) fn with_models_provider_for_tests(
        auth: CodexAuth,
        provider: ModelProviderInfo,
    ) -> Self {
        set_thread_manager_test_mode_for_tests(/*enabled*/ true);
        let codex_home = std::env::temp_dir().join(format!(
            "codex-thread-manager-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&codex_home)
            .unwrap_or_else(|err| panic!("temp codex home dir create failed: {err}"));
        let mut manager = Self::with_models_provider_and_home_for_tests(
            auth,
            provider,
            codex_home.clone(),
            Arc::new(EnvironmentManager::default_for_tests()),
        );
        manager._test_codex_home_guard = Some(TempCodexHomeGuard { path: codex_home });
        manager
    }

    /// Construct with a dummy AuthManager containing the provided CodexAuth and codex home.
    /// Used for integration tests: should not be used by ordinary business logic.
    pub(crate) fn with_models_provider_and_home_for_tests(
        auth: CodexAuth,
        provider: ModelProviderInfo,
        codex_home: PathBuf,
        environment_manager: Arc<EnvironmentManager>,
    ) -> Self {
        Self::with_models_provider_home_and_state_for_tests(
            auth,
            provider,
            codex_home,
            environment_manager,
            /*state_db*/ None,
        )
    }

    pub(crate) fn with_models_provider_home_and_state_for_tests(
        auth: CodexAuth,
        provider: ModelProviderInfo,
        codex_home: PathBuf,
        environment_manager: Arc<EnvironmentManager>,
        state_db: Option<StateDbHandle>,
    ) -> Self {
        set_thread_manager_test_mode_for_tests(/*enabled*/ true);
        let auth_manager = AuthManager::from_auth_for_testing(auth);
        let installation_id = uuid::Uuid::new_v4().to_string();
        let skills_codex_home = match AbsolutePathBuf::from_absolute_path_checked(&codex_home) {
            Ok(codex_home) => codex_home,
            Err(err) => panic!("test codex_home should be absolute: {err}"),
        };
        let (thread_created_tx, _) = broadcast::channel(THREAD_CREATED_CHANNEL_CAPACITY);
        let (patch_available_tx, _) = broadcast::channel(PATCH_AVAILABLE_CHANNEL_CAPACITY);
        let restriction_product = SessionSource::Exec.restriction_product();
        let plugins_manager = Arc::new(PluginsManager::new_with_options(
            codex_home.clone(),
            restriction_product,
            auth_manager.get_api_auth_mode(),
        ));
        let mcp_manager = Arc::new(McpManager::new(Arc::clone(&plugins_manager)));
        let skills_service = Arc::new(SkillsService::new_with_restriction_product(
            skills_codex_home,
            /*bundled_skills_enabled*/ true,
            restriction_product,
        ));
        // This test constructor has no Config input. Tests that need a non-local
        // process store should construct ThreadManager::new with an explicit store.
        let thread_store: Arc<dyn ThreadStore> = Arc::new(LocalThreadStore::new(
            LocalThreadStoreConfig {
                codex_home: codex_home.clone(),
                sqlite_home: codex_home.clone(),
                default_model_provider_id: OPENAI_PROVIDER_ID.to_string(),
            },
            state_db.clone(),
        ));
        let agent_graph_store = local_agent_graph_store_from_state_db(state_db.as_ref());
        Self {
            state: Arc::new(ThreadManagerState {
                threads: Arc::new(RwLock::new(HashMap::new())),
                thread_created_tx,
                patch_available_tx,
                models_manager: create_model_provider(provider, Some(auth_manager.clone()))
                    .models_manager(codex_home, /*config_model_catalog*/ None),
                environment_manager,
                skills_service,
                plugins_manager,
                mcp_manager,
                code_mode_session_provider: Arc::new(InProcessCodeModeSessionProvider),
                extensions: empty_extension_registry(),
                user_instructions_provider: Arc::new(
                    crate::test_support::EmptyUserInstructionsProvider,
                ),
                thread_store,
                agent_graph_store,
                attestation_provider: None,
                external_time_provider: None,
                auth_manager,
                session_source: SessionSource::Exec,
                installation_id,
                analytics_events_client: None,
                hosted_agent_provisioner: Ok(None),
                hosted_agent_runtimes: RwLock::new(HashMap::new()),
                ops_log: should_use_test_thread_manager_behavior()
                    .then(|| Arc::new(std::sync::Mutex::new(Vec::new()))),
            }),
            _test_codex_home_guard: None,
        }
    }

    pub fn session_source(&self) -> SessionSource {
        self.state.session_source.clone()
    }

    pub fn auth_manager(&self) -> Arc<AuthManager> {
        self.state.auth_manager.clone()
    }

    pub fn skills_service(&self) -> Arc<SkillsService> {
        self.state.skills_service.clone()
    }

    pub fn plugins_manager(&self) -> Arc<PluginsManager> {
        self.state.plugins_manager.clone()
    }

    pub fn mcp_manager(&self) -> Arc<McpManager> {
        self.state.mcp_manager.clone()
    }

    pub fn environment_manager(&self) -> Arc<EnvironmentManager> {
        self.state.environment_manager.clone()
    }

    pub fn default_environment_selections(
        &self,
        cwd: &AbsolutePathBuf,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Vec<TurnEnvironmentSelection> {
        default_thread_environment_selections(
            self.state.environment_manager.as_ref(),
            cwd,
            workspace_roots,
        )
    }

    pub fn validate_environment_selections(
        &self,
        environments: &[TurnEnvironmentSelection],
    ) -> CodexResult<()> {
        let mut environment_ids = HashSet::with_capacity(environments.len());
        for environment in environments {
            if !environment_ids.insert(environment.environment_id.as_str()) {
                return Err(CodexErr::InvalidRequest(format!(
                    "duplicate turn environment id `{}`",
                    environment.environment_id
                )));
            }
            self.state
                .environment_manager
                .get_environment(&environment.environment_id)
                .ok_or_else(|| {
                    CodexErr::InvalidRequest(format!(
                        "unknown turn environment id `{}`",
                        environment.environment_id
                    ))
                })?;
        }
        Ok(())
    }

    pub fn get_models_manager(&self) -> SharedModelsManager {
        self.state.models_manager.clone()
    }

    pub async fn list_models(
        &self,
        refresh_strategy: RefreshStrategy,
        http_client_factory: codex_http_client::HttpClientFactory,
    ) -> Vec<ModelPreset> {
        self.state
            .models_manager
            .list_models(refresh_strategy, http_client_factory)
            .await
    }

    pub fn list_collaboration_modes(&self) -> Vec<CollaborationModeMask> {
        self.state.models_manager.list_collaboration_modes()
    }

    pub async fn list_thread_ids(&self) -> Vec<ThreadId> {
        self.state.list_thread_ids().await
    }

    pub fn subscribe_thread_created(&self) -> broadcast::Receiver<ThreadId> {
        self.state.thread_created_tx.subscribe()
    }

    /// Subscribes to durable hosted-agent patches available to owning threads.
    pub fn subscribe_hosted_agent_patch_available(
        &self,
    ) -> broadcast::Receiver<HostedAgentPatchAvailable> {
        self.state.patch_available_tx.subscribe()
    }

    pub async fn get_thread(&self, thread_id: ThreadId) -> CodexResult<Arc<CodexThread>> {
        self.state.get_thread(thread_id).await
    }

    /// Updates metadata for loaded and cold threads through one entrypoint.
    ///
    /// Loaded threads route through `CodexThread`/`LiveThread`, so metadata changes stay ordered
    /// with live rollout writes. Cold threads go directly to the store, which owns unloaded JSONL
    /// compatibility and SQLite metadata updates.
    pub async fn update_thread_metadata(
        &self,
        thread_id: ThreadId,
        patch: ThreadMetadataPatch,
        include_archived: bool,
    ) -> CodexResult<StoredThread> {
        if let Ok(thread) = self.get_thread(thread_id).await {
            if thread.config_snapshot().await.ephemeral {
                return Err(CodexErr::InvalidRequest(format!(
                    "ephemeral thread does not support metadata updates: {thread_id}"
                )));
            }
            return thread
                .update_thread_metadata(patch, include_archived)
                .await
                .map_err(|err| thread_store_metadata_update_error(thread_id, err));
        }
        self.state
            .thread_store
            .update_thread_metadata(UpdateThreadMetadataParams {
                thread_id,
                patch,
                include_archived,
            })
            .await
            .map_err(|err| match err {
                ThreadStoreError::ThreadNotFound { thread_id } => {
                    CodexErr::ThreadNotFound(thread_id)
                }
                err => thread_store_metadata_update_error(thread_id, err),
            })
    }

    /// List `thread_id` plus all known descendants in its spawn subtree.
    pub async fn list_agent_subtree_thread_ids(
        &self,
        thread_id: ThreadId,
    ) -> CodexResult<Vec<ThreadId>> {
        let mut subtree_thread_ids = Vec::new();
        let mut seen_thread_ids = HashSet::new();
        subtree_thread_ids.push(thread_id);
        seen_thread_ids.insert(thread_id);

        if let Some(agent_graph_store) = self.state.agent_graph_store() {
            for descendant_id in agent_graph_store
                .list_thread_spawn_descendants(thread_id, /*status_filter*/ None)
                .await
                .map_err(|err| {
                    CodexErr::Fatal(format!("failed to load thread-spawn descendants: {err}"))
                })?
            {
                if seen_thread_ids.insert(descendant_id) {
                    subtree_thread_ids.push(descendant_id);
                }
            }
        }

        for descendant_id in self
            .agent_control()
            .list_live_agent_subtree_thread_ids(thread_id)
            .await?
        {
            if seen_thread_ids.insert(descendant_id) {
                subtree_thread_ids.push(descendant_id);
            }
        }

        Ok(subtree_thread_ids)
    }

    pub async fn start_thread(&self, config: Config) -> CodexResult<NewThread> {
        // Box delegated thread-spawn futures so these convenience wrappers do
        // not inline the full spawn path into every caller's async state.
        Box::pin(self.start_thread_with_tools(config, Vec::new())).await
    }

    pub async fn start_thread_with_tools(
        &self,
        config: Config,
        dynamic_tools: Vec<codex_protocol::dynamic_tools::DynamicToolSpec>,
    ) -> CodexResult<NewThread> {
        let environments = default_thread_environment_selections(
            self.state.environment_manager.as_ref(),
            &config.cwd,
            &config.workspace_roots,
        );
        Box::pin(self.start_thread_with_options(StartThreadOptions {
            config,
            allow_provider_model_fallback: false,
            initial_history: InitialHistory::New,
            history_mode: None,
            session_source: None,
            thread_source: None,
            dynamic_tools,
            metrics_service_name: None,
            parent_trace: None,
            environments,
            thread_extension_init: ExtensionDataInit::default(),
            supports_openai_form_elicitation: false,
        }))
        .await
    }

    pub async fn start_thread_with_options(
        &self,
        options: StartThreadOptions,
    ) -> CodexResult<NewThread> {
        self.start_thread_with_options_and_fork_source(
            options,
            /*forked_from_thread_id*/ None,
            /*agent_type*/ None,
            HostedAgentProvisioningLineage::default(),
        )
        .await
    }

    /// Starts a root thread with an explicit hosted agent role selection.
    pub async fn start_thread_with_options_and_agent_type(
        &self,
        options: StartThreadOptions,
        agent_type: String,
    ) -> CodexResult<NewThread> {
        self.start_thread_with_options_and_fork_source(
            options,
            /*forked_from_thread_id*/ None,
            Some(agent_type),
            HostedAgentProvisioningLineage::default(),
        )
        .await
    }

    async fn start_thread_with_options_and_fork_source(
        &self,
        options: StartThreadOptions,
        forked_from_thread_id: Option<ThreadId>,
        agent_type: Option<String>,
        hosted_lineage: HostedAgentProvisioningLineage,
    ) -> CodexResult<NewThread> {
        let agent_control = self.agent_control_for_config(&options.config);
        let (resumed_session_source, resumed_thread_source) = options
            .initial_history
            .get_resumed_session_sources()
            .unwrap_or_else(|| (self.state.session_source.clone(), None));
        let session_source = options.session_source.unwrap_or(resumed_session_source);
        let thread_source = options.thread_source.or(resumed_thread_source);
        Box::pin(self.state.spawn_thread_with_source(
            options.config,
            options.initial_history,
            options.history_mode,
            options.allow_provider_model_fallback,
            Arc::clone(&self.state.auth_manager),
            agent_control,
            session_source,
            agent_type,
            hosted_lineage,
            /*parent_thread_id*/ None,
            forked_from_thread_id,
            thread_source,
            options.dynamic_tools,
            options.metrics_service_name,
            /*inherited_environments*/ None,
            /*inherited_exec_policy*/ None,
            options.parent_trace,
            options.environments,
            options.thread_extension_init,
            options.supports_openai_form_elicitation,
            /*user_shell_override*/ None,
        ))
        .await
    }

    // TODO(jif) merge with fork_agent
    /// Spawn a subagent by forking persisted history from `forked_from_thread_id`.
    pub async fn spawn_subagent(
        &self,
        forked_from_thread_id: ThreadId,
        mut options: StartThreadOptions,
    ) -> CodexResult<NewThread> {
        let fork_source = self.get_thread(forked_from_thread_id).await?;
        // Persist queued rollout updates before reading the fork snapshot.
        fork_source.ensure_rollout_materialized().await;
        fork_source.flush_rollout().await?;
        let stored_thread = fork_source
            .read_thread(
                /*include_archived*/ true, /*include_history*/ true,
            )
            .await
            .map_err(|err| {
                CodexErr::Fatal(format!(
                    "failed to read subagent fork source {forked_from_thread_id}: {err}"
                ))
            })?;
        let history = stored_thread_to_initial_history(stored_thread, fork_source.rollout_path())?;
        let inherited_multi_agent_version = fork_source
            .multi_agent_version()
            .unwrap_or(MultiAgentVersion::V1);
        options.initial_history = fork_history_from_snapshot(
            ForkSnapshot::Interrupted,
            history,
            InterruptedTurnHistoryMarker::from_config_and_version(
                &options.config,
                inherited_multi_agent_version,
            ),
        );
        self.start_thread_with_options_and_fork_source(
            options,
            Some(forked_from_thread_id),
            /*agent_type*/ None,
            HostedAgentProvisioningLineage::owned_by(forked_from_thread_id),
        )
        .await
    }

    pub async fn resume_thread_from_rollout(
        &self,
        config: Config,
        rollout_path: PathBuf,
        auth_manager: Arc<AuthManager>,
        parent_trace: Option<W3cTraceContext>,
        supports_openai_form_elicitation: bool,
    ) -> CodexResult<NewThread> {
        let initial_history = self.initial_history_from_rollout_path(rollout_path).await?;
        Box::pin(self.resume_thread_with_history(
            config,
            initial_history,
            auth_manager,
            parent_trace,
            supports_openai_form_elicitation,
        ))
        .await
    }

    #[instrument(level = "trace", skip_all)]
    pub async fn resume_thread_with_history(
        &self,
        config: Config,
        initial_history: InitialHistory,
        auth_manager: Arc<AuthManager>,
        parent_trace: Option<W3cTraceContext>,
        supports_openai_form_elicitation: bool,
    ) -> CodexResult<NewThread> {
        let agent_control = self.agent_control_for_config(&config);
        let environments = default_thread_environment_selections(
            self.state.environment_manager.as_ref(),
            &config.cwd,
            &config.workspace_roots,
        );
        let (session_source, thread_source) = initial_history
            .get_resumed_session_sources()
            .unwrap_or_else(|| (self.state.session_source.clone(), None));
        if let InitialHistory::Resumed(resumed) = &initial_history
            && initial_history.get_multi_agent_version() == Some(MultiAgentVersion::V2)
            && !session_source.is_non_root_agent()
        {
            agent_control
                .restore_v2_agent_metadata(&config, resumed.conversation_id)
                .await;
        }
        Box::pin(self.state.spawn_thread_with_source(
            config,
            initial_history,
            /*history_mode*/ None,
            /*allow_provider_model_fallback*/ false,
            auth_manager,
            agent_control,
            session_source,
            /*agent_type*/ None,
            HostedAgentProvisioningLineage::default(),
            /*parent_thread_id*/ None,
            /*forked_from_thread_id*/ None,
            thread_source,
            Vec::new(),
            /*metrics_service_name*/ None,
            /*inherited_environments*/ None,
            /*inherited_exec_policy*/ None,
            parent_trace,
            environments,
            /*thread_extension_init*/ ExtensionDataInit::default(),
            supports_openai_form_elicitation,
            /*user_shell_override*/ None,
        ))
        .await
    }

    pub(crate) async fn start_thread_with_user_shell_override_for_tests(
        &self,
        config: Config,
        user_shell_override: crate::shell::Shell,
        supports_openai_form_elicitation: bool,
    ) -> CodexResult<NewThread> {
        let agent_control = self.agent_control_for_config(&config);
        let environments = default_thread_environment_selections(
            self.state.environment_manager.as_ref(),
            &config.cwd,
            &config.workspace_roots,
        );
        Box::pin(self.state.spawn_thread(
            config,
            InitialHistory::New,
            Arc::clone(&self.state.auth_manager),
            agent_control,
            HostedAgentProvisioningLineage::default(),
            /*parent_thread_id*/ None,
            /*forked_from_thread_id*/ None,
            /*thread_source*/ None,
            Vec::new(),
            /*metrics_service_name*/ None,
            /*parent_trace*/ None,
            environments,
            /*thread_extension_init*/ ExtensionDataInit::default(),
            supports_openai_form_elicitation,
            /*user_shell_override*/ Some(user_shell_override),
        ))
        .await
    }

    pub(crate) async fn resume_thread_from_rollout_with_user_shell_override_for_tests(
        &self,
        config: Config,
        rollout_path: PathBuf,
        auth_manager: Arc<AuthManager>,
        user_shell_override: crate::shell::Shell,
        supports_openai_form_elicitation: bool,
    ) -> CodexResult<NewThread> {
        let agent_control = self.agent_control_for_config(&config);
        let initial_history = self.initial_history_from_rollout_path(rollout_path).await?;
        let environments = default_thread_environment_selections(
            self.state.environment_manager.as_ref(),
            &config.cwd,
            &config.workspace_roots,
        );
        let (session_source, thread_source) = initial_history
            .get_resumed_session_sources()
            .unwrap_or_else(|| (self.state.session_source.clone(), None));
        Box::pin(self.state.spawn_thread_with_source(
            config,
            initial_history,
            /*history_mode*/ None,
            /*allow_provider_model_fallback*/ false,
            auth_manager,
            agent_control,
            session_source,
            /*agent_type*/ None,
            HostedAgentProvisioningLineage::default(),
            /*parent_thread_id*/ None,
            /*forked_from_thread_id*/ None,
            thread_source,
            Vec::new(),
            /*metrics_service_name*/ None,
            /*inherited_environments*/ None,
            /*inherited_exec_policy*/ None,
            /*parent_trace*/ None,
            environments,
            /*thread_extension_init*/ ExtensionDataInit::default(),
            supports_openai_form_elicitation,
            /*user_shell_override*/ Some(user_shell_override),
        ))
        .await
    }

    /// Removes the thread from the manager's internal map, though the thread is stored
    /// as `Arc<CodexThread>`, it is possible that other references to it exist elsewhere.
    /// Any hosted runtime owned by the thread is also unregistered and released.
    /// Returns the thread if the thread was found and removed.
    pub async fn remove_thread(&self, thread_id: &ThreadId) -> Option<Arc<CodexThread>> {
        self.state.remove_thread(thread_id).await
    }

    /// Permanently clears service-side durable references after local thread deletion.
    pub async fn clear_deleted_hosted_references(
        &self,
        thread_id: ThreadId,
        lease_id: String,
        expected_revision: u64,
    ) -> CodexResult<u64> {
        match self
            .state
            .thread_store
            .read_thread(ReadThreadParams {
                thread_id,
                include_archived: true,
                include_history: false,
            })
            .await
        {
            Ok(_) => {
                return Err(CodexErr::InvalidRequest(format!(
                    "hosted references cannot be cleared while thread {thread_id} still exists"
                )));
            }
            Err(ThreadStoreError::ThreadNotFound { .. }) => {}
            Err(ThreadStoreError::InvalidRequest { message })
                if message == format!("no rollout found for thread id {thread_id}") => {}
            Err(error) => return Err(thread_store_rollout_read_error(error)),
        }
        let provisioner = match &self.state.hosted_agent_provisioner {
            Ok(Some(provisioner)) => provisioner,
            Ok(None) => {
                return Err(CodexErr::Fatal(
                    "hosted-agent provisioner is unavailable during reference clear".to_string(),
                ));
            }
            Err(error) => return Err(CodexErr::Fatal(error.to_string())),
        };
        provisioner
            .clear_references(thread_id, lease_id, expected_revision)
            .await
            .map(|retained| retained.revision)
            .map_err(|error| CodexErr::Fatal(error.to_string()))
    }

    /// Returns whether a hosted runtime is still retained for finalization or cleanup retry.
    pub async fn hosted_runtime_cleanup_pending(&self, thread_id: ThreadId) -> bool {
        self.state
            .hosted_agent_runtimes
            .read()
            .await
            .get(&thread_id)
            .is_some_and(|runtime| {
                matches!(
                    runtime.snapshot().lifecycle_state,
                    codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization
                        | codex_hosted_agent::HostedAgentLifecycleState::Completed
                        | codex_hosted_agent::HostedAgentLifecycleState::ReleasePending
                )
            })
    }

    /// Retries only a retained hosted finalization or release, without removing a thread session.
    pub async fn retry_hosted_runtime_cleanup(&self, thread_id: ThreadId) {
        self.state.retry_hosted_runtime_cleanup(thread_id).await;
    }

    /// Returns whether the thread currently owns any hosted runtime generation.
    pub async fn has_hosted_runtime(&self, thread_id: ThreadId) -> bool {
        self.state
            .hosted_agent_runtimes
            .read()
            .await
            .contains_key(&thread_id)
    }

    /// Tries to shut down all tracked threads concurrently within the provided timeout.
    /// Threads that complete shutdown are removed from the manager; incomplete shutdowns
    /// remain tracked so callers can retry or inspect them later.
    pub async fn shutdown_all_threads_bounded(&self, timeout: Duration) -> ThreadShutdownReport {
        let threads = {
            let threads = self.state.threads.read().await;
            threads
                .iter()
                .map(|(thread_id, thread)| (*thread_id, Arc::clone(thread)))
                .collect::<Vec<_>>()
        };

        let mut shutdowns = threads
            .into_iter()
            .map(|(thread_id, thread)| async move {
                let outcome = match tokio::time::timeout(timeout, thread.shutdown_and_wait()).await
                {
                    Ok(Ok(())) => ShutdownOutcome::Complete,
                    Ok(Err(_)) => ShutdownOutcome::SubmitFailed,
                    Err(_) => ShutdownOutcome::TimedOut,
                };
                (thread_id, outcome)
            })
            .collect::<FuturesUnordered<_>>();
        let mut report = ThreadShutdownReport::default();

        while let Some((thread_id, outcome)) = shutdowns.next().await {
            match outcome {
                ShutdownOutcome::Complete => report.completed.push(thread_id),
                ShutdownOutcome::SubmitFailed => report.submit_failed.push(thread_id),
                ShutdownOutcome::TimedOut => report.timed_out.push(thread_id),
            }
        }

        join_all(
            report
                .completed
                .iter()
                .map(|thread_id| self.state.remove_thread(thread_id)),
        )
        .await;

        report
            .completed
            .sort_by_key(std::string::ToString::to_string);
        report
            .submit_failed
            .sort_by_key(std::string::ToString::to_string);
        report
            .timed_out
            .sort_by_key(std::string::ToString::to_string);
        report
    }

    /// Fork an existing thread by snapshotting rollout history according to
    /// `snapshot` and starting a new thread with identical configuration
    /// (unless overridden by the caller's `config`). The new thread will have
    /// a fresh id.
    pub async fn fork_thread<S>(
        &self,
        snapshot: S,
        config: Config,
        path: PathBuf,
        thread_source: Option<ThreadSource>,
        parent_trace: Option<W3cTraceContext>,
    ) -> CodexResult<NewThread>
    where
        S: Into<ForkSnapshot>,
    {
        let snapshot = snapshot.into();
        let history = self.initial_history_from_rollout_path(path).await?;
        self.fork_thread_from_history(
            snapshot,
            config,
            history,
            thread_source,
            parent_trace,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
    }

    async fn initial_history_from_rollout_path(
        &self,
        rollout_path: PathBuf,
    ) -> CodexResult<InitialHistory> {
        let requested_rollout_path = rollout_path.clone();
        let stored_thread = self
            .state
            .thread_store
            .read_thread_by_rollout_path(ReadThreadByRolloutPathParams {
                rollout_path,
                include_archived: true,
                include_history: true,
            })
            .await
            .map_err(thread_store_rollout_read_error)?;
        stored_thread_to_initial_history(stored_thread, Some(requested_rollout_path))
    }

    /// Fork an existing thread from already-loaded store history.
    pub async fn fork_thread_from_history<S>(
        &self,
        snapshot: S,
        config: Config,
        history: InitialHistory,
        thread_source: Option<ThreadSource>,
        parent_trace: Option<W3cTraceContext>,
        supports_openai_form_elicitation: bool,
    ) -> CodexResult<NewThread>
    where
        S: Into<ForkSnapshot>,
    {
        self.fork_thread_with_initial_history(
            snapshot.into(),
            config,
            history,
            thread_source,
            parent_trace,
            supports_openai_form_elicitation,
        )
        .await
    }

    async fn fork_thread_with_initial_history(
        &self,
        snapshot: ForkSnapshot,
        config: Config,
        history: InitialHistory,
        thread_source: Option<ThreadSource>,
        parent_trace: Option<W3cTraceContext>,
        supports_openai_form_elicitation: bool,
    ) -> CodexResult<NewThread> {
        // `forked_from_id()` describes this history's existing lineage. When
        // forking a resumed thread, the child copies the resumed thread itself.
        let source_thread_id = match &history {
            InitialHistory::Resumed(resumed) => Some(resumed.conversation_id),
            InitialHistory::Forked(_) => history.forked_from_id(),
            InitialHistory::New | InitialHistory::Cleared => None,
        };
        let multi_agent_version = self
            .state
            .effective_multi_agent_version_for_spawn(
                &history,
                /*session_source*/ None,
                /*parent_thread_id*/ None,
                source_thread_id,
                &config,
            )
            .await;
        let interrupted_marker =
            InterruptedTurnHistoryMarker::from_config_and_version(&config, multi_agent_version);
        let history = fork_history_from_snapshot(snapshot, history, interrupted_marker);
        let environments = default_thread_environment_selections(
            self.state.environment_manager.as_ref(),
            &config.cwd,
            &config.workspace_roots,
        );
        let agent_control = self.agent_control_for_config(&config);
        Box::pin(self.state.spawn_thread(
            config,
            history,
            Arc::clone(&self.state.auth_manager),
            agent_control,
            HostedAgentProvisioningLineage::forked_from(source_thread_id),
            /*parent_thread_id*/ None,
            source_thread_id,
            thread_source,
            Vec::new(),
            /*metrics_service_name*/ None,
            parent_trace,
            environments,
            /*thread_extension_init*/ ExtensionDataInit::default(),
            supports_openai_form_elicitation,
            /*user_shell_override*/ None,
        ))
        .await
    }

    pub(crate) fn agent_control(&self) -> AgentControl {
        AgentControl::new(Arc::downgrade(&self.state), /*rollout_budget*/ None)
    }

    fn agent_control_for_config(&self, config: &Config) -> AgentControl {
        AgentControl::new(Arc::downgrade(&self.state), config.rollout_budget.clone())
    }

    #[cfg(test)]
    pub(crate) fn captured_ops(&self) -> Vec<(ThreadId, Op)> {
        self.state
            .ops_log
            .as_ref()
            .and_then(|ops_log| ops_log.lock().ok().map(|log| log.clone()))
            .unwrap_or_default()
    }
}

impl ThreadManagerState {
    pub(crate) async fn prepare_hosted_runtime(
        &self,
        thread_id: ThreadId,
        config: &mut Config,
        initial_history: &InitialHistory,
        session_source: &SessionSource,
        requested_agent_type: Option<String>,
        hosted_lineage: HostedAgentProvisioningLineage,
    ) -> CodexResult<Option<PendingHostedAgentRuntime>> {
        let requested_agent_type = match requested_agent_type {
            Some(agent_type) => {
                let agent_type = agent_type.trim();
                if agent_type.is_empty() {
                    return Err(CodexErr::InvalidRequest(
                        "agentType must not be blank".to_string(),
                    ));
                }
                Some(agent_type.to_string())
            }
            None => None,
        };
        if !config.hosted_agents.enabled {
            if requested_agent_type.is_some() {
                return Err(CodexErr::InvalidRequest(
                    "agentType requires hosted agents to be enabled".to_string(),
                ));
            }
            return Ok(None);
        }
        if config.ephemeral {
            return Err(CodexErr::InvalidRequest(
                "hosted agents require durable thread persistence".to_string(),
            ));
        }
        config.permissions.approval_policy = Constrained::allow_only(AskForApproval::Never);
        config
            .permissions
            .replace_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(
                PermissionProfile::External {
                    network: NetworkSandboxPolicy::Enabled,
                },
            ))
            .map_err(|error| {
                CodexErr::Fatal(format!(
                    "failed to apply hosted-agent runtime permissions: {error}"
                ))
            })?;
        config.permissions.network = None;
        let provisioner = match &self.hosted_agent_provisioner {
            Ok(Some(provisioner)) => provisioner,
            Ok(None) => {
                return Err(CodexErr::Fatal(
                    "hosted agents are enabled without a configured provisioner".to_string(),
                ));
            }
            Err(error) => {
                return Err(CodexErr::Fatal(format!(
                    "failed to initialize hosted-agent service: {error}"
                )));
            }
        };
        if let InitialHistory::Resumed(resumed) = initial_history {
            let record = self
                .thread_store
                .get_hosted_agent_runtime(resumed.conversation_id)
                .await
                .map_err(|error| {
                    CodexErr::Fatal(format!(
                        "failed to read hosted-agent runtime for thread {}: {error}",
                        resumed.conversation_id
                    ))
                })?
                .ok_or_else(|| {
                    CodexErr::InvalidRequest(format!(
                        "thread {} has no persisted hosted-agent runtime metadata",
                        resumed.conversation_id
                    ))
                })?;
            match record.lifecycle_state {
                codex_hosted_agent::HostedAgentLifecycleState::Active => {
                    return provisioner
                        .reconnect_or_restore(thread_id, record)
                        .await
                        .map(Some)
                        .map_err(|error| CodexErr::Fatal(error.to_string()));
                }
                codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization => {
                    if !self
                        .hosted_agent_runtimes
                        .read()
                        .await
                        .contains_key(&thread_id)
                    {
                        let pending = provisioner
                            .reconnect_or_restore(thread_id, record)
                            .await
                            .map_err(|error| CodexErr::Fatal(error.to_string()))?;
                        let (runtime, code_mode_provider) = self
                            .persist_pending_hosted_runtime(thread_id, pending)
                            .await?;
                        self.hosted_agent_runtimes.write().await.insert(
                            thread_id,
                            Arc::new(HostedAgentRuntimeEntry::new(runtime, code_mode_provider)),
                        );
                        self.record_active_hosted_lease_count().await;
                    }
                    let recovered_state = self.retry_pending_hosted_finalization(thread_id).await?;
                    if recovered_state == codex_hosted_agent::HostedAgentLifecycleState::Released {
                        self.hosted_agent_runtimes.write().await.remove(&thread_id);
                    }
                }
                codex_hosted_agent::HostedAgentLifecycleState::Completed
                | codex_hosted_agent::HostedAgentLifecycleState::ReleasePending => {
                    if record.last_exported_patch.is_none() {
                        return Err(CodexErr::Fatal(format!(
                            "hosted-agent thread {} is finalized without a patch artifact",
                            resumed.conversation_id
                        )));
                    }
                    let mut updated_record = record.clone();
                    match provisioner.release_durable_record(thread_id, record).await {
                        Ok(retained) => {
                            updated_record.reference_revision = Some(retained.revision);
                            updated_record.lifecycle_state =
                                codex_hosted_agent::HostedAgentLifecycleState::Released;
                        }
                        Err(error) => {
                            updated_record.lifecycle_state =
                                codex_hosted_agent::HostedAgentLifecycleState::ReleasePending;
                            warn!(
                                %error,
                                %thread_id,
                                "failed to retry hosted runtime cleanup during resume"
                            );
                        }
                    }
                    self.thread_store
                        .set_hosted_agent_runtime(thread_id, updated_record)
                        .await
                        .map_err(|error| {
                            CodexErr::Fatal(format!(
                                "failed to persist hosted-agent cleanup state for thread {thread_id}: {error}"
                            ))
                        })?;
                }
                codex_hosted_agent::HostedAgentLifecycleState::Released => {}
            }
            return Err(CodexErr::InvalidRequest(format!(
                "hosted-agent thread {} is finalized and cannot be resumed",
                resumed.conversation_id
            )));
        }
        let agent_type = requested_agent_type
            .or_else(|| session_source.get_agent_role())
            .unwrap_or_else(|| config.hosted_agents.default_agent_type.clone());
        let sandbox_template = config
            .agent_roles
            .get(&agent_type)
            .and_then(|role| role.sandbox_template.clone())
            .ok_or_else(|| {
                CodexErr::InvalidRequest(format!(
                    "agent role `{agent_type}` does not define a hosted sandbox template"
                ))
            })?;
        let source = match hosted_lineage.snapshot_source_thread_id {
            Some(snapshot_source_thread_id) => {
                let owner_runtime = self
                    .hosted_agent_runtimes
                    .read()
                    .await
                    .get(&snapshot_source_thread_id)
                    .cloned()
                    .ok_or_else(|| {
                        CodexErr::InvalidRequest(format!(
                            "hosted snapshot source thread {snapshot_source_thread_id} has no active runtime"
                        ))
                    })?;
                let owner_lease_id = owner_runtime.snapshot().lease_id;
                ProjectSnapshotSource::AgentEnvironment { owner_lease_id }
            }
            None => match &config.hosted_agents.source_snapshot {
                Some(source) => ProjectSnapshotSource::SourceSnapshot {
                    source_snapshot_id: source.source_snapshot_id.clone(),
                    checksum: source.checksum.clone(),
                },
                None => ProjectSnapshotSource::RootWorkspace {
                    cwd: PathUri::from_abs_path(&config.cwd),
                    workspace_roots: config
                        .workspace_roots
                        .iter()
                        .map(PathUri::from_abs_path)
                        .collect(),
                },
            },
        };
        let request = AgentProvisionRequest {
            agent_id: thread_id,
            owner_agent_id: hosted_lineage.owner_agent_id,
            agent_type,
            sandbox_template,
            source,
            idempotency_key: format!("hosted-agent:{thread_id}:provision"),
        };
        provisioner
            .provision(request)
            .await
            .map(Some)
            .map_err(|error| CodexErr::Fatal(error.to_string()))
    }

    pub(crate) async fn commit_hosted_runtime(
        &self,
        thread_id: ThreadId,
        pending: PendingHostedAgentRuntime,
    ) -> CodexResult<()> {
        let (runtime, code_mode_provider) = self
            .persist_pending_hosted_runtime(thread_id, pending)
            .await?;
        self.hosted_agent_runtimes.write().await.insert(
            thread_id,
            Arc::new(HostedAgentRuntimeEntry::new(runtime, code_mode_provider)),
        );
        self.record_active_hosted_lease_count().await;
        Ok(())
    }

    async fn record_active_hosted_lease_count(&self) {
        let active_lease_count = self
            .hosted_agent_runtimes
            .read()
            .await
            .values()
            .filter(|runtime| {
                matches!(
                    runtime.snapshot().lifecycle_state,
                    codex_hosted_agent::HostedAgentLifecycleState::Active
                        | codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization
                        | codex_hosted_agent::HostedAgentLifecycleState::Completed
                        | codex_hosted_agent::HostedAgentLifecycleState::ReleasePending
                )
            })
            .count();
        crate::hosted_agent_telemetry::record_active_leases(active_lease_count);
    }

    async fn persist_pending_hosted_runtime(
        &self,
        thread_id: ThreadId,
        mut pending: PendingHostedAgentRuntime,
    ) -> CodexResult<(
        HostedAgentRuntime,
        Option<Arc<codex_code_mode::HostedEnvironmentCodeModeSessionProvider>>,
    )> {
        if let Err(error) = pending.retain().await {
            let message = format!(
                "failed to retain hosted-agent durable state for thread {thread_id}: {error}"
            );
            if let Err(cleanup_error) = pending.rollback().await {
                warn!(error = %cleanup_error, %thread_id,
                    "failed to roll back hosted runtime after retention failed");
            }
            return Err(CodexErr::Fatal(message));
        }
        let record = pending.durable_record();
        let persistence_result = self
            .thread_store
            .set_hosted_agent_runtime(thread_id, record)
            .await;
        if let Err(error) = persistence_result {
            let message =
                format!("failed to persist hosted-agent runtime for thread {thread_id}: {error}");
            if let Err(cleanup_error) = pending.rollback().await {
                warn!(
                    error = %cleanup_error,
                    %thread_id,
                    "failed to roll back hosted runtime after persistence failed"
                );
            }
            return Err(CodexErr::Fatal(message));
        }
        Ok(pending.commit_with_provider())
    }

    pub(crate) async fn checkpoint_hosted_runtime(
        &self,
        thread_id: ThreadId,
        turn_id: &str,
    ) -> CodexResult<()> {
        let Some(runtime) = self
            .hosted_agent_runtimes
            .read()
            .await
            .get(&thread_id)
            .cloned()
        else {
            return Ok(());
        };
        let _operation_permit = Arc::clone(&runtime.operation_lock)
            .acquire_owned()
            .await
            .map_err(|_| {
                CodexErr::Fatal(format!(
                    "hosted runtime operation coordination closed for thread {thread_id}"
                ))
            })?;
        let runtime_snapshot = runtime.snapshot();
        let provisioner = match &self.hosted_agent_provisioner {
            Ok(Some(provisioner)) => provisioner,
            Ok(None) => {
                return Err(CodexErr::Fatal(
                    "hosted-agent provisioner is unavailable during checkpoint".to_string(),
                ));
            }
            Err(error) => {
                return Err(CodexErr::Fatal(format!(
                    "failed to initialize hosted-agent service: {error}"
                )));
            }
        };
        let checkpoint = provisioner
            .checkpoint(thread_id, turn_id, &runtime_snapshot)
            .await
            .map_err(|error| CodexErr::Fatal(error.to_string()))?;
        let mut updated_runtime = runtime_snapshot;
        updated_runtime.latest_snapshot_id = Some(checkpoint.snapshot_id);
        self.thread_store
            .set_hosted_agent_runtime(thread_id, updated_runtime.durable_record())
            .await
            .map_err(|error| {
                CodexErr::Fatal(format!(
                    "failed to persist hosted-agent checkpoint for thread {thread_id}: {error}"
                ))
            })?;
        runtime.replace(updated_runtime.clone());
        let retained = provisioner
            .retain(thread_id, &updated_runtime)
            .await
            .map_err(|error| CodexErr::Fatal(error.to_string()))?;
        updated_runtime.reference_revision = Some(retained.revision);
        self.thread_store
            .set_hosted_agent_runtime(thread_id, updated_runtime.durable_record())
            .await
            .map_err(|error| CodexErr::Fatal(format!(
                "failed to persist hosted-agent reference revision for thread {thread_id}: {error}"
            )))?;
        runtime.replace(updated_runtime);
        Ok(())
    }

    async fn rollback_pending_hosted_runtime(
        &self,
        thread_id: ThreadId,
        pending: Option<PendingHostedAgentRuntime>,
    ) {
        if let Some(pending) = pending
            && let Err(error) = pending.rollback().await
        {
            warn!(
                error = %error,
                %thread_id,
                "failed to roll back hosted runtime after thread registration failed"
            );
        }
    }

    async fn detach_stopped_hosted_runtime(&self, thread_id: ThreadId) -> CodexResult<()> {
        let Some(runtime) = self.hosted_agent_runtimes.write().await.remove(&thread_id) else {
            return Ok(());
        };
        let Ok(_operation_permit) = Arc::clone(&runtime.operation_lock).acquire_owned().await
        else {
            self.hosted_agent_runtimes
                .write()
                .await
                .insert(thread_id, runtime);
            return Err(CodexErr::Fatal(format!(
                "hosted runtime operation coordination closed for thread {thread_id}"
            )));
        };
        let runtime_snapshot = runtime.snapshot();
        if let Err(error) = self
            .environment_manager
            .remove_environment(&runtime_snapshot.environment_id)
            .await
        {
            self.hosted_agent_runtimes
                .write()
                .await
                .insert(thread_id, runtime);
            return Err(CodexErr::Fatal(format!(
                "failed to detach hosted environment for thread {thread_id}: {error}"
            )));
        }
        Ok(())
    }

    pub(crate) fn agent_graph_store(&self) -> Option<Arc<dyn AgentGraphStore>> {
        self.agent_graph_store.clone()
    }

    pub(crate) async fn list_thread_ids(&self) -> Vec<ThreadId> {
        self.threads
            .read()
            .await
            .iter()
            .filter_map(|(thread_id, thread)| {
                (!thread.session_source.is_internal()).then_some(*thread_id)
            })
            .collect()
    }

    /// List parent-child edges for currently loaded thread-spawn agents.
    pub(crate) async fn list_live_thread_spawn_edges(&self) -> Vec<(ThreadId, ThreadId)> {
        self.threads
            .read()
            .await
            .iter()
            .filter_map(|(thread_id, thread)| {
                if thread.session_source.is_internal() {
                    return None;
                }
                match &thread.session_source {
                    SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                        parent_thread_id,
                        ..
                    }) => Some((*parent_thread_id, *thread_id)),
                    _ => None,
                }
            })
            .collect()
    }

    /// Fetch a thread by ID or return ThreadNotFound.
    pub(crate) async fn get_thread(&self, thread_id: ThreadId) -> CodexResult<Arc<CodexThread>> {
        let threads = self.threads.read().await;
        match threads.get(&thread_id) {
            Some(thread) if !thread.session_source.is_internal() => Ok(thread.clone()),
            Some(_) | None => Err(CodexErr::ThreadNotFound(thread_id)),
        }
    }

    pub(crate) async fn read_stored_thread(
        &self,
        params: ReadThreadParams,
    ) -> CodexResult<StoredThread> {
        let thread_id = params.thread_id;
        self.thread_store
            .read_thread(params)
            .await
            .map_err(|err| match err {
                ThreadStoreError::ThreadNotFound { thread_id } => {
                    CodexErr::ThreadNotFound(thread_id)
                }
                ThreadStoreError::InvalidRequest { message } => {
                    if message.starts_with("no rollout found for thread id ") {
                        CodexErr::ThreadNotFound(thread_id)
                    } else {
                        CodexErr::Fatal(format!(
                            "failed to read stored thread {thread_id}: invalid thread-store request: {message}"
                        ))
                    }
                }
                err => CodexErr::Fatal(format!("failed to read stored thread {thread_id}: {err}")),
            })
    }

    pub(crate) async fn load_latest_model_context(
        &self,
        params: LoadThreadHistoryParams,
    ) -> CodexResult<StoredModelContext> {
        let thread_id = params.thread_id;
        self.thread_store
            .load_latest_model_context(params)
            .await
            .map_err(|err| match err {
                ThreadStoreError::ThreadNotFound { thread_id } => {
                    CodexErr::ThreadNotFound(thread_id)
                }
                err => CodexErr::Fatal(format!(
                    "failed to load model context for thread {thread_id}: {err}"
                )),
            })
    }

    /// Send an operation to a thread by ID.
    pub(crate) async fn send_op(&self, thread_id: ThreadId, op: Op) -> CodexResult<String> {
        let thread = self.get_thread(thread_id).await?;
        if let Some(ops_log) = &self.ops_log
            && let Ok(mut log) = ops_log.lock()
        {
            log.push((thread_id, op.clone()));
        }
        thread.submit(op).await
    }

    /// Remove a thread from the manager by ID, returning it when present.
    pub(crate) async fn remove_thread(&self, thread_id: &ThreadId) -> Option<Arc<CodexThread>> {
        let (thread, hosted_runtime) = {
            let (mut threads, mut hosted_agent_runtimes) =
                tokio::join!(self.threads.write(), self.hosted_agent_runtimes.write());
            (
                threads.remove(thread_id),
                hosted_agent_runtimes.remove(thread_id),
            )
        };
        self.release_removed_hosted_runtime(*thread_id, hosted_runtime)
            .await;

        thread
    }

    pub(crate) async fn release_hosted_runtime(&self, thread_id: ThreadId) {
        let hosted_runtime = self.hosted_agent_runtimes.write().await.remove(&thread_id);
        self.release_removed_hosted_runtime(thread_id, hosted_runtime)
            .await;
    }

    async fn retry_hosted_runtime_cleanup(&self, thread_id: ThreadId) {
        let hosted_runtime = {
            let mut runtimes = self.hosted_agent_runtimes.write().await;
            let should_retry = runtimes.get(&thread_id).is_some_and(|runtime| {
                matches!(
                    runtime.snapshot().lifecycle_state,
                    codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization
                        | codex_hosted_agent::HostedAgentLifecycleState::Completed
                        | codex_hosted_agent::HostedAgentLifecycleState::ReleasePending
                )
            });
            should_retry.then(|| runtimes.remove(&thread_id)).flatten()
        };
        self.release_removed_hosted_runtime(thread_id, hosted_runtime)
            .await;
    }

    pub(crate) async fn ensure_hosted_runtime_active(
        &self,
        thread_id: ThreadId,
    ) -> CodexResult<()> {
        let lifecycle_state = self
            .hosted_agent_runtimes
            .read()
            .await
            .get(&thread_id)
            .map(|runtime| runtime.snapshot().lifecycle_state);
        match lifecycle_state {
            None | Some(codex_hosted_agent::HostedAgentLifecycleState::Active) => Ok(()),
            Some(lifecycle_state) => Err(CodexErr::InvalidRequest(format!(
                "hosted agent {thread_id} cannot start another turn from lifecycle state {lifecycle_state:?}; spawn a new agent instead"
            ))),
        }
    }

    async fn release_removed_hosted_runtime(
        &self,
        thread_id: ThreadId,
        hosted_runtime: Option<SharedHostedAgentRuntime>,
    ) {
        if let Some(runtime) = hosted_runtime {
            if runtime.snapshot().lifecycle_state
                == codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization
            {
                self.hosted_agent_runtimes
                    .write()
                    .await
                    .insert(thread_id, Arc::clone(&runtime));
                match self.retry_pending_hosted_finalization(thread_id).await {
                    Ok(codex_hosted_agent::HostedAgentLifecycleState::Released) => {
                        self.hosted_agent_runtimes.write().await.remove(&thread_id);
                    }
                    Ok(
                        codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization
                        | codex_hosted_agent::HostedAgentLifecycleState::Completed
                        | codex_hosted_agent::HostedAgentLifecycleState::ReleasePending,
                    ) => {}
                    Ok(codex_hosted_agent::HostedAgentLifecycleState::Active) => {
                        warn!(%thread_id, "pending hosted finalization unexpectedly became active");
                    }
                    Err(error) => {
                        warn!(%error, %thread_id, "failed to retry pending hosted finalization during release");
                    }
                }
                self.record_active_hosted_lease_count().await;
                return;
            }
            let Ok(_operation_permit) = Arc::clone(&runtime.operation_lock).acquire_owned().await
            else {
                warn!(%thread_id, "hosted runtime operation coordination closed during release");
                self.hosted_agent_runtimes
                    .write()
                    .await
                    .entry(thread_id)
                    .or_insert(runtime);
                self.record_active_hosted_lease_count().await;
                return;
            };
            let mut runtime_value = runtime.snapshot();
            match runtime_value.lifecycle_state {
                codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization => {
                    self.hosted_agent_runtimes
                        .write()
                        .await
                        .entry(thread_id)
                        .or_insert(runtime);
                    self.record_active_hosted_lease_count().await;
                    return;
                }
                codex_hosted_agent::HostedAgentLifecycleState::Released => {
                    self.record_active_hosted_lease_count().await;
                    return;
                }
                codex_hosted_agent::HostedAgentLifecycleState::Active
                | codex_hosted_agent::HostedAgentLifecycleState::Completed
                | codex_hosted_agent::HostedAgentLifecycleState::ReleasePending => {}
            }
            if let Some(provider) = &runtime.code_mode_provider
                && let Err(error) = provider.shutdown().await
            {
                warn!(%error, %thread_id, "hosted code-mode runtime did not quiesce before forced lease cleanup");
            }
            let cleanup_result = match &self.hosted_agent_provisioner {
                Ok(Some(provisioner)) => {
                    provisioner.release(thread_id, runtime_value.clone()).await
                }
                Ok(None) => Err(
                    crate::hosted_agent_runtime::HostedAgentRuntimeError::Release(
                        HostedAgentError::new(
                            HostedAgentErrorCategory::Unavailable,
                            "hosted-agent provisioner is unavailable during thread removal",
                        ),
                    ),
                ),
                Err(error) => Err(
                    crate::hosted_agent_runtime::HostedAgentRuntimeError::Release(error.clone()),
                ),
            };
            match cleanup_result {
                Err(error) => {
                    runtime_value.lifecycle_state =
                        codex_hosted_agent::HostedAgentLifecycleState::ReleasePending;
                    runtime.replace(runtime_value.clone());
                    if let Err(persistence_error) = self
                        .thread_store
                        .set_hosted_agent_runtime(thread_id, runtime_value.durable_record())
                        .await
                    {
                        warn!(
                            %persistence_error,
                            %thread_id,
                            "failed to persist hosted runtime pending release"
                        );
                    }
                    warn!(
                        %error,
                        %thread_id,
                        "failed to release hosted runtime during thread removal"
                    );
                    self.hosted_agent_runtimes
                        .write()
                        .await
                        .entry(thread_id)
                        .or_insert(runtime);
                }
                Ok(retained) => {
                    runtime_value.reference_revision = Some(retained.revision);
                    runtime_value.lifecycle_state =
                        codex_hosted_agent::HostedAgentLifecycleState::Released;
                    if let Err(error) = self
                        .thread_store
                        .set_hosted_agent_runtime(thread_id, runtime_value.durable_record())
                        .await
                    {
                        warn!(
                            %error,
                            %thread_id,
                            "failed to persist released hosted runtime"
                        );
                        runtime_value.lifecycle_state =
                            codex_hosted_agent::HostedAgentLifecycleState::ReleasePending;
                        runtime.replace(runtime_value);
                        self.hosted_agent_runtimes
                            .write()
                            .await
                            .entry(thread_id)
                            .or_insert(runtime);
                    }
                }
            }
            self.record_active_hosted_lease_count().await;
        }
    }

    pub(crate) async fn effective_multi_agent_version_for_spawn(
        &self,
        initial_history: &InitialHistory,
        session_source: Option<&SessionSource>,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
        config: &Config,
    ) -> MultiAgentVersion {
        if let Some(multi_agent_version) = config.multi_agent_version_override() {
            return multi_agent_version;
        }
        self.initial_multi_agent_version_for_spawn(
            initial_history,
            session_source,
            parent_thread_id,
            forked_from_thread_id,
        )
        .await
        .unwrap_or_else(|| config.multi_agent_version_from_features())
    }

    async fn initial_multi_agent_version_for_spawn(
        &self,
        initial_history: &InitialHistory,
        session_source: Option<&SessionSource>,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
    ) -> Option<MultiAgentVersion> {
        let inherited_thread_id = match session_source {
            Some(SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id, ..
            })) => Some(*parent_thread_id),
            _ => match initial_history {
                InitialHistory::Resumed(resumed) => Some(resumed.conversation_id),
                InitialHistory::Forked(_) => forked_from_thread_id.or(parent_thread_id),
                InitialHistory::New | InitialHistory::Cleared => parent_thread_id,
            },
        };
        let inherited_multi_agent_version = match inherited_thread_id {
            Some(thread_id) => self
                .get_thread(thread_id)
                .await
                .ok()
                .and_then(|thread| thread.multi_agent_version()),
            None => None,
        };
        resolve_multi_agent_version(initial_history, inherited_multi_agent_version)
    }

    /// Resolves the provider snapshot for a newly spawned runtime.
    ///
    /// Loads a fresh provider snapshot for:
    /// - fresh root threads;
    /// - cold resumes;
    /// - root forks.
    ///
    /// Uses an existing snapshot for:
    /// - subagents, which inherit from their parent without invoking the
    ///   provider;
    /// - running resumes and compaction paths, which retain the live session.
    ///
    /// Provider warnings only apply to fresh loads. If a parent runtime is no
    /// longer available, its child starts without provider instructions rather
    /// than loading independently.
    async fn user_instructions_for_spawn(
        &self,
        session_source: &SessionSource,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
    ) -> LoadedUserInstructions {
        let is_root_agent = !session_source.is_non_root_agent();
        if is_root_agent {
            return self
                .user_instructions_provider
                .load_user_instructions()
                .await;
        }

        let inherited_thread_id = match session_source {
            SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id, ..
            }) => Some(*parent_thread_id),
            _ => parent_thread_id.or(forked_from_thread_id),
        };
        let instructions = match inherited_thread_id {
            // The spawn path retains only thread IDs, so look up the live
            // runtime again here to inherit its user instructions.
            Some(thread_id) => match self.get_thread(thread_id).await {
                Ok(thread) => thread.session.user_instructions().await,
                Err(_) => None,
            },
            None => None,
        };
        LoadedUserInstructions {
            instructions,
            warnings: Vec::new(),
        }
    }

    async fn inherited_originator_for_parent_thread(
        &self,
        session_source: &SessionSource,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
    ) -> Option<String> {
        let inherited_thread_id = match session_source {
            SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id, ..
            }) => Some(*parent_thread_id),
            _ => parent_thread_id.or(forked_from_thread_id),
        };
        let thread = self.get_thread(inherited_thread_id?).await.ok()?;
        let originator = thread.config_snapshot().await.originator;
        (!originator.is_empty()).then_some(originator)
    }

    async fn effective_originator(
        &self,
        initial_history: &InitialHistory,
        metrics_service_name: Option<&str>,
        session_source: &SessionSource,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
    ) -> String {
        let persisted_originator = initial_history.get_session_originator();
        let inherited_originator = match initial_history {
            InitialHistory::New | InitialHistory::Cleared => {
                self.inherited_originator_for_parent_thread(
                    session_source,
                    parent_thread_id,
                    forked_from_thread_id,
                )
                .await
            }
            InitialHistory::Forked(_) if persisted_originator.is_none() => {
                self.inherited_originator_for_parent_thread(
                    session_source,
                    parent_thread_id,
                    forked_from_thread_id,
                )
                .await
            }
            InitialHistory::Resumed(_) | InitialHistory::Forked(_) => None,
        };

        let env_originator = std::env::var(CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR)
            .is_ok()
            .then(|| originator().value);
        effective_originator_value(
            metrics_service_name,
            env_originator,
            persisted_originator,
            inherited_originator,
            originator().value,
        )
    }

    /// Spawn a new thread with no history using a provided config.
    pub(crate) async fn spawn_new_thread(
        &self,
        config: Config,
        agent_control: AgentControl,
    ) -> CodexResult<NewThread> {
        Box::pin(self.spawn_new_thread_with_source(
            config,
            agent_control,
            self.session_source.clone(),
            /*history_mode*/ None,
            /*parent_thread_id*/ None,
            /*forked_from_thread_id*/ None,
            /*thread_source*/ None,
            /*metrics_service_name*/ None,
            /*inherited_environments*/ None,
            /*inherited_exec_policy*/ None,
            /*environments*/ None,
        ))
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn spawn_new_thread_with_source(
        &self,
        config: Config,
        agent_control: AgentControl,
        session_source: SessionSource,
        history_mode: Option<ThreadHistoryMode>,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
        thread_source: Option<ThreadSource>,
        metrics_service_name: Option<String>,
        inherited_environments: Option<TurnEnvironmentSnapshot>,
        inherited_exec_policy: Option<Arc<crate::exec_policy::ExecPolicyManager>>,
        environments: Option<Vec<TurnEnvironmentSelection>>,
    ) -> CodexResult<NewThread> {
        let hosted_lineage = HostedAgentProvisioningLineage::for_subagent(
            &session_source,
            parent_thread_id,
            forked_from_thread_id,
        );
        let environments = environments.unwrap_or_else(|| {
            default_thread_environment_selections(
                self.environment_manager.as_ref(),
                &config.cwd,
                &config.workspace_roots,
            )
        });
        Box::pin(self.spawn_thread_with_source(
            config,
            InitialHistory::New,
            history_mode,
            /*allow_provider_model_fallback*/ false,
            Arc::clone(&self.auth_manager),
            agent_control,
            session_source,
            /*agent_type*/ None,
            hosted_lineage,
            parent_thread_id,
            forked_from_thread_id,
            thread_source,
            Vec::new(),
            metrics_service_name,
            inherited_environments,
            inherited_exec_policy,
            /*parent_trace*/ None,
            environments,
            /*thread_extension_init*/ ExtensionDataInit::default(),
            /*supports_openai_form_elicitation*/ false,
            /*user_shell_override*/ None,
        ))
        .await
    }

    pub(crate) async fn resume_thread_with_history_with_source(
        &self,
        options: ResumeThreadWithHistoryOptions,
    ) -> CodexResult<NewThread> {
        let ResumeThreadWithHistoryOptions {
            config,
            initial_history,
            agent_control,
            session_source,
            parent_thread_id,
            inherited_environments,
            inherited_exec_policy,
        } = options;
        let environments = default_thread_environment_selections(
            self.environment_manager.as_ref(),
            &config.cwd,
            &config.workspace_roots,
        );
        let thread_source = initial_history.get_resumed_thread_source();
        let hosted_lineage = HostedAgentProvisioningLineage::for_subagent(
            &session_source,
            parent_thread_id,
            /*forked_from_thread_id*/ None,
        );
        Box::pin(self.spawn_thread_with_source(
            config,
            initial_history,
            /*history_mode*/ None,
            /*allow_provider_model_fallback*/ false,
            Arc::clone(&self.auth_manager),
            agent_control,
            session_source,
            /*agent_type*/ None,
            hosted_lineage,
            parent_thread_id,
            /*forked_from_thread_id*/ None,
            thread_source,
            Vec::new(),
            /*metrics_service_name*/ None,
            inherited_environments,
            inherited_exec_policy,
            /*parent_trace*/ None,
            environments,
            /*thread_extension_init*/ ExtensionDataInit::default(),
            /*supports_openai_form_elicitation*/ false,
            /*user_shell_override*/ None,
        ))
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn fork_thread_with_source(
        &self,
        config: Config,
        initial_history: InitialHistory,
        history_mode: Option<ThreadHistoryMode>,
        agent_control: AgentControl,
        session_source: SessionSource,
        thread_source: Option<ThreadSource>,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
        inherited_environments: Option<TurnEnvironmentSnapshot>,
        inherited_exec_policy: Option<Arc<crate::exec_policy::ExecPolicyManager>>,
        environments: Option<Vec<TurnEnvironmentSelection>>,
        thread_extension_init: ExtensionDataInit,
    ) -> CodexResult<NewThread> {
        let hosted_lineage = HostedAgentProvisioningLineage::for_subagent(
            &session_source,
            parent_thread_id,
            forked_from_thread_id,
        );
        let environments = environments.unwrap_or_else(|| {
            default_thread_environment_selections(
                self.environment_manager.as_ref(),
                &config.cwd,
                &config.workspace_roots,
            )
        });
        Box::pin(self.spawn_thread_with_source(
            config,
            initial_history,
            history_mode,
            /*allow_provider_model_fallback*/ false,
            Arc::clone(&self.auth_manager),
            agent_control,
            session_source,
            /*agent_type*/ None,
            hosted_lineage,
            parent_thread_id,
            forked_from_thread_id,
            thread_source,
            Vec::new(),
            /*metrics_service_name*/ None,
            inherited_environments,
            inherited_exec_policy,
            /*parent_trace*/ None,
            environments,
            thread_extension_init,
            /*supports_openai_form_elicitation*/ false,
            /*user_shell_override*/ None,
        ))
        .await
    }

    /// Spawn a new thread with optional history and register it with the manager.
    #[allow(clippy::too_many_arguments)]
    async fn spawn_thread(
        &self,
        config: Config,
        initial_history: InitialHistory,
        auth_manager: Arc<AuthManager>,
        agent_control: AgentControl,
        hosted_lineage: HostedAgentProvisioningLineage,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
        thread_source: Option<ThreadSource>,
        dynamic_tools: Vec<codex_protocol::dynamic_tools::DynamicToolSpec>,
        metrics_service_name: Option<String>,
        parent_trace: Option<W3cTraceContext>,
        environments: Vec<TurnEnvironmentSelection>,
        thread_extension_init: ExtensionDataInit,
        supports_openai_form_elicitation: bool,
        user_shell_override: Option<crate::shell::Shell>,
    ) -> CodexResult<NewThread> {
        Box::pin(self.spawn_thread_with_source(
            config,
            initial_history,
            /*history_mode*/ None,
            /*allow_provider_model_fallback*/ false,
            auth_manager,
            agent_control,
            self.session_source.clone(),
            /*agent_type*/ None,
            hosted_lineage,
            parent_thread_id,
            forked_from_thread_id,
            thread_source,
            dynamic_tools,
            metrics_service_name,
            /*inherited_environments*/ None,
            /*inherited_exec_policy*/ None,
            parent_trace,
            environments,
            thread_extension_init,
            supports_openai_form_elicitation,
            user_shell_override,
        ))
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn spawn_thread_with_source(
        &self,
        mut config: Config,
        initial_history: InitialHistory,
        history_mode: Option<ThreadHistoryMode>,
        allow_provider_model_fallback: bool,
        auth_manager: Arc<AuthManager>,
        agent_control: AgentControl,
        session_source: SessionSource,
        agent_type: Option<String>,
        hosted_lineage: HostedAgentProvisioningLineage,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
        thread_source: Option<ThreadSource>,
        dynamic_tools: Vec<codex_protocol::dynamic_tools::DynamicToolSpec>,
        metrics_service_name: Option<String>,
        inherited_environments: Option<TurnEnvironmentSnapshot>,
        inherited_exec_policy: Option<Arc<crate::exec_policy::ExecPolicyManager>>,
        parent_trace: Option<W3cTraceContext>,
        environments: Vec<TurnEnvironmentSelection>,
        thread_extension_init: ExtensionDataInit,
        supports_openai_form_elicitation: bool,
        user_shell_override: Option<crate::shell::Shell>,
    ) -> CodexResult<NewThread> {
        let thread_id = thread_id_for_initial_history(&initial_history);
        let is_resumed_thread = matches!(&initial_history, InitialHistory::Resumed(_));
        if let InitialHistory::Resumed(resumed) = &initial_history {
            let stopped_thread = {
                let mut threads = self.threads.write().await;
                match threads.get(&resumed.conversation_id).cloned() {
                    Some(thread) if thread.is_running() => {
                        if let Some(requested_rollout_path) = resumed.rollout_path.as_deref()
                            && thread.rollout_path().as_deref() != Some(requested_rollout_path)
                        {
                            return Err(CodexErr::InvalidRequest(format!(
                                "thread {} is already running with a different rollout path",
                                resumed.conversation_id
                            )));
                        }
                        return Ok(NewThread {
                            thread_id: resumed.conversation_id,
                            session_configured: thread.session_configured(),
                            thread,
                        });
                    }
                    Some(_) => threads.remove(&resumed.conversation_id),
                    None => None,
                }
            };
            if let Some(stopped_thread) = stopped_thread
                && let Err(error) = self
                    .detach_stopped_hosted_runtime(resumed.conversation_id)
                    .await
            {
                self.threads
                    .write()
                    .await
                    .insert(resumed.conversation_id, stopped_thread);
                return Err(error);
            }
        }
        let user_instructions = self
            .user_instructions_for_spawn(&session_source, parent_thread_id, forked_from_thread_id)
            .await;
        let parent_rollout_thread_trace = self
            .parent_rollout_thread_trace_for_source(&session_source, &initial_history)
            .await;
        let tracked_session_source = session_source.clone();
        let multi_agent_version = self
            .initial_multi_agent_version_for_spawn(
                &initial_history,
                Some(&session_source),
                parent_thread_id,
                forked_from_thread_id,
            )
            .await;
        let originator = self
            .effective_originator(
                &initial_history,
                metrics_service_name.as_deref(),
                &session_source,
                parent_thread_id,
                forked_from_thread_id,
            )
            .await;
        let mut pending_hosted_runtime = self
            .prepare_hosted_runtime(
                thread_id,
                &mut config,
                &initial_history,
                &session_source,
                agent_type,
                hosted_lineage,
            )
            .await?;
        if config.hosted_agents.enabled && pending_hosted_runtime.is_none() {
            crate::hosted_agent_telemetry::record_local_fallback_attempt(
                crate::hosted_agent_telemetry::LocalFallbackPath::ThreadStart,
            );
            return Err(CodexErr::Fatal(
                "hosted thread provisioning returned no runtime; local fallback is disabled"
                    .to_string(),
            ));
        }
        let (environments, inherited_environments, inherited_exec_policy) =
            match pending_hosted_runtime.as_ref() {
                Some(pending) => (
                    vec![pending.environment_selection().clone()],
                    /*inherited_environments*/ None,
                    /*inherited_exec_policy*/ None,
                ),
                None => (environments, inherited_environments, inherited_exec_policy),
            };
        let hosted_tool_authorization = pending_hosted_runtime
            .as_ref()
            .map(PendingHostedAgentRuntime::tool_authorization);
        let code_mode_runtime_placement = match pending_hosted_runtime.as_ref() {
            Some(pending) => match pending.code_mode_provider() {
                Some(provider) => CodeModeRuntimePlacement::HostedEnvironment(provider),
                #[cfg(test)]
                None => {
                    CodeModeRuntimePlacement::Local(Arc::clone(&self.code_mode_session_provider))
                }
                #[cfg(not(test))]
                None => {
                    return Err(CodexErr::Fatal(
                        "hosted thread has no verified environment-bound code-mode provider"
                            .to_string(),
                    ));
                }
            },
            None => CodeModeRuntimePlacement::Local(Arc::clone(&self.code_mode_session_provider)),
        };
        let session_result = Box::pin(Session::spawn(SessionSpawnArgs {
            thread_id,
            config,
            allow_provider_model_fallback,
            user_instructions,
            installation_id: self.installation_id.clone(),
            auth_manager,
            models_manager: Arc::clone(&self.models_manager),
            environment_manager: Arc::clone(&self.environment_manager),
            skills_service: Arc::clone(&self.skills_service),
            plugins_manager: Arc::clone(&self.plugins_manager),
            mcp_manager: Arc::clone(&self.mcp_manager),
            code_mode_runtime_placement,
            extensions: Arc::clone(&self.extensions),
            conversation_history: initial_history,
            requested_history_mode: history_mode,
            session_source,
            forked_from_thread_id,
            parent_thread_id,
            thread_source,
            originator,
            agent_control,
            dynamic_tools,
            hosted_tool_authorization,
            metrics_service_name,
            inherited_environments,
            inherited_exec_policy,
            parent_rollout_thread_trace,
            user_shell_override,
            parent_trace,
            environment_selections: environments,
            thread_extension_init,
            supports_openai_form_elicitation,
            analytics_events_client: self.analytics_events_client.clone(),
            thread_store: Arc::clone(&self.thread_store),
            attestation_provider: self.attestation_provider.clone(),
            external_time_provider: self.external_time_provider.clone(),
            inherited_multi_agent_version: multi_agent_version,
        }))
        .await;
        let (session, io) = match session_result {
            Ok(session) => session,
            Err(error) => {
                if let Some(pending) = pending_hosted_runtime.take()
                    && let Err(cleanup_error) = pending.rollback().await
                {
                    warn!(
                        error = %cleanup_error,
                        thread_id = %thread_id,
                        "failed to roll back hosted runtime after session startup failed"
                    );
                }
                return Err(error);
            }
        };
        let new_thread = self
            .finalize_thread_spawn(session, io, tracked_session_source, pending_hosted_runtime)
            .await?;
        if is_resumed_thread {
            new_thread.thread.emit_thread_resume_lifecycle().await;
        }
        Ok(new_thread)
    }

    async fn finalize_thread_spawn(
        &self,
        session: Arc<Session>,
        io: SessionIo,
        session_source: SessionSource,
        mut pending_hosted_runtime: Option<PendingHostedAgentRuntime>,
    ) -> CodexResult<NewThread> {
        let thread_id = session.thread_id();
        let event = match io.next_event().await {
            Ok(event) => event,
            Err(error) => {
                if let Err(err) = io.shutdown_and_wait().await {
                    warn!("failed to shut down uninitialized thread {thread_id}: {err}");
                }
                self.rollback_pending_hosted_runtime(thread_id, pending_hosted_runtime.take())
                    .await;
                return Err(error);
            }
        };
        let session_configured = match event {
            Event {
                id,
                msg: EventMsg::SessionConfigured(session_configured),
            } if id == INITIAL_SUBMIT_ID => session_configured,
            _ => {
                if let Err(err) = io.shutdown_and_wait().await {
                    warn!("failed to shut down incorrectly initialized thread {thread_id}: {err}");
                }
                self.rollback_pending_hosted_runtime(thread_id, pending_hosted_runtime.take())
                    .await;
                return Err(CodexErr::SessionConfiguredNotFirstEvent);
            }
        };

        if pending_hosted_runtime.is_some()
            && let Err(error) = session.try_ensure_rollout_materialized().await
        {
            if let Err(err) = io.shutdown_and_wait().await {
                warn!("failed to shut down hosted thread {thread_id}: {err}");
            }
            self.rollback_pending_hosted_runtime(thread_id, pending_hosted_runtime.take())
                .await;
            return Err(CodexErr::Fatal(format!(
                "failed to materialize hosted thread {thread_id}: {error}"
            )));
        }

        let hosted_runtime = match pending_hosted_runtime.take() {
            Some(pending) => match self
                .persist_pending_hosted_runtime(thread_id, pending)
                .await
            {
                Ok(runtime) => Some(runtime),
                Err(error) => {
                    if let Err(err) = io.shutdown_and_wait().await {
                        warn!("failed to shut down hosted thread {thread_id}: {err}");
                    }
                    return Err(error);
                }
            },
            None => None,
        };

        {
            let (mut threads, mut hosted_agent_runtimes) =
                tokio::join!(self.threads.write(), self.hosted_agent_runtimes.write());
            if let std::collections::hash_map::Entry::Vacant(e) = threads.entry(thread_id) {
                let thread = Arc::new(CodexThread::new(
                    session,
                    io,
                    session_configured.clone(),
                    session_configured.rollout_path.clone(),
                    session_source,
                ));
                e.insert(thread.clone());
                if let Some((runtime, code_mode_provider)) = hosted_runtime {
                    hosted_agent_runtimes.insert(
                        thread_id,
                        Arc::new(HostedAgentRuntimeEntry::new(runtime, code_mode_provider)),
                    );
                }
                return Ok(NewThread {
                    thread_id,
                    thread,
                    session_configured,
                });
            }
        }

        if let Err(err) = io.shutdown_and_wait().await {
            warn!("failed to shut down duplicate thread {thread_id}: {err}");
        }
        self.release_removed_hosted_runtime(
            thread_id,
            hosted_runtime.map(|(runtime, code_mode_provider)| {
                Arc::new(HostedAgentRuntimeEntry::new(runtime, code_mode_provider))
            }),
        )
        .await;
        Err(CodexErr::InvalidRequest(format!(
            "thread {thread_id} is already running"
        )))
    }

    pub(crate) fn notify_thread_created(&self, thread_id: ThreadId) {
        let _ = self.thread_created_tx.send(thread_id);
    }

    async fn parent_rollout_thread_trace_for_source(
        &self,
        session_source: &SessionSource,
        initial_history: &InitialHistory,
    ) -> codex_rollout_trace::ThreadTraceContext {
        // A fresh v2 child belongs to the same rollout tree as its parent, so
        // session startup derives its child trace from the parent's thread
        // context. Resumed children already have a prior `ThreadStarted` event
        // for this thread id; deriving a child trace during resume would write
        // that start event again and make the bundle unreplayable.
        let SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
            parent_thread_id, ..
        }) = session_source
        else {
            return codex_rollout_trace::ThreadTraceContext::disabled();
        };
        if matches!(initial_history, InitialHistory::Resumed(_)) {
            return codex_rollout_trace::ThreadTraceContext::disabled();
        }
        // Parent lookup can fail if the parent was closed or released between
        // spawn preparation and session construction. Tracing is diagnostic, so
        // that race should not block child creation; the child simply starts
        // without a parent rollout trace.
        self.get_thread(*parent_thread_id)
            .await
            .ok()
            .map(|thread| thread.session.services.rollout_thread_trace.clone())
            .unwrap_or_else(codex_rollout_trace::ThreadTraceContext::disabled)
    }
}

fn stored_thread_to_initial_history(
    stored_thread: StoredThread,
    rollout_path: Option<PathBuf>,
) -> CodexResult<InitialHistory> {
    let thread_id = stored_thread.thread_id;
    let history = stored_thread.history.ok_or_else(|| {
        CodexErr::Fatal(format!(
            "thread {thread_id} did not include persisted history"
        ))
    })?;
    Ok(InitialHistory::Resumed(ResumedHistory {
        conversation_id: thread_id,
        history: Arc::new(history.items),
        rollout_path: rollout_path.or(stored_thread.rollout_path),
    }))
}

fn thread_store_rollout_read_error(err: ThreadStoreError) -> CodexErr {
    match err {
        ThreadStoreError::ThreadNotFound { thread_id } => CodexErr::ThreadNotFound(thread_id),
        ThreadStoreError::InvalidRequest { message } => CodexErr::InvalidRequest(message),
        err => CodexErr::Fatal(format!("failed to read thread by rollout path: {err}")),
    }
}

fn thread_store_metadata_update_error(thread_id: ThreadId, err: ThreadStoreError) -> CodexErr {
    match err {
        ThreadStoreError::ThreadNotFound { thread_id } => CodexErr::ThreadNotFound(thread_id),
        ThreadStoreError::InvalidRequest { message } => CodexErr::InvalidRequest(message),
        ThreadStoreError::Unsupported { operation } => CodexErr::UnsupportedOperation(format!(
            "thread metadata update is not supported by this store: {operation}"
        )),
        err => CodexErr::Fatal(format!(
            "failed to update thread metadata {thread_id}: {err}"
        )),
    }
}

/// Return a fork snapshot cut strictly before the nth user message (0-based).
///
/// Out-of-range values keep the full committed history at a turn boundary, but
/// when the source thread is currently mid-turn they fall back to cutting
/// before the active turn's opening boundary so the fork omits the unfinished
/// suffix entirely.
fn truncate_before_nth_user_message(
    history: InitialHistory,
    n: usize,
    snapshot_state: &SnapshotTurnState,
) -> InitialHistory {
    let items = history.get_rollout_items().to_vec();
    let user_positions = truncation::user_message_positions_in_rollout(&items);
    let rolled = if snapshot_state.ends_mid_turn && n >= user_positions.len() {
        if let Some(cut_idx) = snapshot_state
            .active_turn_start_index
            .or_else(|| user_positions.last().copied())
        {
            items[..cut_idx].to_vec()
        } else {
            items
        }
    } else {
        truncation::truncate_rollout_before_nth_user_message_from_start(&items, n)
    };

    if rolled.is_empty() {
        InitialHistory::New
    } else {
        InitialHistory::Forked(rolled)
    }
}

#[derive(Debug, Eq, PartialEq)]
struct SnapshotTurnState {
    ends_mid_turn: bool,
    active_turn_id: Option<String>,
    active_turn_started_at: Option<i64>,
    active_turn_start_index: Option<usize>,
}

fn snapshot_turn_state(history: &InitialHistory) -> SnapshotTurnState {
    let rollout_items = history.get_rollout_items();
    let mut builder = ThreadHistoryBuilder::new();
    for item in rollout_items {
        builder.handle_rollout_item(item);
    }
    let active_turn_id = builder.active_turn_id_if_explicit();
    if builder.has_active_turn() && active_turn_id.is_some() {
        let active_turn_snapshot = builder.active_turn_snapshot();
        if active_turn_snapshot
            .as_ref()
            .is_some_and(|turn| turn.status != TurnStatus::InProgress)
        {
            return SnapshotTurnState {
                ends_mid_turn: false,
                active_turn_id: None,
                active_turn_started_at: None,
                active_turn_start_index: None,
            };
        }

        return SnapshotTurnState {
            ends_mid_turn: true,
            active_turn_id,
            active_turn_started_at: active_turn_snapshot.and_then(|turn| turn.started_at),
            active_turn_start_index: builder.active_turn_start_index(),
        };
    }

    let Some(last_user_position) = truncation::user_message_positions_in_rollout(rollout_items)
        .last()
        .copied()
    else {
        return SnapshotTurnState {
            ends_mid_turn: false,
            active_turn_id: None,
            active_turn_started_at: None,
            active_turn_start_index: None,
        };
    };

    // Synthetic fork/resume histories can contain user/assistant response items
    // without explicit turn lifecycle events. If the persisted snapshot has no
    // terminating boundary after its last user message, treat it as mid-turn.
    SnapshotTurnState {
        ends_mid_turn: !rollout_items[last_user_position + 1..].iter().any(|item| {
            matches!(
                item,
                RolloutItem::EventMsg(EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_))
            )
        }),
        active_turn_id: None,
        active_turn_started_at: None,
        active_turn_start_index: None,
    }
}

fn fork_history_from_snapshot(
    snapshot: ForkSnapshot,
    history: InitialHistory,
    interrupted_marker: InterruptedTurnHistoryMarker,
) -> InitialHistory {
    let snapshot_state = snapshot_turn_state(&history);
    match snapshot {
        ForkSnapshot::TruncateBeforeNthUserMessage(nth_user_message) => {
            truncate_before_nth_user_message(history, nth_user_message, &snapshot_state)
        }
        ForkSnapshot::Interrupted => {
            let history = match history {
                InitialHistory::New => InitialHistory::New,
                InitialHistory::Cleared => InitialHistory::Cleared,
                InitialHistory::Forked(history) => InitialHistory::Forked(history),
                InitialHistory::Resumed(resumed) => {
                    InitialHistory::Forked(Arc::unwrap_or_clone(resumed.history))
                }
            };
            if snapshot_state.ends_mid_turn {
                append_interrupted_boundary(
                    history,
                    snapshot_state.active_turn_id,
                    snapshot_state.active_turn_started_at,
                    interrupted_marker,
                )
            } else {
                history
            }
        }
    }
}

/// Append the same persisted interrupt boundary used by the live interrupt path
/// to an existing fork snapshot after the source thread has been confirmed to
/// be mid-turn.
fn append_interrupted_boundary(
    history: InitialHistory,
    turn_id: Option<String>,
    started_at: Option<i64>,
    interrupted_marker: InterruptedTurnHistoryMarker,
) -> InitialHistory {
    let aborted_event = RolloutItem::EventMsg(EventMsg::TurnAborted(TurnAbortedEvent {
        turn_id,
        reason: TurnAbortReason::Interrupted,
        started_at,
        completed_at: None,
        duration_ms: None,
    }));

    match history {
        InitialHistory::New | InitialHistory::Cleared => {
            let mut history = Vec::new();
            if let Some(marker) = interrupted_turn_history_marker(interrupted_marker) {
                history.push(RolloutItem::ResponseItem(marker));
            }
            history.push(aborted_event);
            InitialHistory::Forked(history)
        }
        InitialHistory::Forked(mut history) => {
            if let Some(marker) = interrupted_turn_history_marker(interrupted_marker) {
                history.push(RolloutItem::ResponseItem(marker));
            }
            history.push(aborted_event);
            InitialHistory::Forked(history)
        }
        InitialHistory::Resumed(resumed) => {
            let mut history = Arc::unwrap_or_clone(resumed.history);
            if let Some(marker) = interrupted_turn_history_marker(interrupted_marker) {
                history.push(RolloutItem::ResponseItem(marker));
            }
            history.push(aborted_event);
            InitialHistory::Forked(history)
        }
    }
}

#[cfg(test)]
#[path = "thread_manager_tests.rs"]
mod tests;
