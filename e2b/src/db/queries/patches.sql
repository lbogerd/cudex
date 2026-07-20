/* @name ResolvePatchExportLease */
SELECT lease_id, agent_id, owner_agent_id, owner_lease_id, source_snapshot_id,
  base_snapshot_id, latest_snapshot_id, state
FROM hosted_agent_leases WHERE tenant_id = :tenantId! AND lease_id = :leaseId!;

/* @name ResolvePatchExportSnapshotMaterial */
SELECT snapshot.snapshot_id, snapshot.lease_id, snapshot.manifest_object_id,
  snapshot.manifest_checksum, snapshot.state AS snapshot_state,
  snapshot.expires_at AS snapshot_expires_at,
  object_row.object_id, object_row.kind, object_row.storage_bucket,
  object_row.storage_key, object_row.checksum, object_row.size_bytes::text,
  object_row.state AS object_state, object_row.expires_at AS object_expires_at,
  reference.purpose
FROM hosted_agent_snapshots AS snapshot
JOIN hosted_agent_object_references AS reference
  ON reference.reference_kind = 'snapshot' AND reference.reference_id = snapshot.snapshot_id
JOIN hosted_agent_objects AS object_row
  ON object_row.object_id = reference.object_id AND object_row.tenant_id = snapshot.tenant_id
WHERE snapshot.tenant_id = :tenantId! AND snapshot.lease_id = :leaseId! AND snapshot.snapshot_id = :snapshotId!
  AND reference.purpose IN ('manifest', 'content_blob')
ORDER BY object_row.object_id;

/* @name LockPatchApplyTarget */
SELECT lease_id, agent_id, provider_sandbox_id, latest_snapshot_id, state
FROM hosted_agent_leases WHERE tenant_id = :tenantId! AND lease_id = :leaseId! FOR UPDATE;

/* @name SharePatchApplyArtifact */
SELECT artifact.artifact_id, artifact.agent_id, artifact.source_lease_id,
 artifact.base_snapshot_id, artifact.current_snapshot_id, artifact.base_manifest_object_id,
 artifact.current_manifest_object_id, artifact.artifact_object_id, artifact.checksum,
 artifact.changed_files, artifact.size_bytes::text, artifact.state, artifact.expires_at,
 source.agent_id AS source_agent_id, source.owner_agent_id AS source_owner_agent_id,
 source.owner_lease_id AS source_owner_lease_id
FROM hosted_agent_artifacts artifact JOIN hosted_agent_leases source
 ON source.lease_id = artifact.source_lease_id AND source.tenant_id = artifact.tenant_id
WHERE artifact.tenant_id = :tenantId! AND artifact.artifact_id = :artifactId!
FOR SHARE OF artifact, source;

/* @name HasRetainedPatchArtifact */
SELECT 1 AS retained FROM hosted_agent_artifact_references
WHERE artifact_id = :artifactId! AND reference_kind = 'codex_thread' LIMIT 1;

/* @name SharePatchArtifactOwnership */
SELECT reference_kind, reference_id, retain_until FROM hosted_agent_artifact_references
WHERE artifact_id = :artifactId! AND reference_kind = 'owner_agent' FOR SHARE;

/* @name SharePatchApplySnapshots */
SELECT snapshot_id, lease_id, workspace_archive_object_id, manifest_object_id,
 manifest_checksum, state, expires_at FROM hosted_agent_snapshots
WHERE tenant_id = :tenantId! AND snapshot_id = ANY(:snapshotIds!::text[]) FOR SHARE;

/* @name SharePatchArtifactSnapshotReferences */
SELECT snapshot_id, reference_kind, retain_until FROM hosted_agent_snapshot_references
WHERE reference_id = :artifactId! AND reference_kind IN ('artifact_base', 'artifact_current') FOR SHARE;

/* @name SharePatchApplySnapshot */
SELECT snapshot_id, lease_id, workspace_archive_object_id, manifest_object_id,
 manifest_checksum, state, expires_at FROM hosted_agent_snapshots
WHERE tenant_id = :tenantId! AND snapshot_id = :snapshotId! FOR SHARE;

/* @name HasLatestSnapshotReference */
SELECT 1 AS retained FROM hosted_agent_snapshot_references
WHERE snapshot_id = :snapshotId! AND reference_kind = 'lease_latest' AND reference_id = :leaseId! FOR SHARE;

/* @name SharePatchApplyObjectReferences */
SELECT reference.purpose, reference.retain_until, object_row.object_id,
 object_row.kind, object_row.storage_bucket, object_row.storage_key, object_row.checksum,
 object_row.size_bytes::text, object_row.state, object_row.expires_at
FROM hosted_agent_object_references reference JOIN hosted_agent_objects object_row
 ON object_row.object_id = reference.object_id
WHERE object_row.tenant_id = :tenantId! AND reference.reference_kind = :referenceKind!
 AND reference.reference_id = :referenceId!
ORDER BY reference.purpose, object_row.object_id FOR SHARE OF object_row, reference;

/* @name CreatePatchApplication */
INSERT INTO hosted_agent_patch_applications
 (application_id, operation, idempotency_key, tenant_id, created_generation, target_lease_id,
 artifact_id, source_target_snapshot_id, target_provider_sandbox_id, result_snapshot_id,
 result_manifest_checksum, result_archive_checksum, result_archive_size_bytes, phase)
SELECT :applicationId!, operation, idempotency_key, tenant_id, :generation!, :targetLeaseId!,
 :artifactId!, :sourceTargetSnapshotId!, :targetProviderSandboxId!, :resultSnapshotId!,
 :resultManifestChecksum!, :resultArchiveChecksum!, :resultArchiveSizeBytes!, 'planned'
FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!
 AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId!
 AND state='in_progress' AND primary_lease_id=:targetLeaseId! ON CONFLICT DO NOTHING;

/* @name OwnsPatchApplicationOperation */
SELECT 1 AS owned FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!
 AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress' FOR UPDATE;

/* @name GetPatchApplicationForOperation */
SELECT application.application_id,application.operation,application.idempotency_key,application.tenant_id,
 application.created_generation::text,application.target_lease_id,application.artifact_id,
 application.source_target_snapshot_id,application.target_provider_sandbox_id,application.result_snapshot_id,
 application.result_manifest_checksum,application.result_archive_checksum,application.result_archive_size_bytes::text,
 application.rollback_allocation_id::text,application.rollback_provider_snapshot_id,application.phase,
 application.error_message,application.created_at,application.updated_at,application.rollback_ready_at,
 application.swap_started_at,application.swapped_at,application.checkpointed_at,
 application.rollback_started_at,application.rolled_back_at,application.failed_at
FROM hosted_agent_patch_applications application WHERE application.operation=:operation!
 AND application.idempotency_key=:idempotencyKey! AND application.tenant_id=:tenantId!;

/* @name LockPatchApplication */
SELECT application.application_id,application.operation,application.idempotency_key,application.tenant_id,
 application.created_generation::text,application.target_lease_id,application.artifact_id,
 application.source_target_snapshot_id,application.target_provider_sandbox_id,application.result_snapshot_id,
 application.result_manifest_checksum,application.result_archive_checksum,application.result_archive_size_bytes::text,
 application.rollback_allocation_id::text,application.rollback_provider_snapshot_id,application.phase,
 application.error_message,application.created_at,application.updated_at,application.rollback_ready_at,
 application.swap_started_at,application.swapped_at,application.checkpointed_at,
 application.rollback_started_at,application.rolled_back_at,application.failed_at
FROM hosted_agent_patch_applications application JOIN hosted_agent_operations operation
 USING(operation,idempotency_key,tenant_id) WHERE application.application_id=:applicationId!
 AND application.tenant_id=:tenantId! AND operation.operation=:operation!
 AND operation.idempotency_key=:idempotencyKey! AND operation.generation=:generation!
 AND operation.worker_id=:workerId! AND operation.state='in_progress' FOR UPDATE OF application,operation;

/* @name LockPatchApplicationForOperation */
SELECT application.application_id,application.operation,application.idempotency_key,application.tenant_id,
 application.created_generation::text,application.target_lease_id,application.artifact_id,
 application.source_target_snapshot_id,application.target_provider_sandbox_id,application.result_snapshot_id,
 application.result_manifest_checksum,application.result_archive_checksum,application.result_archive_size_bytes::text,
 application.rollback_allocation_id::text,application.rollback_provider_snapshot_id,application.phase,
 application.error_message,application.created_at,application.updated_at,application.rollback_ready_at,
 application.swap_started_at,application.swapped_at,application.checkpointed_at,
 application.rollback_started_at,application.rolled_back_at,application.failed_at
FROM hosted_agent_patch_applications application JOIN hosted_agent_operations operation
 USING(operation,idempotency_key,tenant_id) WHERE operation.operation=:operation!
 AND operation.idempotency_key=:idempotencyKey! AND operation.tenant_id=:tenantId!
 AND operation.generation=:generation! AND operation.worker_id=:workerId!
 AND operation.state='in_progress' FOR UPDATE OF application,operation;

/* @name ValidatePatchRollbackAllocation */
SELECT 1 AS valid FROM hosted_agent_operation_allocations WHERE allocation_id=:allocationId!::bigint
 AND operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId!
 AND allocation_kind='provider_snapshot' AND resource_id=:providerSnapshotId! AND lease_id=:leaseId!
 AND state='allocated' AND metadata->>'purpose'='patch_apply_rollback' FOR UPDATE;

/* @name ValidatePatchApplicationCheckpoint */
SELECT 1 AS valid FROM hosted_agent_snapshots snapshot JOIN hosted_agent_leases lease
 ON lease.lease_id=snapshot.lease_id AND lease.tenant_id=snapshot.tenant_id JOIN hosted_agent_objects archive
 ON archive.object_id=snapshot.workspace_archive_object_id AND archive.tenant_id=snapshot.tenant_id
WHERE snapshot.snapshot_id=:snapshotId! AND snapshot.lease_id=:leaseId! AND snapshot.tenant_id=:tenantId!
 AND snapshot.state='available' AND snapshot.manifest_checksum=:manifestChecksum!
 AND lease.latest_snapshot_id=snapshot.snapshot_id AND lease.state IN('active','paused')
 AND archive.kind='workspace_archive' AND archive.state='available' AND archive.checksum=:archiveChecksum!
 AND archive.size_bytes=:archiveSizeBytes! FOR SHARE OF snapshot,lease,archive;

/* @name MarkPatchRollbackReady */
UPDATE hosted_agent_patch_applications SET phase='rollback_ready',rollback_allocation_id=:allocationId!::bigint,
 rollback_provider_snapshot_id=:providerSnapshotId!,rollback_ready_at=now() WHERE application_id=:applicationId!
RETURNING *;
/* @name MarkPatchSwapStarted */
UPDATE hosted_agent_patch_applications SET phase='swap_started',swap_started_at=now() WHERE application_id=:applicationId! RETURNING *;
/* @name MarkPatchSwapped */
UPDATE hosted_agent_patch_applications SET phase='swapped',swapped_at=now() WHERE application_id=:applicationId! RETURNING *;
/* @name MarkPatchCheckpointed */
UPDATE hosted_agent_patch_applications SET phase='checkpointed',checkpointed_at=now() WHERE application_id=:applicationId! RETURNING *;
/* @name MarkPatchRollbackStarted */
UPDATE hosted_agent_patch_applications SET phase='rollback_started',rollback_started_at=now(),error_message=:errorMessage! WHERE application_id=:applicationId! RETURNING *;
/* @name MarkPatchRolledBack */
UPDATE hosted_agent_patch_applications SET phase='rolled_back',rolled_back_at=now() WHERE application_id=:applicationId! RETURNING *;
/* @name MarkPatchFailed */
UPDATE hosted_agent_patch_applications SET phase='failed',failed_at=now(),error_message=:errorMessage! WHERE application_id=:applicationId! RETURNING *;

/* @name ResolveLocalRootPatchArtifact */
SELECT artifact.artifact_id,artifact.agent_id,artifact.source_lease_id,artifact.base_snapshot_id,
 artifact.current_snapshot_id,artifact.base_manifest_object_id,artifact.current_manifest_object_id,
 artifact.artifact_object_id,artifact.checksum,artifact.changed_files,artifact.size_bytes::text,
 artifact.state,artifact.expires_at,lease.agent_id lease_agent_id,lease.owner_agent_id,
 lease.owner_lease_id,lease.source_snapshot_id,lease.base_snapshot_id lease_base_snapshot_id,
 lease.latest_snapshot_id lease_latest_snapshot_id,lease.state lease_state
FROM hosted_agent_artifacts artifact JOIN hosted_agent_leases lease
 ON lease.lease_id=artifact.source_lease_id AND lease.tenant_id=artifact.tenant_id
WHERE artifact.tenant_id=:tenantId! AND artifact.artifact_id=:artifactId! FOR SHARE OF artifact,lease;

/* @name ShareLocalPatchArtifactRetention */
SELECT reference_kind,reference_id,retain_until FROM hosted_agent_artifact_references
WHERE artifact_id=:artifactId! FOR SHARE;
