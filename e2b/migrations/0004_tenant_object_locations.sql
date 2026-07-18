ALTER TABLE hosted_agent_objects
    DROP CONSTRAINT hosted_agent_objects_storage_bucket_storage_key_key,
    ADD CONSTRAINT hosted_agent_objects_tenant_storage_location_key
        UNIQUE (tenant_id, storage_bucket, storage_key);
