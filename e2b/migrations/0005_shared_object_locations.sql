ALTER TABLE hosted_agent_objects
    DROP CONSTRAINT hosted_agent_objects_tenant_storage_location_key;

CREATE INDEX hosted_agent_objects_storage_location_idx
    ON hosted_agent_objects (storage_bucket, storage_key)
    WHERE state <> 'deleted';
