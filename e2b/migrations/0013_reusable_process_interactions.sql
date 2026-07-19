DROP INDEX hosted_agent_lease_interactions_process_uidx;

CREATE UNIQUE INDEX hosted_agent_lease_interactions_process_uidx
    ON hosted_agent_lease_interactions
        (tenant_id, lease_id, connection_generation, session_id, process_id)
    WHERE interaction_kind = 'process' AND state <> 'finished';
