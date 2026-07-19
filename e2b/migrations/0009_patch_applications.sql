CREATE TABLE hosted_agent_patch_applications (
    application_id text PRIMARY KEY,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    tenant_id text NOT NULL,
    created_generation bigint NOT NULL CHECK (created_generation >= 0),
    target_lease_id text NOT NULL,
    artifact_id text NOT NULL,
    source_target_snapshot_id text NOT NULL,
    target_provider_sandbox_id text NOT NULL,
    result_snapshot_id text NOT NULL,
    result_manifest_checksum text NOT NULL CHECK (result_manifest_checksum ~ '^sha256:[0-9a-f]{64}$'),
    result_archive_checksum text NOT NULL CHECK (result_archive_checksum ~ '^sha256:[0-9a-f]{64}$'),
    result_archive_size_bytes bigint NOT NULL CHECK (result_archive_size_bytes >= 0),
    rollback_allocation_id bigint,
    rollback_provider_snapshot_id text,
    phase text NOT NULL CHECK (phase IN (
        'planned', 'rollback_ready', 'swap_started', 'swapped', 'checkpointed',
        'rollback_started', 'rolled_back', 'failed'
    )),
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    rollback_ready_at timestamptz,
    swap_started_at timestamptz,
    swapped_at timestamptz,
    checkpointed_at timestamptz,
    rollback_started_at timestamptz,
    rolled_back_at timestamptz,
    failed_at timestamptz,
    CHECK (octet_length(application_id) BETWEEN 1 AND 512 AND btrim(application_id) <> ''),
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 512 AND btrim(tenant_id) <> ''),
    CHECK (octet_length(target_lease_id) BETWEEN 1 AND 512 AND btrim(target_lease_id) <> ''),
    CHECK (octet_length(artifact_id) BETWEEN 1 AND 512 AND btrim(artifact_id) <> ''),
    CHECK (octet_length(source_target_snapshot_id) BETWEEN 1 AND 512 AND btrim(source_target_snapshot_id) <> ''),
    CHECK (octet_length(target_provider_sandbox_id) BETWEEN 1 AND 2048 AND btrim(target_provider_sandbox_id) <> ''),
    CHECK (octet_length(result_snapshot_id) BETWEEN 1 AND 512 AND btrim(result_snapshot_id) <> ''),
    CHECK (rollback_provider_snapshot_id IS NULL OR
        (octet_length(rollback_provider_snapshot_id) BETWEEN 1 AND 2048
         AND btrim(rollback_provider_snapshot_id) <> '')),
    CHECK ((rollback_allocation_id IS NULL) = (rollback_provider_snapshot_id IS NULL)),
    CHECK ((phase IN ('planned', 'failed')) = (rollback_allocation_id IS NULL)),
    CHECK (error_message IS NULL OR octet_length(error_message) <= 4096),
    FOREIGN KEY (operation, idempotency_key, tenant_id)
        REFERENCES hosted_agent_operations(operation, idempotency_key, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (target_lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (artifact_id, tenant_id)
        REFERENCES hosted_agent_artifacts(artifact_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (source_target_snapshot_id, target_lease_id, tenant_id)
        REFERENCES hosted_agent_snapshots(snapshot_id, lease_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (rollback_allocation_id, operation, idempotency_key, tenant_id)
        REFERENCES hosted_agent_operation_allocations
          (allocation_id, operation, idempotency_key, tenant_id) ON DELETE RESTRICT,
    UNIQUE (operation, idempotency_key),
    UNIQUE (application_id, tenant_id)
);

CREATE INDEX hosted_agent_patch_applications_reconcile_idx
    ON hosted_agent_patch_applications (tenant_id, phase, updated_at)
    WHERE phase NOT IN ('checkpointed', 'rolled_back', 'failed');

CREATE TRIGGER hosted_agent_patch_applications_updated_at
    BEFORE UPDATE ON hosted_agent_patch_applications
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();

CREATE OR REPLACE FUNCTION hosted_agent_protect_patch_application()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.application_id, NEW.operation, NEW.idempotency_key, NEW.tenant_id,
           NEW.created_generation, NEW.target_lease_id, NEW.artifact_id,
           NEW.source_target_snapshot_id, NEW.target_provider_sandbox_id,
           NEW.result_snapshot_id, NEW.result_manifest_checksum,
           NEW.result_archive_checksum, NEW.result_archive_size_bytes, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.application_id, OLD.operation, OLD.idempotency_key, OLD.tenant_id,
           OLD.created_generation, OLD.target_lease_id, OLD.artifact_id,
           OLD.source_target_snapshot_id, OLD.target_provider_sandbox_id,
           OLD.result_snapshot_id, OLD.result_manifest_checksum,
           OLD.result_archive_checksum, OLD.result_archive_size_bytes, OLD.created_at) THEN
        RAISE EXCEPTION 'patch application identity is immutable';
    END IF;

    IF NEW.phase <> OLD.phase AND NOT (
        (OLD.phase = 'planned' AND NEW.phase IN ('rollback_ready', 'failed')) OR
        (OLD.phase = 'rollback_ready' AND NEW.phase IN ('swap_started', 'rollback_started')) OR
        (OLD.phase = 'swap_started' AND NEW.phase IN ('swapped', 'rollback_started')) OR
        (OLD.phase = 'swapped' AND NEW.phase IN ('checkpointed', 'rollback_started')) OR
        (OLD.phase = 'rollback_started' AND NEW.phase = 'rolled_back')
    ) THEN
        RAISE EXCEPTION 'illegal patch application transition';
    END IF;

    IF OLD.phase = 'planned' AND NEW.phase = 'rollback_ready' THEN
        IF NEW.rollback_allocation_id IS NULL OR NEW.rollback_provider_snapshot_id IS NULL
           OR NEW.rollback_ready_at IS NULL THEN
            RAISE EXCEPTION 'patch application rollback identity is incomplete';
        END IF;
    ELSIF ROW(NEW.rollback_allocation_id, NEW.rollback_provider_snapshot_id,
              NEW.rollback_ready_at)
          IS DISTINCT FROM
          ROW(OLD.rollback_allocation_id, OLD.rollback_provider_snapshot_id,
              OLD.rollback_ready_at) THEN
        RAISE EXCEPTION 'patch application rollback identity is immutable';
    END IF;

    IF NEW.phase <> OLD.phase THEN
        IF NEW.phase = 'swap_started' AND NEW.swap_started_at IS NULL THEN
            RAISE EXCEPTION 'patch application swap start is incomplete';
        ELSIF NEW.phase = 'swapped' AND NEW.swapped_at IS NULL THEN
            RAISE EXCEPTION 'patch application swap is incomplete';
        ELSIF NEW.phase = 'checkpointed' AND NEW.checkpointed_at IS NULL THEN
            RAISE EXCEPTION 'patch application checkpoint is incomplete';
        ELSIF NEW.phase = 'rollback_started' AND NEW.rollback_started_at IS NULL THEN
            RAISE EXCEPTION 'patch application rollback start is incomplete';
        ELSIF NEW.phase = 'rolled_back' AND NEW.rolled_back_at IS NULL THEN
            RAISE EXCEPTION 'patch application rollback is incomplete';
        ELSIF NEW.phase = 'failed' AND NEW.failed_at IS NULL THEN
            RAISE EXCEPTION 'patch application failure is incomplete';
        END IF;
    END IF;

    IF NOT (OLD.phase = 'rollback_ready' AND NEW.phase = 'swap_started')
       AND NEW.swap_started_at IS DISTINCT FROM OLD.swap_started_at THEN
        RAISE EXCEPTION 'patch application swap-start timestamp is immutable';
    END IF;
    IF NOT (OLD.phase = 'swap_started' AND NEW.phase = 'swapped')
       AND NEW.swapped_at IS DISTINCT FROM OLD.swapped_at THEN
        RAISE EXCEPTION 'patch application swapped timestamp is immutable';
    END IF;
    IF NOT (OLD.phase = 'swapped' AND NEW.phase = 'checkpointed')
       AND NEW.checkpointed_at IS DISTINCT FROM OLD.checkpointed_at THEN
        RAISE EXCEPTION 'patch application checkpoint timestamp is immutable';
    END IF;
    IF NOT (OLD.phase IN ('rollback_ready', 'swap_started', 'swapped')
            AND NEW.phase = 'rollback_started')
       AND NEW.rollback_started_at IS DISTINCT FROM OLD.rollback_started_at THEN
        RAISE EXCEPTION 'patch application rollback-start timestamp is immutable';
    END IF;
    IF NOT (OLD.phase = 'rollback_started' AND NEW.phase = 'rolled_back')
       AND NEW.rolled_back_at IS DISTINCT FROM OLD.rolled_back_at THEN
        RAISE EXCEPTION 'patch application rolled-back timestamp is immutable';
    END IF;
    IF NOT (OLD.phase = 'planned' AND NEW.phase = 'failed')
       AND NEW.failed_at IS DISTINCT FROM OLD.failed_at THEN
        RAISE EXCEPTION 'patch application failed timestamp is immutable';
    END IF;
    IF NOT ((OLD.phase IN ('rollback_ready', 'swap_started', 'swapped')
             AND NEW.phase = 'rollback_started')
            OR (OLD.phase = 'planned' AND NEW.phase = 'failed'))
       AND NEW.error_message IS DISTINCT FROM OLD.error_message THEN
        RAISE EXCEPTION 'patch application error is immutable';
    END IF;

    IF NEW.phase = OLD.phase AND
       ROW(NEW.rollback_allocation_id, NEW.rollback_provider_snapshot_id,
           NEW.rollback_ready_at, NEW.swap_started_at, NEW.swapped_at,
           NEW.checkpointed_at, NEW.rollback_started_at, NEW.rolled_back_at,
           NEW.failed_at, NEW.error_message)
       IS DISTINCT FROM
       ROW(OLD.rollback_allocation_id, OLD.rollback_provider_snapshot_id,
           OLD.rollback_ready_at, OLD.swap_started_at, OLD.swapped_at,
           OLD.checkpointed_at, OLD.rollback_started_at, OLD.rolled_back_at,
           OLD.failed_at, OLD.error_message) THEN
        RAISE EXCEPTION 'patch application phase metadata is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_agent_patch_applications_immutable
    BEFORE UPDATE ON hosted_agent_patch_applications
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_protect_patch_application();
