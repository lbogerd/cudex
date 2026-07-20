/* @name InspectPocLeases */
SELECT lease_id, environment_id, agent_id, owner_agent_id, owner_lease_id,
  provider_sandbox_id, base_snapshot_id, latest_snapshot_id, state
FROM hosted_agent_leases WHERE tenant_id = :tenantId! ORDER BY created_at;

/* @name InspectPocOperations */
SELECT operation, state, primary_lease_id, result_lease_id
FROM hosted_agent_operations WHERE tenant_id = :tenantId! ORDER BY started_at;

/* @name InspectPocSnapshots */
SELECT snapshot_id, lease_id, provider_snapshot_id, state
FROM hosted_agent_snapshots WHERE tenant_id = :tenantId! ORDER BY created_at;

/* @name InspectPocArtifacts */
SELECT artifact_id, agent_id, source_lease_id, state
FROM hosted_agent_artifacts WHERE tenant_id = :tenantId! ORDER BY created_at;

/* @name InspectPocPatchApplications */
SELECT application_id, target_lease_id, artifact_id, source_target_snapshot_id, result_snapshot_id, phase
FROM hosted_agent_patch_applications WHERE tenant_id = :tenantId! ORDER BY created_at;

/* @name InspectPocAllocations */
SELECT allocation_kind, resource_id, lease_id, state
FROM hosted_agent_operation_allocations WHERE tenant_id = :tenantId! ORDER BY allocation_id;

/* @name InspectPocLiveTickets */
SELECT count(*)::text AS count FROM hosted_agent_tickets AS ticket
JOIN hosted_agent_leases AS lease ON lease.lease_id = ticket.lease_id
WHERE lease.tenant_id = :tenantId! AND ticket.revoked_at IS NULL AND ticket.consumed_at IS NULL
  AND ticket.expires_at > now();

/* @name InspectPocInteractions */
SELECT lease_id, connection_generation::text, process_id, state
FROM hosted_agent_lease_interactions WHERE tenant_id = :tenantId! ORDER BY created_at;

/* @name FindActivePocSandbox */
SELECT lease_id FROM hosted_agent_leases
WHERE tenant_id = :tenantId! AND provider_sandbox_id = :providerSandboxId! AND state = 'active' LIMIT 2;

/* @name InspectPocUnsettled */
SELECT
  (SELECT count(*)::integer FROM hosted_agent_leases
    WHERE tenant_id = :tenantId! AND state <> 'released') AS leases,
  (SELECT count(*)::integer FROM hosted_agent_operations
    WHERE tenant_id = :tenantId! AND state = 'in_progress') AS operations;

/* @name ListPocProviderSnapshots */
SELECT DISTINCT provider_snapshot_id FROM hosted_agent_snapshots
WHERE tenant_id = :tenantId! AND provider_snapshot_id IS NOT NULL
ORDER BY provider_snapshot_id LIMIT 1001;

/* @name ProbeDatabase */
SELECT 1 AS available;
