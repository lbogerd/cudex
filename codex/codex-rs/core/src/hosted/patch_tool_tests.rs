use codex_hosted_agent::AgentCheckpoint;
use codex_hosted_agent::PatchApplyResult;
use codex_utils_path_uri::PathUri;
use pretty_assertions::assert_eq;
use serde_json::json;

use super::MAX_MODEL_PATCH_RESULT_BYTES;
use super::model_patch_result;

#[test]
fn applied_model_result_omits_internal_checkpoint() {
    assert_eq!(
        model_patch_result(PatchApplyResult::Applied {
            checkpoint: AgentCheckpoint {
                snapshot_id: "private-checkpoint".repeat(MAX_MODEL_PATCH_RESULT_BYTES),
            },
        }),
        json!({"type": "applied"})
    );
}

#[test]
fn ordinary_conflict_and_rejection_details_are_preserved() {
    let paths = vec![PathUri::parse("file:///workspace/conflicted.rs").unwrap()];
    assert_eq!(
        model_patch_result(PatchApplyResult::Conflict {
            paths: paths.clone()
        }),
        json!({"type": "conflict", "paths": paths})
    );
    assert_eq!(
        model_patch_result(PatchApplyResult::Rejected {
            reason: "owner mismatch".into()
        }),
        json!({"type": "rejected", "reason": "owner mismatch"})
    );
}

#[test]
fn oversized_model_results_preserve_outcome_without_unbounded_details() {
    let path = PathUri::parse("file:///workspace/conflicted.rs").unwrap();
    let paths = vec![path; 1000];
    let conflict = model_patch_result(PatchApplyResult::Conflict { paths });
    assert_eq!(
        conflict,
        json!({
            "type": "conflict", "paths": [], "omittedPathCount": 1000,
            "summary": "Conflict path details exceeded the model result limit; no changes were applied."
        })
    );
    assert!(conflict.to_string().len() <= MAX_MODEL_PATCH_RESULT_BYTES);

    // Include characters that expand under JSON escaping: the bound is on actual
    // serialized model output, not the unescaped service string length.
    let rejected = model_patch_result(PatchApplyResult::Rejected {
        reason: "\n\"😀".repeat(MAX_MODEL_PATCH_RESULT_BYTES),
    });
    assert_eq!(
        rejected,
        json!({"type": "rejected", "reason": "Rejection details exceeded the model result limit; no changes were applied."})
    );
    assert!(rejected.to_string().len() <= MAX_MODEL_PATCH_RESULT_BYTES);
}
