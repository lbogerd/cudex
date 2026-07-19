CREATE TABLE hosted_agent_lease_interactions (
    interaction_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    lease_id text NOT NULL,
    connection_generation bigint NOT NULL
        CHECK (connection_generation BETWEEN 0 AND 9007199254740991),
    session_id text NOT NULL,
    process_id text,
    interaction_kind text NOT NULL CHECK (interaction_kind IN ('process', 'filesystem')),
    state text NOT NULL CHECK (state IN ('active', 'detached', 'finished')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    detached_at timestamptz,
    finished_at timestamptz,
    CHECK (octet_length(interaction_id) BETWEEN 1 AND 512 AND btrim(interaction_id) <> ''),
    CHECK (octet_length(session_id) BETWEEN 1 AND 512 AND btrim(session_id) <> ''),
    CHECK (process_id IS NULL OR
        (octet_length(process_id) BETWEEN 1 AND 512 AND btrim(process_id) <> '')),
    CHECK ((interaction_kind = 'process') = (process_id IS NOT NULL)),
    CHECK ((state = 'active' AND detached_at IS NULL AND finished_at IS NULL)
        OR (state = 'detached' AND detached_at IS NOT NULL AND finished_at IS NULL)
        OR (state = 'finished' AND finished_at IS NOT NULL)),
    FOREIGN KEY (lease_id, tenant_id)
        REFERENCES hosted_agent_leases(lease_id, tenant_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX hosted_agent_lease_interactions_process_uidx
    ON hosted_agent_lease_interactions
        (tenant_id, lease_id, connection_generation, session_id, process_id)
    WHERE interaction_kind = 'process';

CREATE INDEX hosted_agent_lease_interactions_unfinished_idx
    ON hosted_agent_lease_interactions (tenant_id, lease_id, connection_generation, state)
    WHERE state <> 'finished';

CREATE OR REPLACE FUNCTION hosted_agent_protect_lease_interaction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.interaction_id IS DISTINCT FROM OLD.interaction_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
       OR NEW.connection_generation IS DISTINCT FROM OLD.connection_generation
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.process_id IS DISTINCT FROM OLD.process_id
       OR NEW.interaction_kind IS DISTINCT FROM OLD.interaction_kind THEN
        RAISE EXCEPTION 'lease interaction identity is immutable';
    END IF;
    IF OLD.state = 'finished' AND NEW.state <> 'finished' THEN
        RAISE EXCEPTION 'finished lease interaction is terminal';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_agent_lease_interactions_immutable
    BEFORE UPDATE ON hosted_agent_lease_interactions
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_protect_lease_interaction();

CREATE TRIGGER hosted_agent_lease_interactions_updated_at
    BEFORE UPDATE ON hosted_agent_lease_interactions
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_set_updated_at();
