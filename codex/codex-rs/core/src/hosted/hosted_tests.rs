use std::sync::Arc;

use codex_features::Feature;
use codex_history::InitialHistory;
use codex_history::ResumedHistory;
use codex_login::CodexAuth;
use codex_protocol::ThreadId;
use pretty_assertions::assert_eq;

use crate::thread_manager::StartThreadOptions;
use crate::thread_manager::ThreadManager;

#[tokio::test]
async fn hosted_start_resume_and_fork_reject_missing_configuration_before_local_startup() {
    let mut config = crate::config::test_config().await;
    let home = tempfile::tempdir().expect("temporary Codex home");
    config.codex_home = codex_utils_absolute_path::AbsolutePathBuf::try_from(home.path()).unwrap();
    config.features.enable(Feature::HostedAgents).unwrap();
    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("test"),
        config.model_provider.clone(),
        home.path().to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    for history in [
        InitialHistory::New,
        InitialHistory::Forked(Vec::new()),
        InitialHistory::Resumed(ResumedHistory {
            conversation_id: ThreadId::new(),
            history: Arc::new(Vec::new()),
            rollout_path: None,
        }),
    ] {
        let mut options = StartThreadOptions::new(config.clone());
        options.initial_history = history;
        let error = manager
            .start_thread(options)
            .await
            .err()
            .expect("hosted configuration must fail closed");
        assert!(error.to_string().contains("hosted_agents configuration"));
        assert_eq!(manager.list_thread_ids().await, Vec::<ThreadId>::new());
    }
}

#[test]
fn hosted_configuration_error_is_typed() {
    let error = std::io::Error::other(super::HostedConfigurationError(
        "invalid hosted config".into(),
    ));
    assert!(super::is_hosted_configuration_error(&error));
    assert!(!super::is_hosted_configuration_error(
        &std::io::Error::other("ordinary error")
    ));
}

#[test]
fn hosted_configuration_rejects_unknown_fields_and_credential_urls() {
    let base = format!(
        r#"
enabled = true
service_url = "https://service.example/"
default_agent_type = "root"
[source_snapshot]
source_snapshot_id = "source_{}"
checksum = "sha256:{}"
"#,
        "a".repeat(32),
        "a".repeat(64)
    );
    let settings: super::config::HostedConfig = toml::from_str(&base).unwrap();
    assert!(settings.validate().is_ok());
    let credentials = base.replace(
        "https://service.example/",
        "https://user:secret@service.example/",
    );
    let settings: super::config::HostedConfig = toml::from_str(&credentials).unwrap();
    assert!(settings.validate().is_err());
    assert!(
        toml::from_str::<super::config::HostedConfig>(
            &base.replace("enabled = true", "enabled = true\nunexpected = true")
        )
        .is_err()
    );
}

#[tokio::test]
async fn hosted_configuration_rejects_ambient_processes_before_startup() {
    let home = tempfile::tempdir().unwrap();
    let hosted: toml::Value = toml::from_str(&format!(
        r#"
enabled = true
service_url = "https://service.example/"
default_agent_type = "root"
[source_snapshot]
source_snapshot_id = "source_{}"
checksum = "sha256:{}"
"#,
        "a".repeat(32),
        "a".repeat(64)
    ))
    .unwrap();
    let base = vec![
        ("features.hosted_agents".into(), toml::Value::Boolean(true)),
        ("hosted_agents".into(), hosted),
        (
            "agents.root.sandbox_template".into(),
            toml::Value::String("root-template".into()),
        ),
    ];
    let valid = crate::config::ConfigBuilder::default()
        .codex_home(home.path().to_path_buf())
        .cli_overrides(base.clone())
        .build()
        .await;
    assert!(valid.is_ok(), "valid hosted settings: {:?}", valid.err());
    let mut ambient = base;
    ambient.push((
        "mcp_servers.ambient.command".into(),
        toml::Value::String("must-not-run".into()),
    ));
    let error = crate::config::ConfigBuilder::default()
        .codex_home(home.path().to_path_buf())
        .cli_overrides(ambient)
        .build()
        .await
        .expect_err("ambient process startup must be rejected");
    assert!(super::is_hosted_configuration_error(&error));
    assert!(error.to_string().contains("ambient MCP"));
}

#[tokio::test]
async fn persisted_hosted_identity_cannot_resume_or_delete_without_hosted_configuration() {
    let home = tempfile::tempdir().unwrap();
    let mut config = crate::config::test_config().await;
    config.codex_home = codex_utils_absolute_path::AbsolutePathBuf::try_from(home.path()).unwrap();
    let thread_id = ThreadId::new();
    let journals = home.path().join("cudex-runtime/hosted-runtime-v1");
    std::fs::create_dir_all(&journals).unwrap();
    // Even an unreadable/corrupt hosted identity must not be mistaken for a local thread.
    let journal = journals.join(format!("{thread_id}.json"));
    std::fs::write(&journal, "interrupted journal write").unwrap();
    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("test"),
        config.model_provider.clone(),
        home.path().to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let mut options = StartThreadOptions::new(config.clone());
    options.initial_history = InitialHistory::Resumed(ResumedHistory {
        conversation_id: thread_id,
        history: Arc::new(Vec::new()),
        rollout_path: None,
    });
    assert!(manager.start_thread(options).await.is_err());
    assert_eq!(manager.list_thread_ids().await, Vec::<ThreadId>::new());
    assert!(
        manager
            .prepare_delete_hosted_thread(thread_id, &config)
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(journal).unwrap(),
        "interrupted journal write"
    );
    // Ordinary local identities still need no remote cleanup configuration.
    manager
        .prepare_delete_hosted_thread(ThreadId::new(), &config)
        .await
        .unwrap();
}
