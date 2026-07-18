use std::time::Duration;

use codex_protocol::ThreadId;
use codex_utils_path_uri::PathUri;
use pretty_assertions::assert_eq;
use serde_json::json;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_partial_json;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::*;

fn root_request(key: &str) -> AgentProvisionRequest {
    AgentProvisionRequest {
        agent_id: ThreadId::new(),
        owner_agent_id: None,
        agent_type: "default".to_string(),
        sandbox_template: "general-v1".to_string(),
        source: ProjectSnapshotSource::RootWorkspace {
            cwd: PathUri::parse("file:///workspace").expect("valid cwd"),
            workspace_roots: vec![PathUri::parse("file:///workspace").expect("valid root")],
        },
        idempotency_key: key.to_string(),
    }
}

#[test]
fn durable_runtime_record_round_trips_without_transient_data() {
    let agent_id =
        ThreadId::from_string("00000000-0000-0000-0000-000000000123").expect("valid thread id");
    let record = HostedAgentRuntimeRecord {
        agent_type: "reviewer".to_string(),
        sandbox_template: "review-v2".to_string(),
        lease_id: "lease-1".to_string(),
        environment_id: "environment-1".to_string(),
        base_snapshot_id: "snapshot-base".to_string(),
        latest_snapshot_id: Some("snapshot-latest".to_string()),
        last_exported_patch: Some(AgentPatchArtifact {
            artifact_id: "artifact-1".to_string(),
            agent_id,
            base_snapshot_id: "snapshot-base".to_string(),
            checksum: "sha256:1234".to_string(),
            changed_files: 2,
            size_bytes: 512,
        }),
        lifecycle_state: HostedAgentLifecycleState::Completed,
    };

    let json = serde_json::to_value(&record).expect("record should serialize");
    assert_eq!(
        json,
        json!({
            "agentType": "reviewer",
            "sandboxTemplate": "review-v2",
            "leaseId": "lease-1",
            "environmentId": "environment-1",
            "baseSnapshotId": "snapshot-base",
            "latestSnapshotId": "snapshot-latest",
            "lastExportedPatch": {
                "artifactId": "artifact-1",
                "agentId": agent_id,
                "baseSnapshotId": "snapshot-base",
                "checksum": "sha256:1234",
                "changedFiles": 2,
                "sizeBytes": 512,
            },
            "lifecycleState": "completed",
        })
    );
    assert_eq!(
        serde_json::from_value::<HostedAgentRuntimeRecord>(json)
            .expect("record should deserialize"),
        record
    );
}

#[tokio::test]
async fn fake_lifecycle_is_idempotent_and_restorable() {
    let service = FakeHostedAgentService::default();
    let request = root_request("provision-1");
    let first = service
        .provision(request.clone())
        .await
        .expect("provision succeeds");
    assert_eq!(
        service.provision(request).await.expect("retry succeeds"),
        first
    );

    let checkpoint_request = AgentCheckpointRequest {
        lease_id: first.lease_id.clone(),
        idempotency_key: "checkpoint-1".to_string(),
    };
    let checkpoint = service
        .checkpoint(checkpoint_request.clone())
        .await
        .expect("checkpoint succeeds");
    assert_eq!(
        service
            .checkpoint(checkpoint_request)
            .await
            .expect("checkpoint retry succeeds"),
        checkpoint
    );
    service
        .release(AgentReleaseRequest {
            lease_id: first.lease_id,
            idempotency_key: "release-1".to_string(),
        })
        .await
        .expect("release succeeds");

    let mut restore = root_request("restore-1");
    restore.source = ProjectSnapshotSource::DurableSnapshot {
        snapshot_id: checkpoint.snapshot_id,
    };
    let restored = service.provision(restore).await.expect("restore succeeds");
    assert_eq!(restored.cwd, PathUri::parse("file:///workspace").unwrap());
}

#[tokio::test]
async fn fake_reports_missing_and_released_leases() {
    let service = FakeHostedAgentService::default();
    let unknown_lease_id = "unknown-lease".to_string();
    assert_lease_missing(
        service
            .reconnect(AgentReconnectRequest {
                lease_id: unknown_lease_id.clone(),
                idempotency_key: "reconnect-unknown".to_string(),
            })
            .await,
    );
    assert_lease_missing(
        service
            .checkpoint(AgentCheckpointRequest {
                lease_id: unknown_lease_id.clone(),
                idempotency_key: "checkpoint-unknown".to_string(),
            })
            .await,
    );
    assert_lease_missing(
        service
            .export_patch(AgentPatchExportRequest {
                lease_id: unknown_lease_id.clone(),
                agent_id: ThreadId::new(),
                base_snapshot_id: "snapshot-unknown".to_string(),
                idempotency_key: "export-unknown".to_string(),
            })
            .await,
    );
    assert_lease_missing(
        service
            .apply_patch(AgentPatchApplyRequest {
                target_lease_id: unknown_lease_id.clone(),
                artifact_id: "artifact-unknown".to_string(),
                idempotency_key: "apply-unknown".to_string(),
            })
            .await,
    );
    assert_lease_missing(
        service
            .release(AgentReleaseRequest {
                lease_id: unknown_lease_id,
                idempotency_key: "release-unknown".to_string(),
            })
            .await,
    );

    let provisioned = service
        .provision(root_request("released"))
        .await
        .expect("provision succeeds");
    service
        .release(AgentReleaseRequest {
            lease_id: provisioned.lease_id.clone(),
            idempotency_key: "release".to_string(),
        })
        .await
        .expect("release succeeds");
    assert_lease_missing(
        service
            .reconnect(AgentReconnectRequest {
                lease_id: provisioned.lease_id.clone(),
                idempotency_key: "reconnect-released".to_string(),
            })
            .await,
    );
    assert_lease_missing(
        service
            .checkpoint(AgentCheckpointRequest {
                lease_id: provisioned.lease_id,
                idempotency_key: "checkpoint-released".to_string(),
            })
            .await,
    );
}

fn assert_lease_missing<T: std::fmt::Debug>(result: crate::types::Result<T>) {
    let error = result.expect_err("lease lookup must fail");
    assert_eq!(error.category, HostedAgentErrorCategory::LeaseMissing);
}

#[tokio::test]
async fn fake_patch_conflict_is_atomic_and_clean_apply_returns_checkpoint() {
    let service = FakeHostedAgentService::default();
    let source = service
        .provision(root_request("source"))
        .await
        .expect("source provision succeeds");
    let target = service
        .provision(root_request("target"))
        .await
        .expect("target provision succeeds");
    let artifact = service
        .export_patch(AgentPatchExportRequest {
            lease_id: source.lease_id,
            agent_id: ThreadId::new(),
            base_snapshot_id: source.base_snapshot_id,
            idempotency_key: "export".to_string(),
        })
        .await
        .expect("export succeeds");

    let conflict_path = PathUri::parse("file:///workspace/conflict.rs").unwrap();
    service.set_patch_conflict(&artifact.artifact_id, vec![conflict_path.clone()]);
    let before = service.latest_snapshot_id(&target.lease_id);
    let conflict_request = AgentPatchApplyRequest {
        target_lease_id: target.lease_id.clone(),
        artifact_id: artifact.artifact_id.clone(),
        idempotency_key: "apply-conflict".to_string(),
    };
    assert_eq!(
        service
            .apply_patch(conflict_request.clone())
            .await
            .expect("conflict is a result"),
        PatchApplyResult::Conflict {
            paths: vec![conflict_path]
        }
    );
    assert_eq!(service.latest_snapshot_id(&target.lease_id), before);
    assert_eq!(
        service
            .apply_patch(conflict_request)
            .await
            .expect("conflict retry succeeds"),
        PatchApplyResult::Conflict {
            paths: vec![PathUri::parse("file:///workspace/conflict.rs").unwrap()]
        }
    );

    service.clear_patch_conflict(&artifact.artifact_id);
    let clean_target = service
        .provision(root_request("clean-target"))
        .await
        .expect("clean target provision succeeds");
    let apply_request = AgentPatchApplyRequest {
        target_lease_id: clean_target.lease_id.clone(),
        artifact_id: artifact.artifact_id,
        idempotency_key: "apply-clean".to_string(),
    };
    let result = service
        .apply_patch(apply_request.clone())
        .await
        .expect("apply succeeds");
    let PatchApplyResult::Applied { checkpoint } = &result else {
        panic!("clean apply must succeed");
    };
    assert_eq!(
        service.latest_snapshot_id(&clean_target.lease_id),
        Some(checkpoint.snapshot_id.clone())
    );
    assert_eq!(
        service
            .apply_patch(apply_request)
            .await
            .expect("apply retry succeeds"),
        result
    );
    assert_eq!(
        service.latest_snapshot_id(&clean_target.lease_id),
        Some(checkpoint.snapshot_id.clone())
    );
}

#[tokio::test]
async fn fake_rejects_idempotency_key_reuse_with_a_different_request() {
    let service = FakeHostedAgentService::default();
    let first = service
        .provision(root_request("first"))
        .await
        .expect("first provision succeeds");
    let second = service
        .provision(root_request("second"))
        .await
        .expect("second provision succeeds");
    service
        .reconnect(AgentReconnectRequest {
            lease_id: first.lease_id.clone(),
            idempotency_key: "reconnect".to_string(),
        })
        .await
        .expect("first reconnect succeeds");
    let error = service
        .reconnect(AgentReconnectRequest {
            lease_id: second.lease_id.clone(),
            idempotency_key: "reconnect".to_string(),
        })
        .await
        .expect_err("key reuse must fail");
    assert_eq!(error.category, HostedAgentErrorCategory::InvalidResponse);

    service
        .checkpoint(AgentCheckpointRequest {
            lease_id: first.lease_id.clone(),
            idempotency_key: "checkpoint".to_string(),
        })
        .await
        .unwrap();
    assert_key_reuse_rejected(
        service
            .checkpoint(AgentCheckpointRequest {
                lease_id: second.lease_id.clone(),
                idempotency_key: "checkpoint".to_string(),
            })
            .await,
    );

    let artifact = service
        .export_patch(AgentPatchExportRequest {
            lease_id: first.lease_id.clone(),
            agent_id: ThreadId::new(),
            base_snapshot_id: first.base_snapshot_id.clone(),
            idempotency_key: "export".to_string(),
        })
        .await
        .unwrap();
    assert_key_reuse_rejected(
        service
            .export_patch(AgentPatchExportRequest {
                lease_id: second.lease_id.clone(),
                agent_id: ThreadId::new(),
                base_snapshot_id: second.base_snapshot_id,
                idempotency_key: "export".to_string(),
            })
            .await,
    );

    service
        .apply_patch(AgentPatchApplyRequest {
            target_lease_id: first.lease_id.clone(),
            artifact_id: artifact.artifact_id.clone(),
            idempotency_key: "apply".to_string(),
        })
        .await
        .unwrap();
    assert_key_reuse_rejected(
        service
            .apply_patch(AgentPatchApplyRequest {
                target_lease_id: second.lease_id.clone(),
                artifact_id: artifact.artifact_id,
                idempotency_key: "apply".to_string(),
            })
            .await,
    );

    service
        .release(AgentReleaseRequest {
            lease_id: first.lease_id,
            idempotency_key: "release".to_string(),
        })
        .await
        .unwrap();
    assert_key_reuse_rejected(
        service
            .release(AgentReleaseRequest {
                lease_id: second.lease_id,
                idempotency_key: "release".to_string(),
            })
            .await,
    );
}

fn assert_key_reuse_rejected<T: std::fmt::Debug>(result: crate::types::Result<T>) {
    let error = result.expect_err("idempotency key reuse must fail");
    assert_eq!(error.category, HostedAgentErrorCategory::InvalidResponse);
}

#[test]
fn connection_and_http_diagnostics_are_redacted() {
    let connection = HostedEnvironmentConnection::try_new(
        "wss://executor.example/session?token=connection-secret",
    )
    .expect("connection is valid");
    let connection_debug = format!("{connection:?}");
    assert!(!connection_debug.contains("connection-secret"));
    assert!(!connection_debug.contains("executor.example"));

    let client = HttpHostedAgentService::with_timeout(
        "https://service.example/api",
        "service-secret",
        Duration::from_secs(1),
    )
    .expect("client is valid");
    let client_debug = format!("{client:?}");
    assert!(!client_debug.contains("service-secret"));
    assert!(!client_debug.contains("service.example"));
}

#[test]
fn connection_rejects_insecure_executor_url() {
    let error = HostedEnvironmentConnection::try_new("ws://executor.example/session")
        .expect_err("insecure endpoint must fail");
    assert_eq!(error.category, HostedAgentErrorCategory::InvalidResponse);
}

#[test]
fn http_client_rejects_service_url_credentials_and_fragments() {
    for url in [
        "https://user:password@service.example",
        "https://service.example/?token=secret",
        "https://service.example/#secret",
        "http://service.example",
    ] {
        let error = HttpHostedAgentService::new(url, "token").expect_err("URL must be rejected");
        assert_eq!(error.category, HostedAgentErrorCategory::ConnectionFailed);
    }
}

#[tokio::test]
async fn http_client_rejects_duplicate_lease_or_environment_ids() {
    let server = MockServer::start().await;
    for (key, environment_id) in [("one", "environment-1"), ("two", "environment-2")] {
        Mock::given(method("POST"))
            .and(path("/v1/agents/provision"))
            .and(body_partial_json(json!({ "idempotencyKey": key })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "leaseId": "lease-1",
                "environmentId": environment_id,
                "connection": { "execServerUrl": "wss://executor.invalid/session" },
                "cwd": "file:///workspace",
                "workspaceRoots": ["file:///workspace"],
                "baseSnapshotId": "snapshot-1",
                "toolPolicy": { "allowedDomains": [], "allowedTools": [] }
            })))
            .mount(&server)
            .await;
    }
    let client = HttpHostedAgentService::for_test(&server.uri(), "secret").unwrap();
    client
        .provision(root_request("one"))
        .await
        .expect("first response is valid");
    let error = client
        .provision(root_request("two"))
        .await
        .expect_err("duplicate lease must fail");
    assert_eq!(error.category, HostedAgentErrorCategory::InvalidResponse);
}

#[tokio::test]
async fn http_client_distinguishes_missing_leases_and_snapshots() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/agents/reconnect"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/agents/provision"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let client = HttpHostedAgentService::for_test(&server.uri(), "secret").unwrap();

    assert_lease_missing(
        client
            .reconnect(AgentReconnectRequest {
                lease_id: "lease-missing".to_string(),
                idempotency_key: "reconnect".to_string(),
            })
            .await,
    );

    let mut restore = root_request("restore");
    restore.source = ProjectSnapshotSource::DurableSnapshot {
        snapshot_id: "snapshot-missing".to_string(),
    };
    let error = client
        .provision(restore)
        .await
        .expect_err("missing snapshot must fail");
    assert_eq!(error.category, HostedAgentErrorCategory::SnapshotMissing);
}

#[tokio::test]
async fn http_client_validates_checkpoint_response() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/agents/checkpoint"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "snapshotId": "" })))
        .mount(&server)
        .await;
    let client = HttpHostedAgentService::for_test(&server.uri(), "secret").unwrap();
    let error = client
        .checkpoint(AgentCheckpointRequest {
            lease_id: "lease-1".to_string(),
            idempotency_key: "checkpoint".to_string(),
        })
        .await
        .expect_err("empty snapshot ID must fail");
    assert_eq!(error.category, HostedAgentErrorCategory::InvalidResponse);
}

#[tokio::test]
async fn http_client_validates_applied_patch_checkpoint() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/agents/patch/apply"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "applied",
            "checkpoint": { "snapshotId": "" }
        })))
        .mount(&server)
        .await;
    let client = HttpHostedAgentService::for_test(&server.uri(), "secret").unwrap();
    let error = client
        .apply_patch(AgentPatchApplyRequest {
            target_lease_id: "lease-1".to_string(),
            artifact_id: "artifact-1".to_string(),
            idempotency_key: "apply".to_string(),
        })
        .await
        .expect_err("empty applied snapshot ID must fail");
    assert_eq!(error.category, HostedAgentErrorCategory::InvalidResponse);
}
