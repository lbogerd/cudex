use std::process::Command;

use anyhow::Result;
use tempfile::TempDir;

#[test]
fn hosted_configuration_errors_abort_before_local_session_startup() -> Result<()> {
    for config in [
        "[features]\nhosted_agents = true\n",
        "[hosted_agents]\nenabled = true\nservice_url = [\n",
        "[features]\nhosted_agents = true\n[hosted_agents]\nenabled = true\nservice_url = 7\n",
    ] {
        let home = TempDir::new()?;
        std::fs::write(home.path().join("config.toml"), config)?;
        let output = Command::new(codex_utils_cargo_bin::cargo_bin("codex-app-server")?)
            .env("CODEX_HOME", home.path())
            .env(
                "CODEX_APP_SERVER_MANAGED_CONFIG_PATH",
                home.path().join("managed_config.toml"),
            )
            .args(["--listen", "off"])
            .output()?;
        assert!(
            !output.status.success(),
            "invalid hosted config was accepted"
        );
        assert!(!home.path().join("hosted-runtime-v1").exists());
    }
    Ok(())
}

#[test]
fn strict_config_rejects_unknown_config_fields_for_standalone_app_server() -> Result<()> {
    let codex_home = TempDir::new()?;
    std::fs::write(
        codex_home.path().join("config.toml"),
        r#"
foo = "bar"
"#,
    )?;

    let output = Command::new(codex_utils_cargo_bin::cargo_bin("codex-app-server")?)
        .env("CODEX_HOME", codex_home.path())
        .env(
            "CODEX_APP_SERVER_MANAGED_CONFIG_PATH",
            codex_home.path().join("managed_config.toml"),
        )
        .args(["--strict-config", "--listen", "off"])
        .output()?;

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr)?;
    assert!(
        stderr.contains("unknown configuration field `foo`"),
        "expected strict config error in stderr, got: {stderr}"
    );

    Ok(())
}

#[test]
fn managed_auth_requirements_fail_closed_for_standalone_app_server() -> Result<()> {
    for requirements in [
        "allowed_login_methods = []\n",
        "allowed_login_methods = [\"chatgpt\"]\nallowed_chatgpt_workspaces = []\n",
    ] {
        let codex_home = TempDir::new()?;
        std::fs::write(codex_home.path().join("requirements.toml"), requirements)?;

        let output = Command::new(codex_utils_cargo_bin::cargo_bin("codex-app-server")?)
            .env("CODEX_HOME", codex_home.path())
            .env(
                "CODEX_APP_SERVER_MANAGED_CONFIG_PATH",
                codex_home.path().join("managed_config.toml"),
            )
            .args(["--listen", "off"])
            .output()?;

        assert!(!output.status.success());
        let stderr = String::from_utf8(output.stderr)?;
        assert!(
            stderr.contains("authentication requirements do not permit any usable login method"),
            "expected managed authentication error in stderr, got: {stderr}"
        );
        assert!(
            !stderr.contains("using defaults"),
            "managed authentication requirements must not fall back to defaults"
        );
    }

    Ok(())
}
