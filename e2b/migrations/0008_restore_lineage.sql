ALTER TABLE hosted_agent_snapshots
    ADD CONSTRAINT hosted_agent_snapshots_restore_lineage_key
        UNIQUE (snapshot_id, lease_id, tenant_id);

ALTER TABLE hosted_agent_leases
    ADD COLUMN restore_source_lease_id text,
    ADD COLUMN restore_source_snapshot_id text,
    ADD CONSTRAINT hosted_agent_leases_restore_source_pair_check
        CHECK ((restore_source_lease_id IS NULL) = (restore_source_snapshot_id IS NULL)),
    ADD CONSTRAINT hosted_agent_leases_restore_source_lease_fk
        FOREIGN KEY (restore_source_lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT,
    ADD CONSTRAINT hosted_agent_leases_restore_source_snapshot_fk
        FOREIGN KEY (restore_source_snapshot_id, restore_source_lease_id, tenant_id)
        REFERENCES hosted_agent_snapshots(snapshot_id, lease_id, tenant_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX hosted_agent_leases_restore_source_uidx
    ON hosted_agent_leases (restore_source_lease_id)
    WHERE restore_source_lease_id IS NOT NULL;

ALTER TABLE hosted_agent_operations
    ADD COLUMN result_lease_id text,
    ADD CONSTRAINT hosted_agent_operations_result_lease_fk
        FOREIGN KEY (result_lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT;

CREATE INDEX hosted_agent_operations_result_lease_idx
    ON hosted_agent_operations (result_lease_id, started_at DESC)
    WHERE result_lease_id IS NOT NULL;

ALTER TABLE hosted_agent_snapshot_references
    DROP CONSTRAINT hosted_agent_snapshot_references_reference_kind_check,
    ADD CONSTRAINT hosted_agent_snapshot_references_reference_kind_check
        CHECK (reference_kind IN (
            'lease_base', 'lease_latest', 'lease_restore_source',
            'artifact_base', 'artifact_current', 'codex_thread'
        ));
