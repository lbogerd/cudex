ALTER TABLE hosted_agent_operation_allocations
    ADD CONSTRAINT hosted_agent_operation_allocations_id_tenant_unique
        UNIQUE (allocation_id, tenant_id),
    ADD CONSTRAINT hosted_agent_operation_allocations_identity_unique
        UNIQUE (allocation_id, operation, idempotency_key, tenant_id);

CREATE TABLE hosted_agent_workspace_preparations (
    preparation_id text PRIMARY KEY,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    tenant_id text NOT NULL,
    created_generation bigint NOT NULL CHECK (created_generation >= 0),
    intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
    intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
    lease_id text NOT NULL,
    snapshot_id text NOT NULL,
    source_snapshot_id text,
    expected_object_count integer NOT NULL CHECK (expected_object_count BETWEEN 2 AND 100002),
    state text NOT NULL CHECK (state IN ('publishing', 'prepared', 'committed', 'reclaim_pending', 'reclaimed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    committed_at timestamptz,
    reclaimed_at timestamptz,
    CHECK (octet_length(preparation_id) BETWEEN 1 AND 512 AND btrim(preparation_id) <> ''),
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 512 AND btrim(tenant_id) <> ''),
    CHECK (octet_length(lease_id) BETWEEN 1 AND 512 AND btrim(lease_id) <> ''),
    CHECK (octet_length(snapshot_id) BETWEEN 1 AND 512 AND btrim(snapshot_id) <> ''),
    CHECK (source_snapshot_id IS NULL OR
        (octet_length(source_snapshot_id) BETWEEN 1 AND 512 AND btrim(source_snapshot_id) <> '')),
    CHECK (intent ->> 'tenantId' = tenant_id),
    CHECK (intent ->> 'leaseId' = lease_id),
    CHECK (intent ->> 'snapshotId' = snapshot_id),
    CHECK ((intent ->> 'sourceSnapshotId') IS NOT DISTINCT FROM source_snapshot_id),
    CHECK (octet_length(intent::text) <= 65536),
    CHECK ((state = 'committed') = (committed_at IS NOT NULL)),
    CHECK ((state = 'reclaimed') = (reclaimed_at IS NOT NULL)),
    FOREIGN KEY (operation, idempotency_key, tenant_id)
        REFERENCES hosted_agent_operations(operation, idempotency_key, tenant_id) ON DELETE RESTRICT,
    UNIQUE (operation, idempotency_key),
    UNIQUE (preparation_id, tenant_id),
    UNIQUE (preparation_id, operation, idempotency_key, tenant_id)
);

CREATE INDEX hosted_agent_workspace_preparations_reconcile_idx
    ON hosted_agent_workspace_preparations (tenant_id, state, updated_at)
    WHERE state IN ('publishing', 'reclaim_pending');

CREATE TABLE hosted_agent_workspace_preparation_objects (
    preparation_id text NOT NULL,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    tenant_id text NOT NULL,
    allocation_id bigint NOT NULL UNIQUE,
    object_id text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('workspace_archive', 'manifest', 'content_blob')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (preparation_id, object_id),
    FOREIGN KEY (preparation_id, operation, idempotency_key, tenant_id)
        REFERENCES hosted_agent_workspace_preparations
          (preparation_id, operation, idempotency_key, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (allocation_id, operation, idempotency_key, tenant_id)
        REFERENCES hosted_agent_operation_allocations
          (allocation_id, operation, idempotency_key, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (object_id, tenant_id)
        REFERENCES hosted_agent_objects(object_id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX hosted_agent_workspace_preparation_objects_preparation_idx
    ON hosted_agent_workspace_preparation_objects (preparation_id, allocation_id);

CREATE TRIGGER hosted_agent_workspace_preparations_updated_at
    BEFORE UPDATE ON hosted_agent_workspace_preparations
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();

CREATE OR REPLACE FUNCTION hosted_agent_protect_workspace_preparation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.preparation_id, NEW.operation, NEW.idempotency_key, NEW.tenant_id,
           NEW.created_generation, NEW.intent_hash, NEW.intent, NEW.lease_id,
           NEW.snapshot_id, NEW.source_snapshot_id, NEW.expected_object_count,
           NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.preparation_id, OLD.operation, OLD.idempotency_key, OLD.tenant_id,
           OLD.created_generation, OLD.intent_hash, OLD.intent, OLD.lease_id,
           OLD.snapshot_id, OLD.source_snapshot_id, OLD.expected_object_count,
           OLD.created_at) THEN
        RAISE EXCEPTION 'workspace preparation identity is immutable';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
        (OLD.state = 'publishing' AND NEW.state IN ('prepared', 'reclaim_pending')) OR
        (OLD.state = 'prepared' AND NEW.state IN ('committed', 'reclaim_pending')) OR
        (OLD.state = 'reclaim_pending' AND NEW.state = 'reclaimed')
    ) THEN
        RAISE EXCEPTION 'illegal workspace preparation transition';
    END IF;
    IF NEW.state = OLD.state AND
       ROW(NEW.committed_at, NEW.reclaimed_at) IS DISTINCT FROM
       ROW(OLD.committed_at, OLD.reclaimed_at) THEN
        RAISE EXCEPTION 'workspace preparation terminal timestamps are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_agent_workspace_preparations_immutable
    BEFORE UPDATE ON hosted_agent_workspace_preparations
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_protect_workspace_preparation();

CREATE OR REPLACE FUNCTION hosted_agent_validate_workspace_preparation_object()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'workspace preparation object association is immutable';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM hosted_agent_workspace_preparations AS preparation
        JOIN hosted_agent_operation_allocations AS allocation
          ON allocation.allocation_id = NEW.allocation_id
         AND allocation.operation = NEW.operation
         AND allocation.idempotency_key = NEW.idempotency_key
         AND allocation.tenant_id = NEW.tenant_id
         AND allocation.allocation_kind = 'object'
         AND allocation.resource_id = NEW.object_id
         AND allocation.state = 'allocated'
        JOIN hosted_agent_objects AS object_row
          ON object_row.object_id = NEW.object_id
         AND object_row.tenant_id = NEW.tenant_id
         AND object_row.kind = NEW.purpose
         AND object_row.state = 'available'
        WHERE preparation.preparation_id = NEW.preparation_id
          AND preparation.operation = NEW.operation
          AND preparation.idempotency_key = NEW.idempotency_key
          AND preparation.tenant_id = NEW.tenant_id
          AND preparation.state = 'publishing'
    ) THEN
        RAISE EXCEPTION 'invalid workspace preparation object association';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_agent_workspace_preparation_objects_valid
    BEFORE INSERT OR UPDATE ON hosted_agent_workspace_preparation_objects
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_validate_workspace_preparation_object();

CREATE OR REPLACE FUNCTION hosted_agent_protect_object_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.object_id, NEW.tenant_id, NEW.kind, NEW.storage_bucket, NEW.storage_key,
           NEW.checksum, NEW.size_bytes, NEW.expires_at, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.object_id, OLD.tenant_id, OLD.kind, OLD.storage_bucket, OLD.storage_key,
           OLD.checksum, OLD.size_bytes, OLD.expires_at, OLD.created_at) THEN
        RAISE EXCEPTION 'hosted agent object identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_agent_objects_immutable_identity
    BEFORE UPDATE ON hosted_agent_objects
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_protect_object_identity();
