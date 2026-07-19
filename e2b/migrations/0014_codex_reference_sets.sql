CREATE TABLE hosted_agent_codex_reference_sets (
    tenant_id text NOT NULL,
    agent_id text NOT NULL,
    lease_id text NOT NULL,
    base_snapshot_id text NOT NULL,
    latest_snapshot_id text NOT NULL,
    artifact_id text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT,
    CHECK (octet_length(agent_id) BETWEEN 1 AND 512 AND btrim(agent_id) <> ''),
    CHECK (octet_length(base_snapshot_id) BETWEEN 1 AND 512 AND btrim(base_snapshot_id) <> ''),
    CHECK (octet_length(latest_snapshot_id) BETWEEN 1 AND 512 AND btrim(latest_snapshot_id) <> ''),
    PRIMARY KEY (tenant_id, agent_id),
    CHECK (artifact_id IS NULL OR
        (octet_length(artifact_id) BETWEEN 1 AND 512 AND btrim(artifact_id) <> ''))
);

CREATE INDEX hosted_agent_codex_reference_sets_lease_idx
    ON hosted_agent_codex_reference_sets (tenant_id, lease_id);

CREATE TRIGGER hosted_agent_codex_reference_sets_updated_at
    BEFORE UPDATE ON hosted_agent_codex_reference_sets
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();
