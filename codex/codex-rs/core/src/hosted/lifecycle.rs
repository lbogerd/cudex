use std::sync::atomic::Ordering;

use codex_protocol::protocol::ErrorEvent;
use codex_protocol::protocol::EventMsg;

use crate::session::session::Session;

use super::HostedAgentPatchAvailable;
use super::HostedThread;

pub(crate) async fn before_event(session: &Session, event: &mut EventMsg) {
    let EventMsg::TurnComplete(completed) = event else {
        return;
    };
    if completed.error.is_some() {
        return;
    }
    let Some(hosted) = session.services.thread_extension_data.get::<HostedThread>() else {
        return;
    };
    if let Some(owner_thread_id) = hosted.binding.owner_agent_id {
        session
            .services
            .unified_exec_manager
            .terminate_all_processes()
            .await;
        let result = async {
            // The lease-long JS host is explicitly exempted by the service ledger;
            // delegated command and filesystem activity is still independently fenced.
            let artifact = hosted.manager.publish_patch(hosted.binding.agent_id).await
                .map_err(|error| error.to_string())?;
            let metadata = format!("\nHosted patch artifact: {} ({} changed files). Use apply_agent_patch to apply it.",
                artifact.artifact_id, artifact.changed_files);
            completed.last_agent_message.get_or_insert_with(String::new).push_str(&metadata);
            let _ = hosted.patch_tx.send(HostedAgentPatchAvailable { owner_thread_id, artifact });
            Ok::<_, String>(())
        }.await;
        if let Err(error) = result {
            completed.error = Some(ErrorEvent {
                misalignment: None,
                message: format!("failed to finalize hosted agent: {error}"),
                codex_error_info: None,
            });
        }
    } else if let Err(error) = hosted.manager.checkpoint(hosted.binding.agent_id).await {
        completed.error = Some(ErrorEvent {
            misalignment: None,
            message: format!("failed to checkpoint hosted root: {error}"),
            codex_error_info: None,
        });
    }
}

pub(crate) async fn shutdown(session: &Session) {
    let Some(hosted) = session.services.thread_extension_data.get::<HostedThread>() else {
        return;
    };
    let was_active = hosted.active.swap(false, Ordering::AcqRel);
    if let Err(error) = hosted.code_mode.shutdown().await {
        tracing::warn!(%error, "hosted runtime shutdown failed; retaining lease without a successful handoff");
        let _ = hosted
            .environments
            .remove_environment(&hosted.binding.provisioned.environment_id)
            .await;
        return;
    }
    if hosted.binding.owner_agent_id.is_none() {
        // The trusted runner owns root patch export after the TUI exits. The
        // public child-export endpoint cannot authorize that operation, and
        // releasing here would make the runner's active-lease capture fail.
        if was_active
            && let Err(error) = hosted
                .manager
                .checkpoint_for_handoff(hosted.binding.agent_id)
                .await
        {
            tracing::warn!(%error, "hosted root checkpoint failed; retaining lease for recovery");
        }
        let _ = hosted
            .environments
            .remove_environment(&hosted.binding.provisioned.environment_id)
            .await;
        return;
    }
    if was_active {
        match hosted.manager.finalize(hosted.binding.agent_id).await {
            Ok(artifact) => {
                let _ = hosted.patch_tx.send(HostedAgentPatchAvailable {
                    owner_thread_id: hosted
                        .binding
                        .owner_agent_id
                        .unwrap_or(hosted.binding.agent_id),
                    artifact,
                });
            }
            Err(error) => {
                tracing::warn!(%error, "hosted finalization failed; retaining lease for recovery");
                let _ = hosted
                    .environments
                    .remove_environment(&hosted.binding.provisioned.environment_id)
                    .await;
                return;
            }
        }
    }
    let _ = hosted
        .environments
        .remove_environment(&hosted.binding.provisioned.environment_id)
        .await;
    if let Err(error) = hosted.manager.release(hosted.binding.agent_id).await {
        tracing::warn!(%error, "hosted lease cleanup remains pending");
    }
}
