use codex_app_server_protocol::AgentPatchApplyResponse;
use codex_app_server_protocol::MAX_AGENT_PATCH_CONFLICT_PATHS;
use codex_core::HostedAgentPatchApplyResult;
use codex_utils_path_uri::PathUri;
use pretty_assertions::assert_eq;

use super::map_patch_apply_result;
use crate::error_code::INTERNAL_ERROR_CODE;

#[test]
fn maps_applied_patch_result() {
    assert_eq!(
        map_patch_apply_result(HostedAgentPatchApplyResult::Applied),
        Ok(AgentPatchApplyResponse::Applied)
    );
}

#[test]
fn maps_bounded_patch_conflicts() {
    let path = PathUri::parse("file:///workspace/conflicted.rs").expect("valid path URI");
    let paths = vec![path; MAX_AGENT_PATCH_CONFLICT_PATHS];

    assert_eq!(
        map_patch_apply_result(HostedAgentPatchApplyResult::Conflict {
            paths: paths.clone(),
        }),
        Ok(AgentPatchApplyResponse::Conflict { paths })
    );
}

#[test]
fn preserves_rejected_patch_reason() {
    let reason = "patch artifact is stale".to_string();

    assert_eq!(
        map_patch_apply_result(HostedAgentPatchApplyResult::Rejected {
            reason: reason.clone(),
        }),
        Ok(AgentPatchApplyResponse::Rejected { reason })
    );
}

#[test]
fn rejects_oversized_patch_conflicts() {
    let path = PathUri::parse("file:///workspace/conflicted.rs").expect("valid path URI");
    let error = map_patch_apply_result(HostedAgentPatchApplyResult::Conflict {
        paths: vec![path; MAX_AGENT_PATCH_CONFLICT_PATHS + 1],
    })
    .expect_err("oversized conflict response must fail closed");

    assert_eq!(error.code, INTERNAL_ERROR_CODE);
    assert_eq!(
        error.message,
        "hosted-agent service returned too many patch conflicts"
    );
    assert_eq!(error.data, None);
}
