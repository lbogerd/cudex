CREATE OR REPLACE FUNCTION hosted_agent_protect_artifact_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (
        NEW.artifact_id IS DISTINCT FROM OLD.artifact_id OR
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
        NEW.agent_id IS DISTINCT FROM OLD.agent_id OR
        NEW.source_lease_id IS DISTINCT FROM OLD.source_lease_id OR
        NEW.base_snapshot_id IS DISTINCT FROM OLD.base_snapshot_id OR
        NEW.current_snapshot_id IS DISTINCT FROM OLD.current_snapshot_id OR
        NEW.base_manifest_object_id IS DISTINCT FROM OLD.base_manifest_object_id OR
        NEW.current_manifest_object_id IS DISTINCT FROM OLD.current_manifest_object_id OR
        NEW.artifact_object_id IS DISTINCT FROM OLD.artifact_object_id OR
        NEW.checksum IS DISTINCT FROM OLD.checksum OR
        NEW.changed_files IS DISTINCT FROM OLD.changed_files OR
        NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR
        NEW.expires_at IS DISTINCT FROM OLD.expires_at
    ) THEN
        RAISE EXCEPTION 'patch artifact identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_agent_artifact_identity_immutable
    BEFORE UPDATE ON hosted_agent_artifacts
    FOR EACH ROW EXECUTE FUNCTION hosted_agent_protect_artifact_identity();
