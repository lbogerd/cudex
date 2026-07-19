ALTER TABLE hosted_agent_operations
    DROP CONSTRAINT hosted_agent_operations_subtype_check,
    ADD CONSTRAINT hosted_agent_operations_subtype_check
        CHECK (operation_subtype IS NULL OR
            (operation = 'provision' AND operation_subtype = 'child'
             AND primary_lease_id IS NOT NULL));
