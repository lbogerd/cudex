ALTER TABLE hosted_agent_leases
    DROP CONSTRAINT hosted_agent_leases_state_check;

ALTER TABLE hosted_agent_leases
    ADD CONSTRAINT hosted_agent_leases_state_check
    CHECK (state IN (
        'provisioning', 'active', 'paused', 'release_pending', 'released', 'lost', 'failed'
    )),
    ADD COLUMN connection_generation bigint NOT NULL DEFAULT 0
        CHECK (connection_generation BETWEEN 0 AND 9007199254740991);

ALTER TABLE hosted_agent_tickets
    ADD COLUMN connection_generation bigint NOT NULL DEFAULT 0
        CHECK (connection_generation BETWEEN 0 AND 9007199254740991);
