CREATE TABLE hosted_agent_objects (
    object_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('source_archive', 'workspace_archive', 'manifest', 'content_blob', 'patch_artifact')),
    storage_bucket text NOT NULL,
    storage_key text NOT NULL,
    checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    state text NOT NULL CHECK (state IN ('pending', 'available', 'deleting', 'deleted', 'failed')),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (octet_length(object_id) BETWEEN 1 AND 512 AND btrim(object_id) <> ''),
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 512 AND btrim(tenant_id) <> ''),
    CHECK (octet_length(storage_bucket) BETWEEN 1 AND 512 AND btrim(storage_bucket) <> ''),
    CHECK (octet_length(storage_key) BETWEEN 1 AND 2048 AND btrim(storage_key) <> ''),
    UNIQUE (object_id, tenant_id),
    UNIQUE (storage_bucket, storage_key)
);

CREATE INDEX hosted_agent_objects_state_expiry_idx
    ON hosted_agent_objects (state, expires_at)
    WHERE state IN ('pending', 'available', 'deleting');
CREATE INDEX hosted_agent_objects_tenant_checksum_idx
    ON hosted_agent_objects (tenant_id, checksum);

CREATE TABLE hosted_agent_source_snapshots (
    source_snapshot_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    archive_object_id text NOT NULL,
    checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
    cwd_uri text NOT NULL CHECK (cwd_uri ~ '^file:///'),
    workspace_root_uris jsonb NOT NULL CHECK (jsonb_typeof(workspace_root_uris) = 'array'),
    state text NOT NULL CHECK (state IN ('pending', 'available', 'expired', 'deleted', 'failed')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (octet_length(source_snapshot_id) BETWEEN 1 AND 512 AND btrim(source_snapshot_id) <> ''),
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 512 AND btrim(tenant_id) <> ''),
    CHECK (jsonb_array_length(workspace_root_uris) BETWEEN 1 AND 64),
    FOREIGN KEY (archive_object_id, tenant_id)
        REFERENCES hosted_agent_objects(object_id, tenant_id) ON DELETE RESTRICT,
    UNIQUE (source_snapshot_id, tenant_id),
    UNIQUE (tenant_id, checksum)
);

CREATE INDEX hosted_agent_source_snapshots_expiry_idx
    ON hosted_agent_source_snapshots (state, expires_at)
    WHERE state IN ('pending', 'available');

CREATE TABLE hosted_agent_leases (
    lease_id text PRIMARY KEY,
    environment_id text NOT NULL UNIQUE,
    tenant_id text NOT NULL,
    agent_id text NOT NULL,
    owner_agent_id text,
    owner_lease_id text,
    source_snapshot_id text,
    provider_sandbox_id text,
    sandbox_template text NOT NULL,
    cwd_uri text NOT NULL CHECK (cwd_uri ~ '^file:///'),
    workspace_root_uris jsonb NOT NULL CHECK (jsonb_typeof(workspace_root_uris) = 'array'),
    base_snapshot_id text,
    latest_snapshot_id text,
    state text NOT NULL CHECK (state IN ('provisioning', 'active', 'paused', 'release_pending', 'released', 'failed')),
    tool_policy jsonb NOT NULL CHECK (jsonb_typeof(tool_policy) = 'object'),
    policy_version bigint NOT NULL CHECK (policy_version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz,
    CHECK (octet_length(lease_id) BETWEEN 1 AND 512 AND btrim(lease_id) <> ''),
    CHECK (octet_length(environment_id) BETWEEN 1 AND 512 AND btrim(environment_id) <> ''),
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 512 AND btrim(tenant_id) <> ''),
    CHECK (octet_length(agent_id) BETWEEN 1 AND 512 AND btrim(agent_id) <> ''),
    CHECK (owner_agent_id IS NULL OR (octet_length(owner_agent_id) BETWEEN 1 AND 512 AND btrim(owner_agent_id) <> '')),
    CHECK (provider_sandbox_id IS NULL OR (octet_length(provider_sandbox_id) BETWEEN 1 AND 512 AND btrim(provider_sandbox_id) <> '')),
    CHECK (octet_length(sandbox_template) BETWEEN 1 AND 512 AND btrim(sandbox_template) <> ''),
    CHECK (jsonb_array_length(workspace_root_uris) BETWEEN 1 AND 64),
    CHECK ((state = 'released') = (released_at IS NOT NULL)),
    CHECK (owner_lease_id IS NULL OR owner_agent_id IS NOT NULL),
    FOREIGN KEY (owner_lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (source_snapshot_id, tenant_id)
        REFERENCES hosted_agent_source_snapshots(source_snapshot_id, tenant_id) ON DELETE RESTRICT,
    UNIQUE (lease_id, tenant_id)
);

CREATE UNIQUE INDEX hosted_agent_leases_provider_sandbox_uidx
    ON hosted_agent_leases (provider_sandbox_id)
    WHERE provider_sandbox_id IS NOT NULL AND state <> 'released';
CREATE INDEX hosted_agent_leases_tenant_agent_idx ON hosted_agent_leases (tenant_id, agent_id);
CREATE INDEX hosted_agent_leases_owner_idx ON hosted_agent_leases (owner_lease_id) WHERE owner_lease_id IS NOT NULL;
CREATE INDEX hosted_agent_leases_reconcile_idx
    ON hosted_agent_leases (state, updated_at)
    WHERE state IN ('provisioning', 'active', 'paused', 'release_pending', 'failed');

CREATE TABLE hosted_agent_snapshots (
    snapshot_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    lease_id text NOT NULL,
    provider_snapshot_id text,
    workspace_archive_object_id text NOT NULL,
    manifest_object_id text NOT NULL,
    manifest_checksum text NOT NULL CHECK (manifest_checksum ~ '^sha256:[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('creating', 'available', 'deleting', 'deleted', 'failed')),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (octet_length(snapshot_id) BETWEEN 1 AND 512 AND btrim(snapshot_id) <> ''),
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 512 AND btrim(tenant_id) <> ''),
    CHECK (provider_snapshot_id IS NULL OR (octet_length(provider_snapshot_id) BETWEEN 1 AND 512 AND btrim(provider_snapshot_id) <> '')),
    FOREIGN KEY (lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_archive_object_id, tenant_id)
        REFERENCES hosted_agent_objects(object_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (manifest_object_id, tenant_id)
        REFERENCES hosted_agent_objects(object_id, tenant_id) ON DELETE RESTRICT,
    UNIQUE (snapshot_id, tenant_id)
);

CREATE UNIQUE INDEX hosted_agent_snapshots_provider_uidx
    ON hosted_agent_snapshots (provider_snapshot_id)
    WHERE provider_snapshot_id IS NOT NULL AND state <> 'deleted';
CREATE INDEX hosted_agent_snapshots_lease_created_idx ON hosted_agent_snapshots (lease_id, created_at DESC);
CREATE INDEX hosted_agent_snapshots_reconcile_idx
    ON hosted_agent_snapshots (state, updated_at)
    WHERE state IN ('creating', 'deleting', 'failed');

ALTER TABLE hosted_agent_leases
    ADD CONSTRAINT hosted_agent_leases_base_snapshot_fk
        FOREIGN KEY (base_snapshot_id, tenant_id) REFERENCES hosted_agent_snapshots(snapshot_id, tenant_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT hosted_agent_leases_latest_snapshot_fk
        FOREIGN KEY (latest_snapshot_id, tenant_id) REFERENCES hosted_agent_snapshots(snapshot_id, tenant_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE hosted_agent_artifacts (
    artifact_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    agent_id text NOT NULL,
    source_lease_id text NOT NULL,
    base_snapshot_id text NOT NULL,
    current_snapshot_id text NOT NULL,
    base_manifest_object_id text NOT NULL,
    current_manifest_object_id text NOT NULL,
    artifact_object_id text NOT NULL,
    checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
    changed_files integer NOT NULL CHECK (changed_files >= 0),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    state text NOT NULL CHECK (state IN ('creating', 'available', 'expired', 'deleting', 'deleted', 'failed')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (octet_length(artifact_id) BETWEEN 1 AND 512 AND btrim(artifact_id) <> ''),
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 512 AND btrim(tenant_id) <> ''),
    CHECK (octet_length(agent_id) BETWEEN 1 AND 512 AND btrim(agent_id) <> ''),
    FOREIGN KEY (source_lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (base_snapshot_id, tenant_id)
        REFERENCES hosted_agent_snapshots(snapshot_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (current_snapshot_id, tenant_id)
        REFERENCES hosted_agent_snapshots(snapshot_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (base_manifest_object_id, tenant_id)
        REFERENCES hosted_agent_objects(object_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (current_manifest_object_id, tenant_id)
        REFERENCES hosted_agent_objects(object_id, tenant_id) ON DELETE RESTRICT,
    FOREIGN KEY (artifact_object_id, tenant_id)
        REFERENCES hosted_agent_objects(object_id, tenant_id) ON DELETE RESTRICT,
    UNIQUE (artifact_id, tenant_id)
);

CREATE INDEX hosted_agent_artifacts_tenant_agent_idx ON hosted_agent_artifacts (tenant_id, agent_id, created_at DESC);
CREATE INDEX hosted_agent_artifacts_expiry_idx
    ON hosted_agent_artifacts (state, expires_at)
    WHERE state IN ('creating', 'available', 'expired', 'deleting');

CREATE TABLE hosted_agent_operations (
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    tenant_id text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('in_progress', 'succeeded', 'failed_terminal')),
    logical_response jsonb,
    error_code text,
    error_message text,
    primary_lease_id text,
    worker_id text,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    heartbeat_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (operation, idempotency_key),
    CHECK (octet_length(operation) BETWEEN 1 AND 128 AND btrim(operation) <> ''),
    CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512 AND btrim(idempotency_key) <> ''),
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 512 AND btrim(tenant_id) <> ''),
    CHECK (error_message IS NULL OR octet_length(error_message) <= 4096),
    CHECK ((state = 'in_progress') = (completed_at IS NULL)),
    CHECK (state <> 'succeeded' OR logical_response IS NOT NULL),
    FOREIGN KEY (primary_lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT,
    UNIQUE (operation, idempotency_key, tenant_id)
);

CREATE INDEX hosted_agent_operations_stale_idx
    ON hosted_agent_operations (heartbeat_at, started_at)
    WHERE state = 'in_progress';
CREATE INDEX hosted_agent_operations_lease_idx
    ON hosted_agent_operations (primary_lease_id, started_at DESC)
    WHERE primary_lease_id IS NOT NULL;

CREATE TABLE hosted_agent_operation_allocations (
    allocation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    tenant_id text NOT NULL,
    allocation_kind text NOT NULL CHECK (allocation_kind IN ('sandbox', 'capture_sandbox', 'provider_snapshot', 'ticket', 'object')),
    resource_id text NOT NULL,
    lease_id text,
    state text NOT NULL CHECK (state IN ('allocated', 'adopted', 'reclaim_pending', 'reclaimed')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    allocated_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    reclaimed_at timestamptz,
    FOREIGN KEY (operation, idempotency_key, tenant_id)
        REFERENCES hosted_agent_operations(operation, idempotency_key, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT,
    CHECK (octet_length(tenant_id) BETWEEN 1 AND 512 AND btrim(tenant_id) <> ''),
    CHECK (octet_length(resource_id) BETWEEN 1 AND 2048 AND btrim(resource_id) <> ''),
    CHECK ((state = 'reclaimed') = (reclaimed_at IS NOT NULL)),
    UNIQUE (operation, idempotency_key, allocation_kind, resource_id)
);

CREATE INDEX hosted_agent_operation_allocations_reconcile_idx
    ON hosted_agent_operation_allocations (state, updated_at)
    WHERE state IN ('allocated', 'reclaim_pending');
CREATE INDEX hosted_agent_operation_allocations_resource_idx
    ON hosted_agent_operation_allocations (allocation_kind, resource_id);

CREATE TABLE hosted_agent_tickets (
    ticket_hash bytea PRIMARY KEY CHECK (octet_length(ticket_hash) = 32),
    lease_id text NOT NULL REFERENCES hosted_agent_leases(lease_id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose IN ('connect', 'reconnect')),
    expires_at timestamptz NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz,
    revoked_at timestamptz,
    CHECK (expires_at > issued_at)
);

CREATE INDEX hosted_agent_tickets_lease_idx ON hosted_agent_tickets (lease_id, expires_at DESC);
CREATE INDEX hosted_agent_tickets_expiry_idx
    ON hosted_agent_tickets (expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE hosted_agent_object_references (
    object_id text NOT NULL REFERENCES hosted_agent_objects(object_id) ON DELETE RESTRICT,
    reference_kind text NOT NULL CHECK (reference_kind IN ('source_snapshot', 'snapshot', 'artifact', 'lease', 'operation', 'codex_thread')),
    reference_id text NOT NULL,
    purpose text NOT NULL,
    retain_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (object_id, reference_kind, reference_id, purpose),
    CHECK (octet_length(reference_id) BETWEEN 1 AND 512 AND btrim(reference_id) <> ''),
    CHECK (octet_length(purpose) BETWEEN 1 AND 128 AND btrim(purpose) <> '')
);

CREATE INDEX hosted_agent_object_references_owner_idx
    ON hosted_agent_object_references (reference_kind, reference_id);
CREATE INDEX hosted_agent_object_references_retention_idx
    ON hosted_agent_object_references (retain_until)
    WHERE retain_until IS NOT NULL;

CREATE TABLE hosted_agent_snapshot_references (
    snapshot_id text NOT NULL REFERENCES hosted_agent_snapshots(snapshot_id) ON DELETE RESTRICT,
    reference_kind text NOT NULL CHECK (reference_kind IN ('lease_base', 'lease_latest', 'artifact_base', 'artifact_current', 'codex_thread')),
    reference_id text NOT NULL,
    retain_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (snapshot_id, reference_kind, reference_id),
    CHECK (octet_length(reference_id) BETWEEN 1 AND 512 AND btrim(reference_id) <> '')
);

CREATE INDEX hosted_agent_snapshot_references_owner_idx
    ON hosted_agent_snapshot_references (reference_kind, reference_id);

CREATE TABLE hosted_agent_artifact_references (
    artifact_id text NOT NULL REFERENCES hosted_agent_artifacts(artifact_id) ON DELETE RESTRICT,
    reference_kind text NOT NULL CHECK (reference_kind IN ('codex_thread', 'owner_agent', 'operation')),
    reference_id text NOT NULL,
    retain_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (artifact_id, reference_kind, reference_id),
    CHECK (octet_length(reference_id) BETWEEN 1 AND 512 AND btrim(reference_id) <> '')
);

CREATE INDEX hosted_agent_artifact_references_owner_idx
    ON hosted_agent_artifact_references (reference_kind, reference_id);

CREATE OR REPLACE FUNCTION hosted_agent_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_agent_objects_updated_at
    BEFORE UPDATE ON hosted_agent_objects
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();
CREATE TRIGGER hosted_agent_source_snapshots_updated_at
    BEFORE UPDATE ON hosted_agent_source_snapshots
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();
CREATE TRIGGER hosted_agent_leases_updated_at
    BEFORE UPDATE ON hosted_agent_leases
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();
CREATE TRIGGER hosted_agent_snapshots_updated_at
    BEFORE UPDATE ON hosted_agent_snapshots
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();
CREATE TRIGGER hosted_agent_artifacts_updated_at
    BEFORE UPDATE ON hosted_agent_artifacts
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();
CREATE TRIGGER hosted_agent_operations_updated_at
    BEFORE UPDATE ON hosted_agent_operations
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();
CREATE TRIGGER hosted_agent_operation_allocations_updated_at
    BEFORE UPDATE ON hosted_agent_operation_allocations
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();

CREATE OR REPLACE FUNCTION hosted_agent_protect_available_source_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (
        NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id OR
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
        NEW.archive_object_id IS DISTINCT FROM OLD.archive_object_id OR
        NEW.checksum IS DISTINCT FROM OLD.checksum OR
        NEW.cwd_uri IS DISTINCT FROM OLD.cwd_uri OR
        NEW.workspace_root_uris IS DISTINCT FROM OLD.workspace_root_uris
    ) THEN
        RAISE EXCEPTION 'available source snapshots are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_agent_source_snapshots_immutable
    BEFORE UPDATE ON hosted_agent_source_snapshots
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_protect_available_source_snapshot();
