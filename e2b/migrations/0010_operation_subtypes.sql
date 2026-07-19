ALTER TABLE hosted_agent_operations
    ADD COLUMN operation_subtype text,
    ADD CONSTRAINT hosted_agent_operations_subtype_check
        CHECK (operation_subtype IS NULL OR operation_subtype = 'child');

CREATE INDEX hosted_agent_operations_subtype_stale_idx
    ON hosted_agent_operations (tenant_id, operation, operation_subtype, heartbeat_at, started_at)
    WHERE state = 'in_progress' AND operation_subtype IS NOT NULL;

CREATE OR REPLACE FUNCTION hosted_agent_protect_operation_subtype()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.operation_subtype IS DISTINCT FROM OLD.operation_subtype THEN
        RAISE EXCEPTION 'operation subtype is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_agent_operations_subtype_immutable
    BEFORE UPDATE ON hosted_agent_operations
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_protect_operation_subtype();
