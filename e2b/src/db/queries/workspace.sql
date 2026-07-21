/* @name GetWorkspacePreparationForOperation */
SELECT preparation.*,(SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects a
 WHERE a.preparation_id=preparation.preparation_id) associated_object_count
FROM hosted_agent_workspace_preparations preparation WHERE operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId!;
/* @name InsertWorkspacePreparation */
INSERT INTO hosted_agent_workspace_preparations(preparation_id,operation,idempotency_key,tenant_id,created_generation,intent_hash,intent,lease_id,snapshot_id,source_snapshot_id,expected_object_count,state)
VALUES(:preparationId!,:operation!,:idempotencyKey!,:tenantId!,:generation!,:intentHash!,:intent!::jsonb,:leaseId,:snapshotId,:sourceSnapshotId,:expectedObjectCount!,'publishing') ON CONFLICT DO NOTHING;
/* @name InsertWorkspacePreparationObject */
INSERT INTO hosted_agent_workspace_preparation_objects(preparation_id,operation,idempotency_key,tenant_id,allocation_id,object_id,purpose)
SELECT :preparationId!,:operation!,:idempotencyKey!,:tenantId!,a.allocation_id,o.object_id,:purpose!
FROM hosted_agent_operation_allocations a JOIN hosted_agent_objects o ON o.object_id=:objectId! AND o.tenant_id=:tenantId! AND o.state='available' AND o.kind=:purpose!
WHERE a.allocation_id=:allocationId!::bigint AND a.operation=:operation! AND a.idempotency_key=:idempotencyKey! AND a.tenant_id=:tenantId! AND a.allocation_kind='object' AND a.resource_id=:objectId! AND a.state='allocated' ON CONFLICT DO NOTHING;
/* @name GetWorkspacePreparationObject */
SELECT p.preparation_id,p.tenant_id,p.allocation_id::text,p.object_id,p.purpose,o.checksum object_checksum,o.size_bytes::text object_size_bytes,o.expires_at object_expires_at,o.storage_bucket,o.storage_key,o.kind object_kind,o.state object_state,a.state allocation_state
FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id
WHERE p.preparation_id=:preparationId! AND p.allocation_id=:allocationId!::bigint;
/* @name LockWorkspacePreparationObject */
SELECT p.preparation_id,p.tenant_id,p.allocation_id::text,p.object_id,p.purpose,o.checksum object_checksum,o.size_bytes::text object_size_bytes,o.expires_at object_expires_at,o.storage_bucket,o.storage_key,o.kind object_kind,o.state object_state,a.state allocation_state
FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id AND a.tenant_id=p.tenant_id JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id
WHERE p.preparation_id=:preparationId! AND p.object_id=:objectId! FOR UPDATE OF p,a,o;
/* @name MarkWorkspacePreparationPrepared */
UPDATE hosted_agent_workspace_preparations SET state='prepared' WHERE preparation_id=:preparationId!;
/* @name MarkWorkspacePreparationCommitted */
UPDATE hosted_agent_workspace_preparations SET state='committed',committed_at=now(),reclaimed_at=NULL WHERE preparation_id=:preparationId! AND state='prepared';
/* @name MarkWorkspacePreparationReclaimPending */
UPDATE hosted_agent_workspace_preparations SET state='reclaim_pending' WHERE preparation_id=:preparationId!;
/* @name HasOutstandingWorkspaceAllocations */
SELECT 1 AS outstanding FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id WHERE p.preparation_id=:preparationId! AND a.state<>'reclaimed' LIMIT 1;
/* @name MarkWorkspacePreparationReclaimed */
UPDATE hosted_agent_workspace_preparations SET state='reclaimed',reclaimed_at=now(),committed_at=NULL WHERE preparation_id=:preparationId!;
/* @name OwnsWorkspacePreparationOperation */
SELECT 1 AS owned FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress' FOR UPDATE;
/* @name GetWorkspacePreparation */
SELECT preparation.*,(SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects a WHERE a.preparation_id=preparation.preparation_id) associated_object_count FROM hosted_agent_workspace_preparations preparation WHERE preparation_id=:preparationId!;
/* @name LockWorkspacePreparation */
SELECT preparation.*,(SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects a WHERE a.preparation_id=preparation.preparation_id) associated_object_count FROM hosted_agent_workspace_preparations preparation WHERE preparation_id=:preparationId! FOR UPDATE;
/* @name ListWorkspacePreparationAllocationIds */
SELECT p.allocation_id::text FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_workspace_preparations preparation ON preparation.preparation_id=p.preparation_id AND preparation.tenant_id=p.tenant_id WHERE preparation.operation=:operation! AND preparation.idempotency_key=:idempotencyKey! AND preparation.tenant_id=:tenantId! ORDER BY p.allocation_id;
/* @name LockWorkspacePreparationObjects */
SELECT p.preparation_id,p.tenant_id,p.allocation_id::text,p.object_id,p.purpose,o.checksum object_checksum,o.size_bytes::text object_size_bytes,o.expires_at object_expires_at,o.storage_bucket,o.storage_key,o.kind object_kind,o.state object_state,a.state allocation_state
FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id AND a.tenant_id=p.tenant_id JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id
WHERE p.preparation_id=:preparationId! AND a.allocation_kind='object' ORDER BY p.allocation_id,p.object_id FOR UPDATE OF p,a,o;
