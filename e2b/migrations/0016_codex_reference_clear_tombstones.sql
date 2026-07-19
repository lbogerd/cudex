ALTER TABLE hosted_agent_codex_reference_sets
    ADD COLUMN cleared_at timestamptz;

CREATE INDEX hosted_agent_codex_reference_sets_cleared_idx
    ON hosted_agent_codex_reference_sets (tenant_id, cleared_at)
    WHERE cleared_at IS NOT NULL;
