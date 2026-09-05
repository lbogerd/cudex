//! Durable capture, patch, and cleanup transitions for hosted runtime journals.
use codex_protocol::ThreadId;

use crate::runtime::HostedRuntimeManager;
use crate::runtime::ensure_active;
use crate::runtime::live_record;
use crate::runtime::live_record_mut;
use crate::runtime::validate_binding;
use crate::store::CompletionMode;
use crate::store::Journal;
use crate::store::failure;
use crate::types::Result;
use crate::*;

impl<S: HostedAgentService> HostedRuntimeManager<S> {
    pub(super) async fn capture(&self, journal: &mut Journal) -> Result<AgentCheckpoint> {
        journal.handoff_snapshot_id = None;
        let lease_id = live_record(journal)?.lease_id.clone();
        let idempotency_key = self.begin(journal, "checkpoint")?;
        let result = self
            .service
            .checkpoint(AgentCheckpointRequest {
                lease_id,
                idempotency_key,
            })
            .await;
        // A rejected quiescence check is terminal for that service operation key.
        // A later explicit retry needs a new key; ambiguous transport errors must
        // retain the original key so a committed capture cannot be duplicated.
        if result
            .as_ref()
            .is_err_and(|e| e.category == HostedAgentErrorCategory::PatchConflict)
        {
            self.finish(journal)?;
        }
        let checkpoint = result?;
        live_record_mut(journal)?.latest_snapshot_id = Some(checkpoint.snapshot_id.clone());
        if journal.finalization.as_deref() == Some("checkpoint") {
            journal.finalization = Some("export".into());
        }
        self.finish(journal)?;
        Ok(checkpoint)
    }

    pub async fn checkpoint(&self, id: ThreadId) -> Result<AgentCheckpoint> {
        let mutex = self.lock_for(id);
        let _guard = mutex
            .acquire_owned()
            .await
            .map_err(|_| failure("hosted operation gate closed"))?;
        let _file = self.store.lock(id)?;
        let mut journal = self.journal(id)?;
        ensure_active(&journal)?;
        let result = self.capture(&mut journal).await?;
        self.retain(&mut journal).await?;
        Ok(result)
    }

    /// Marks the exact root snapshot handed to the trusted local return path.
    /// Execution must be stopped first; a failed capture never leaves a marker.
    pub async fn checkpoint_for_handoff(&self, id: ThreadId) -> Result<AgentCheckpoint> {
        let mutex = self.lock_for(id);
        let _guard = mutex
            .acquire_owned()
            .await
            .map_err(|_| failure("hosted operation gate closed"))?;
        let _file = self.store.lock(id)?;
        let mut journal = self.journal(id)?;
        ensure_active(&journal)?;
        if journal.request.owner_agent_id.is_some() {
            return Err(failure("only a root can hand off a local patch"));
        }
        journal.handoff_snapshot_id = None;
        self.store.write(&journal)?;
        let checkpoint = self.capture(&mut journal).await?;
        self.retain(&mut journal).await?;
        journal.handoff_snapshot_id = Some(checkpoint.snapshot_id.clone());
        self.store.write(&journal)?;
        Ok(checkpoint)
    }

    pub(super) async fn retain(&self, journal: &mut Journal) -> Result<()> {
        let record = live_record(journal)?;
        let request = AgentRetentionRequest {
            agent_id: journal.request.agent_id,
            lease_id: record.lease_id.clone(),
            base_snapshot_id: record.base_snapshot_id.clone(),
            latest_snapshot_id: record
                .latest_snapshot_id
                .clone()
                .unwrap_or_else(|| record.base_snapshot_id.clone()),
            artifact_id: record
                .last_exported_patch
                .as_ref()
                .map(|p| p.artifact_id.clone()),
            expected_revision: record.reference_revision,
        };
        self.begin(journal, "retain")?;
        let retained = self.service.retain(request).await?;
        live_record_mut(journal)?.reference_revision = Some(retained.revision);
        self.finish(journal)
    }

    pub async fn finalize(&self, id: ThreadId) -> Result<AgentPatchArtifact> {
        let mutex = self.lock_for(id);
        let _guard = mutex
            .acquire_owned()
            .await
            .map_err(|_| failure("hosted operation gate closed"))?;
        let _file = self.store.lock(id)?;
        let mut journal = self.journal(id)?;
        if journal.finalization.is_none() {
            journal.completion_mode = CompletionMode::Finalize;
        }
        let artifact = self.finalize_locked(&mut journal).await?;
        if live_record(&journal)?.lifecycle_state == HostedAgentLifecycleState::Active {
            journal.completion_mode = CompletionMode::Finalize;
            self.finalize_locked(&mut journal).await
        } else {
            Ok(artifact)
        }
    }

    /// Publishes a turn's durable patch without retiring the lease or its JS heap.
    /// This allows an existing child session to receive follow-up work.
    pub async fn publish_patch(&self, id: ThreadId) -> Result<AgentPatchArtifact> {
        let mutex = self.lock_for(id);
        let _guard = mutex
            .acquire_owned()
            .await
            .map_err(|_| failure("hosted operation gate closed"))?;
        let _file = self.store.lock(id)?;
        let mut journal = self.journal(id)?;
        if journal.finalization.is_none() {
            ensure_active(&journal)?;
            journal.completion_mode = CompletionMode::Publish;
        } else if journal.completion_mode != CompletionMode::Publish {
            return Err(failure("terminal finalization is already in progress"));
        }
        self.finalize_locked(&mut journal).await
    }

    pub(super) async fn finalize_locked(
        &self,
        journal: &mut Journal,
    ) -> Result<AgentPatchArtifact> {
        let record = live_record(journal)?;
        if matches!(
            record.lifecycle_state,
            HostedAgentLifecycleState::Completed
                | HostedAgentLifecycleState::ReleasePending
                | HostedAgentLifecycleState::Released
        ) {
            return record
                .last_exported_patch
                .clone()
                .ok_or_else(|| failure("hosted runtime has no finalized patch"));
        }
        if journal.finalization.is_none() {
            if journal.pending.as_deref() == Some("retain") {
                self.retain(journal).await?;
            }
            if journal.pending.is_some() {
                return Err(failure("hosted operation must finish before finalization"));
            }
            live_record_mut(journal)?.lifecycle_state =
                HostedAgentLifecycleState::PendingFinalization;
            journal.finalization = Some("checkpoint".into());
            self.store.write(journal)?;
        }
        if journal.finalization.as_deref() == Some("checkpoint") {
            self.capture(journal).await?;
            journal.finalization = Some("export".into());
            self.store.write(journal)?;
        }
        if journal.finalization.as_deref() == Some("export") {
            let record = live_record(journal)?;
            let mut request = AgentPatchExportRequest {
                lease_id: record.lease_id.clone(),
                agent_id: journal.request.agent_id,
                base_snapshot_id: record.base_snapshot_id.clone(),
                idempotency_key: String::new(),
            };
            request.idempotency_key = self.begin(journal, "export")?;
            let artifact = self.service.export_patch(request).await?;
            if artifact.agent_id != journal.request.agent_id
                || artifact.base_snapshot_id != live_record(journal)?.base_snapshot_id
            {
                return Err(failure("exported patch changed durable lineage"));
            }
            live_record_mut(journal)?.last_exported_patch = Some(artifact);
            journal.finalization = Some("retain".into());
            self.finish(journal)?;
        }
        if journal.finalization.as_deref() == Some("retain") {
            self.retain(journal).await?;
            live_record_mut(journal)?.lifecycle_state =
                if journal.completion_mode == CompletionMode::Finalize {
                    HostedAgentLifecycleState::Completed
                } else {
                    HostedAgentLifecycleState::Active
                };
            journal.finalization = None;
            self.store.write(journal)?;
            if journal.completion_mode == CompletionMode::Finalize {
                self.forget(journal.request.agent_id);
            }
        }
        live_record(journal)?
            .last_exported_patch
            .clone()
            .ok_or_else(|| failure("finalization did not produce an artifact"))
    }

    pub async fn apply_patch(&self, id: ThreadId, artifact_id: &str) -> Result<PatchApplyResult> {
        if artifact_id.is_empty() || artifact_id.len() > MAX_OPAQUE_ID_BYTES {
            return Err(failure("invalid patch artifact identity"));
        }
        let mutex = self.lock_for(id);
        let _guard = mutex
            .acquire_owned()
            .await
            .map_err(|_| failure("hosted operation gate closed"))?;
        let _file = self.store.lock(id)?;
        let mut journal = self.journal(id)?;
        ensure_active(&journal)?;
        self.apply_locked(&mut journal, artifact_id).await
    }

    pub(super) async fn apply_locked(
        &self,
        journal: &mut Journal,
        artifact_id: &str,
    ) -> Result<PatchApplyResult> {
        journal.handoff_snapshot_id = None;
        let target_lease_id = live_record(journal)?.lease_id.clone();
        let operation = format!("apply:{artifact_id}");
        let idempotency_key = self.begin(journal, &operation)?;
        let result = self
            .service
            .apply_patch(AgentPatchApplyRequest {
                target_lease_id,
                artifact_id: artifact_id.into(),
                idempotency_key,
            })
            .await?;
        if let PatchApplyResult::Applied { checkpoint } = &result {
            live_record_mut(journal)?.latest_snapshot_id = Some(checkpoint.snapshot_id.clone());
        }
        self.finish(journal)?;
        if matches!(result, PatchApplyResult::Applied { .. }) {
            self.retain(journal).await?;
        }
        Ok(result)
    }

    pub async fn release(&self, id: ThreadId) -> Result<()> {
        let mutex = self.lock_for(id);
        let _guard = mutex
            .acquire_owned()
            .await
            .map_err(|_| failure("hosted operation gate closed"))?;
        let _file = self.store.lock(id)?;
        let mut journal = self.journal(id)?;
        self.release_locked(&mut journal).await
    }

    pub(super) async fn release_locked(&self, journal: &mut Journal) -> Result<()> {
        if live_record(journal)?.lifecycle_state == HostedAgentLifecycleState::Released {
            return Ok(());
        }
        if journal.pending.as_deref() == Some("retain") {
            self.retain(journal).await?;
        }
        if journal.pending.is_some() && journal.pending.as_deref() != Some("release") {
            return Err(failure("hosted operation requires recovery before release"));
        }
        let lease_id = live_record(journal)?.lease_id.clone();
        live_record_mut(journal)?.lifecycle_state = HostedAgentLifecycleState::ReleasePending;
        let idempotency_key = self.begin(journal, "release")?;
        self.forget(journal.request.agent_id);
        self.service
            .release(AgentReleaseRequest {
                lease_id,
                idempotency_key,
            })
            .await?;
        live_record_mut(journal)?.lifecycle_state = HostedAgentLifecycleState::Released;
        self.finish(journal)
    }

    pub async fn startup_failed(&self, id: ThreadId) -> Result<()> {
        self.delete(id).await
    }

    /// Persists deletion intent BEFORE remote cleanup; a tombstone prevents reuse.
    pub async fn delete(&self, id: ThreadId) -> Result<()> {
        let mutex = self.lock_for(id);
        let _guard = mutex
            .acquire_owned()
            .await
            .map_err(|_| failure("hosted operation gate closed"))?;
        let _file = self.store.lock(id)?;
        let Some(mut journal) = self.store.read(id)? else {
            return Ok(());
        };
        if journal.deleted {
            return Ok(());
        }
        let _session_guard = if self.binding(id).is_none() {
            Some(self.store.session_lock(id)?)
        } else {
            None
        };
        journal.deleting = true;
        self.store.write(&journal)?;
        self.forget(id);
        if journal.record.is_none() {
            // Provision may have committed remotely before the client disconnected.
            // Replay the durable request to recover its lease, then clean that lease.
            let value = self.service.provision(journal.request.clone()).await?;
            journal.record = Some(HostedAgentRuntimeRecord {
                owner_agent_id: journal.request.owner_agent_id,
                agent_type: journal.request.agent_type.clone(),
                sandbox_template: journal.request.sandbox_template.clone(),
                lease_id: value.lease_id,
                environment_id: value.environment_id,
                connection_generation: value.connection_generation,
                base_snapshot_id: value.base_snapshot_id,
                latest_snapshot_id: None,
                last_exported_patch: None,
                reference_revision: None,
                lifecycle_state: HostedAgentLifecycleState::Active,
            });
            self.store.write(&journal)?;
        }
        if journal.pending.as_deref() == Some("restore") {
            let value = self.restore(&mut journal).await?;
            validate_binding(&value)?;
            let record = live_record_mut(&mut journal)?;
            record.lease_id = value.lease_id;
            record.environment_id = value.environment_id;
            record.connection_generation = value.connection_generation;
            record.latest_snapshot_id = Some(value.base_snapshot_id);
            record.lifecycle_state = HostedAgentLifecycleState::Active;
            self.finish(&mut journal)?;
        }
        if journal.finalization.is_some() {
            self.finalize_locked(&mut journal).await?;
        }
        if journal.pending.as_deref() == Some("checkpoint") {
            self.capture(&mut journal).await?;
        }
        if let Some(artifact) = journal
            .pending
            .as_deref()
            .and_then(|s| s.strip_prefix("apply:"))
            .map(str::to_owned)
        {
            self.apply_locked(&mut journal, &artifact).await?;
        }
        if journal.pending.as_deref() == Some("reconnect") {
            let lease_id = live_record(&journal)?.lease_id.clone();
            let key = self.begin(&mut journal, "reconnect")?;
            self.service
                .reconnect(AgentReconnectRequest {
                    lease_id,
                    idempotency_key: key,
                })
                .await?;
            self.finish(&mut journal)?;
        }
        if journal.pending.as_deref() == Some("retain")
            || (journal.pending.is_none()
                && live_record(&journal)?.lifecycle_state != HostedAgentLifecycleState::Released)
        {
            self.retain(&mut journal).await?;
        }
        if journal.pending.as_deref() != Some("clear") {
            self.release_locked(&mut journal).await?;
        }
        let record = live_record(&journal)?;
        let request = AgentReferenceClearRequest {
            agent_id: id,
            lease_id: record.lease_id.clone(),
            expected_revision: record
                .reference_revision
                .ok_or_else(|| failure("missing retained revision"))?,
        };
        self.begin(&mut journal, "clear")?;
        let result = self.service.clear_references(request).await?;
        live_record_mut(&mut journal)?.reference_revision = Some(result.revision);
        journal.deleted = true;
        self.finish(&mut journal)
    }

    pub async fn retry_deletions(&self) -> Result<()> {
        let mut first_error = None;
        for id in self.store.ids()? {
            if self
                .store
                .read(id)?
                .is_some_and(|j| j.deleting && !j.deleted)
                && let Err(error) = self.delete(id).await
            {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}
