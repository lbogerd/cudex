use anyhow::Result;
use app_test_support::DEFAULT_CLIENT_NAME;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use codex_app_server_protocol::AgentPatchApplyResponse;
use codex_app_server_protocol::ClientInfo;
use codex_app_server_protocol::InitializeCapabilities;
use codex_app_server_protocol::JSONRPCError;
use codex_app_server_protocol::JSONRPCMessage;
use codex_app_server_protocol::JSONRPCResponse;
use codex_app_server_protocol::RequestId;
use codex_protocol::ThreadId;
use pretty_assertions::assert_eq;
use serde_json::json;
use tokio::time::timeout;

#[cfg(any(target_os = "macos", windows))]
const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
#[cfg(not(any(target_os = "macos", windows)))]
const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const INVALID_REQUEST_ERROR_CODE: i64 = -32600;

#[tokio::test]
async fn agent_patch_apply_requires_experimental_api_capability() -> Result<()> {
    let mut mcp = TestAppServer::builder().build().await?;
    let initialized = mcp
        .initialize_with_capabilities(
            ClientInfo {
                name: DEFAULT_CLIENT_NAME.to_string(),
                title: None,
                version: "0.1.0".to_string(),
            },
            Some(InitializeCapabilities {
                experimental_api: false,
                ..Default::default()
            }),
        )
        .await?;
    let JSONRPCMessage::Response(_) = initialized else {
        anyhow::bail!("expected initialize response, got {initialized:?}");
    };

    let request_id = mcp
        .send_raw_request(
            "agent/patchApply",
            Some(json!({
                "threadId": ThreadId::new(),
                "agentId": ThreadId::new(),
                "artifactId": "artifact-1",
            })),
        )
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;

    assert_eq!(error.error.code, INVALID_REQUEST_ERROR_CODE);
    assert_eq!(
        error.error.message,
        "agent/patchApply requires experimentalApi capability"
    );
    assert_eq!(error.error.data, None);

    Ok(())
}

#[tokio::test]
async fn agent_patch_apply_validates_public_request_ids() -> Result<()> {
    let mut mcp = TestAppServer::builder().build().await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;
    let valid_id = ThreadId::new().to_string();

    for (params, expected_message) in [
        (
            json!({
                "threadId": "not-a-thread-id",
                "agentId": valid_id.clone(),
                "artifactId": "artifact-1",
            }),
            "invalid thread id",
        ),
        (
            json!({
                "threadId": valid_id.clone(),
                "agentId": "not-an-agent-id",
                "artifactId": "artifact-1",
            }),
            "invalid agent id",
        ),
    ] {
        let request_id = mcp
            .send_raw_request("agent/patchApply", Some(params))
            .await?;
        let error: JSONRPCError = timeout(
            DEFAULT_READ_TIMEOUT,
            mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
        )
        .await??;

        assert_eq!(error.error.code, INVALID_REQUEST_ERROR_CODE);
        assert!(
            error.error.message.contains(expected_message),
            "unexpected error: {}",
            error.error.message
        );
    }

    let request_id = mcp
        .send_raw_request(
            "agent/patchApply",
            Some(json!({
                "threadId": valid_id,
                "agentId": ThreadId::new(),
            })),
        )
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;
    assert_eq!(error.error.code, INVALID_REQUEST_ERROR_CODE);
    assert!(error.error.message.contains("artifactId"));

    Ok(())
}

#[tokio::test]
async fn agent_patch_apply_rejects_unowned_artifacts_without_disclosure() -> Result<()> {
    let mut mcp = TestAppServer::builder().build().await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;
    let requesting_agent_id = ThreadId::new();
    let unowned_agent_id = ThreadId::new();

    for source_agent_id in [unowned_agent_id, requesting_agent_id] {
        let request_id = mcp
            .send_raw_request(
                "agent/patchApply",
                Some(json!({
                    "threadId": requesting_agent_id,
                    "agentId": source_agent_id,
                    "artifactId": "artifact-unknown",
                })),
            )
            .await?;
        let response: JSONRPCResponse = timeout(
            DEFAULT_READ_TIMEOUT,
            mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
        )
        .await??;

        assert_eq!(
            to_response::<AgentPatchApplyResponse>(response)?,
            AgentPatchApplyResponse::Rejected {
                reason: "patch is not available to the requesting agent".to_string(),
            }
        );
    }

    Ok(())
}
