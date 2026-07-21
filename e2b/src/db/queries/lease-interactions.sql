/* @name InsertLeaseInteraction */
INSERT INTO hosted_agent_lease_interactions
  (interaction_id, tenant_id, lease_id, connection_generation,
   session_id, interaction_kind, process_id, state)
VALUES (:interactionId!, :tenantId!, :leaseId!, :connectionGeneration!,
  :sessionId!, :interactionKind!, :processId, 'active')
ON CONFLICT (interaction_id) DO NOTHING
RETURNING interaction_id, tenant_id, lease_id, connection_generation::text,
  session_id, interaction_kind, process_id, state, created_at, updated_at,
  detached_at, finished_at;

/* @name HasUnfinishedLeaseInteraction */
SELECT 1 AS present FROM hosted_agent_lease_interactions
WHERE tenant_id = :tenantId! AND lease_id = :leaseId! AND state <> 'finished'
  AND NOT (interaction_kind = 'process' AND process_id = :codeModeProcessId!)
LIMIT 1;

/* @name ListUnfinishedLeaseInteractions */
SELECT interaction_id, tenant_id, lease_id, connection_generation::text,
  session_id, interaction_kind, process_id, state, created_at, updated_at,
  detached_at, finished_at
FROM hosted_agent_lease_interactions
WHERE tenant_id = :tenantId! AND lease_id = :leaseId!
  AND session_id = :sessionId! AND interaction_kind = :interactionKind! AND state <> 'finished'
ORDER BY interaction_id
FOR UPDATE;

/* @name UpdateLeaseInteraction */
UPDATE hosted_agent_lease_interactions
SET state = :state!,
    detached_at = CASE WHEN :state! = 'detached' THEN now()
      WHEN :state! = 'active' THEN NULL ELSE detached_at END,
    finished_at = CASE WHEN :state! = 'finished' THEN now() ELSE NULL END
WHERE interaction_id = :interactionId!
RETURNING interaction_id, tenant_id, lease_id, connection_generation::text,
  session_id, interaction_kind, process_id, state, created_at, updated_at,
  detached_at, finished_at;

/* @name SelectLeaseInteractionForUpdate */
SELECT interaction_id, tenant_id, lease_id, connection_generation::text,
  session_id, interaction_kind, process_id, state, created_at, updated_at,
  detached_at, finished_at
FROM hosted_agent_lease_interactions
WHERE interaction_id = :interactionId!
FOR UPDATE;
