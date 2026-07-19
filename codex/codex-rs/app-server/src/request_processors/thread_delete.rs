//! `thread/delete` request handling.

use super::thread_processor::thread_removal_order;
use super::thread_processor::unsupported_thread_store_operation;
use super::*;

impl ThreadRequestProcessor {
    pub(crate) async fn thread_delete(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadDeleteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let mut deleted_thread_ids = Vec::new();
        let result = {
            let _thread_list_state_permit = self.acquire_thread_list_state_permit().await?;
            self.thread_delete_response(params, &mut deleted_thread_ids)
                .await
        };
        match result {
            Ok(response) => {
                self.outgoing
                    .send_response(request_id.clone(), response)
                    .await;
                self.send_thread_deleted_notifications(deleted_thread_ids)
                    .await;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    async fn thread_delete_response(
        &self,
        params: ThreadDeleteParams,
        deleted_thread_ids: &mut Vec<String>,
    ) -> Result<ThreadDeleteResponse, JSONRPCErrorError> {
        let thread_id = ThreadId::from_string(&params.thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;

        let persisted_delete = if let Some(state_db) = self.state_db.as_ref() {
            state_db
                .thread_deletion_outbox_members(thread_id)
                .await
                .map_err(|err| {
                    internal_error(format!(
                        "failed to read deletion outbox for {thread_id}: {err}"
                    ))
                })?
        } else {
            Vec::new()
        };
        let retrying_delete = !persisted_delete.is_empty();
        let thread_ids = if retrying_delete {
            persisted_delete
        } else {
            self.state_db_spawn_subtree_thread_ids(thread_id).await?
        };

        if !retrying_delete {
            self.validate_root_thread_delete(thread_id, thread_ids.len() > 1)
                .await?;
        }
        let delete_order = thread_removal_order(&thread_ids);
        self.prepare_threads_for_delete(&delete_order).await?;
        if let Some(pending_thread_id) = self.pending_hosted_cleanup(&delete_order).await {
            return Err(internal_error(format!(
                "hosted cleanup is still pending for thread {pending_thread_id}; retry deletion after cleanup succeeds"
            )));
        }
        if let Some(state_db) = self.state_db.as_ref() {
            state_db
                .enqueue_thread_deletion(thread_id, thread_ids.as_slice())
                .await
                .map_err(|err| {
                    internal_error(format!(
                        "failed to persist deletion outbox for {thread_id}: {err}"
                    ))
                })?;
        } else if self.config.hosted_agents.enabled {
            return Err(internal_error(
                "hosted thread deletion requires the durable state database",
            ));
        }

        for thread_id_to_delete in delete_order.iter().copied() {
            match self
                .thread_store
                .delete_thread(StoreDeleteThreadParams {
                    thread_id: thread_id_to_delete,
                })
                .await
            {
                Ok(()) => {}
                Err(ThreadStoreError::ThreadNotFound { .. }) => {
                    warn!(
                        "thread {thread_id_to_delete} was already missing while deleting {thread_id}"
                    );
                }
                Err(err) => {
                    return Err(thread_store_delete_error(err));
                }
            }
        }

        if let Some(state_db) = self.state_db.as_ref() {
            state_db
                .delete_threads_strict(thread_ids.as_slice())
                .await
                .map_err(|err| {
                    internal_error(format!(
                        "failed to delete app-server state for {thread_id}: {err}"
                    ))
                })?;
            if drain_thread_deletion_outbox(state_db, &self.thread_manager).await {
                let state_db = Arc::clone(state_db);
                let thread_manager = Arc::clone(&self.thread_manager);
                let shutdown = self.deletion_outbox_shutdown.clone();
                self.background_tasks.spawn(async move {
                    retry_thread_deletion_outbox(state_db, thread_manager, shutdown).await;
                });
            }
        }

        deleted_thread_ids.extend(
            delete_order
                .into_iter()
                .map(|thread_id| thread_id.to_string()),
        );
        Ok(ThreadDeleteResponse {})
    }

    async fn send_thread_deleted_notifications(&self, deleted_thread_ids: Vec<String>) {
        for thread_id in deleted_thread_ids {
            self.outgoing
                .send_server_notification(ServerNotification::ThreadDeleted(
                    ThreadDeletedNotification { thread_id },
                ))
                .await;
        }
    }

    async fn validate_root_thread_delete(
        &self,
        thread_id: ThreadId,
        has_descendants: bool,
    ) -> Result<(), JSONRPCErrorError> {
        if let Ok(thread) = self.thread_manager.get_thread(thread_id).await {
            if !thread.config_snapshot().await.ephemeral {
                return Ok(());
            }
            return Err(invalid_request(format!(
                "thread is not persisted and cannot be deleted: {thread_id}"
            )));
        }
        match self
            .thread_store
            .read_thread(StoreReadThreadParams {
                thread_id,
                include_archived: true,
                include_history: false,
            })
            .await
        {
            Ok(_) => Ok(()),
            Err(ThreadStoreError::ThreadNotFound { .. }) => {
                if has_descendants {
                    return Ok(());
                }
                let Some(state_db) = self.state_db.as_ref() else {
                    return Err(thread_store_delete_error(
                        ThreadStoreError::ThreadNotFound { thread_id },
                    ));
                };
                if state_db
                    .get_thread(thread_id)
                    .await
                    .map_err(|err| {
                        internal_error(format!(
                            "failed to read app-server state for {thread_id}: {err}"
                        ))
                    })?
                    .is_some()
                {
                    Ok(())
                } else {
                    Err(thread_store_delete_error(
                        ThreadStoreError::ThreadNotFound { thread_id },
                    ))
                }
            }
            Err(err) => Err(thread_store_delete_error(err)),
        }
    }

    async fn prepare_threads_for_delete(
        &self,
        thread_ids: &[ThreadId],
    ) -> Result<(), JSONRPCErrorError> {
        self.prepare_threads_for_removal(thread_ids, "delete")
            .await?;
        if let Some(log_db) = self.log_db.as_ref() {
            log_db.flush().await;
        }
        Ok(())
    }

    async fn pending_hosted_cleanup(&self, thread_ids: &[ThreadId]) -> Option<ThreadId> {
        for thread_id in thread_ids.iter().copied() {
            if self
                .thread_manager
                .hosted_runtime_cleanup_pending(thread_id)
                .await
            {
                return Some(thread_id);
            }
        }
        None
    }
}

pub(super) async fn drain_thread_deletion_outbox(
    state_db: &StateDbHandle,
    thread_manager: &Arc<ThreadManager>,
) -> bool {
    let batches = match state_db.ready_thread_deletion_batches(64).await {
        Ok(batches) => batches,
        Err(error) => {
            warn!(%error, "failed to list ready thread deletion outbox batches");
            return true;
        }
    };
    let mut pending = batches.len() == 64;
    for batch in batches {
        let Some(root_thread_id) = batch.first().map(|entry| entry.root_thread_id) else {
            continue;
        };
        let mut complete = true;
        for entry in &batch {
            let (Some(lease_id), Some(expected_revision)) =
                (entry.lease_id.clone(), entry.expected_revision)
            else {
                continue;
            };
            if let Err(error) = thread_manager
                .clear_deleted_hosted_references(entry.thread_id, lease_id, expected_revision)
                .await
            {
                complete = false;
                pending = true;
                warn!(%error, thread_id = %entry.thread_id,
                    "failed to clear deleted hosted thread references; durable retry remains pending");
            }
        }
        if !complete && let Err(error) = state_db.defer_thread_deletion_outbox(root_thread_id).await
        {
            warn!(%error, %root_thread_id, "failed to defer thread deletion outbox batch");
        }
        if complete
            && let Err(error) = state_db
                .complete_thread_deletion_outbox(root_thread_id)
                .await
        {
            pending = true;
            warn!(%error, %root_thread_id, "failed to complete thread deletion outbox batch");
        }
    }
    pending
}

pub(super) async fn retry_thread_deletion_outbox(
    state_db: StateDbHandle,
    thread_manager: Arc<ThreadManager>,
    shutdown: CancellationToken,
) {
    let mut delay = 1;
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = tokio::time::sleep(Duration::from_secs(delay)) => {}
        }
        if !drain_thread_deletion_outbox(&state_db, &thread_manager).await {
            return;
        }
        delay = (delay * 2).min(60);
    }
}

fn thread_store_delete_error(err: ThreadStoreError) -> JSONRPCErrorError {
    match err {
        ThreadStoreError::ThreadNotFound { thread_id } => {
            invalid_request(format!("thread not found: {thread_id}"))
        }
        ThreadStoreError::InvalidRequest { message } => invalid_request(message),
        ThreadStoreError::Unsupported { operation } => {
            unsupported_thread_store_operation(operation)
        }
        err => internal_error(format!("failed to delete thread: {err}")),
    }
}
