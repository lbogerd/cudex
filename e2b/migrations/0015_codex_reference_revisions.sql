ALTER TABLE hosted_agent_codex_reference_sets
    ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN desired_hash text NOT NULL DEFAULT repeat('0', 64)
        CHECK (desired_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE hosted_agent_codex_reference_sets
    ALTER COLUMN revision DROP DEFAULT,
    ALTER COLUMN desired_hash DROP DEFAULT;
