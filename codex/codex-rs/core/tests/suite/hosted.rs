//! Exercises the hosted startup boundary through the normal thread/session builder.
//! Positive remote execution is covered by the CubeSandbox smoke test; these tests ensure
//! invalid hosted requests cannot become ordinary local sessions or run startup hooks.

use std::sync::Arc;

use anyhow::Result;
use codex_core::config::Config;
use codex_features::Feature;
use codex_protocol::protocol::Op;
use core_test_support::hooks::trust_discovered_hooks;
use core_test_support::responses;
use core_test_support::responses::start_mock_server;
use core_test_support::test_codex::test_codex;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

fn replace_user_config(config: &mut Config, user_config: toml::Value) {
    config.config_layer_stack = config
        .config_layer_stack
        .with_user_config(&config.codex_home.join("config.toml"), user_config)
        .expect("test user layer");
}

fn hosted_settings() -> toml::Value {
    toml::from_str(&format!(
        r#"
[hosted_agents]
enabled = true
service_url = "https://hosted.invalid/"
default_agent_type = "root"
[hosted_agents.source_snapshot]
source_snapshot_id = "source_{}"
checksum = "sha256:{}"
[agents.root]
sandbox_template = "test-root"
"#,
        "a".repeat(32),
        "b".repeat(64),
    ))
    .expect("valid hosted test settings")
}

#[tokio::test]
async fn hosted_startup_rejects_incoherent_settings_before_model_requests() -> Result<()> {
    let server = start_mock_server().await;
    let cases = [
        (true, toml::Value::Table(Default::default()), "requires"),
        (false, hosted_settings(), "must agree"),
        (
            true,
            {
                let mut settings = hosted_settings();
                settings["hosted_agents"]
                    .as_table_mut()
                    .unwrap()
                    .insert("unexpected".into(), true.into());
                settings
            },
            "unknown field",
        ),
        (
            true,
            {
                let mut settings = hosted_settings();
                settings["hosted_agents"]["service_url"] = "http://localhost/".into();
                settings
            },
            "HTTPS",
        ),
    ];
    for (enabled, settings, expected) in cases {
        let mut builder = test_codex().with_config(move |config| {
            if enabled {
                config.features.enable(Feature::HostedAgents).unwrap();
            }
            replace_user_config(config, settings);
        });
        let Err(error) = builder.build_with_auto_env(&server).await else {
            panic!("invalid hosted request must not create a session");
        };
        assert!(
            format!("{error:#}").contains(expected),
            "unexpected startup error for {expected}: {error:#}"
        );
    }
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
    Ok(())
}

#[tokio::test]
async fn hosted_startup_never_runs_an_otherwise_trusted_local_hook() -> Result<()> {
    let server = start_mock_server().await;
    // First establish that this exact discovered/trusted hook runs in an ordinary session.
    // Then prove both hosted configuration failure and ambient-hook rejection happen before it.
    for mode in [
        "local",
        "missing-hosted-settings",
        "hosted-with-ambient-hook",
    ] {
        let requests_before = server.received_requests().await.unwrap().len();
        let home = Arc::new(TempDir::new()?);
        let marker = home.path().join("startup-hook-ran");
        let command = format!("echo ran > {}", shlex::try_quote(marker.to_str().unwrap())?);
        let hooks = serde_json::json!({
            "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": command}]}]}
        });
        std::fs::write(home.path().join("hooks.json"), serde_json::to_vec(&hooks)?)?;
        let mut builder = test_codex().with_home(home).with_config(move |config| {
            if mode != "local" {
                config.features.enable(Feature::HostedAgents).unwrap();
            }
            if mode == "hosted-with-ambient-hook" {
                replace_user_config(config, hosted_settings());
            }
            trust_discovered_hooks(config);
        });
        let result = builder.build_with_auto_env(&server).await;
        if mode == "local" {
            let test = result?;
            let response = responses::mount_sse_once(
                &server,
                responses::sse(vec![
                    responses::ev_response_created("local-control"),
                    responses::ev_assistant_message("message", "done"),
                    responses::ev_completed("local-control"),
                ]),
            )
            .await;
            test.submit_turn("run the startup hook").await?;
            response.single_request();
            assert_eq!(std::fs::read_to_string(&marker)?.trim(), "ran");
            test.codex.submit(Op::Shutdown).await?;
        } else {
            let Err(error) = result else {
                panic!("hosted startup must reject {mode}");
            };
            let expected = if mode == "missing-hosted-settings" {
                "requires hosted_agents configuration"
            } else {
                "ambient MCP, hooks, or plugins"
            };
            assert!(format!("{error:#}").contains(expected), "{error:#}");
            assert!(!marker.exists(), "hosted startup executed a local hook");
            assert_eq!(
                server.received_requests().await.unwrap().len(),
                requests_before
            );
        }
    }
    Ok(())
}
