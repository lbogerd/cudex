/* @name InsertOperationClaim */
INSERT INTO hosted_agent_operations
  (operation, idempotency_key, tenant_id, request_hash, state, worker_id, heartbeat_at, operation_subtype)
VALUES (:operation!, :idempotencyKey!, :tenantId!, :requestHash!, 'in_progress', :workerId!, now(), :operationSubtype)
ON CONFLICT (operation, idempotency_key) DO NOTHING RETURNING generation::text;

/* @name InsertLeaseOperationClaim */
INSERT INTO hosted_agent_operations
  (operation, idempotency_key, tenant_id, request_hash, state, worker_id, heartbeat_at, primary_lease_id, operation_subtype)
SELECT :operation!, :idempotencyKey!, :tenantId!, :requestHash!, 'in_progress', :workerId!, now(), lease_id, :operationSubtype
FROM hosted_agent_leases WHERE tenant_id = :tenantId! AND lease_id = :primaryLeaseId!
ON CONFLICT (operation, idempotency_key) DO NOTHING RETURNING generation::text;

/* @name LockOperationClaim */
SELECT tenant_id, operation_subtype, request_hash, state, logical_response, error_code, error_message,
  generation::text, heartbeat_at, primary_lease_id, result_lease_id
FROM hosted_agent_operations WHERE operation = :operation! AND idempotency_key = :idempotencyKey! FOR UPDATE;

/* @name GetOperationClaim */
SELECT tenant_id, operation_subtype, request_hash, state, logical_response, error_code, error_message,
  generation::text, heartbeat_at, primary_lease_id, result_lease_id
FROM hosted_agent_operations WHERE operation = :operation! AND idempotency_key = :idempotencyKey!;

/* @name HeartbeatOperation */
UPDATE hosted_agent_operations SET heartbeat_at = now()
WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress';

/* @name RecordAllocation */
INSERT INTO hosted_agent_operation_allocations
  (operation, idempotency_key, tenant_id, allocation_kind, resource_id, lease_id, state, metadata)
SELECT operation, idempotency_key, tenant_id, :allocationKind!, :resourceId!, :leaseId, 'allocated', :metadata!::jsonb
FROM hosted_agent_operations
WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'
ON CONFLICT (operation, idempotency_key, allocation_kind, resource_id)
DO UPDATE SET updated_at = hosted_agent_operation_allocations.updated_at
RETURNING allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,
  allocated_at, updated_at, reclaimed_at;

/* @name UpdateAllocationState */
UPDATE hosted_agent_operation_allocations AS allocation
SET state = :state!, reclaimed_at = CASE WHEN :state! = 'reclaimed' THEN now() ELSE NULL END
FROM hosted_agent_operations AS operation
WHERE allocation.allocation_id = :allocationId!::bigint
  AND allocation.operation = operation.operation AND allocation.idempotency_key = operation.idempotency_key
  AND allocation.tenant_id = operation.tenant_id AND operation.operation = :operation!
  AND operation.idempotency_key = :idempotencyKey! AND operation.tenant_id = :tenantId!
  AND operation.generation = :generation! AND operation.worker_id = :workerId! AND operation.state = 'in_progress'
RETURNING allocation.allocation_id::text, allocation.allocation_kind, allocation.resource_id,
  allocation.lease_id, allocation.state, allocation.metadata, allocation.allocated_at,
  allocation.updated_at, allocation.reclaimed_at;

/* @name ListAllocations */
SELECT allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,
  allocated_at, updated_at, reclaimed_at
FROM hosted_agent_operation_allocations
WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
ORDER BY allocation_id LIMIT :limit!;

/* @name HasUnreclaimedAllocation */
SELECT 1 AS present FROM hosted_agent_operation_allocations AS allocation
JOIN hosted_agent_operations AS operation USING (operation, idempotency_key, tenant_id)
WHERE allocation.allocation_kind = :allocationKind! AND allocation.resource_id = :resourceId!
  AND allocation.state <> 'reclaimed' AND operation.state = 'in_progress' LIMIT 1;

/* @name BindPrimaryLease */
UPDATE hosted_agent_operations SET primary_lease_id = :leaseId!
WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'
  AND (primary_lease_id IS NULL OR primary_lease_id = :leaseId!);

/* @name BindResultLease */
UPDATE hosted_agent_operations SET result_lease_id = :leaseId!
WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'
  AND (result_lease_id IS NULL OR result_lease_id = :leaseId!);

/* @name AdoptAllocations */
UPDATE hosted_agent_operation_allocations SET lease_id = :leaseId!, state = 'adopted'
WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
  AND allocation_id = ANY(:allocationIds!::bigint[])
  AND (state IN ('allocated', 'reclaim_pending') OR (state = 'adopted' AND lease_id = :leaseId!))
RETURNING allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,
  allocated_at, updated_at, reclaimed_at;

/* @name ClaimStaleOperations */
WITH candidates AS (
  SELECT operation, idempotency_key, tenant_id, worker_id FROM hosted_agent_operations
  WHERE state = 'in_progress' AND COALESCE(heartbeat_at, started_at) < :staleBefore!
    AND (:tenantId::text IS NULL OR tenant_id = :tenantId)
    AND (:operationFilter::text IS NULL OR operation = :operationFilter)
    AND (:subtypeFilter::text IS NULL OR (:subtypeFilter = 'none' AND operation_subtype IS NULL)
      OR operation_subtype = :subtypeFilter)
    AND (:excludedOperations::text[] IS NULL OR NOT (operation = ANY(:excludedOperations)))
  ORDER BY COALESCE(heartbeat_at, started_at), operation, idempotency_key
  FOR UPDATE SKIP LOCKED LIMIT :limit!
)
UPDATE hosted_agent_operations AS operation
SET generation = operation.generation + 1, worker_id = :workerId!, heartbeat_at = now()
FROM candidates WHERE operation.operation = candidates.operation
  AND operation.idempotency_key = candidates.idempotency_key AND operation.tenant_id = candidates.tenant_id
RETURNING operation.operation, operation.idempotency_key, operation.tenant_id,
  operation.operation_subtype, operation.request_hash, operation.generation::text,
  candidates.worker_id AS previous_worker_id, operation.worker_id,
  operation.primary_lease_id, operation.result_lease_id;

/* @name LockExistingLeases */
SELECT lease_id FROM hosted_agent_leases
WHERE tenant_id = :tenantId! AND lease_id = ANY(:leaseIds!::text[])
ORDER BY lease_id FOR UPDATE;

/* @name CompleteOperation */
UPDATE hosted_agent_operations
SET state = 'succeeded', logical_response = :logicalResponse!::jsonb, error_code = NULL,
  error_message = NULL, completed_at = now(), heartbeat_at = now()
WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress';

/* @name FailOperation */
UPDATE hosted_agent_operations
SET state = 'failed_terminal', logical_response = NULL, error_code = :errorCode!,
  error_message = :errorMessage!, completed_at = now(), heartbeat_at = now()
WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress';
