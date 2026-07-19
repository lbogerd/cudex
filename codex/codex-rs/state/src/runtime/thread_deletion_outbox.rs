use super::*;

/// One durable member of a locally deleting thread subtree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadDeletionOutboxEntry {
    pub root_thread_id: ThreadId,
    pub thread_id: ThreadId,
    pub lease_id: Option<String>,
    pub expected_revision: Option<u64>,
}

impl StateRuntime {
    /// Records the complete deletion batch before any rollout or thread row is removed.
    pub async fn enqueue_thread_deletion(
        &self,
        root_thread_id: ThreadId,
        thread_ids: &[ThreadId],
    ) -> anyhow::Result<Vec<ThreadDeletionOutboxEntry>> {
        let requested = thread_ids
            .iter()
            .map(ThreadId::to_string)
            .collect::<BTreeSet<_>>();
        if requested.is_empty() || !requested.contains(&root_thread_id.to_string()) {
            anyhow::bail!("thread deletion batch must contain its root");
        }
        let mut tx = self.pool.begin().await?;
        let existing = load_entries(&mut *tx, root_thread_id).await?;
        if !existing.is_empty() {
            let existing_ids: BTreeSet<String> = existing
                .iter()
                .map(|entry| entry.thread_id.to_string())
                .collect();
            if existing_ids != requested {
                anyhow::bail!("thread deletion batch does not match its durable outbox");
            }
            tx.commit().await?;
            return Ok(existing);
        }

        let created_at = Utc::now().timestamp_millis();
        let mut entries = Vec::with_capacity(requested.len());
        for thread_id in requested {
            let thread_id = ThreadId::try_from(thread_id)?;
            let hosted_runtime = sqlx::query_scalar::<_, Option<String>>(
                "SELECT hosted_runtime_json FROM threads WHERE id = ?",
            )
            .bind(thread_id.to_string())
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
            let (lease_id, expected_revision) = match hosted_runtime {
                None => (None, None),
                Some(serialized) => {
                    let value: Value = serde_json::from_str(&serialized)?;
                    let lease_id = value
                        .get("leaseId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            anyhow::anyhow!("hosted thread {thread_id} has no durable lease")
                        })?
                        .to_string();
                    let revision = value
                        .get("referenceRevision")
                        .and_then(Value::as_u64)
                        .filter(|revision| *revision > 0 && *revision <= i64::MAX as u64)
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "hosted thread {thread_id} has no durable reference revision"
                            )
                        })?;
                    (Some(lease_id), Some(revision))
                }
            };
            sqlx::query(
                "INSERT INTO thread_deletion_outbox
                 (root_thread_id, thread_id, lease_id, expected_revision, created_at)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(root_thread_id.to_string())
            .bind(thread_id.to_string())
            .bind(lease_id.as_deref())
            .bind(expected_revision.map(|revision| revision as i64))
            .bind(created_at)
            .execute(&mut *tx)
            .await?;
            entries.push(ThreadDeletionOutboxEntry {
                root_thread_id,
                thread_id,
                lease_id,
                expected_revision,
            });
        }
        tx.commit().await?;
        Ok(entries)
    }

    /// Returns durable batch membership, including after every thread row was deleted.
    pub async fn thread_deletion_outbox_members(
        &self,
        root_thread_id: ThreadId,
    ) -> anyhow::Result<Vec<ThreadId>> {
        Ok(load_entries(self.pool.as_ref(), root_thread_id)
            .await?
            .into_iter()
            .map(|entry| entry.thread_id)
            .collect())
    }

    /// Lists bounded batches whose local thread rows are all gone and may be cleared remotely.
    pub async fn ready_thread_deletion_batches(
        &self,
        limit: u32,
    ) -> anyhow::Result<Vec<Vec<ThreadDeletionOutboxEntry>>> {
        if limit == 0 || limit > 256 {
            anyhow::bail!("thread deletion outbox limit must be between 1 and 256");
        }
        let roots = sqlx::query_scalar::<_, String>(
            r#"
SELECT DISTINCT candidate.root_thread_id
FROM thread_deletion_outbox AS candidate
WHERE NOT EXISTS (
    SELECT 1
    FROM thread_deletion_outbox AS member
    JOIN threads ON threads.id = member.thread_id
    WHERE member.root_thread_id = candidate.root_thread_id
)
GROUP BY candidate.root_thread_id
ORDER BY MIN(COALESCE(candidate.last_attempt_at, 0)), MIN(candidate.created_at), candidate.root_thread_id
LIMIT ?
            "#,
        )
        .bind(i64::from(limit))
        .fetch_all(self.pool.as_ref())
        .await?;
        let mut batches = Vec::with_capacity(roots.len());
        for root in roots {
            batches.push(load_entries(self.pool.as_ref(), ThreadId::try_from(root)?).await?);
        }
        Ok(batches)
    }

    /// Moves a failed batch behind other ready work so one poison batch cannot starve the queue.
    pub async fn defer_thread_deletion_outbox(
        &self,
        root_thread_id: ThreadId,
    ) -> anyhow::Result<u64> {
        Ok(sqlx::query(
            "UPDATE thread_deletion_outbox SET last_attempt_at = ? WHERE root_thread_id = ?",
        )
        .bind(Utc::now().timestamp_millis())
        .bind(root_thread_id.to_string())
        .execute(self.pool.as_ref())
        .await?
        .rows_affected())
    }

    /// Completes a fully cleared deletion batch.
    pub async fn complete_thread_deletion_outbox(
        &self,
        root_thread_id: ThreadId,
    ) -> anyhow::Result<u64> {
        Ok(
            sqlx::query("DELETE FROM thread_deletion_outbox WHERE root_thread_id = ?")
                .bind(root_thread_id.to_string())
                .execute(self.pool.as_ref())
                .await?
                .rows_affected(),
        )
    }
}

async fn load_entries<'e, E>(
    executor: E,
    root_thread_id: ThreadId,
) -> anyhow::Result<Vec<ThreadDeletionOutboxEntry>>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    let rows = sqlx::query(
        "SELECT thread_id, lease_id, expected_revision FROM thread_deletion_outbox
         WHERE root_thread_id = ? ORDER BY thread_id",
    )
    .bind(root_thread_id.to_string())
    .fetch_all(executor)
    .await?;
    rows.into_iter()
        .map(|row| {
            let thread_id: String = row.try_get("thread_id")?;
            let revision: Option<i64> = row.try_get("expected_revision")?;
            Ok(ThreadDeletionOutboxEntry {
                root_thread_id,
                thread_id: ThreadId::try_from(thread_id)?,
                lease_id: row.try_get("lease_id")?,
                expected_revision: revision.map(|value| value as u64),
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "thread_deletion_outbox_tests.rs"]
mod tests;
