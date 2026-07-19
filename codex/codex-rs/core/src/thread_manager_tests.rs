use super::*;
use crate::codex_thread::CodexThreadSettingsOverrides;
use crate::config::test_config;
use crate::init_state_db;
use crate::installation_id::INSTALLATION_ID_FILENAME;
use crate::rollout::RolloutRecorder;
use crate::session::session::SessionSettingsUpdate;
use crate::session::tests::build_world_state_from_turn_context;
use crate::session::tests::make_session_and_context;
use crate::tasks::InterruptedTurnHistoryMarker;
use crate::tasks::interrupted_turn_history_marker;
use codex_extension_api::empty_extension_registry;
use codex_hosted_agent::HostedAgentService;
use codex_models_manager::manager::RefreshStrategy;
use codex_protocol::ResponseItemId;
use codex_protocol::capabilities::CapabilityRootLocation;
use codex_protocol::capabilities::SelectedCapabilityRoot;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ReasoningItemReasoningSummary;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ModelsResponse;
use codex_protocol::protocol::AgentMessageEvent;
use codex_protocol::protocol::InitialHistory;
use codex_protocol::protocol::InternalSessionSource;
use codex_protocol::protocol::ResumedHistory;
use codex_protocol::protocol::SessionMeta;
use codex_protocol::protocol::SessionMetaLine;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::ThreadSource;
use codex_protocol::protocol::TurnAbortReason;
use codex_protocol::protocol::TurnAbortedEvent;
use codex_protocol::protocol::TurnCompleteEvent;
use codex_protocol::protocol::TurnStartedEvent;
use codex_protocol::protocol::UserMessageEvent;
use codex_utils_path_uri::PathUri;
use core_test_support::PathBufExt;
use core_test_support::PathExt;
use core_test_support::responses::mount_models_once;
use pretty_assertions::assert_eq;
use std::time::Duration;
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;
use wiremock::MockServer;

const TEST_INSTALLATION_ID: &str = "11111111-1111-4111-8111-111111111111";

struct FakeAgentGraphStore {
    root_thread_id: ThreadId,
    descendant_thread_ids: Vec<ThreadId>,
}

impl codex_agent_graph_store::AgentGraphStore for FakeAgentGraphStore {
    fn upsert_thread_spawn_edge(
        &self,
        _parent_thread_id: ThreadId,
        _child_thread_id: ThreadId,
        _status: codex_agent_graph_store::ThreadSpawnEdgeStatus,
    ) -> codex_agent_graph_store::AgentGraphStoreFuture<'_, ()> {
        Box::pin(async { panic!("unexpected graph upsert") })
    }

    fn set_thread_spawn_edge_status(
        &self,
        _child_thread_id: ThreadId,
        _status: codex_agent_graph_store::ThreadSpawnEdgeStatus,
    ) -> codex_agent_graph_store::AgentGraphStoreFuture<'_, ()> {
        Box::pin(async { panic!("unexpected graph status update") })
    }

    fn list_thread_spawn_children(
        &self,
        _parent_thread_id: ThreadId,
        _status_filter: Option<codex_agent_graph_store::ThreadSpawnEdgeStatus>,
    ) -> codex_agent_graph_store::AgentGraphStoreFuture<'_, Vec<ThreadId>> {
        Box::pin(async { panic!("unexpected direct-child listing") })
    }

    fn list_thread_spawn_descendants(
        &self,
        root_thread_id: ThreadId,
        status_filter: Option<codex_agent_graph_store::ThreadSpawnEdgeStatus>,
    ) -> codex_agent_graph_store::AgentGraphStoreFuture<'_, Vec<ThreadId>> {
        assert_eq!(root_thread_id, self.root_thread_id);
        assert_eq!(status_filter, None);
        let descendant_thread_ids = self.descendant_thread_ids.clone();
        Box::pin(async move { Ok(descendant_thread_ids) })
    }
}

fn user_msg(text: &str) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![ContentItem::OutputText {
            text: text.to_string(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}
fn assistant_msg(text: &str) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: "assistant".to_string(),
        content: vec![ContentItem::OutputText {
            text: text.to_string(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}

fn contextual_user_interrupted_marker() -> ResponseItem {
    interrupted_turn_history_marker(InterruptedTurnHistoryMarker::ContextualUser)
        .expect("contextual-user interrupted marker should be enabled")
}

fn developer_interrupted_marker() -> ResponseItem {
    interrupted_turn_history_marker(InterruptedTurnHistoryMarker::Developer)
        .expect("developer interrupted marker should be enabled")
}

fn start_thread_options(config: Config) -> StartThreadOptions {
    StartThreadOptions {
        config,
        allow_provider_model_fallback: false,
        initial_history: InitialHistory::New,
        history_mode: None,
        session_source: None,
        thread_source: None,
        dynamic_tools: Vec::new(),
        metrics_service_name: None,
        parent_trace: None,
        environments: Vec::new(),
        thread_extension_init: ExtensionDataInit::default(),
        supports_openai_form_elicitation: false,
    }
}

async fn hosted_thread_manager_for_tests() -> (
    tempfile::TempDir,
    Config,
    ThreadManager,
    Arc<codex_hosted_agent::FakeHostedAgentService>,
) {
    hosted_thread_manager_with_durable_store_for_tests(/*durable_store*/ true).await
}

async fn hosted_thread_manager_with_durable_store_for_tests(
    durable_store: bool,
) -> (
    tempfile::TempDir,
    Config,
    ThreadManager,
    Arc<codex_hosted_agent::FakeHostedAgentService>,
) {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = temp_dir.path().join("workspace").abs();
    config.workspace_roots = vec![config.cwd.clone()];
    config.hosted_agents = crate::config::HostedAgentsConfig {
        enabled: true,
        service_url: Some("https://hosted.invalid".to_string()),
        default_agent_type: "default".to_string(),
        source_snapshot: None,
    };
    config.agent_roles.insert(
        "default".to_string(),
        crate::config::AgentRoleConfig {
            description: Some("Hosted test agent".to_string()),
            sandbox_template: Some("general-v1".to_string()),
            ..Default::default()
        },
    );
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");
    std::fs::create_dir_all(&config.cwd).expect("create workspace");

    let environment_manager = Arc::new(EnvironmentManager::without_environments());
    let mut manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::clone(&environment_manager),
    );
    let hosted_service = Arc::new(codex_hosted_agent::FakeHostedAgentService::default());
    let provisioner = Arc::new(HostedAgentProvisioner::new(
        Arc::clone(&hosted_service),
        environment_manager,
    ));
    let manager_state =
        Arc::get_mut(&mut manager.state).expect("new thread manager state must be unshared");
    manager_state.hosted_agent_provisioner = Ok(Some(provisioner));
    if durable_store {
        let state_db = codex_state::StateRuntime::init(
            config.sqlite_home.clone(),
            config.model_provider_id.clone(),
        )
        .await
        .expect("state db should initialize");
        manager_state.thread_store = Arc::new(LocalThreadStore::new(
            LocalThreadStoreConfig::from_config(&config),
            Some(state_db),
        ));
    }

    (temp_dir, config, manager, hosted_service)
}

fn hosted_provision_request(
    service: &codex_hosted_agent::FakeHostedAgentService,
    thread_id: ThreadId,
) -> codex_hosted_agent::AgentProvisionRequest {
    service
        .provision_request(&format!("hosted-agent:{thread_id}:provision"))
        .expect("hosted provision request")
}

async fn start_hosted_owned_agent(
    manager: &ThreadManager,
    config: &Config,
) -> (NewThread, NewThread) {
    let owner = manager
        .start_thread_with_options(start_thread_options(config.clone()))
        .await
        .expect("start hosted owner");
    let agent = manager
        .spawn_subagent(owner.thread_id, start_thread_options(config.clone()))
        .await
        .expect("spawn hosted owned agent");
    (owner, agent)
}

async fn grant_hosted_patch_application(manager: &ThreadManager, thread_id: ThreadId) {
    let runtime = manager
        .state
        .hosted_agent_runtimes
        .read()
        .await
        .get(&thread_id)
        .cloned()
        .expect("hosted runtime");
    let mut value = runtime.snapshot();
    value
        .tool_policy
        .allowed_domains
        .insert(codex_tools::ToolExecutionDomainKind::ControlPlane);
    value
        .tool_policy
        .allowed_tools
        .insert(codex_tools::ToolName::plain(
            crate::thread_manager::hosted_agent_patch_apply::HOSTED_AGENT_PATCH_APPLY_TOOL_NAME,
        ));
    runtime.replace(value);
}

#[tokio::test]
async fn hosted_runtime_is_durable_and_checkpoints_only_successful_turns() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let root = manager
        .start_thread_with_options(start_thread_options(config))
        .await
        .expect("start hosted root");
    let request = hosted_provision_request(&hosted_service, root.thread_id);
    let lease_id = hosted_service
        .provisioned_lease_id(&request.idempotency_key)
        .expect("hosted lease");
    let initial_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(root.thread_id)
        .await
        .expect("read initial hosted runtime")
        .expect("initial hosted runtime record");
    assert_eq!(
        initial_record,
        codex_hosted_agent::HostedAgentRuntimeRecord {
            owner_agent_id: request.owner_agent_id,
            agent_type: request.agent_type,
            sandbox_template: request.sandbox_template,
            lease_id: lease_id.clone(),
            environment_id: hosted_service.provisioned_environment_ids()[0].clone(),
            base_snapshot_id: initial_record.base_snapshot_id.clone(),
            latest_snapshot_id: Some(initial_record.base_snapshot_id.clone()),
            last_exported_patch: None,
            reference_revision: initial_record.reference_revision,
            lifecycle_state: codex_hosted_agent::HostedAgentLifecycleState::Active,
        }
    );

    hosted_service.set_checkpoint_failure(Some(codex_hosted_agent::HostedAgentError::new(
        codex_hosted_agent::HostedAgentErrorCategory::Unavailable,
        "checkpoint unavailable",
    )));
    let failed_turn = root
        .thread
        .session
        .new_default_turn_with_sub_id("failed-checkpoint-turn".to_string())
        .await;
    root.thread
        .session
        .send_event(
            &failed_turn,
            EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: failed_turn.sub_id.clone(),
                last_agent_message: Some("done".to_string()),
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
                time_to_first_token_ms: None,
            }),
        )
        .await;
    assert_eq!(
        manager
            .state
            .thread_store
            .get_hosted_agent_runtime(root.thread_id)
            .await
            .expect("read hosted runtime after failed checkpoint"),
        Some(initial_record.clone())
    );

    hosted_service.set_checkpoint_failure(None);
    let completed_turn = root
        .thread
        .session
        .new_default_turn_with_sub_id("completed-turn".to_string())
        .await;
    root.thread
        .session
        .send_event(
            &completed_turn,
            EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: completed_turn.sub_id.clone(),
                last_agent_message: Some("done".to_string()),
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
                time_to_first_token_ms: None,
            }),
        )
        .await;
    let checkpointed_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(root.thread_id)
        .await
        .expect("read checkpointed hosted runtime")
        .expect("checkpointed hosted runtime record");
    assert_eq!(
        checkpointed_record.latest_snapshot_id,
        hosted_service.latest_snapshot_id(&lease_id)
    );
    assert_ne!(checkpointed_record, initial_record);

    let aborted_turn = root
        .thread
        .session
        .new_default_turn_with_sub_id("aborted-turn".to_string())
        .await;
    root.thread
        .session
        .send_event(
            &aborted_turn,
            EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id: Some(aborted_turn.sub_id.clone()),
                reason: TurnAbortReason::Interrupted,
                started_at: None,
                completed_at: None,
                duration_ms: None,
            }),
        )
        .await;
    assert_eq!(
        manager
            .state
            .thread_store
            .get_hosted_agent_runtime(root.thread_id)
            .await
            .expect("read hosted runtime after aborted turn"),
        Some(checkpointed_record)
    );

    let report = manager
        .shutdown_all_threads_bounded(Duration::from_secs(10))
        .await;
    assert_eq!(report.completed, vec![root.thread_id]);
}

#[tokio::test]
async fn hosted_finalization_persists_patch_notifies_owner_and_releases() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let mut patch_available = manager.subscribe_hosted_agent_patch_available();
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    let owner_thread_id = owner.thread_id;
    let request = hosted_provision_request(&hosted_service, agent.thread_id);
    let lease_id = hosted_service
        .provisioned_lease_id(&request.idempotency_key)
        .expect("hosted lease");
    let initial_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read initial agent runtime")
        .expect("initial agent runtime record");
    assert_eq!(initial_record.owner_agent_id, Some(owner_thread_id));
    let environment_id = initial_record.environment_id.clone();

    let error = manager
        .state
        .finalize_hosted_runtime(agent.thread_id, ThreadId::new())
        .await
        .expect_err("non-owner must not finalize hosted agent");
    assert!(error.to_string().contains("does not own hosted agent"));
    assert_eq!(
        manager
            .state
            .thread_store
            .get_hosted_agent_runtime(agent.thread_id)
            .await
            .expect("read runtime after unauthorized finalization"),
        Some(initial_record)
    );

    let artifact = manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner_thread_id)
        .await
        .expect("finalize hosted agent")
        .expect("hosted patch artifact");
    assert_eq!(
        patch_available.recv().await.expect("patch notification"),
        HostedAgentPatchAvailable {
            owner_thread_id,
            artifact: artifact.clone(),
        }
    );
    let record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read finalized runtime")
        .expect("finalized runtime record");
    assert_eq!(record.last_exported_patch, Some(artifact));
    assert_eq!(
        record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::Released
    );
    assert_eq!(
        record.latest_snapshot_id,
        hosted_service.latest_snapshot_id(&lease_id)
    );
    assert_eq!(hosted_service.active_lease_count(), 1);
    assert!(
        manager
            .state
            .environment_manager
            .get_environment(&environment_id)
            .is_none()
    );

    let report = manager
        .shutdown_all_threads_bounded(Duration::from_secs(10))
        .await;
    assert_eq!(report.completed.len(), 2);
}

#[tokio::test]
async fn hosted_patch_apply_persists_checkpoint_and_retry_is_idempotent() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    let artifact = manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner.thread_id)
        .await
        .expect("finalize hosted agent")
        .expect("hosted patch artifact");
    grant_hosted_patch_application(&manager, owner.thread_id).await;
    let initial_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(owner.thread_id)
        .await
        .expect("read owner runtime")
        .expect("owner runtime record");

    assert_eq!(
        manager
            .apply_hosted_agent_patch(owner.thread_id, agent.thread_id, &artifact.artifact_id,)
            .await
            .expect("apply hosted patch"),
        HostedAgentPatchApplyResult::Applied
    );
    let applied_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(owner.thread_id)
        .await
        .expect("read applied owner runtime")
        .expect("applied owner runtime record");
    assert_ne!(
        applied_record.latest_snapshot_id,
        initial_record.latest_snapshot_id
    );
    assert_eq!(
        applied_record.latest_snapshot_id,
        hosted_service.latest_snapshot_id(&applied_record.lease_id)
    );
    assert_eq!(
        manager
            .state
            .hosted_agent_runtimes
            .read()
            .await
            .get(&owner.thread_id)
            .expect("owner runtime")
            .snapshot()
            .latest_snapshot_id,
        applied_record.latest_snapshot_id
    );

    assert_eq!(
        manager
            .apply_hosted_agent_patch(owner.thread_id, agent.thread_id, &artifact.artifact_id,)
            .await
            .expect("retry hosted patch"),
        HostedAgentPatchApplyResult::Applied
    );
    assert_eq!(
        manager
            .state
            .thread_store
            .get_hosted_agent_runtime(owner.thread_id)
            .await
            .expect("read retried owner runtime"),
        Some(applied_record)
    );
}

#[tokio::test]
async fn hosted_patch_apply_conflict_leaves_owner_unchanged() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    let artifact = manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner.thread_id)
        .await
        .expect("finalize hosted agent")
        .expect("hosted patch artifact");
    grant_hosted_patch_application(&manager, owner.thread_id).await;
    let conflict_path = PathUri::parse("file:///workspace/conflicted.rs").expect("conflict path");
    hosted_service.set_patch_conflict(&artifact.artifact_id, vec![conflict_path.clone()]);
    let initial_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(owner.thread_id)
        .await
        .expect("read owner runtime")
        .expect("owner runtime record");

    assert_eq!(
        manager
            .apply_hosted_agent_patch(owner.thread_id, agent.thread_id, &artifact.artifact_id,)
            .await
            .expect("apply conflicting hosted patch"),
        HostedAgentPatchApplyResult::Conflict {
            paths: vec![conflict_path],
        }
    );
    assert_eq!(
        manager
            .state
            .thread_store
            .get_hosted_agent_runtime(owner.thread_id)
            .await
            .expect("read owner runtime after conflict"),
        Some(initial_record)
    );
}

#[tokio::test]
async fn hosted_patch_apply_rejects_missing_policy_stale_artifact_and_non_owner() {
    let (_temp_dir, config, manager, _hosted_service) = hosted_thread_manager_for_tests().await;
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    let artifact = manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner.thread_id)
        .await
        .expect("finalize hosted agent")
        .expect("hosted patch artifact");
    let owner_before = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(owner.thread_id)
        .await
        .expect("read owner runtime")
        .expect("owner runtime record");

    assert!(matches!(
        manager
            .apply_hosted_agent_patch(owner.thread_id, agent.thread_id, &artifact.artifact_id,)
            .await
            .expect("policy rejection"),
        HostedAgentPatchApplyResult::Rejected { .. }
    ));

    grant_hosted_patch_application(&manager, owner.thread_id).await;
    assert!(matches!(
        manager
            .apply_hosted_agent_patch(owner.thread_id, agent.thread_id, "stale-artifact")
            .await
            .expect("stale artifact rejection"),
        HostedAgentPatchApplyResult::Rejected { .. }
    ));

    let unrelated_owner = manager
        .start_thread_with_options(start_thread_options(config))
        .await
        .expect("start unrelated hosted owner");
    grant_hosted_patch_application(&manager, unrelated_owner.thread_id).await;
    assert!(matches!(
        manager
            .apply_hosted_agent_patch(
                unrelated_owner.thread_id,
                agent.thread_id,
                &artifact.artifact_id,
            )
            .await
            .expect("ownership rejection"),
        HostedAgentPatchApplyResult::Rejected { .. }
    ));
    assert_eq!(
        manager
            .state
            .thread_store
            .get_hosted_agent_runtime(owner.thread_id)
            .await
            .expect("read unchanged owner runtime"),
        Some(owner_before)
    );
}

#[tokio::test]
async fn finalized_hosted_agent_rejects_followup_turns() {
    let (_temp_dir, config, manager, _hosted_service) = hosted_thread_manager_for_tests().await;
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner.thread_id)
        .await
        .expect("finalize hosted agent")
        .expect("hosted patch artifact");

    manager
        .state
        .ensure_hosted_runtime_active(owner.thread_id)
        .await
        .expect("active hosted owner can start another turn");
    let error = manager
        .state
        .ensure_hosted_runtime_active(agent.thread_id)
        .await
        .expect_err("finalized hosted agent must reject a followup turn");
    assert!(error.to_string().contains("spawn a new agent instead"));
}

#[tokio::test]
async fn hosted_finalization_checkpoint_failure_preserves_pending_lease() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let mut patch_available = manager.subscribe_hosted_agent_patch_available();
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    hosted_service.set_checkpoint_failure(Some(codex_hosted_agent::HostedAgentError::new(
        codex_hosted_agent::HostedAgentErrorCategory::Unavailable,
        "checkpoint unavailable",
    )));

    let error = manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner.thread_id)
        .await
        .expect_err("failed checkpoint must keep completion pending");
    assert!(
        error
            .to_string()
            .contains("failed to checkpoint hosted-agent lease")
    );
    let record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read pending runtime")
        .expect("pending runtime record");
    assert_eq!(
        record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization
    );
    assert_eq!(record.last_exported_patch, None);
    assert_eq!(hosted_service.active_lease_count(), 2);
    assert!(matches!(
        patch_available.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    let report = manager
        .shutdown_all_threads_bounded(Duration::from_secs(10))
        .await;
    assert_eq!(report.completed.len(), 2);
    assert_eq!(hosted_service.active_lease_count(), 1);
}

#[tokio::test]
async fn hosted_finalization_export_failure_persists_checkpoint_and_preserves_lease() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let mut patch_available = manager.subscribe_hosted_agent_patch_available();
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    let request = hosted_provision_request(&hosted_service, agent.thread_id);
    let lease_id = hosted_service
        .provisioned_lease_id(&request.idempotency_key)
        .expect("hosted lease");
    hosted_service.set_export_failure(Some(codex_hosted_agent::HostedAgentError::new(
        codex_hosted_agent::HostedAgentErrorCategory::Unavailable,
        "export unavailable",
    )));

    let error = manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner.thread_id)
        .await
        .expect_err("failed export must keep completion pending");
    assert!(
        error
            .to_string()
            .contains("failed to export hosted-agent patch")
    );
    let record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read pending runtime")
        .expect("pending runtime record");
    assert_eq!(
        record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization
    );
    assert_eq!(
        record.latest_snapshot_id,
        hosted_service.latest_snapshot_id(&lease_id)
    );
    assert_ne!(record.latest_snapshot_id, Some(record.base_snapshot_id));
    assert_eq!(record.last_exported_patch, None);
    assert_eq!(hosted_service.active_lease_count(), 2);
    assert!(matches!(
        patch_available.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn hosted_finalization_failure_persists_error_before_failed_completion() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    hosted_service.set_export_failure(Some(codex_hosted_agent::HostedAgentError::new(
        codex_hosted_agent::HostedAgentErrorCategory::Unavailable,
        "export unavailable",
    )));
    let mut turn = agent
        .thread
        .session
        .new_default_turn_with_sub_id("hosted-finalization-failure".to_string())
        .await;
    Arc::get_mut(&mut turn)
        .expect("new turn context must be uniquely owned")
        .parent_thread_id = Some(owner.thread_id);

    agent
        .thread
        .session
        .send_event(
            &turn,
            EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: turn.sub_id.clone(),
                last_agent_message: Some("done".to_string()),
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
                time_to_first_token_ms: None,
            }),
        )
        .await;
    let mut terminal_events = Vec::new();
    while terminal_events.len() < 2 {
        let event = tokio::time::timeout(Duration::from_secs(5), agent.thread.next_event())
            .await
            .expect("timed out waiting for finalization events")
            .expect("read finalization event");
        match event.msg {
            EventMsg::Error(error) if error.message.contains("failed to finalize hosted agent") => {
                terminal_events.push(EventMsg::Error(error));
            }
            EventMsg::TurnComplete(event) if event.turn_id == turn.sub_id => {
                terminal_events.push(EventMsg::TurnComplete(event));
            }
            _ => {}
        }
    }
    let [EventMsg::Error(error), EventMsg::TurnComplete(completion)] = terminal_events.as_slice()
    else {
        panic!("expected Error followed by TurnComplete, got {terminal_events:?}");
    };
    assert_eq!(completion.error.as_ref(), Some(error));
    assert!(matches!(
        agent.thread.agent_status().await,
        codex_protocol::protocol::AgentStatus::Errored(_)
    ));
}

#[tokio::test]
async fn hosted_finalization_release_failure_is_durable_and_cleanup_retries() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let mut patch_available = manager.subscribe_hosted_agent_patch_available();
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    hosted_service.set_release_failure(Some(codex_hosted_agent::HostedAgentError::new(
        codex_hosted_agent::HostedAgentErrorCategory::Unavailable,
        "release unavailable",
    )));

    let artifact = manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner.thread_id)
        .await
        .expect("durable artifact makes finalization successful")
        .expect("hosted patch artifact");
    assert_eq!(
        patch_available
            .recv()
            .await
            .expect("patch notification")
            .artifact,
        artifact
    );
    let record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read release-pending runtime")
        .expect("release-pending runtime record");
    assert_eq!(
        record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::ReleasePending
    );
    assert!(
        manager
            .hosted_runtime_cleanup_pending(agent.thread_id)
            .await
    );
    assert_eq!(hosted_service.active_lease_count(), 2);

    hosted_service.set_release_failure(None);
    manager.retry_hosted_runtime_cleanup(agent.thread_id).await;
    let record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read released runtime")
        .expect("released runtime record");
    assert_eq!(
        record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::Released
    );
    assert!(
        !manager
            .hosted_runtime_cleanup_pending(agent.thread_id)
            .await
    );
    assert_eq!(hosted_service.active_lease_count(), 1);
}

#[tokio::test]
async fn hosted_cleanup_retry_does_not_remove_an_active_runtime_generation() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let root = manager
        .start_thread_with_options(start_thread_options(config))
        .await
        .expect("start hosted root");

    manager.retry_hosted_runtime_cleanup(root.thread_id).await;

    assert!(manager.get_thread(root.thread_id).await.is_ok());
    manager
        .state
        .ensure_hosted_runtime_active(root.thread_id)
        .await
        .expect("cleanup retry must preserve active generation");
    assert_eq!(hosted_service.active_lease_count(), 1);
}

#[tokio::test]
async fn removing_pending_finalization_retries_before_releasing_the_runtime() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    hosted_service.set_checkpoint_failure(Some(codex_hosted_agent::HostedAgentError::new(
        codex_hosted_agent::HostedAgentErrorCategory::Unavailable,
        "checkpoint unavailable",
    )));
    manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner.thread_id)
        .await
        .expect_err("initial finalization must remain pending");
    agent
        .thread
        .shutdown_and_wait()
        .await
        .expect("stop pending hosted agent");
    let mut patch_available = manager.subscribe_hosted_agent_patch_available();

    assert!(manager.remove_thread(&agent.thread_id).await.is_some());
    let still_pending_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read still-pending runtime")
        .expect("still-pending runtime record");
    assert_eq!(
        still_pending_record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization
    );
    assert_eq!(hosted_service.active_lease_count(), 2);
    assert!(matches!(
        patch_available.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    hosted_service.set_checkpoint_failure(None);
    assert!(manager.remove_thread(&agent.thread_id).await.is_none());
    let released_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read finalized runtime")
        .expect("finalized runtime record");
    let notification = patch_available.recv().await.expect("patch notification");

    assert_eq!(notification.owner_thread_id, owner.thread_id);
    assert_eq!(
        released_record.last_exported_patch,
        Some(notification.artifact)
    );
    assert_eq!(
        released_record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::Released
    );
    assert!(
        manager
            .state
            .hosted_agent_runtimes
            .read()
            .await
            .get(&agent.thread_id)
            .is_none()
    );
    assert_eq!(hosted_service.active_lease_count(), 1);
}

#[tokio::test]
async fn hosted_startup_rolls_back_when_runtime_metadata_cannot_be_stored() {
    let (_temp_dir, config, manager, hosted_service) =
        hosted_thread_manager_with_durable_store_for_tests(/*durable_store*/ false).await;
    let error = match manager
        .start_thread_with_options(start_thread_options(config))
        .await
    {
        Ok(_) => panic!("hosted startup must require durable runtime storage"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("failed to persist hosted-agent runtime")
    );
    assert_eq!(hosted_service.active_lease_count(), 0);
    for environment_id in hosted_service.provisioned_environment_ids() {
        assert!(
            manager
                .state
                .environment_manager
                .get_environment(&environment_id)
                .is_none()
        );
    }
    assert!(manager.state.hosted_agent_runtimes.read().await.is_empty());
}

#[tokio::test]
async fn hosted_provision_failure_leaves_no_thread_runtime_environment_or_lease() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    hosted_service.set_provision_failure(Some(codex_hosted_agent::HostedAgentError::new(
        codex_hosted_agent::HostedAgentErrorCategory::QuotaExceeded,
        "test quota exhausted",
    )));
    let initial_thread_ids = manager.list_thread_ids().await;

    let error = match manager
        .start_thread_with_options(start_thread_options(config))
        .await
    {
        Ok(_) => panic!("hosted provision failure must prevent thread startup"),
        Err(error) => error,
    };

    assert!(error.to_string().contains("test quota exhausted"));
    assert_eq!(manager.list_thread_ids().await, initial_thread_ids);
    assert!(manager.state.hosted_agent_runtimes.read().await.is_empty());
    assert_eq!(
        manager.state.environment_manager.default_environment_ids(),
        Vec::<String>::new()
    );
    assert_eq!(hosted_service.active_lease_count(), 0);
    assert!(hosted_service.provisioned_environment_ids().is_empty());
}

#[tokio::test]
async fn stopped_hosted_thread_reconnects_without_releasing_its_lease() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let root = manager
        .start_thread_with_options(start_thread_options(config.clone()))
        .await
        .expect("start hosted root");
    let original_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(root.thread_id)
        .await
        .expect("read hosted runtime")
        .expect("hosted runtime record");
    root.thread
        .shutdown_and_wait()
        .await
        .expect("stop hosted thread");

    let resumed = manager
        .resume_thread_with_history(
            config,
            InitialHistory::Resumed(ResumedHistory {
                conversation_id: root.thread_id,
                history: Arc::new(Vec::new()),
                rollout_path: root.session_configured.rollout_path.clone(),
            }),
            manager.auth_manager(),
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("resume hosted thread");
    let resumed_runtime = manager
        .state
        .hosted_agent_runtimes
        .read()
        .await
        .get(&root.thread_id)
        .expect("resumed runtime")
        .snapshot();
    assert_eq!(resumed_runtime.lease_id, original_record.lease_id);
    assert_eq!(hosted_service.active_lease_count(), 1);
    assert_eq!(hosted_service.provisioned_environment_ids().len(), 1);

    resumed
        .thread
        .shutdown_and_wait()
        .await
        .expect("stop resumed thread");
    manager.remove_thread(&resumed.thread_id).await;
}

#[tokio::test]
async fn pending_finalization_resume_finishes_without_starting_a_new_turn() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let (owner, agent) = start_hosted_owned_agent(&manager, &config).await;
    hosted_service.set_export_failure(Some(codex_hosted_agent::HostedAgentError::new(
        codex_hosted_agent::HostedAgentErrorCategory::Unavailable,
        "export unavailable",
    )));
    manager
        .state
        .finalize_hosted_runtime(agent.thread_id, owner.thread_id)
        .await
        .expect_err("initial finalization must remain pending");
    let pending_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read pending runtime")
        .expect("pending runtime record");
    assert_eq!(
        pending_record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::PendingFinalization
    );
    agent
        .thread
        .shutdown_and_wait()
        .await
        .expect("stop pending hosted agent");
    hosted_service.set_export_failure(None);
    let mut patch_available = manager.subscribe_hosted_agent_patch_available();

    let error = match manager
        .resume_thread_with_history(
            config,
            InitialHistory::Resumed(ResumedHistory {
                conversation_id: agent.thread_id,
                history: Arc::new(Vec::new()),
                rollout_path: agent.session_configured.rollout_path.clone(),
            }),
            manager.auth_manager(),
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
    {
        Ok(_) => panic!("finalized hosted agent must not start another turn"),
        Err(error) => error,
    };
    let released_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(agent.thread_id)
        .await
        .expect("read recovered runtime")
        .expect("recovered runtime record");
    let notification = patch_available.recv().await.expect("patch notification");

    assert!(
        error
            .to_string()
            .contains("is finalized and cannot be resumed")
    );
    assert_eq!(
        released_record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::Released
    );
    assert_eq!(notification.owner_thread_id, owner.thread_id);
    assert_eq!(
        released_record.last_exported_patch,
        Some(notification.artifact)
    );
    assert!(manager.get_thread(agent.thread_id).await.is_err());
    assert_eq!(hosted_service.active_lease_count(), 1);
    assert_eq!(hosted_service.provisioned_environment_ids().len(), 2);
}

#[tokio::test]
async fn completed_hosted_thread_resume_retries_release_without_restoring() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let root = manager
        .start_thread_with_options(start_thread_options(config.clone()))
        .await
        .expect("start hosted root");
    let mut record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(root.thread_id)
        .await
        .expect("read hosted runtime")
        .expect("hosted runtime record");
    let artifact = codex_hosted_agent::AgentPatchArtifact {
        artifact_id: "artifact-completed-resume".to_string(),
        agent_id: root.thread_id,
        base_snapshot_id: record.base_snapshot_id.clone(),
        checksum: "sha256:completed-resume".to_string(),
        changed_files: 1,
        size_bytes: 128,
    };
    hosted_service.register_patch_artifact(artifact.clone());
    record.last_exported_patch = Some(artifact);
    record.lifecycle_state = codex_hosted_agent::HostedAgentLifecycleState::Completed;
    manager
        .state
        .thread_store
        .set_hosted_agent_runtime(root.thread_id, record)
        .await
        .expect("persist completed runtime");
    root.thread
        .shutdown_and_wait()
        .await
        .expect("stop hosted thread");

    let error = match manager
        .resume_thread_with_history(
            config,
            InitialHistory::Resumed(ResumedHistory {
                conversation_id: root.thread_id,
                history: Arc::new(Vec::new()),
                rollout_path: root.session_configured.rollout_path.clone(),
            }),
            manager.auth_manager(),
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
    {
        Ok(_) => panic!("completed hosted thread must not resume"),
        Err(error) => error,
    };
    let released_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(root.thread_id)
        .await
        .expect("read released hosted runtime")
        .expect("released hosted runtime record");

    assert!(
        error
            .to_string()
            .contains("is finalized and cannot be resumed")
    );
    assert_eq!(
        released_record.lifecycle_state,
        codex_hosted_agent::HostedAgentLifecycleState::Released
    );
    assert_eq!(hosted_service.active_lease_count(), 0);
    assert_eq!(hosted_service.provisioned_environment_ids().len(), 1);
}

#[tokio::test]
async fn stopped_hosted_thread_restores_a_missing_lease_and_persists_it() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let root = manager
        .start_thread_with_options(start_thread_options(config.clone()))
        .await
        .expect("start hosted root");
    let original_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(root.thread_id)
        .await
        .expect("read hosted runtime")
        .expect("hosted runtime record");
    root.thread
        .shutdown_and_wait()
        .await
        .expect("stop hosted thread");
    hosted_service
        .release(codex_hosted_agent::AgentReleaseRequest {
            lease_id: original_record.lease_id.clone(),
            idempotency_key: format!("hosted-agent:{}:expire-before-restore", root.thread_id),
        })
        .await
        .expect("expire lease before restore");

    let resumed = manager
        .resume_thread_with_history(
            config,
            InitialHistory::Resumed(ResumedHistory {
                conversation_id: root.thread_id,
                history: Arc::new(Vec::new()),
                rollout_path: root.session_configured.rollout_path.clone(),
            }),
            manager.auth_manager(),
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("restore hosted thread");
    let restored_record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(root.thread_id)
        .await
        .expect("read restored runtime")
        .expect("restored runtime record");
    assert_ne!(restored_record.lease_id, original_record.lease_id);
    assert_ne!(
        restored_record.environment_id,
        original_record.environment_id
    );
    assert_eq!(
        restored_record.base_snapshot_id,
        original_record.base_snapshot_id
    );
    assert_eq!(
        restored_record.latest_snapshot_id,
        original_record.latest_snapshot_id
    );
    assert_eq!(hosted_service.active_lease_count(), 1);
    assert_eq!(hosted_service.provisioned_environment_ids().len(), 2);

    resumed
        .thread
        .shutdown_and_wait()
        .await
        .expect("stop restored thread");
    manager.remove_thread(&resumed.thread_id).await;
}

#[tokio::test]
async fn hosted_resume_without_snapshot_fails_without_reprovisioning() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let root = manager
        .start_thread_with_options(start_thread_options(config.clone()))
        .await
        .expect("start hosted root");
    let mut record = manager
        .state
        .thread_store
        .get_hosted_agent_runtime(root.thread_id)
        .await
        .expect("read hosted runtime")
        .expect("hosted runtime record");
    record.latest_snapshot_id = None;
    let lease_id = record.lease_id.clone();
    manager
        .state
        .thread_store
        .set_hosted_agent_runtime(root.thread_id, record)
        .await
        .expect("remove durable snapshot");
    root.thread
        .shutdown_and_wait()
        .await
        .expect("stop hosted thread");
    hosted_service
        .release(codex_hosted_agent::AgentReleaseRequest {
            lease_id,
            idempotency_key: format!("hosted-agent:{}:expire-before-resume", root.thread_id),
        })
        .await
        .expect("expire lease before resume");

    let error = match manager
        .resume_thread_with_history(
            config,
            InitialHistory::Resumed(ResumedHistory {
                conversation_id: root.thread_id,
                history: Arc::new(Vec::new()),
                rollout_path: root.session_configured.rollout_path.clone(),
            }),
            manager.auth_manager(),
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
    {
        Ok(_) => panic!("resume without a durable snapshot must fail"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("hosted-agent runtime has no durable snapshot")
    );
    assert_eq!(hosted_service.active_lease_count(), 0);
    assert_eq!(hosted_service.provisioned_environment_ids().len(), 1);
    assert!(
        manager
            .state
            .hosted_agent_runtimes
            .read()
            .await
            .get(&root.thread_id)
            .is_none()
    );
}

#[tokio::test]
async fn hosted_provisioning_separates_ownership_from_snapshot_lineage() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let root = manager
        .start_thread_with_options(start_thread_options(config.clone()))
        .await
        .expect("start hosted root");
    let root_request = hosted_provision_request(&hosted_service, root.thread_id);
    assert_eq!(root_request.owner_agent_id, None);
    assert_eq!(
        root_request.source,
        ProjectSnapshotSource::RootWorkspace {
            cwd: PathUri::from_abs_path(&config.cwd),
            workspace_roots: vec![PathUri::from_abs_path(&config.cwd)],
        }
    );
    let root_lease_id = hosted_service
        .provisioned_lease_id(&root_request.idempotency_key)
        .expect("root lease");

    let detached = manager
        .spawn_subagent(root.thread_id, start_thread_options(config.clone()))
        .await
        .expect("spawn hosted detached subagent");
    let detached_request = hosted_provision_request(&hosted_service, detached.thread_id);
    assert_eq!(detached_request.owner_agent_id, Some(root.thread_id));
    assert_eq!(
        detached_request.source,
        ProjectSnapshotSource::AgentEnvironment {
            owner_lease_id: root_lease_id.clone(),
        }
    );

    root.thread.ensure_rollout_materialized().await;
    root.thread
        .flush_rollout()
        .await
        .expect("flush hosted root");
    let fork = manager
        .fork_thread(
            ForkSnapshot::Interrupted,
            config.clone(),
            root.thread.rollout_path().expect("root rollout path"),
            Some(ThreadSource::User),
            /*parent_trace*/ None,
        )
        .await
        .expect("fork hosted root");
    let fork_request = hosted_provision_request(&hosted_service, fork.thread_id);
    assert_eq!(fork_request.owner_agent_id, None);
    assert_eq!(
        fork_request.source,
        ProjectSnapshotSource::AgentEnvironment {
            owner_lease_id: root_lease_id,
        }
    );

    let mut non_hosted_config = config;
    non_hosted_config.hosted_agents.enabled = false;
    let non_hosted = manager
        .start_thread_with_options(start_thread_options(non_hosted_config))
        .await
        .expect("start non-hosted root");
    assert!(
        hosted_service
            .provision_request(&format!("hosted-agent:{}:provision", non_hosted.thread_id))
            .is_none()
    );
    assert!(
        manager
            .state
            .hosted_agent_runtimes
            .read()
            .await
            .get(&non_hosted.thread_id)
            .is_none()
    );

    let report = manager
        .shutdown_all_threads_bounded(Duration::from_secs(10))
        .await;
    assert_eq!(report.completed.len(), 4);
}

#[tokio::test]
async fn hosted_root_uses_trusted_source_snapshot_without_client_host_paths() {
    let (_temp_dir, mut config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let source_snapshot_id = "source_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
    let checksum =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string();
    let remote_root = PathUri::parse("file:///workspace/roots/0/project").expect("remote root");
    let remote_cwd = PathUri::parse("file:///workspace/roots/0/project/src").expect("remote cwd");
    config.hosted_agents.source_snapshot = Some(crate::config::HostedSourceSnapshotConfig {
        source_snapshot_id: source_snapshot_id.clone(),
        checksum: checksum.clone(),
    });
    hosted_service.register_source_snapshot(
        source_snapshot_id.clone(),
        checksum.clone(),
        remote_cwd,
        vec![remote_root],
    );

    let root = manager
        .start_thread_with_options(start_thread_options(config))
        .await
        .expect("start hosted root from immutable source");
    let request = hosted_provision_request(&hosted_service, root.thread_id);
    assert_eq!(request.owner_agent_id, None);
    assert_eq!(
        request.source,
        ProjectSnapshotSource::SourceSnapshot {
            source_snapshot_id,
            checksum,
        }
    );
}

#[tokio::test]
async fn hosted_codex_delegate_owns_and_releases_an_isolated_runtime() {
    let (_temp_dir, config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    let root = manager
        .start_thread_with_options(start_thread_options(config.clone()))
        .await
        .expect("start hosted root");
    let root_request = hosted_provision_request(&hosted_service, root.thread_id);
    let root_lease_id = hosted_service
        .provisioned_lease_id(&root_request.idempotency_key)
        .expect("root lease");
    let parent_turn = root.thread.session.new_default_turn().await;
    let (delegate, delegate_io) = crate::codex_delegate::run_codex_thread_interactive(
        config,
        Arc::clone(&root.thread.session.services.auth_manager),
        Arc::clone(&root.thread.session.services.models_manager),
        Arc::clone(&root.thread.session),
        Arc::clone(&parent_turn),
        CancellationToken::new(),
        SubAgentSource::Review,
        /*initial_history*/ None,
    )
    .await
    .expect("start hosted delegate");
    let delegate_id = delegate.thread_id();
    let delegate_request = hosted_provision_request(&hosted_service, delegate_id);
    assert_eq!(delegate_request.owner_agent_id, Some(root.thread_id));
    assert_eq!(
        delegate_request.source,
        ProjectSnapshotSource::AgentEnvironment {
            owner_lease_id: root_lease_id,
        }
    );
    assert_eq!(manager.list_thread_ids().await, vec![root.thread_id]);
    assert!(matches!(
        manager.get_thread(delegate_id).await,
        Err(CodexErr::ThreadNotFound(thread_id)) if thread_id == delegate_id
    ));

    let delegate_snapshot = delegate.thread_config_snapshot().await;
    assert_eq!(delegate_snapshot.approval_policy, AskForApproval::Never);
    assert!(matches!(
        delegate_snapshot.permission_profile,
        PermissionProfile::External { .. }
    ));
    assert_ne!(
        delegate_snapshot.environments.environments,
        parent_turn.environments.to_selections()
    );
    assert!(!Arc::ptr_eq(
        &delegate.services.exec_policy,
        &root.thread.session.services.exec_policy
    ));
    let delegate_lease_id = hosted_service
        .provisioned_lease_id(&delegate_request.idempotency_key)
        .expect("delegate lease");

    delegate_io
        .shutdown_and_wait()
        .await
        .expect("shut down hosted delegate");
    tokio::time::timeout(Duration::from_secs(1), async {
        while manager
            .state
            .hosted_agent_runtimes
            .read()
            .await
            .contains_key(&delegate_id)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("delegate runtime release timed out");
    hosted_service
        .reconnect(codex_hosted_agent::AgentReconnectRequest {
            lease_id: delegate_lease_id,
            idempotency_key: format!("hosted-agent:{delegate_id}:delegate-release-check"),
        })
        .await
        .expect_err("delegate lease must be released after shutdown");
}

#[tokio::test]
async fn non_hosted_codex_delegate_preserves_parent_runtime_inheritance() {
    let (_temp_dir, mut config, manager, hosted_service) = hosted_thread_manager_for_tests().await;
    config.hosted_agents.enabled = false;
    let root = manager
        .start_thread_with_options(start_thread_options(config.clone()))
        .await
        .expect("start non-hosted root");
    let parent_turn = root.thread.session.new_default_turn().await;
    let parent_environments = parent_turn.environments.to_selections();
    let (delegate, delegate_io) = crate::codex_delegate::run_codex_thread_interactive(
        config,
        Arc::clone(&root.thread.session.services.auth_manager),
        Arc::clone(&root.thread.session.services.models_manager),
        Arc::clone(&root.thread.session),
        Arc::clone(&parent_turn),
        CancellationToken::new(),
        SubAgentSource::Review,
        /*initial_history*/ None,
    )
    .await
    .expect("start non-hosted delegate");

    assert_eq!(
        delegate
            .thread_config_snapshot()
            .await
            .environments
            .environments,
        parent_environments
    );
    assert!(Arc::ptr_eq(
        &delegate.services.exec_policy,
        &root.thread.session.services.exec_policy
    ));
    assert!(
        hosted_service
            .provision_request(&format!("hosted-agent:{}:provision", delegate.thread_id()))
            .is_none()
    );
    delegate_io
        .shutdown_and_wait()
        .await
        .expect("shut down non-hosted delegate");
}

#[tokio::test]
async fn hosted_root_and_spawned_threads_own_distinct_provisioned_environments() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = temp_dir.path().join("workspace").abs();
    config.workspace_roots = vec![config.cwd.clone()];
    config.permissions.approval_policy =
        crate::config::Constrained::allow_any(AskForApproval::OnRequest);
    config
        .set_legacy_sandbox_policy(codex_protocol::protocol::SandboxPolicy::ReadOnly {
            network_access: false,
        })
        .expect("set restrictive local sandbox policy");
    config.permissions.network = Some(
        crate::config::NetworkProxySpec::from_config_and_constraints(
            codex_network_proxy::NetworkProxyConfig::default(),
            Some(codex_config::NetworkConstraints {
                enabled: Some(true),
                ..Default::default()
            }),
            config.permissions.permission_profile(),
        )
        .expect("create managed network proxy spec"),
    );
    config.hosted_agents = crate::config::HostedAgentsConfig {
        enabled: true,
        service_url: Some("https://hosted.invalid".to_string()),
        default_agent_type: "default".to_string(),
        source_snapshot: None,
    };
    config.agent_roles.insert(
        "default".to_string(),
        crate::config::AgentRoleConfig {
            description: Some("Hosted test agent".to_string()),
            sandbox_template: Some("general-v1".to_string()),
            ..Default::default()
        },
    );
    config.agent_roles.insert(
        "researcher".to_string(),
        crate::config::AgentRoleConfig {
            description: Some("Hosted research agent".to_string()),
            sandbox_template: Some("research-v1".to_string()),
            ..Default::default()
        },
    );
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");
    std::fs::create_dir_all(&config.cwd).expect("create workspace");

    let environment_manager = Arc::new(EnvironmentManager::without_environments());
    let mut manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::clone(&environment_manager),
    );
    let hosted_service = Arc::new(codex_hosted_agent::FakeHostedAgentService::default());
    let provisioner = Arc::new(HostedAgentProvisioner::new(
        Arc::clone(&hosted_service),
        Arc::clone(&environment_manager),
    ));
    let manager_state =
        Arc::get_mut(&mut manager.state).expect("new thread manager state must be unshared");
    manager_state.hosted_agent_provisioner = Ok(Some(provisioner));
    manager_state.thread_store = InMemoryThreadStore::for_id(format!(
        "hosted-role-selection-test-{}",
        uuid::Uuid::new_v4()
    ));

    let blank_agent_type_error = manager
        .start_thread_with_options_and_agent_type(
            start_thread_options(config.clone()),
            "  ".to_string(),
        )
        .await
        .err()
        .expect("blank root agent type must fail");
    assert_eq!(
        blank_agent_type_error.to_string(),
        "agentType must not be blank"
    );

    let mut non_hosted_config = config.clone();
    non_hosted_config.hosted_agents.enabled = false;
    let non_hosted_agent_type_error = manager
        .start_thread_with_options_and_agent_type(
            start_thread_options(non_hosted_config),
            "researcher".to_string(),
        )
        .await
        .err()
        .expect("non-hosted root agent type must fail");
    assert_eq!(
        non_hosted_agent_type_error.to_string(),
        "agentType requires hosted agents to be enabled"
    );

    let new_thread = manager
        .start_thread_with_options_and_agent_type(
            start_thread_options(config.clone()),
            " researcher ".to_string(),
        )
        .await
        .expect("start hosted thread");
    let snapshot = new_thread.thread.config_snapshot().await;
    assert_eq!(snapshot.approval_policy, AskForApproval::Never);
    assert_eq!(
        snapshot.permission_profile,
        PermissionProfile::External {
            network: NetworkSandboxPolicy::Enabled,
        }
    );
    assert_eq!(snapshot.active_permission_profile, None);
    assert!(
        new_thread
            .thread
            .config()
            .await
            .permissions
            .network
            .is_none()
    );
    let approval_override_error = new_thread
        .thread
        .preview_thread_settings_overrides(CodexThreadSettingsOverrides {
            approval_policy: Some(AskForApproval::OnRequest),
            ..Default::default()
        })
        .await
        .expect_err("hosted approval policy must be immutable");
    assert!(
        approval_override_error
            .to_string()
            .contains("approval_policy")
    );
    let sandbox_override_error = new_thread
        .thread
        .preview_thread_settings_overrides(CodexThreadSettingsOverrides {
            sandbox_policy: Some(codex_protocol::protocol::SandboxPolicy::ReadOnly {
                network_access: false,
            }),
            ..Default::default()
        })
        .await
        .expect_err("hosted sandbox policy must be immutable");
    assert!(
        sandbox_override_error
            .to_string()
            .contains("sandbox_policy")
    );
    let mut mismatched_environments = snapshot.environments.clone();
    mismatched_environments.environments[0].environment_id = "other-environment".to_string();
    let environment_override_error = new_thread
        .thread
        .preview_thread_settings_overrides(CodexThreadSettingsOverrides {
            environments: Some(mismatched_environments),
            ..Default::default()
        })
        .await
        .expect_err("hosted environment selection must be immutable");
    assert!(
        environment_override_error
            .to_string()
            .contains("environments")
    );
    let permission_profile_override_error = new_thread
        .thread
        .preview_thread_settings_overrides(CodexThreadSettingsOverrides {
            permission_profile: Some(PermissionProfile::Disabled),
            ..Default::default()
        })
        .await
        .expect_err("hosted permission profile must be immutable");
    assert!(
        permission_profile_override_error
            .to_string()
            .contains("permission_profile")
    );
    let active_profile_override_error = new_thread
        .thread
        .preview_thread_settings_overrides(CodexThreadSettingsOverrides {
            active_permission_profile: Some(
                codex_protocol::models::ActivePermissionProfile::read_only(),
            ),
            ..Default::default()
        })
        .await
        .expect_err("hosted active permission profile must remain unset");
    assert!(
        active_profile_override_error
            .to_string()
            .contains("active_permission_profile")
    );
    let profile_roots_override_error = new_thread
        .thread
        .preview_thread_settings_overrides(CodexThreadSettingsOverrides {
            profile_workspace_roots: Some(snapshot.workspace_roots.clone()),
            ..Default::default()
        })
        .await
        .expect_err("hosted profile workspace roots must remain unset");
    assert!(
        profile_roots_override_error
            .to_string()
            .contains("profile_workspace_roots")
    );
    let [selection] = snapshot.environments.environments.as_slice() else {
        panic!("hosted thread must select exactly one environment");
    };
    {
        let runtime = manager
            .state
            .hosted_agent_runtimes
            .read()
            .await
            .get(&new_thread.thread_id)
            .cloned()
            .expect("thread must own a hosted runtime");
        let runtime = runtime.snapshot();
        assert_eq!(selection.environment_id, runtime.environment_id);
        assert_eq!(runtime.agent_type, "researcher");
        assert_eq!(runtime.sandbox_template, "research-v1");
    }
    assert!(environment_manager.try_local_environment().is_none());

    let child_source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
        parent_thread_id: new_thread.thread_id,
        depth: 1,
        agent_path: None,
        agent_nickname: None,
        agent_role: Some("default".to_string()),
    });
    let inherited_environments = new_thread
        .thread
        .session
        .services
        .turn_environments
        .snapshot()
        .await;
    let inherited_exec_policy = Arc::clone(&new_thread.thread.session.services.exec_policy);
    let inherited_environment_selections = inherited_environments.to_selections();
    let child = manager
        .state
        .spawn_new_thread_with_source(
            config,
            manager.agent_control(),
            child_source,
            /*history_mode*/ None,
            /*parent_thread_id*/ Some(new_thread.thread_id),
            /*forked_from_thread_id*/ None,
            /*thread_source*/ Some(ThreadSource::Subagent),
            /*metrics_service_name*/ None,
            /*inherited_environments*/ Some(inherited_environments),
            /*inherited_exec_policy*/ Some(Arc::clone(&inherited_exec_policy)),
            /*environments*/ Some(inherited_environment_selections),
        )
        .await
        .expect("start hosted child thread");
    let child_snapshot = child.thread.config_snapshot().await;
    assert_eq!(child_snapshot.approval_policy, AskForApproval::Never);
    assert_eq!(
        child_snapshot.permission_profile,
        PermissionProfile::External {
            network: NetworkSandboxPolicy::Enabled,
        }
    );
    assert_eq!(child_snapshot.active_permission_profile, None);
    assert!(child.thread.config().await.permissions.network.is_none());
    assert!(!Arc::ptr_eq(
        &child.thread.session.services.exec_policy,
        &inherited_exec_policy
    ));
    let [child_selection] = child_snapshot.environments.environments.as_slice() else {
        panic!("hosted child must select exactly one environment");
    };
    let (root_environment_id, root_lease_id, child_environment_id, child_lease_id) = {
        let runtimes = manager.state.hosted_agent_runtimes.read().await;
        let root_runtime = runtimes
            .get(&new_thread.thread_id)
            .cloned()
            .expect("root hosted runtime");
        let child_runtime = runtimes
            .get(&child.thread_id)
            .cloned()
            .expect("child hosted runtime");
        drop(runtimes);
        let root_runtime = root_runtime.snapshot();
        let child_runtime = child_runtime.snapshot();

        assert_eq!(child_selection.environment_id, child_runtime.environment_id);
        assert_ne!(child_runtime.lease_id, root_runtime.lease_id);
        assert_ne!(child_runtime.environment_id, root_runtime.environment_id);
        (
            root_runtime.environment_id.clone(),
            root_runtime.lease_id,
            child_runtime.environment_id.clone(),
            child_runtime.lease_id,
        )
    };

    child
        .thread
        .shutdown_and_wait()
        .await
        .expect("shut down hosted child");
    assert!(manager.remove_thread(&child.thread_id).await.is_some());

    assert!(
        manager
            .state
            .hosted_agent_runtimes
            .read()
            .await
            .get(&child.thread_id)
            .is_none()
    );
    assert!(
        manager
            .state
            .hosted_agent_runtimes
            .read()
            .await
            .get(&new_thread.thread_id)
            .is_some()
    );
    assert!(
        environment_manager
            .get_environment(&child_environment_id)
            .is_none()
    );
    assert!(
        environment_manager
            .get_environment(&root_environment_id)
            .is_some()
    );
    hosted_service
        .reconnect(codex_hosted_agent::AgentReconnectRequest {
            lease_id: child_lease_id,
            idempotency_key: format!("hosted-agent:{}:removed-child-reconnect", child.thread_id),
        })
        .await
        .expect_err("removed child lease must be released");
    hosted_service
        .reconnect(codex_hosted_agent::AgentReconnectRequest {
            lease_id: root_lease_id.clone(),
            idempotency_key: format!(
                "hosted-agent:{}:remaining-root-reconnect",
                new_thread.thread_id
            ),
        })
        .await
        .expect("removing a child must not release its root lease");

    let shutdown_report = manager
        .shutdown_all_threads_bounded(Duration::from_secs(10))
        .await;
    assert_eq!(shutdown_report.completed, vec![new_thread.thread_id]);
    assert!(manager.state.hosted_agent_runtimes.read().await.is_empty());
    assert!(
        environment_manager
            .get_environment(&root_environment_id)
            .is_none()
    );
    hosted_service
        .reconnect(codex_hosted_agent::AgentReconnectRequest {
            lease_id: root_lease_id,
            idempotency_key: format!(
                "hosted-agent:{}:shutdown-root-reconnect",
                new_thread.thread_id
            ),
        })
        .await
        .expect_err("manager shutdown must release the root lease");
}

#[test]
fn effective_originator_prefers_thread_scoped_sources_before_env_originator() {
    for (metrics_service_name, persisted_originator, inherited_originator, expected_originator) in [
        (
            Some("codex_work_desktop"),
            Some("persisted_originator"),
            Some("inherited_originator"),
            "codex_work_desktop",
        ),
        (
            Some("codex_work_web"),
            Some("persisted_originator"),
            Some("inherited_originator"),
            "codex_work_web",
        ),
        (
            Some("codex_work_mobile"),
            Some("persisted_originator"),
            Some("inherited_originator"),
            "codex_work_mobile",
        ),
        (
            Some("codex_work_cca"),
            Some("persisted_originator"),
            Some("inherited_originator"),
            "codex_work_cca",
        ),
        (
            Some("chatgpt_cca"),
            Some("persisted_originator"),
            Some("inherited_originator"),
            "chatgpt_cca",
        ),
        (
            Some("chatgpt_cca_extra"),
            Some("persisted_originator"),
            Some("inherited_originator"),
            "persisted_originator",
        ),
        (
            None,
            Some("persisted_originator"),
            Some("inherited_originator"),
            "persisted_originator",
        ),
        (
            None,
            None,
            Some("inherited_originator"),
            "inherited_originator",
        ),
    ] {
        assert_eq!(
            effective_originator_value(
                metrics_service_name,
                Some("Codex Desktop".to_string()),
                persisted_originator.map(str::to_string),
                inherited_originator.map(str::to_string),
                "codex_cli_rs".to_string(),
            ),
            expected_originator
        );
    }
}

#[test]
fn truncates_before_requested_user_message() {
    let items = [
        user_msg("u1"),
        assistant_msg("a1"),
        assistant_msg("a2"),
        user_msg("u2"),
        assistant_msg("a3"),
        ResponseItem::Reasoning {
            id: Some(ResponseItemId::with_suffix("rs", "1")),
            summary: vec![ReasoningItemReasoningSummary::SummaryText {
                text: "s".to_string(),
            }],
            content: None,
            encrypted_content: None,
            internal_chat_message_metadata_passthrough: None,
        },
        ResponseItem::FunctionCall {
            id: None,
            call_id: "c1".to_string(),
            name: "tool".to_string(),
            namespace: None,
            arguments: "{}".to_string(),
            internal_chat_message_metadata_passthrough: None,
        },
        assistant_msg("a4"),
    ];

    let initial: Vec<RolloutItem> = items
        .iter()
        .cloned()
        .map(RolloutItem::ResponseItem)
        .collect();
    let truncated = truncate_before_nth_user_message(
        InitialHistory::Forked(initial),
        /*n*/ 1,
        &SnapshotTurnState {
            ends_mid_turn: false,
            active_turn_id: None,
            active_turn_started_at: None,
            active_turn_start_index: None,
        },
    );
    let got_items = truncated.get_rollout_items();
    let expected_items = vec![
        RolloutItem::ResponseItem(items[0].clone()),
        RolloutItem::ResponseItem(items[1].clone()),
        RolloutItem::ResponseItem(items[2].clone()),
    ];
    assert_eq!(
        serde_json::to_value(got_items).unwrap(),
        serde_json::to_value(&expected_items).unwrap()
    );

    let initial2: Vec<RolloutItem> = items
        .iter()
        .cloned()
        .map(RolloutItem::ResponseItem)
        .collect();
    let truncated2 = truncate_before_nth_user_message(
        InitialHistory::Forked(initial2.clone()),
        /*n*/ 2,
        &SnapshotTurnState {
            ends_mid_turn: false,
            active_turn_id: None,
            active_turn_started_at: None,
            active_turn_start_index: None,
        },
    );
    assert_eq!(
        serde_json::to_value(truncated2.get_rollout_items()).unwrap(),
        serde_json::to_value(initial2).unwrap()
    );
}

#[test]
fn out_of_range_truncation_drops_only_unfinished_suffix_mid_turn() {
    let items = vec![
        RolloutItem::ResponseItem(user_msg("u1")),
        RolloutItem::ResponseItem(assistant_msg("a1")),
        RolloutItem::ResponseItem(user_msg("u2")),
        RolloutItem::ResponseItem(assistant_msg("partial")),
    ];

    let truncated = truncate_before_nth_user_message(
        InitialHistory::Forked(items.clone()),
        usize::MAX,
        &SnapshotTurnState {
            ends_mid_turn: true,
            active_turn_id: None,
            active_turn_started_at: None,
            active_turn_start_index: None,
        },
    );

    assert_eq!(
        serde_json::to_value(truncated.get_rollout_items()).unwrap(),
        serde_json::to_value(items[..2].to_vec()).unwrap()
    );
}

#[test]
fn fork_thread_accepts_legacy_usize_snapshot_argument() {
    fn assert_legacy_snapshot_callsite(
        manager: &ThreadManager,
        config: Config,
        path: std::path::PathBuf,
    ) {
        let _future = manager.fork_thread(
            usize::MAX,
            config,
            path,
            /*thread_source*/ None,
            /*parent_trace*/ None,
        );
    }

    let _: fn(&ThreadManager, Config, std::path::PathBuf) = assert_legacy_snapshot_callsite;
}

#[test]
fn out_of_range_truncation_drops_pre_user_active_turn_prefix() {
    let items = vec![
        RolloutItem::ResponseItem(user_msg("u1")),
        RolloutItem::ResponseItem(assistant_msg("a1")),
        RolloutItem::EventMsg(EventMsg::TurnStarted(TurnStartedEvent {
            turn_id: "turn-2".to_string(),
            trace_id: None,
            started_at: None,
            model_context_window: None,
            collaboration_mode_kind: Default::default(),
        })),
        RolloutItem::ResponseItem(user_msg("u2")),
        RolloutItem::ResponseItem(assistant_msg("partial")),
    ];

    let snapshot_state = snapshot_turn_state(&InitialHistory::Forked(items.clone()));
    assert_eq!(
        snapshot_state,
        SnapshotTurnState {
            ends_mid_turn: true,
            active_turn_id: Some("turn-2".to_string()),
            active_turn_started_at: None,
            active_turn_start_index: Some(2),
        },
    );

    let truncated = truncate_before_nth_user_message(
        InitialHistory::Forked(items.clone()),
        usize::MAX,
        &snapshot_state,
    );

    assert_eq!(
        serde_json::to_value(truncated.get_rollout_items()).unwrap(),
        serde_json::to_value(items[..2].to_vec()).unwrap()
    );
}

#[tokio::test]
async fn ignores_session_prefix_messages_when_truncating() {
    let (session, turn_context) = make_session_and_context().await;
    let turn_context = Arc::new(turn_context);
    let world_state = build_world_state_from_turn_context(&session, &turn_context).await;
    let mut items = session
        .build_initial_context_with_world_state(&turn_context, &world_state)
        .await;
    items.push(user_msg("feature request"));
    items.push(assistant_msg("ack"));
    items.push(user_msg("second question"));
    items.push(assistant_msg("answer"));

    let rollout_items: Vec<RolloutItem> = items
        .iter()
        .cloned()
        .map(RolloutItem::ResponseItem)
        .collect();

    let truncated = truncate_before_nth_user_message(
        InitialHistory::Forked(rollout_items),
        /*n*/ 1,
        &SnapshotTurnState {
            ends_mid_turn: false,
            active_turn_id: None,
            active_turn_started_at: None,
            active_turn_start_index: None,
        },
    );
    let got_items = truncated.get_rollout_items();

    let expected: Vec<RolloutItem> = vec![
        RolloutItem::ResponseItem(items[0].clone()),
        RolloutItem::ResponseItem(items[1].clone()),
        RolloutItem::ResponseItem(items[2].clone()),
        RolloutItem::ResponseItem(items[3].clone()),
    ];

    assert_eq!(
        serde_json::to_value(got_items).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
}

#[tokio::test]
async fn shutdown_all_threads_bounded_submits_shutdown_to_every_thread() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let thread_1 = manager
        .start_thread(config.clone())
        .await
        .expect("start first thread")
        .thread_id;
    let thread_2 = manager
        .start_thread(config.clone())
        .await
        .expect("start second thread")
        .thread_id;

    let report = manager
        .shutdown_all_threads_bounded(Duration::from_secs(10))
        .await;

    let mut expected_completed = vec![thread_1, thread_2];
    expected_completed.sort_by_key(std::string::ToString::to_string);
    assert_eq!(report.completed, expected_completed);
    assert!(report.submit_failed.is_empty());
    assert!(report.timed_out.is_empty());
    assert!(manager.list_thread_ids().await.is_empty());
}

#[tokio::test]
async fn code_mode_session_provider_is_shared_across_threads() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let first = manager
        .start_thread(config.clone())
        .await
        .expect("start first thread");
    let second = manager
        .start_thread(config)
        .await
        .expect("start second thread");

    let first_provider = first
        .thread
        .session
        .services
        .code_mode_service
        .session_provider();
    let second_provider = second
        .thread
        .session
        .services
        .code_mode_service
        .session_provider();
    assert!(Arc::ptr_eq(&first_provider, &second_provider));
    assert!(Arc::ptr_eq(
        &first_provider,
        &manager.state.code_mode_session_provider
    ));

    let mut completed = vec![first.thread_id, second.thread_id];
    completed.sort_by_key(std::string::ToString::to_string);
    let report = manager
        .shutdown_all_threads_bounded(Duration::from_secs(10))
        .await;
    assert_eq!(
        report,
        ThreadShutdownReport {
            completed,
            submit_failed: Vec::new(),
            timed_out: Vec::new(),
        }
    );
}

#[tokio::test]
async fn start_thread_keeps_internal_threads_hidden_from_normal_lookups() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let thread = manager
        .start_thread_with_options(StartThreadOptions {
            config,
            allow_provider_model_fallback: false,
            initial_history: InitialHistory::New,
            history_mode: None,
            session_source: Some(SessionSource::Internal(
                InternalSessionSource::MemoryConsolidation,
            )),
            thread_source: None,
            dynamic_tools: Vec::new(),
            metrics_service_name: None,
            parent_trace: None,
            environments: Vec::new(),
            thread_extension_init: Default::default(),
            supports_openai_form_elicitation: false,
        })
        .await
        .expect("internal thread should start");

    assert_eq!(manager.list_thread_ids().await, Vec::new());
    assert!(manager.get_thread(thread.thread_id).await.is_err());

    let report = manager
        .shutdown_all_threads_bounded(Duration::from_secs(10))
        .await;
    assert_eq!(report.completed, vec![thread.thread_id]);
    assert!(report.submit_failed.is_empty());
    assert!(report.timed_out.is_empty());
    assert!(manager.list_thread_ids().await.is_empty());
}

#[tokio::test]
async fn start_thread_seeds_extension_data_for_mcp_and_lifecycle_contributors() {
    struct InitialDataRecorder {
        lifecycle_observed: Arc<std::sync::Mutex<Vec<(String, String)>>>,
        mcp_observed: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl codex_extension_api::ThreadLifecycleContributor<Config> for InitialDataRecorder {
        fn on_thread_start<'a>(
            &'a self,
            input: codex_extension_api::ThreadStartInput<'a, Config>,
        ) -> codex_extension_api::ExtensionFuture<'a, ()> {
            Box::pin(async move {
                let selected_root = input
                    .thread_store
                    .get::<Vec<SelectedCapabilityRoot>>()
                    .and_then(|roots| roots.first().cloned())
                    .expect("selected root should be available");
                self.lifecycle_observed
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push((input.thread_store.level_id().to_string(), selected_root.id));
                input
                    .thread_store
                    .insert(Vec::<SelectedCapabilityRoot>::new());
            })
        }
    }

    impl codex_extension_api::McpServerContributor<Config> for InitialDataRecorder {
        fn id(&self) -> &'static str {
            "selected_root_test"
        }

        fn contribute<'a>(
            &'a self,
            context: codex_extension_api::McpServerContributionContext<'a, Config>,
        ) -> codex_extension_api::ExtensionFuture<'a, Vec<codex_extension_api::McpServerContribution>>
        {
            Box::pin(async move {
                let thread_init = context
                    .thread_init()
                    .expect("initial MCP resolution should be thread-scoped");
                let selected_root = thread_init
                    .get::<Vec<SelectedCapabilityRoot>>()
                    .and_then(|roots| roots.first().cloned())
                    .expect("selected root should be available");
                self.mcp_observed
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(selected_root.id.clone());
                let mut server = codex_mcp::codex_apps_mcp_server_config(
                    "https://selected.invalid",
                    /*apps_mcp_product_sku*/ None,
                    /*originator*/ None,
                );
                let CapabilityRootLocation::Environment { environment_id, .. } =
                    &selected_root.location;
                server.environment_id = environment_id.clone();
                server.enabled = false;
                let plugin_id = selected_root.id;
                vec![codex_extension_api::McpServerContribution::SelectedPlugin {
                    name: plugin_id.clone(),
                    plugin_display_name: plugin_id.clone(),
                    plugin_id,
                    selection_order: 0,
                    config: Box::new(server),
                }]
            })
        }
    }

    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    config
        .features
        .enable(Feature::Apps)
        .expect("test config should allow apps");
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let lifecycle_observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mcp_observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorder = Arc::new(InitialDataRecorder {
        lifecycle_observed: Arc::clone(&lifecycle_observed),
        mcp_observed: Arc::clone(&mcp_observed),
    });
    let mut extensions = codex_extension_api::ExtensionRegistryBuilder::new();
    extensions.thread_lifecycle_contributor(recorder.clone());
    extensions.mcp_server_contributor(recorder);
    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        Arc::new(extensions.build()),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, /*state_db*/ None),
        /*agent_graph_store*/ None,
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );
    let selected_root_init = |id: &str, environment_id: &str| {
        let mut init = codex_extension_api::ExtensionDataInit::new();
        init.insert(vec![SelectedCapabilityRoot {
            id: id.to_string(),
            location: CapabilityRootLocation::Environment {
                environment_id: environment_id.to_string(),
                path: PathUri::parse(&format!("file:///plugins/{id}")).expect("plugin root URI"),
            },
        }]);
        init
    };

    let first_thread = manager
        .start_thread_with_options(StartThreadOptions {
            config: config.clone(),
            allow_provider_model_fallback: false,
            initial_history: InitialHistory::New,
            history_mode: None,
            session_source: None,
            thread_source: None,
            dynamic_tools: Vec::new(),
            metrics_service_name: Some("codex_work_desktop".to_string()),
            parent_trace: None,
            environments: Vec::new(),
            thread_extension_init: selected_root_init("selected-a", "env-a"),
            supports_openai_form_elicitation: false,
        })
        .await
        .expect("start first thread");
    let second_thread = manager
        .start_thread_with_options(StartThreadOptions {
            config: config.clone(),
            allow_provider_model_fallback: false,
            initial_history: InitialHistory::New,
            history_mode: None,
            session_source: None,
            thread_source: None,
            dynamic_tools: Vec::new(),
            metrics_service_name: None,
            parent_trace: None,
            environments: Vec::new(),
            thread_extension_init: selected_root_init("selected-b", "env-b"),
            supports_openai_form_elicitation: false,
        })
        .await
        .expect("start second thread");
    let first_session = &first_thread.thread.session;
    let first_originator = first_session.originator().await;
    let first_resolved = first_session
        .services
        .mcp_manager
        .runtime_config_for_step(
            &config,
            &first_session.services.mcp_thread_init,
            &first_session.services.thread_extension_data,
            &first_originator,
            /*ready_selected_capability_roots*/ &[],
            /*executor_capability_discovery*/ None,
        )
        .await;
    let second_session = &second_thread.thread.session;
    let second_originator = second_session.originator().await;
    let second_resolved = second_session
        .services
        .mcp_manager
        .runtime_config_for_step(
            &config,
            &second_session.services.mcp_thread_init,
            &second_session.services.thread_extension_data,
            &second_originator,
            /*ready_selected_capability_roots*/ &[],
            /*executor_capability_discovery*/ None,
        )
        .await;

    assert_eq!(
        *lifecycle_observed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        vec![
            (first_thread.thread_id.to_string(), "selected-a".to_string()),
            (
                second_thread.thread_id.to_string(),
                "selected-b".to_string()
            ),
        ]
    );
    assert_eq!(
        *mcp_observed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        vec![
            "selected-a".to_string(),
            "selected-b".to_string(),
            "selected-a".to_string(),
            "selected-b".to_string(),
        ]
    );
    let selected_servers = |config: &codex_mcp::McpConfig| {
        codex_mcp::configured_mcp_servers(config)
            .into_iter()
            .filter(|(name, _)| name.starts_with("selected-"))
            .map(|(name, server)| (name, server.environment_id))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    assert_eq!(
        selected_servers(&first_resolved.config),
        std::collections::BTreeMap::from([("selected-a".to_string(), "env-a".to_string())])
    );
    assert_eq!(
        selected_servers(&second_resolved.config),
        std::collections::BTreeMap::from([("selected-b".to_string(), "env-b".to_string())])
    );
    let codex_apps_server = codex_mcp::configured_mcp_servers(&first_resolved.config)
        .remove(codex_mcp::CODEX_APPS_MCP_SERVER_NAME)
        .expect("Codex Apps server should be configured");
    let codex_apps_headers = match codex_apps_server.transport {
        codex_config::McpServerTransportConfig::StreamableHttp { http_headers, .. } => http_headers,
        codex_config::McpServerTransportConfig::Stdio { .. } => {
            panic!("Codex Apps server should use streamable HTTP")
        }
    };
    assert_eq!(
        codex_apps_headers
            .expect("Codex Apps headers should be configured")
            .get("originator"),
        Some(&"codex_work_desktop".to_string())
    );
}

#[tokio::test]
async fn selected_capability_roots_round_trip_through_fork() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let selected_roots = vec![SelectedCapabilityRoot {
        id: "demo@1".to_string(),
        location: CapabilityRootLocation::Environment {
            environment_id: "build".to_string(),
            path: PathUri::parse("file:///plugins/demo").expect("plugin root URI"),
        },
    }];
    let inherited = manager
        .start_thread_with_options(StartThreadOptions {
            config,
            allow_provider_model_fallback: false,
            initial_history: InitialHistory::Forked(vec![RolloutItem::SessionMeta(
                SessionMetaLine {
                    meta: SessionMeta {
                        selected_capability_roots: selected_roots.clone(),
                        ..SessionMeta::default()
                    },
                    git: None,
                },
            )]),
            history_mode: None,
            session_source: None,
            thread_source: None,
            dynamic_tools: Vec::new(),
            metrics_service_name: None,
            parent_trace: None,
            environments: Vec::new(),
            thread_extension_init: Default::default(),
            supports_openai_form_elicitation: false,
        })
        .await
        .expect("start inherited fork");
    inherited.thread.ensure_rollout_materialized().await;
    inherited
        .thread
        .flush_rollout()
        .await
        .expect("flush inherited fork");
    let inherited_history = RolloutRecorder::get_rollout_history(
        &inherited
            .thread
            .rollout_path()
            .expect("inherited fork rollout path"),
    )
    .await
    .expect("read inherited fork rollout");

    assert_eq!(
        inherited_history.get_selected_capability_roots(),
        selected_roots
    );
}

#[tokio::test]
async fn resume_and_fork_do_not_restore_thread_environments_from_rollout() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager.clone()),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, /*state_db*/ None),
        /*agent_graph_store*/ None,
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );
    let selected_cwd =
        AbsolutePathBuf::try_from(config.cwd.as_path().join("selected")).expect("absolute path");
    std::fs::create_dir_all(&selected_cwd).expect("create selected cwd");
    let environments = vec![TurnEnvironmentSelection {
        environment_id: "local".to_string(),
        cwd: PathUri::from_abs_path(&selected_cwd),
        workspace_roots: Vec::new(),
    }];
    let default_cwd = config.cwd.clone();
    let mut source_config = config.clone();
    source_config.cwd = selected_cwd.clone();
    let source = manager
        .start_thread_with_options(StartThreadOptions {
            config: source_config,
            allow_provider_model_fallback: false,
            initial_history: InitialHistory::New,
            history_mode: None,
            session_source: None,
            thread_source: None,
            dynamic_tools: Vec::new(),
            metrics_service_name: None,
            parent_trace: None,
            environments: environments.clone(),
            thread_extension_init: Default::default(),
            supports_openai_form_elicitation: false,
        })
        .await
        .expect("start source thread");
    source.thread.ensure_rollout_materialized().await;
    source
        .thread
        .flush_rollout()
        .await
        .expect("flush source rollout");
    let rollout_path = source
        .thread
        .rollout_path()
        .expect("source rollout path should exist");
    source
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown source thread before resume");
    let _ = manager.remove_thread(&source.thread_id).await;

    let resumed = manager
        .resume_thread_from_rollout(
            config.clone(),
            rollout_path.clone(),
            auth_manager,
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("resume source thread");
    let resumed_turn = resumed
        .thread
        .session
        .new_turn_with_sub_id("resume-turn".to_string(), SessionSettingsUpdate::default())
        .await
        .expect("build resumed turn context");
    assert_eq!(resumed_turn.environments.turn_environments().count(), 1);
    assert_eq!(
        resumed_turn
            .environments
            .primary()
            .expect("primary environment")
            .cwd(),
        &PathUri::from_abs_path(&default_cwd)
    );
    assert_ne!(
        resumed_turn
            .environments
            .primary()
            .expect("primary environment")
            .cwd(),
        &PathUri::from_abs_path(&selected_cwd)
    );

    let forked = manager
        .fork_thread(
            ForkSnapshot::Interrupted,
            config,
            rollout_path,
            /*thread_source*/ None,
            /*parent_trace*/ None,
        )
        .await
        .expect("fork source thread");
    let forked_turn = forked
        .thread
        .session
        .new_turn_with_sub_id("fork-turn".to_string(), SessionSettingsUpdate::default())
        .await
        .expect("build forked turn context");
    assert_eq!(forked_turn.environments.turn_environments().count(), 1);
    assert_eq!(
        forked_turn
            .environments
            .primary()
            .expect("primary environment")
            .cwd(),
        &PathUri::from_abs_path(&default_cwd)
    );
    assert_ne!(
        forked_turn
            .environments
            .primary()
            .expect("primary environment")
            .cwd(),
        &PathUri::from_abs_path(&selected_cwd)
    );
}

#[tokio::test]
async fn explicit_installation_id_skips_codex_home_file() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let installation_id = uuid::Uuid::new_v4().to_string();
    let state_db = init_state_db(&config).await;
    let thread_store = thread_store_from_config(&config, state_db.clone());
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store,
        local_agent_graph_store_from_state_db(state_db.as_ref()),
        installation_id.clone(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let thread = manager
        .start_thread(config.clone())
        .await
        .expect("start thread with explicit installation id");

    assert!(!config.codex_home.join(INSTALLATION_ID_FILENAME).exists());
    assert_eq!(thread.thread.session.installation_id, installation_id);

    thread
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown thread");
    let _ = manager.remove_thread(&thread.thread_id).await;
}

#[tokio::test]
async fn resume_active_thread_from_rollout_returns_running_thread() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager.clone()),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, /*state_db*/ None),
        /*agent_graph_store*/ None,
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let source = manager
        .start_thread(config.clone())
        .await
        .expect("start source thread");
    source.thread.ensure_rollout_materialized().await;
    source
        .thread
        .flush_rollout()
        .await
        .expect("flush source rollout");
    let rollout_path = source
        .thread
        .rollout_path()
        .expect("source rollout path should exist");

    let resumed = manager
        .resume_thread_from_rollout(
            config,
            rollout_path,
            auth_manager,
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("resume active source thread");
    assert_eq!(resumed.thread_id, source.thread_id);
    assert!(Arc::ptr_eq(&resumed.thread, &source.thread));

    source
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown source thread");
}

#[tokio::test]
async fn resume_stopped_thread_from_rollout_spawns_new_thread() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager.clone()),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, /*state_db*/ None),
        /*agent_graph_store*/ None,
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let source = manager
        .start_thread(config.clone())
        .await
        .expect("start source thread");
    source.thread.ensure_rollout_materialized().await;
    source
        .thread
        .flush_rollout()
        .await
        .expect("flush source rollout");
    let rollout_path = source
        .thread
        .rollout_path()
        .expect("source rollout path should exist");
    source
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown source thread");

    let resumed = manager
        .resume_thread_from_rollout(
            config,
            rollout_path,
            auth_manager,
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("resume stopped source thread");
    assert_eq!(resumed.thread_id, source.thread_id);
    assert!(!Arc::ptr_eq(&resumed.thread, &source.thread));

    resumed
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown resumed thread");
}

#[tokio::test]
async fn resume_stopped_thread_from_rollout_preserves_thread_source() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let state_db = init_state_db(&config).await;
    let thread_store = thread_store_from_config(&config, state_db.clone());
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager.clone()),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store,
        local_agent_graph_store_from_state_db(state_db.as_ref()),
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let source = manager
        .start_thread_with_options(StartThreadOptions {
            config: config.clone(),
            allow_provider_model_fallback: false,
            initial_history: InitialHistory::New,
            history_mode: None,
            session_source: None,
            thread_source: Some(ThreadSource::User),
            dynamic_tools: Vec::new(),
            metrics_service_name: None,
            parent_trace: None,
            environments: Vec::new(),
            thread_extension_init: Default::default(),
            supports_openai_form_elicitation: false,
        })
        .await
        .expect("start source thread");
    source.thread.ensure_rollout_materialized().await;
    source
        .thread
        .flush_rollout()
        .await
        .expect("flush source rollout");
    let rollout_path = source
        .thread
        .rollout_path()
        .expect("source rollout path should exist");
    source
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown source thread before resume");
    let _ = manager.remove_thread(&source.thread_id).await;

    let resumed = manager
        .resume_thread_from_rollout(
            config,
            rollout_path,
            auth_manager,
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("resume source thread");

    assert_eq!(
        resumed
            .thread
            .config_snapshot()
            .await
            .thread_source
            .as_ref(),
        Some(&ThreadSource::User)
    );

    resumed
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown resumed thread");
}

#[tokio::test]
async fn subtree_listing_uses_injected_graph_store_without_state_db() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let root_thread_id = ThreadId::new();
    let descendant_thread_ids = vec![ThreadId::new(), ThreadId::new()];
    let agent_graph_store = Arc::new(FakeAgentGraphStore {
        root_thread_id,
        descendant_thread_ids: descendant_thread_ids.clone(),
    });
    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, /*state_db*/ None),
        Some(agent_graph_store),
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let mut expected_thread_ids = vec![root_thread_id];
    expected_thread_ids.extend(descendant_thread_ids);
    assert_eq!(
        manager
            .list_agent_subtree_thread_ids(root_thread_id)
            .await
            .expect("subtree should load from injected graph store"),
        expected_thread_ids
    );
}

#[tokio::test]
async fn rollout_path_resume_and_fork_read_history_through_thread_store() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    config.experimental_thread_store = ThreadStoreConfig::InMemory {
        id: format!("thread-manager-{}", uuid::Uuid::new_v4()),
    };
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let state_db = init_state_db(&config).await;
    let thread_store = thread_store_from_config(&config, state_db.clone());
    let in_memory_store = thread_store
        .as_any()
        .downcast_ref::<InMemoryThreadStore>()
        .expect("configured in-memory store");
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager.clone()),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store.clone(),
        local_agent_graph_store_from_state_db(state_db.as_ref()),
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let source = manager
        .start_thread(config.clone())
        .await
        .expect("start source thread");
    source
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown source thread");
    let _ = manager.remove_thread(&source.thread_id).await;

    let rollout_path = config
        .codex_home
        .join("rollouts/source.jsonl")
        .to_path_buf();
    let resumed = manager
        .resume_thread_with_history(
            config.clone(),
            InitialHistory::Resumed(ResumedHistory {
                conversation_id: source.thread_id,
                history: Arc::new(vec![RolloutItem::ResponseItem(user_msg("hello"))]),
                rollout_path: Some(rollout_path.clone()),
            }),
            auth_manager.clone(),
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("seed rollout path in store");
    resumed
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown seeded resumed thread");
    let _ = manager.remove_thread(&resumed.thread_id).await;

    let resumed_from_path = manager
        .resume_thread_from_rollout(
            config.clone(),
            rollout_path.clone(),
            auth_manager,
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("resume from rollout path");
    assert_eq!(resumed_from_path.thread_id, resumed.thread_id);

    let forked = manager
        .fork_thread(
            ForkSnapshot::Interrupted,
            config,
            rollout_path,
            /*thread_source*/ None,
            /*parent_trace*/ None,
        )
        .await
        .expect("fork from rollout path");
    assert_ne!(forked.thread_id, resumed.thread_id);

    let calls = in_memory_store.calls().await;
    assert_eq!(calls.read_thread_by_rollout_path, 2);

    resumed_from_path
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown path-resumed thread");
    forked
        .thread
        .shutdown_and_wait()
        .await
        .expect("shutdown forked thread");
}

#[tokio::test]
async fn new_uses_active_provider_for_model_refresh() {
    let server = MockServer::start().await;
    let models_mock = mount_models_once(&server, ModelsResponse { models: vec![] }).await;

    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");
    config.model_catalog = None;
    config.model_provider.base_url = Some(server.uri());

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, /*state_db*/ None),
        /*agent_graph_store*/ None,
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let _ = manager
        .list_models(
            RefreshStrategy::Online,
            crate::test_support::default_http_client_factory(),
        )
        .await;
    assert_eq!(models_mock.requests().len(), 1);
}

#[tokio::test]
async fn injected_models_manager_controls_refresh_policy() {
    let server = MockServer::start().await;
    let _ = mount_models_once(&server, ModelsResponse { models: vec![] }).await;
    let _ = mount_models_once(&server, ModelsResponse { models: vec![] }).await;

    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");
    config.model_catalog = None;
    config.model_provider.base_url = Some(server.uri());

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let provider = create_model_provider(
        config.model_provider.clone(),
        Some(Arc::clone(&auth_manager)),
    );
    let models_manager = provider.models_manager_without_cache(config.model_catalog.clone());
    let manager = ThreadManager::new(
        &config,
        auth_manager,
        models_manager,
        crate::CodexAppsToolsCache::default(),
        SessionSource::Custom("test-embedder".to_string()),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, /*state_db*/ None),
        /*agent_graph_store*/ None,
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let http_client_factory = crate::test_support::default_http_client_factory();
    let _ = manager
        .list_models(
            RefreshStrategy::OnlineIfUncached,
            http_client_factory.clone(),
        )
        .await;
    let _ = manager
        .list_models(RefreshStrategy::OnlineIfUncached, http_client_factory)
        .await;

    assert_eq!(
        server.received_requests().await.unwrap_or_default().len(),
        2
    );
    assert!(!config.codex_home.join("models_cache.json").exists());
}

#[test]
fn interrupted_fork_snapshot_appends_interrupt_boundary() {
    let committed_history =
        InitialHistory::Forked(vec![RolloutItem::ResponseItem(user_msg("hello"))]);

    assert_eq!(
        serde_json::to_value(
            append_interrupted_boundary(
                committed_history,
                /*turn_id*/ None,
                /*started_at*/ None,
                InterruptedTurnHistoryMarker::ContextualUser,
            )
            .get_rollout_items()
        )
        .expect("serialize interrupted fork history"),
        serde_json::to_value(vec![
            RolloutItem::ResponseItem(user_msg("hello")),
            RolloutItem::ResponseItem(contextual_user_interrupted_marker()),
            RolloutItem::EventMsg(EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id: None,
                started_at: None,
                reason: TurnAbortReason::Interrupted,
                completed_at: None,
                duration_ms: None,
            })),
        ])
        .expect("serialize expected interrupted fork history"),
    );
    assert_eq!(
        serde_json::to_value(
            append_interrupted_boundary(
                InitialHistory::New,
                /*turn_id*/ None,
                /*started_at*/ None,
                InterruptedTurnHistoryMarker::ContextualUser,
            )
            .get_rollout_items()
        )
        .expect("serialize interrupted empty fork history"),
        serde_json::to_value(vec![
            RolloutItem::ResponseItem(contextual_user_interrupted_marker()),
            RolloutItem::EventMsg(EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id: None,
                started_at: None,
                reason: TurnAbortReason::Interrupted,
                completed_at: None,
                duration_ms: None,
            })),
        ])
        .expect("serialize expected interrupted empty history"),
    );
}

#[test]
fn disabled_interrupted_fork_snapshot_appends_only_interrupt_event() {
    let committed_history =
        InitialHistory::Forked(vec![RolloutItem::ResponseItem(user_msg("hello"))]);

    assert_eq!(
        serde_json::to_value(
            append_interrupted_boundary(
                committed_history,
                /*turn_id*/ None,
                /*started_at*/ None,
                InterruptedTurnHistoryMarker::Disabled,
            )
            .get_rollout_items()
        )
        .expect("serialize disabled interrupted fork history"),
        serde_json::to_value(vec![
            RolloutItem::ResponseItem(user_msg("hello")),
            RolloutItem::EventMsg(EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id: None,
                started_at: None,
                reason: TurnAbortReason::Interrupted,
                completed_at: None,
                duration_ms: None,
            })),
        ])
        .expect("serialize expected disabled interrupted fork history"),
    );
    assert_eq!(
        serde_json::to_value(
            append_interrupted_boundary(
                InitialHistory::New,
                /*turn_id*/ None,
                /*started_at*/ None,
                InterruptedTurnHistoryMarker::Disabled,
            )
            .get_rollout_items()
        )
        .expect("serialize disabled interrupted empty fork history"),
        serde_json::to_value(vec![RolloutItem::EventMsg(EventMsg::TurnAborted(
            TurnAbortedEvent {
                turn_id: None,
                started_at: None,
                reason: TurnAbortReason::Interrupted,
                completed_at: None,
                duration_ms: None,
            },
        ))])
        .expect("serialize expected disabled interrupted empty fork history"),
    );
}

#[test]
fn interrupted_snapshot_is_not_mid_turn() {
    let interrupted_history = InitialHistory::Forked(vec![
        RolloutItem::ResponseItem(user_msg("hello")),
        RolloutItem::ResponseItem(assistant_msg("partial")),
        RolloutItem::ResponseItem(contextual_user_interrupted_marker()),
        RolloutItem::EventMsg(EventMsg::TurnAborted(TurnAbortedEvent {
            turn_id: Some("turn-1".to_string()),
            started_at: None,
            reason: TurnAbortReason::Interrupted,
            completed_at: None,
            duration_ms: None,
        })),
    ]);

    assert_eq!(
        snapshot_turn_state(&interrupted_history),
        SnapshotTurnState {
            ends_mid_turn: false,
            active_turn_id: None,
            active_turn_started_at: None,
            active_turn_start_index: None,
        },
    );
}

#[test]
fn multi_agent_v2_interrupted_marker_uses_developer_input_message() {
    let marker = developer_interrupted_marker();

    let ResponseItem::Message { role, content, .. } = marker else {
        panic!("expected interrupted marker to be a message");
    };
    assert_eq!(role, "developer");
    assert!(
        matches!(
            content.as_slice(),
            [ContentItem::InputText { text }]
                if text.contains(crate::context::TurnAborted::INTERRUPTED_DEVELOPER_GUIDANCE)
        ),
        "expected interrupted marker to use developer InputText content"
    );
}

#[test]
fn completed_legacy_event_history_is_not_mid_turn() {
    let completed_history = InitialHistory::Forked(vec![
        RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
            client_id: None,
            message: "hello".to_string(),
            images: None,
            text_elements: Vec::new(),
            local_images: Vec::new(),
            ..Default::default()
        })),
        RolloutItem::EventMsg(EventMsg::AgentMessage(AgentMessageEvent {
            message: "done".to_string(),
            phase: None,
            memory_citation: None,
        })),
    ]);

    assert_eq!(
        snapshot_turn_state(&completed_history),
        SnapshotTurnState {
            ends_mid_turn: false,
            active_turn_id: None,
            active_turn_started_at: None,
            active_turn_start_index: None,
        },
    );
}

#[test]
fn mixed_response_and_legacy_user_event_history_is_mid_turn() {
    let mixed_history = InitialHistory::Forked(vec![
        RolloutItem::ResponseItem(user_msg("hello")),
        RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
            client_id: None,
            message: "hello".to_string(),
            images: None,
            text_elements: Vec::new(),
            local_images: Vec::new(),
            ..Default::default()
        })),
    ]);

    assert_eq!(
        snapshot_turn_state(&mixed_history),
        SnapshotTurnState {
            ends_mid_turn: true,
            active_turn_id: None,
            active_turn_started_at: None,
            active_turn_start_index: None,
        },
    );
}

#[tokio::test]
async fn interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let state_db = init_state_db(&config).await;
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager.clone()),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, state_db.clone()),
        local_agent_graph_store_from_state_db(state_db.as_ref()),
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let source = manager
        .resume_thread_with_history(
            config.clone(),
            InitialHistory::Forked(vec![
                RolloutItem::ResponseItem(user_msg("hello")),
                RolloutItem::ResponseItem(assistant_msg("partial")),
            ]),
            auth_manager,
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("create source thread from completed history");
    let source_path = source
        .thread
        .rollout_path()
        .expect("source rollout path should exist");
    let source_history = RolloutRecorder::get_rollout_history(&source_path)
        .await
        .expect("read source rollout history");
    let source_snapshot_state = snapshot_turn_state(&source_history);
    assert!(source_snapshot_state.ends_mid_turn);
    let expected_turn_id = source_snapshot_state.active_turn_id.clone();
    assert_eq!(expected_turn_id, None);

    let forked = manager
        .fork_thread(
            ForkSnapshot::Interrupted,
            config.clone(),
            source_path,
            /*thread_source*/ None,
            /*parent_trace*/ None,
        )
        .await
        .expect("fork interrupted snapshot");
    let forked_path = forked
        .thread
        .rollout_path()
        .expect("forked rollout path should exist");
    let history = RolloutRecorder::get_rollout_history(&forked_path)
        .await
        .expect("read forked rollout history");
    assert!(!snapshot_turn_state(&history).ends_mid_turn);
    let rollout_items: Vec<_> = history
        .get_rollout_items()
        .iter()
        .filter(|item| !matches!(item, RolloutItem::SessionMeta(_)))
        .collect();
    let interrupted_marker_json = serde_json::to_value(RolloutItem::ResponseItem(
        contextual_user_interrupted_marker(),
    ))
    .expect("serialize interrupted marker");
    let interrupted_abort_json = serde_json::to_value(RolloutItem::EventMsg(
        EventMsg::TurnAborted(TurnAbortedEvent {
            turn_id: expected_turn_id,
            started_at: None,
            reason: TurnAbortReason::Interrupted,
            completed_at: None,
            duration_ms: None,
        }),
    ))
    .expect("serialize interrupted abort event");
    assert_eq!(
        rollout_items
            .iter()
            .filter(|item| {
                serde_json::to_value(item).expect("serialize rollout item")
                    == interrupted_marker_json
            })
            .count(),
        1,
    );
    assert_eq!(
        rollout_items
            .iter()
            .filter(|item| {
                serde_json::to_value(item).expect("serialize rollout item")
                    == interrupted_abort_json
            })
            .count(),
        1,
    );
}

#[tokio::test]
async fn interrupted_fork_snapshot_preserves_explicit_turn_id() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let state_db = init_state_db(&config).await;
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager.clone()),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, state_db.clone()),
        local_agent_graph_store_from_state_db(state_db.as_ref()),
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let source = manager
        .resume_thread_with_history(
            config.clone(),
            InitialHistory::Forked(vec![
                RolloutItem::EventMsg(EventMsg::TurnStarted(TurnStartedEvent {
                    turn_id: "turn-explicit".to_string(),
                    trace_id: None,
                    started_at: None,
                    model_context_window: None,
                    collaboration_mode_kind: Default::default(),
                })),
                RolloutItem::ResponseItem(user_msg("hello")),
                RolloutItem::ResponseItem(assistant_msg("partial")),
            ]),
            auth_manager,
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("create source thread from explicit partial history");
    let source_path = source
        .thread
        .rollout_path()
        .expect("source rollout path should exist");
    let source_history = RolloutRecorder::get_rollout_history(&source_path)
        .await
        .expect("read source rollout history");
    let source_snapshot_state = snapshot_turn_state(&source_history);
    assert_eq!(
        source_snapshot_state,
        SnapshotTurnState {
            ends_mid_turn: true,
            active_turn_id: Some("turn-explicit".to_string()),
            active_turn_started_at: None,
            active_turn_start_index: Some(1),
        },
    );

    let forked = manager
        .fork_thread(
            ForkSnapshot::Interrupted,
            config.clone(),
            source_path,
            /*thread_source*/ None,
            /*parent_trace*/ None,
        )
        .await
        .expect("fork interrupted snapshot");
    let forked_path = forked
        .thread
        .rollout_path()
        .expect("forked rollout path should exist");
    let history = RolloutRecorder::get_rollout_history(&forked_path)
        .await
        .expect("read forked rollout history");
    let rollout_items: Vec<_> = history
        .get_rollout_items()
        .iter()
        .filter(|item| !matches!(item, RolloutItem::SessionMeta(_)))
        .collect();

    assert!(rollout_items.iter().any(|item| {
        matches!(
            item,
            RolloutItem::EventMsg(EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id: Some(turn_id),
                started_at: None,
                reason: TurnAbortReason::Interrupted,
            completed_at: None,
            duration_ms: None,
            })) if turn_id == "turn-explicit"
        )
    }));
}

#[tokio::test]
async fn interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source() {
    let temp_dir = tempdir().expect("tempdir");
    let mut config = test_config().await;
    config.codex_home = temp_dir.path().join("codex-home").abs();
    config.cwd = config.codex_home.abs();
    std::fs::create_dir_all(&config.codex_home).expect("create codex home");

    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let state_db = init_state_db(&config).await;
    let manager = ThreadManager::new(
        &config,
        auth_manager.clone(),
        build_models_manager(&config, auth_manager.clone()),
        crate::CodexAppsToolsCache::default(),
        SessionSource::Exec,
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        empty_extension_registry(),
        Arc::new(crate::test_support::EmptyUserInstructionsProvider),
        /*analytics_events_client*/ None,
        thread_store_from_config(&config, state_db.clone()),
        local_agent_graph_store_from_state_db(state_db.as_ref()),
        TEST_INSTALLATION_ID.to_string(),
        /*attestation_provider*/ None,
        /*external_time_provider*/ None,
    );

    let source = manager
        .resume_thread_with_history(
            config.clone(),
            InitialHistory::Forked(vec![
                RolloutItem::ResponseItem(user_msg("hello")),
                RolloutItem::ResponseItem(assistant_msg("partial")),
            ]),
            auth_manager,
            /*parent_trace*/ None,
            /*supports_openai_form_elicitation*/ false,
        )
        .await
        .expect("create source thread from partial history");
    let source_path = source
        .thread
        .rollout_path()
        .expect("source rollout path should exist");
    let source_history = RolloutRecorder::get_rollout_history(&source_path)
        .await
        .expect("read source rollout history");
    assert!(snapshot_turn_state(&source_history).ends_mid_turn);
    manager.remove_thread(&source.thread_id).await;

    let forked = manager
        .fork_thread(
            ForkSnapshot::Interrupted,
            config.clone(),
            source_path,
            /*thread_source*/ None,
            /*parent_trace*/ None,
        )
        .await
        .expect("fork interrupted snapshot");
    let forked_path = forked
        .thread
        .rollout_path()
        .expect("forked rollout path should exist");
    let history = RolloutRecorder::get_rollout_history(&forked_path)
        .await
        .expect("read forked rollout history");
    assert!(!snapshot_turn_state(&history).ends_mid_turn);

    let forked_rollout_items: Vec<_> = history
        .get_rollout_items()
        .iter()
        .filter(|item| !matches!(item, RolloutItem::SessionMeta(_)))
        .collect();
    let interrupted_marker_json = serde_json::to_value(RolloutItem::ResponseItem(
        contextual_user_interrupted_marker(),
    ))
    .expect("serialize interrupted marker");
    assert_eq!(
        forked_rollout_items
            .iter()
            .filter(|item| {
                serde_json::to_value(item).expect("serialize forked rollout item")
                    == interrupted_marker_json
            })
            .count(),
        1,
    );

    manager.remove_thread(&forked.thread_id).await;
    let reforked = manager
        .fork_thread(
            ForkSnapshot::Interrupted,
            config.clone(),
            forked_path,
            /*thread_source*/ None,
            /*parent_trace*/ None,
        )
        .await
        .expect("re-fork interrupted snapshot");
    let reforked_path = reforked
        .thread
        .rollout_path()
        .expect("re-forked rollout path should exist");
    let reforked_history = RolloutRecorder::get_rollout_history(&reforked_path)
        .await
        .expect("read re-forked rollout history");
    let reforked_rollout_items: Vec<_> = reforked_history
        .get_rollout_items()
        .iter()
        .filter(|item| !matches!(item, RolloutItem::SessionMeta(_)))
        .collect();

    assert_eq!(
        reforked_rollout_items
            .iter()
            .filter(|item| {
                serde_json::to_value(item).expect("serialize re-forked rollout item")
                    == interrupted_marker_json
            })
            .count(),
        1,
    );
    assert_eq!(
        reforked_rollout_items
            .iter()
            .filter(|item| {
                matches!(
                    item,
                    RolloutItem::EventMsg(EventMsg::TurnAborted(TurnAbortedEvent {
                        reason: TurnAbortReason::Interrupted,
                        ..
                    }))
                )
            })
            .count(),
        1,
    );
}
