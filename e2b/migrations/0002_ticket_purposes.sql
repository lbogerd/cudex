ALTER TABLE hosted_agent_tickets
    DROP CONSTRAINT hosted_agent_tickets_purpose_check,
    ADD CONSTRAINT hosted_agent_tickets_purpose_check
        CHECK (purpose IN ('exec_gateway_connect', 'exec_gateway_probe'));
