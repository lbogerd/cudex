/* @name InsertPatchArtifact */
INSERT INTO hosted_agent_artifacts
  (artifact_id, tenant_id, agent_id, source_lease_id, base_snapshot_id, current_snapshot_id,
   base_manifest_object_id, current_manifest_object_id, artifact_object_id, checksum,
   changed_files, size_bytes, state, expires_at)
VALUES (:artifactId!, :tenantId!, :agentId!, :sourceLeaseId!, :baseSnapshotId!, :currentSnapshotId!,
  :baseManifestObjectId!, :currentManifestObjectId!, :artifactObjectId!, :checksum!,
  :changedFiles!, :sizeBytes!, :state!, :expiresAt!)
ON CONFLICT (artifact_id) DO NOTHING;

/* @name GetAuthorizedPatchArtifact */
SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
  a.current_manifest_object_id, a.artifact_object_id, a.checksum,
  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
FROM hosted_agent_artifacts a
JOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
WHERE a.artifact_id = :artifactId! AND a.tenant_id = :tenantId! AND a.agent_id = :agentId!
  AND a.state = 'available' AND (a.expires_at > :at! OR EXISTS (
    SELECT 1 FROM hosted_agent_artifact_references retained
    WHERE retained.artifact_id = a.artifact_id
      AND retained.reference_kind = 'codex_thread' AND retained.reference_id = :agentId!));

/* @name GetOwnerAuthorizedPatchArtifact */
SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
  a.current_manifest_object_id, a.artifact_object_id, a.checksum,
  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
FROM hosted_agent_artifacts a
JOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
WHERE a.artifact_id = :artifactId! AND a.tenant_id = :tenantId! AND l.owner_agent_id = :ownerAgentId!
  AND a.state = 'available' AND (a.expires_at > :at! OR EXISTS (
    SELECT 1 FROM hosted_agent_artifact_references retained
    WHERE retained.artifact_id = a.artifact_id AND retained.reference_kind = 'codex_thread'));

/* @name FindPatchArtifactForReconciliation */
SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
  a.current_manifest_object_id, a.artifact_object_id, a.checksum,
  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
FROM hosted_agent_artifacts a
JOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
JOIN hosted_agent_objects o ON o.object_id = a.artifact_object_id AND o.tenant_id = a.tenant_id
WHERE a.artifact_id = :artifactId! AND a.tenant_id = :tenantId! AND a.state = 'available'
  AND o.kind = 'patch_artifact' AND o.state = 'available' AND o.checksum = a.checksum
FOR SHARE OF a, o;

/* @name AddPatchArtifactReference */
INSERT INTO hosted_agent_artifact_references (artifact_id, reference_kind, reference_id, retain_until)
SELECT artifact_id, :referenceKind!, :referenceId!, :retainUntil FROM hosted_agent_artifacts
WHERE artifact_id = :artifactId! AND tenant_id = :tenantId! AND state = 'available' AND expires_at > now()
ON CONFLICT (artifact_id, reference_kind, reference_id) DO UPDATE SET retain_until = CASE
  WHEN hosted_agent_artifact_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
  ELSE GREATEST(hosted_agent_artifact_references.retain_until, EXCLUDED.retain_until) END;

/* @name LockCodexReferenceSet */
SELECT lease_id, revision::text, desired_hash, cleared_at FROM hosted_agent_codex_reference_sets
WHERE tenant_id = :tenantId! AND agent_id = :agentId! FOR UPDATE;
/* @name InsertCodexReferenceSet */
INSERT INTO hosted_agent_codex_reference_sets
(tenant_id,agent_id,lease_id,base_snapshot_id,latest_snapshot_id,artifact_id,revision,desired_hash)
VALUES (:tenantId!,:agentId!,:leaseId!,:baseSnapshotId!,:latestSnapshotId!,:artifactId,:revision!,:desiredHash!);
/* @name UpdateCodexReferenceSet */
UPDATE hosted_agent_codex_reference_sets SET lease_id=:leaseId!,base_snapshot_id=:baseSnapshotId!,
latest_snapshot_id=:latestSnapshotId!,artifact_id=:artifactId,revision=:revision!,desired_hash=:desiredHash!
WHERE tenant_id=:tenantId! AND agent_id=:agentId!;
/* @name AddCodexSnapshotReferences */
INSERT INTO hosted_agent_snapshot_references(snapshot_id,reference_kind,reference_id)
SELECT snapshot_id,'codex_thread',:agentId! FROM hosted_agent_snapshots
WHERE tenant_id=:tenantId! AND snapshot_id=ANY(:snapshotIds!::text[])
ON CONFLICT(snapshot_id,reference_kind,reference_id) DO NOTHING;
/* @name DeleteOtherCodexSnapshotReferences */
DELETE FROM hosted_agent_snapshot_references r USING hosted_agent_snapshots s
WHERE r.snapshot_id=s.snapshot_id AND s.tenant_id=:tenantId! AND r.reference_kind='codex_thread'
AND r.reference_id=:agentId! AND r.snapshot_id<>ALL(:snapshotIds!::text[]);
/* @name DeleteCodexArtifactReferences */
DELETE FROM hosted_agent_artifact_references r USING hosted_agent_artifacts a
WHERE r.artifact_id=a.artifact_id AND a.tenant_id=:tenantId! AND r.reference_kind='codex_thread'
AND r.reference_id=:agentId!;
/* @name AddCodexArtifactReference */
INSERT INTO hosted_agent_artifact_references(artifact_id,reference_kind,reference_id)
VALUES(:artifactId!,'codex_thread',:agentId!) ON CONFLICT(artifact_id,reference_kind,reference_id) DO NOTHING;
/* @name DeleteOtherCodexArtifactReferences */
DELETE FROM hosted_agent_artifact_references r USING hosted_agent_artifacts a
WHERE r.artifact_id=a.artifact_id AND a.tenant_id=:tenantId! AND r.reference_kind='codex_thread'
AND r.reference_id=:agentId! AND r.artifact_id<>:artifactId!;
/* @name DeleteCodexObjectReferences */
DELETE FROM hosted_agent_object_references r USING hosted_agent_objects o
WHERE r.object_id=o.object_id AND o.tenant_id=:tenantId! AND r.reference_kind='codex_thread'
AND r.reference_id=:agentId!;
/* @name CopyCodexSnapshotObjectReferences */
INSERT INTO hosted_agent_object_references(object_id,reference_kind,reference_id,purpose)
SELECT r.object_id,'codex_thread',:agentId!,left(CASE WHEN r.reference_id=:baseSnapshotId!
THEN 'base_'||r.purpose ELSE 'latest_'||r.purpose END,128)
FROM hosted_agent_object_references r JOIN hosted_agent_objects o ON o.object_id=r.object_id
WHERE r.reference_kind='snapshot' AND r.reference_id=ANY(:snapshotIds!::text[])
AND o.tenant_id=:tenantId! AND o.state='available'
ON CONFLICT(object_id,reference_kind,reference_id,purpose) DO NOTHING;
/* @name CopyCodexArtifactObjectReferences */
INSERT INTO hosted_agent_object_references(object_id,reference_kind,reference_id,purpose)
SELECT r.object_id,'codex_thread',:agentId!,left('artifact_'||r.purpose,128)
FROM hosted_agent_object_references r JOIN hosted_agent_objects o ON o.object_id=r.object_id
WHERE r.reference_kind='artifact' AND r.reference_id=:artifactId! AND o.tenant_id=:tenantId! AND o.state='available'
ON CONFLICT(object_id,reference_kind,reference_id,purpose) DO NOTHING;
/* @name ClearCodexReferenceSet */
UPDATE hosted_agent_codex_reference_sets SET revision=:revision!,desired_hash=:desiredHash!,cleared_at=now()
WHERE tenant_id=:tenantId! AND agent_id=:agentId!;
/* @name RemoveReleasedLeaseRoots */
DELETE FROM hosted_agent_snapshot_references WHERE reference_id=:leaseId!
AND reference_kind IN ('lease_base','lease_latest','lease_restore_source');
/* @name AuthorizeCodexLease */
SELECT 1 AS present FROM hosted_agent_leases WHERE tenant_id=:tenantId! AND lease_id=:leaseId!
AND agent_id=:agentId! FOR SHARE;
/* @name AuthorizeCodexSnapshot */
SELECT 1 AS present FROM hosted_agent_snapshots s JOIN hosted_agent_leases l ON l.lease_id=s.lease_id
WHERE s.tenant_id=:tenantId! AND s.snapshot_id=:snapshotId! AND s.state='available' AND l.agent_id=:agentId! FOR SHARE OF s;
/* @name AuthorizeCodexArtifact */
SELECT 1 AS present FROM hosted_agent_artifacts a JOIN hosted_agent_leases l
ON l.lease_id=a.source_lease_id AND l.tenant_id=a.tenant_id
WHERE a.tenant_id=:tenantId! AND a.artifact_id=:artifactId! AND a.state='available'
AND (a.agent_id=:agentId! OR l.owner_agent_id=:agentId!) FOR SHARE OF a;
/* @name AssertCodexReferencesSynchronized */
SELECT 1 AS present FROM hosted_agent_leases l JOIN hosted_agent_codex_reference_sets r
ON r.tenant_id=l.tenant_id AND r.lease_id=l.lease_id AND r.agent_id=l.agent_id
WHERE l.tenant_id=:tenantId! AND l.lease_id=:leaseId! AND r.cleared_at IS NULL
AND r.latest_snapshot_id=l.latest_snapshot_id
AND EXISTS(SELECT 1 FROM hosted_agent_snapshot_references WHERE snapshot_id=r.base_snapshot_id AND reference_kind='codex_thread' AND reference_id=r.agent_id)
AND EXISTS(SELECT 1 FROM hosted_agent_snapshot_references WHERE snapshot_id=r.latest_snapshot_id AND reference_kind='codex_thread' AND reference_id=r.agent_id)
AND (r.artifact_id IS NULL OR EXISTS(SELECT 1 FROM hosted_agent_artifact_references WHERE artifact_id=r.artifact_id AND reference_kind='codex_thread' AND reference_id=r.agent_id))
AND (r.artifact_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM hosted_agent_artifacts WHERE tenant_id=l.tenant_id AND source_lease_id=l.lease_id AND current_snapshot_id=r.latest_snapshot_id AND state='available'))
AND NOT EXISTS(SELECT 1 FROM hosted_agent_object_references source WHERE source.reference_kind='snapshot'
AND source.reference_id IN(r.base_snapshot_id,r.latest_snapshot_id) AND NOT EXISTS(SELECT 1 FROM hosted_agent_object_references rooted
WHERE rooted.object_id=source.object_id AND rooted.reference_kind='codex_thread' AND rooted.reference_id=r.agent_id))
AND (r.artifact_id IS NULL OR NOT EXISTS(SELECT 1 FROM hosted_agent_object_references source
WHERE source.reference_kind='artifact' AND source.reference_id=r.artifact_id AND NOT EXISTS(SELECT 1 FROM hosted_agent_object_references rooted
WHERE rooted.object_id=source.object_id AND rooted.reference_kind='codex_thread' AND rooted.reference_id=r.agent_id)))
FOR SHARE OF r;
/* @name ReclaimerLockObjectWithKind */
SELECT object_id,tenant_id,kind,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects
WHERE object_id=:objectId! AND tenant_id=:tenantId! FOR UPDATE;
/* @name ReclaimerLockObject */
SELECT object_id,tenant_id,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects
WHERE object_id=:objectId! AND tenant_id=:tenantId! FOR UPDATE;
/* @name ReclaimerGetObject */
SELECT object_id,tenant_id,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects
WHERE object_id=:objectId! AND tenant_id=:tenantId!;
/* @name ReclaimerHasSharedLocator */
SELECT 1 AS present FROM hosted_agent_objects WHERE object_id<>:objectId! AND storage_bucket=:storageBucket!
AND storage_key=:storageKey! AND state<>'deleted' LIMIT 1;
/* @name ReclaimerMarkObjectDeleted */
UPDATE hosted_agent_objects SET state='deleted' WHERE object_id=:objectId!;
/* @name ReclaimerMarkObjectDeleting */
UPDATE hosted_agent_objects SET state='deleting' WHERE object_id=:objectId!;
/* @name ReclaimerListDeletingObjects */
SELECT object_id,tenant_id,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects
WHERE tenant_id=:tenantId! AND state='deleting' ORDER BY object_id LIMIT :limit!;
/* @name ReclaimerClaimOperationObjects */
WITH candidates AS (SELECT a.allocation_id FROM hosted_agent_operation_allocations a
JOIN hosted_agent_operations op USING(operation,idempotency_key,tenant_id)
JOIN hosted_agent_objects o ON o.object_id=a.resource_id AND o.tenant_id=a.tenant_id
WHERE a.operation=:operation! AND a.idempotency_key=:idempotencyKey! AND a.tenant_id=:tenantId!
AND a.allocation_kind='object' AND a.state IN('allocated','reclaim_pending')
AND op.generation=:generation! AND op.worker_id=:workerId! AND op.state='in_progress'
ORDER BY a.allocation_id FOR UPDATE OF a SKIP LOCKED LIMIT :limit!)
UPDATE hosted_agent_operation_allocations a SET state='reclaim_pending' FROM candidates
WHERE a.allocation_id=candidates.allocation_id RETURNING a.allocation_id::text,a.resource_id;
/* @name ReclaimerLockPreparation */
SELECT state FROM hosted_agent_workspace_preparations WHERE preparation_id=:preparationId!
AND operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId! FOR UPDATE;
/* @name ReclaimerClaimPreparationObjects */
WITH candidates AS (SELECT a.allocation_id FROM hosted_agent_workspace_preparation_objects p
JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id AND a.operation=p.operation
AND a.idempotency_key=p.idempotency_key AND a.tenant_id=p.tenant_id
JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id
WHERE p.preparation_id=:preparationId! AND p.operation=:operation! AND p.idempotency_key=:idempotencyKey!
AND p.tenant_id=:tenantId! AND a.allocation_kind='object' AND a.resource_id=p.object_id
AND a.state IN('allocated','reclaim_pending') ORDER BY a.allocation_id FOR UPDATE OF a SKIP LOCKED LIMIT :limit!)
UPDATE hosted_agent_operation_allocations a SET state='reclaim_pending' FROM candidates
WHERE a.allocation_id=candidates.allocation_id RETURNING a.allocation_id::text,a.resource_id;
/* @name ReclaimerPreparationOutstanding */
SELECT count(*) FILTER(WHERE a.state<>'reclaimed')::text AS outstanding
FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a
ON a.allocation_id=p.allocation_id AND a.operation=p.operation AND a.idempotency_key=p.idempotency_key
AND a.tenant_id=p.tenant_id WHERE p.preparation_id=:preparationId!;
/* @name ReclaimerFinalizePreparation */
UPDATE hosted_agent_workspace_preparations SET state='reclaimed',reclaimed_at=now(),committed_at=NULL
WHERE preparation_id=:preparationId! AND state='reclaim_pending';
/* @name ReclaimerLockOwnedAllocation */
SELECT a.state FROM hosted_agent_operation_allocations a JOIN hosted_agent_operations op
USING(operation,idempotency_key,tenant_id) WHERE a.allocation_id=:allocationId!::bigint
AND a.operation=:operation! AND a.idempotency_key=:idempotencyKey! AND a.tenant_id=:tenantId!
AND a.allocation_kind='object' AND a.resource_id=:resourceId! AND op.generation=:generation!
AND op.worker_id=:workerId! AND op.state='in_progress' FOR UPDATE OF a,op;
/* @name ReclaimerLockAllocation */
SELECT state FROM hosted_agent_operation_allocations WHERE allocation_id=:allocationId!::bigint FOR UPDATE;
/* @name ReclaimerMarkObjectAllocationsReclaimed */
UPDATE hosted_agent_operation_allocations SET state='reclaimed',reclaimed_at=now()
WHERE tenant_id=:tenantId! AND allocation_kind='object' AND resource_id=:objectId! AND state='reclaim_pending';
/* @name ReclaimerHasDurableReference */
SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM hosted_agent_object_references WHERE object_id=:objectId!)
OR EXISTS(SELECT 1 FROM hosted_agent_source_snapshots WHERE archive_object_id=:objectId!)
OR EXISTS(SELECT 1 FROM hosted_agent_snapshots WHERE workspace_archive_object_id=:objectId! OR manifest_object_id=:objectId!)
OR EXISTS(SELECT 1 FROM hosted_agent_artifacts WHERE base_manifest_object_id=:objectId!
OR current_manifest_object_id=:objectId! OR artifact_object_id=:objectId!);
/* @name ReclaimerMarkAllocationReclaimed */
UPDATE hosted_agent_operation_allocations SET state='reclaimed',reclaimed_at=now()
WHERE allocation_id=:allocationId!::bigint AND state='reclaim_pending';
/* @name ReclaimerOwnsOperation */
SELECT 1 AS present FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!
AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress';
/* @name ReclaimerOwnsOperationForUpdate */
SELECT 1 AS present FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!
AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress' FOR UPDATE;

/* @name ExpireAvailablePatchArtifacts */
UPDATE hosted_agent_artifacts SET state = 'expired'
WHERE tenant_id = :tenantId! AND state = 'available' AND expires_at <= :at!
  AND NOT EXISTS (SELECT 1 FROM hosted_agent_artifact_references retained
    WHERE retained.artifact_id = hosted_agent_artifacts.artifact_id
      AND retained.reference_kind = 'codex_thread');

/* @name GetPatchArtifact */
SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
  a.current_manifest_object_id, a.artifact_object_id, a.checksum,
  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
FROM hosted_agent_artifacts a JOIN hosted_agent_leases l
  ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
WHERE a.artifact_id = :artifactId!;

/* @name LockPatchArtifact */
SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
  a.current_manifest_object_id, a.artifact_object_id, a.checksum,
  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
FROM hosted_agent_artifacts a JOIN hosted_agent_leases l
  ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
WHERE a.artifact_id = :artifactId! FOR UPDATE OF a;

/* @name LockPatchArtifactSourceLease */
SELECT agent_id, owner_agent_id, base_snapshot_id, latest_snapshot_id, state
FROM hosted_agent_leases WHERE lease_id = :leaseId! AND tenant_id = :tenantId! FOR UPDATE;

/* @name SharePatchArtifactSnapshots */
SELECT snapshot_id, lease_id, manifest_object_id, manifest_checksum, state, expires_at
FROM hosted_agent_snapshots WHERE tenant_id = :tenantId! AND snapshot_id = ANY(:snapshotIds!::text[]) FOR SHARE;

/* @name SharePatchArtifactObjects */
SELECT object_id, tenant_id, kind, checksum, size_bytes::text, state, expires_at
FROM hosted_agent_objects WHERE object_id = ANY(:objectIds!::text[]) FOR SHARE;

/* @name RetainPatchArtifactObject */
INSERT INTO hosted_agent_object_references (object_id, reference_kind, reference_id, purpose, retain_until)
VALUES (:objectId!, 'artifact', :artifactId!, :purpose!, :retainUntil!)
ON CONFLICT (object_id, reference_kind, reference_id, purpose) DO UPDATE SET retain_until = CASE
  WHEN hosted_agent_object_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
  ELSE GREATEST(hosted_agent_object_references.retain_until, EXCLUDED.retain_until) END;

/* @name RetainPatchArtifactSnapshots */
INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id, retain_until)
VALUES (:baseSnapshotId!, 'artifact_base', :artifactId!, :retainUntil!),
  (:currentSnapshotId!, 'artifact_current', :artifactId!, :retainUntil!)
ON CONFLICT (snapshot_id, reference_kind, reference_id) DO UPDATE SET retain_until = CASE
  WHEN hosted_agent_snapshot_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
  ELSE GREATEST(hosted_agent_snapshot_references.retain_until, EXCLUDED.retain_until) END;

/* @name RetainPatchArtifact */
INSERT INTO hosted_agent_artifact_references (artifact_id, reference_kind, reference_id, retain_until)
VALUES (:artifactId!, :referenceKind!, :referenceId!, :retainUntil!)
ON CONFLICT (artifact_id, reference_kind, reference_id) DO UPDATE SET retain_until = CASE
  WHEN hosted_agent_artifact_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
  ELSE GREATEST(hosted_agent_artifact_references.retain_until, EXCLUDED.retain_until) END;

/* @name StateInsertObject */
INSERT INTO hosted_agent_objects
  (object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes, state, expires_at)
VALUES (:objectId!, :tenantId!, :kind!, :storageBucket!, :storageKey!, :checksum!, :sizeBytes!,
  :state!, :expiresAt)
ON CONFLICT (object_id) DO NOTHING;

/* @name StateLockObjectById */
SELECT object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes::text, state, expires_at
FROM hosted_agent_objects WHERE object_id = :objectId! FOR UPDATE;

/* @name StateLockObjectByTenant */
SELECT object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes::text, state, expires_at
FROM hosted_agent_objects WHERE object_id = :objectId! AND tenant_id = :tenantId! FOR UPDATE;

/* @name StateAddSnapshotReference */
INSERT INTO hosted_agent_snapshot_references
  (snapshot_id, reference_kind, reference_id, retain_until)
SELECT snapshot_id, :referenceKind!, :referenceId!, :retainUntil
FROM hosted_agent_snapshots WHERE snapshot_id = :snapshotId! AND tenant_id = :tenantId!
ON CONFLICT (snapshot_id, reference_kind, reference_id)
DO UPDATE SET retain_until = CASE
  WHEN hosted_agent_snapshot_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
  ELSE GREATEST(hosted_agent_snapshot_references.retain_until, EXCLUDED.retain_until) END
RETURNING 1 AS affected;

/* @name StateGetSourceTenant */
SELECT tenant_id FROM hosted_agent_source_snapshots WHERE source_snapshot_id = :sourceSnapshotId!;

/* @name StateInsertSourceSnapshot */
INSERT INTO hosted_agent_source_snapshots
  (source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
   workspace_root_uris, state, expires_at)
VALUES (:sourceSnapshotId!, :tenantId!, :archiveObjectId!, :checksum!, :cwdUri!,
  :workspaceRootUris!::jsonb, :state!, :expiresAt!)
ON CONFLICT DO NOTHING;

/* @name StateLockSourceById */
SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
  workspace_root_uris, state, expires_at
FROM hosted_agent_source_snapshots WHERE source_snapshot_id = :sourceSnapshotId! FOR UPDATE;

/* @name StateLockSourceByChecksum */
SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
  workspace_root_uris, state, expires_at
FROM hosted_agent_source_snapshots
WHERE tenant_id = :tenantId! AND checksum = :checksum! FOR UPDATE;

/* @name StateFindAuthorizedSource */
SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
  workspace_root_uris, state, expires_at
FROM hosted_agent_source_snapshots
WHERE source_snapshot_id = :sourceSnapshotId! AND tenant_id = :tenantId!
  AND state = 'available' AND expires_at > :at!;

/* @name StateLockAuthorizedSource */
SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
  workspace_root_uris, state, expires_at
FROM hosted_agent_source_snapshots
WHERE source_snapshot_id = :sourceSnapshotId! AND tenant_id = :tenantId! AND checksum = :checksum!
  AND state = 'available' AND expires_at > :at! FOR UPDATE;

/* @name StateFindAuthorizedSourceByChecksum */
SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
  workspace_root_uris, state, expires_at
FROM hosted_agent_source_snapshots
WHERE tenant_id = :tenantId! AND checksum = :checksum!
  AND state = 'available' AND expires_at > :at!;

/* @name StateUpsertObjectReference */
INSERT INTO hosted_agent_object_references
  (object_id, reference_kind, reference_id, purpose, retain_until)
VALUES (:objectId!, :referenceKind!, :referenceId!, :purpose!, :retainUntil)
ON CONFLICT (object_id, reference_kind, reference_id, purpose)
DO UPDATE SET retain_until = CASE
  WHEN hosted_agent_object_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
  ELSE GREATEST(hosted_agent_object_references.retain_until, EXCLUDED.retain_until) END;

/* @name StateLockAvailableObject */
SELECT 1 AS found FROM hosted_agent_objects
WHERE object_id = :objectId! AND tenant_id = :tenantId! AND state = 'available'
  AND (:expectedKind::text IS NULL OR kind = :expectedKind)
FOR UPDATE;
