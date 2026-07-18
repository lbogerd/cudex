use super::*;

impl StateRuntime {
    /// Returns the opaque durable hosted-runtime metadata for a thread.
    pub async fn get_thread_hosted_runtime_json(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<Value>> {
        let serialized = sqlx::query_scalar::<_, Option<String>>(
            "SELECT hosted_runtime_json FROM threads WHERE id = ?",
        )
        .bind(thread_id.to_string())
        .fetch_optional(self.pool.as_ref())
        .await?
        .flatten();
        serialized
            .map(|serialized| serde_json::from_str(&serialized))
            .transpose()
            .map_err(Into::into)
    }

    /// Replaces the opaque durable hosted-runtime metadata for an existing thread.
    pub async fn set_thread_hosted_runtime_json(
        &self,
        thread_id: ThreadId,
        hosted_runtime_json: &Value,
    ) -> anyhow::Result<bool> {
        let serialized = serde_json::to_string(hosted_runtime_json)?;
        let result = sqlx::query("UPDATE threads SET hosted_runtime_json = ? WHERE id = ?")
            .bind(serialized)
            .bind(thread_id.to_string())
            .execute(self.pool.as_ref())
            .await?;
        Ok(result.rows_affected() > 0)
    }
}

#[cfg(test)]
#[path = "hosted_agent_tests.rs"]
mod tests;
