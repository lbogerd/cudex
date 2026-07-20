/* @name GetLease */
SELECT lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at
FROM hosted_agent_leases WHERE lease_id = :leaseId! AND tenant_id = :tenantId!;

/* @name InsertLease */
INSERT INTO hosted_agent_leases
  (lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id,
   provider_sandbox_id, sandbox_template, cwd_uri, workspace_root_uris, state, tool_policy, policy_version)
VALUES (:leaseId!, :environmentId!, :tenantId!, :agentId!, :ownerAgentId, :ownerLeaseId,
  :sourceSnapshotId, :restoreSourceLeaseId, :restoreSourceSnapshotId, :providerSandboxId!,
  :sandboxTemplate!, :cwdUri!, :workspaceRootUris!::jsonb, 'provisioning', :toolPolicy!::jsonb,
  :policyVersion!);

/* @name InsertLeaseBaseReferences */
INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
VALUES (:snapshotId!, 'lease_base', :leaseId!), (:snapshotId!, 'lease_latest', :leaseId!);

/* @name InsertLeaseRestoreSourceReference */
INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
VALUES (:snapshotId!, 'lease_restore_source', :leaseId!);

/* @name ActivateLease */
UPDATE hosted_agent_leases
SET base_snapshot_id = :snapshotId!, latest_snapshot_id = :snapshotId!, state = 'active'
WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at;

/* @name FindRestoreReplacementForUpdate */
SELECT lease_id FROM hosted_agent_leases
WHERE restore_source_lease_id = :sourceLeaseId! AND tenant_id = :tenantId! FOR UPDATE;

/* @name ReleaseLostRestoreSource */
UPDATE hosted_agent_leases SET state = 'released', released_at = now()
WHERE lease_id = :leaseId! AND tenant_id = :tenantId! AND state = 'lost';

/* @name DeleteLatestSnapshotReference */
DELETE FROM hosted_agent_snapshot_references
WHERE reference_kind = 'lease_latest' AND reference_id = :leaseId!;

/* @name InsertLatestSnapshotReference */
INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
VALUES (:snapshotId!, 'lease_latest', :leaseId!);

/* @name SetLatestSnapshot */
UPDATE hosted_agent_leases SET latest_snapshot_id = :snapshotId!
WHERE lease_id = :leaseId! AND tenant_id = :tenantId!;

/* @name LockLease */
SELECT lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at
FROM hosted_agent_leases WHERE lease_id = :leaseId! AND tenant_id = :tenantId! FOR UPDATE;

/* @name ActiveLeaseTarget */
SELECT provider_sandbox_id, connection_generation::text
FROM hosted_agent_leases
WHERE lease_id = :leaseId! AND state = 'active' AND provider_sandbox_id IS NOT NULL;

/* @name FindLeaseByProviderSandboxForReconciliation */
SELECT lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at
FROM hosted_agent_leases
WHERE provider_sandbox_id = :providerSandboxId!
  AND state IN ('provisioning', 'active', 'paused', 'release_pending')
ORDER BY created_at DESC LIMIT 1;

/* @name FindSnapshotByProviderIdForReconciliation */
SELECT snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
  manifest_object_id, manifest_checksum, state, expires_at, created_at
FROM hosted_agent_snapshots
WHERE provider_snapshot_id = :providerSnapshotId! AND state <> 'deleted'
ORDER BY created_at DESC LIMIT 1;

/* @name GetSnapshot */
SELECT snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
  manifest_object_id, manifest_checksum, state, expires_at, created_at
FROM hosted_agent_snapshots WHERE snapshot_id = :snapshotId! AND tenant_id = :tenantId!;

/* @name LockSnapshot */
SELECT snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
  manifest_object_id, manifest_checksum, state, expires_at, created_at
FROM hosted_agent_snapshots
WHERE snapshot_id = :snapshotId! AND tenant_id = :tenantId! FOR UPDATE;

/* @name InsertSnapshot */
INSERT INTO hosted_agent_snapshots
  (snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
   manifest_object_id, manifest_checksum, state, expires_at)
VALUES (:snapshotId!, :tenantId!, :leaseId!, :providerSnapshotId, :workspaceArchiveObjectId!,
  :manifestObjectId!, :manifestChecksum!, 'available', :expiresAt);

/* @name TransitionLeaseState */
UPDATE hosted_agent_leases
SET state = :next!, released_at = CASE WHEN :next! = 'released' THEN now() ELSE NULL END
WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at;

/* @name RevokeTicketsByLeaseId */
UPDATE hosted_agent_tickets SET revoked_at = COALESCE(revoked_at, now())
WHERE lease_id = :leaseId!;

/* @name BeginRelease */
UPDATE hosted_agent_leases SET state = 'release_pending', released_at = NULL
WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at;

/* @name CompleteReconnect */
UPDATE hosted_agent_leases
SET state = 'active', released_at = NULL, connection_generation = connection_generation + 1
WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at;

/* @name RotateReconnectReplayAccess */
UPDATE hosted_agent_leases SET connection_generation = connection_generation + 1
WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at;

/* @name MarkLeaseLost */
UPDATE hosted_agent_leases
SET state = 'lost', released_at = NULL, connection_generation = connection_generation + 1
WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at;

/* @name CompleteRelease */
UPDATE hosted_agent_leases SET state = 'released', released_at = now()
WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
  tool_policy, policy_version::text, connection_generation::text, released_at;

/* @name InsertTicket */
INSERT INTO hosted_agent_tickets
  (ticket_hash, lease_id, purpose, expires_at, connection_generation)
VALUES (:ticketHash!, :leaseId!, :purpose!, :expiresAt!, :connectionGeneration!);

/* @name ConsumeTicket */
UPDATE hosted_agent_tickets AS ticket
SET consumed_at = :at!
FROM hosted_agent_leases AS lease
WHERE ticket.ticket_hash = :ticketHash! AND ticket.lease_id = :leaseId!
  AND ticket.purpose = :purpose! AND ticket.lease_id = lease.lease_id
  AND lease.tenant_id = :tenantId! AND lease.state = 'active'
  AND ticket.connection_generation = lease.connection_generation
  AND ticket.consumed_at IS NULL AND ticket.revoked_at IS NULL AND ticket.expires_at > :at!
RETURNING ticket.connection_generation::text;

/* @name RevokeLeaseTickets */
UPDATE hosted_agent_tickets AS ticket SET revoked_at = COALESCE(ticket.revoked_at, now())
FROM hosted_agent_leases AS lease
WHERE ticket.lease_id = lease.lease_id AND lease.lease_id = :leaseId!
  AND lease.tenant_id = :tenantId! AND ticket.revoked_at IS NULL
RETURNING 1 AS affected;

/* @name CleanupTickets */
DELETE FROM hosted_agent_tickets WHERE ctid IN (
  SELECT ctid FROM hosted_agent_tickets
  WHERE expires_at < :before! OR consumed_at < :before! OR revoked_at < :before!
  LIMIT :limit!
)
RETURNING 1 AS affected;
