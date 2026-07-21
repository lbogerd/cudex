/** Types generated for queries found in "src/db/queries/journal.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NumberOrString = number | string;

export type NumberOrStringArray = (NumberOrString)[];

export type stringArray = (string)[];

/** 'InsertOperationClaim' parameters type */
export interface IInsertOperationClaimParams {
  idempotencyKey: string;
  operation: string;
  operationSubtype?: string | null | void;
  requestHash: string;
  tenantId: string;
  workerId: string;
}

/** 'InsertOperationClaim' return type */
export interface IInsertOperationClaimResult {
  generation: string | null;
}

/** 'InsertOperationClaim' query type */
export interface IInsertOperationClaimQuery {
  params: IInsertOperationClaimParams;
  result: IInsertOperationClaimResult;
}

const insertOperationClaimIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"requestHash":true,"workerId":true,"operationSubtype":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":151,"b":161}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":164,"b":179}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":182,"b":191}]},{"name":"requestHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":194,"b":206}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":224,"b":233}]},{"name":"operationSubtype","required":false,"transform":{"type":"scalar"},"locs":[{"a":243,"b":259}]}],"statement":"INSERT INTO hosted_agent_operations\n  (operation, idempotency_key, tenant_id, request_hash, state, worker_id, heartbeat_at, operation_subtype)\nVALUES (:operation!, :idempotencyKey!, :tenantId!, :requestHash!, 'in_progress', :workerId!, now(), :operationSubtype)\nON CONFLICT (operation, idempotency_key) DO NOTHING RETURNING generation::text"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_operations
 *   (operation, idempotency_key, tenant_id, request_hash, state, worker_id, heartbeat_at, operation_subtype)
 * VALUES (:operation!, :idempotencyKey!, :tenantId!, :requestHash!, 'in_progress', :workerId!, now(), :operationSubtype)
 * ON CONFLICT (operation, idempotency_key) DO NOTHING RETURNING generation::text
 * ```
 */
export const insertOperationClaim = new PreparedQuery<IInsertOperationClaimParams,IInsertOperationClaimResult>(insertOperationClaimIR);


/** 'InsertLeaseOperationClaim' parameters type */
export interface IInsertLeaseOperationClaimParams {
  idempotencyKey: string;
  operation: string;
  operationSubtype?: string | null | void;
  primaryLeaseId: string;
  requestHash: string;
  tenantId: string;
  workerId: string;
}

/** 'InsertLeaseOperationClaim' return type */
export interface IInsertLeaseOperationClaimResult {
  generation: string | null;
}

/** 'InsertLeaseOperationClaim' query type */
export interface IInsertLeaseOperationClaimQuery {
  params: IInsertLeaseOperationClaimParams;
  result: IInsertLeaseOperationClaimResult;
}

const insertLeaseOperationClaimIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"requestHash":true,"workerId":true,"operationSubtype":true,"primaryLeaseId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":168,"b":178}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":181,"b":196}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":199,"b":208},{"a":331,"b":340}]},{"name":"requestHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":211,"b":223}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":241,"b":250}]},{"name":"operationSubtype","required":false,"transform":{"type":"scalar"},"locs":[{"a":270,"b":286}]},{"name":"primaryLeaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":357,"b":372}]}],"statement":"INSERT INTO hosted_agent_operations\n  (operation, idempotency_key, tenant_id, request_hash, state, worker_id, heartbeat_at, primary_lease_id, operation_subtype)\nSELECT :operation!, :idempotencyKey!, :tenantId!, :requestHash!, 'in_progress', :workerId!, now(), lease_id, :operationSubtype\nFROM hosted_agent_leases WHERE tenant_id = :tenantId! AND lease_id = :primaryLeaseId!\nON CONFLICT (operation, idempotency_key) DO NOTHING RETURNING generation::text"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_operations
 *   (operation, idempotency_key, tenant_id, request_hash, state, worker_id, heartbeat_at, primary_lease_id, operation_subtype)
 * SELECT :operation!, :idempotencyKey!, :tenantId!, :requestHash!, 'in_progress', :workerId!, now(), lease_id, :operationSubtype
 * FROM hosted_agent_leases WHERE tenant_id = :tenantId! AND lease_id = :primaryLeaseId!
 * ON CONFLICT (operation, idempotency_key) DO NOTHING RETURNING generation::text
 * ```
 */
export const insertLeaseOperationClaim = new PreparedQuery<IInsertLeaseOperationClaimParams,IInsertLeaseOperationClaimResult>(insertLeaseOperationClaimIR);


/** 'LockOperationClaim' parameters type */
export interface ILockOperationClaimParams {
  idempotencyKey: string;
  operation: string;
}

/** 'LockOperationClaim' return type */
export interface ILockOperationClaimResult {
  error_code: string | null;
  error_message: string | null;
  generation: string | null;
  heartbeat_at: Date | null;
  logical_response: Json | null;
  operation_subtype: string | null;
  primary_lease_id: string | null;
  request_hash: string;
  result_lease_id: string | null;
  state: string;
  tenant_id: string;
}

/** 'LockOperationClaim' query type */
export interface ILockOperationClaimQuery {
  params: ILockOperationClaimParams;
  result: ILockOperationClaimResult;
}

const lockOperationClaimIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":218,"b":228}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":252,"b":267}]}],"statement":"SELECT tenant_id, operation_subtype, request_hash, state, logical_response, error_code, error_message,\n  generation::text, heartbeat_at, primary_lease_id, result_lease_id\nFROM hosted_agent_operations WHERE operation = :operation! AND idempotency_key = :idempotencyKey! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT tenant_id, operation_subtype, request_hash, state, logical_response, error_code, error_message,
 *   generation::text, heartbeat_at, primary_lease_id, result_lease_id
 * FROM hosted_agent_operations WHERE operation = :operation! AND idempotency_key = :idempotencyKey! FOR UPDATE
 * ```
 */
export const lockOperationClaim = new PreparedQuery<ILockOperationClaimParams,ILockOperationClaimResult>(lockOperationClaimIR);


/** 'GetOperationClaim' parameters type */
export interface IGetOperationClaimParams {
  idempotencyKey: string;
  operation: string;
}

/** 'GetOperationClaim' return type */
export interface IGetOperationClaimResult {
  error_code: string | null;
  error_message: string | null;
  generation: string | null;
  heartbeat_at: Date | null;
  logical_response: Json | null;
  operation_subtype: string | null;
  primary_lease_id: string | null;
  request_hash: string;
  result_lease_id: string | null;
  state: string;
  tenant_id: string;
}

/** 'GetOperationClaim' query type */
export interface IGetOperationClaimQuery {
  params: IGetOperationClaimParams;
  result: IGetOperationClaimResult;
}

const getOperationClaimIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":218,"b":228}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":252,"b":267}]}],"statement":"SELECT tenant_id, operation_subtype, request_hash, state, logical_response, error_code, error_message,\n  generation::text, heartbeat_at, primary_lease_id, result_lease_id\nFROM hosted_agent_operations WHERE operation = :operation! AND idempotency_key = :idempotencyKey!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT tenant_id, operation_subtype, request_hash, state, logical_response, error_code, error_message,
 *   generation::text, heartbeat_at, primary_lease_id, result_lease_id
 * FROM hosted_agent_operations WHERE operation = :operation! AND idempotency_key = :idempotencyKey!
 * ```
 */
export const getOperationClaim = new PreparedQuery<IGetOperationClaimParams,IGetOperationClaimResult>(getOperationClaimIR);


/** 'HeartbeatOperation' parameters type */
export interface IHeartbeatOperationParams {
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'HeartbeatOperation' return type */
export type IHeartbeatOperationResult = void;

/** 'HeartbeatOperation' query type */
export interface IHeartbeatOperationQuery {
  params: IHeartbeatOperationParams;
  result: IHeartbeatOperationResult;
}

const heartbeatOperationIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":74,"b":84}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":108,"b":123}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":141,"b":150}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":171,"b":182}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":200,"b":209}]}],"statement":"UPDATE hosted_agent_operations SET heartbeat_at = now()\nWHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!\n  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_operations SET heartbeat_at = now()
 * WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
 *   AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'
 * ```
 */
export const heartbeatOperation = new PreparedQuery<IHeartbeatOperationParams,IHeartbeatOperationResult>(heartbeatOperationIR);


/** 'RecordAllocation' parameters type */
export interface IRecordAllocationParams {
  allocationKind: string;
  generation: NumberOrString;
  idempotencyKey: string;
  leaseId?: string | null | void;
  metadata: Json;
  operation: string;
  resourceId: string;
  tenantId: string;
  workerId: string;
}

/** 'RecordAllocation' return type */
export interface IRecordAllocationResult {
  allocated_at: Date;
  allocation_id: string | null;
  allocation_kind: string;
  lease_id: string | null;
  metadata: Json;
  reclaimed_at: Date | null;
  resource_id: string;
  state: string;
  updated_at: Date;
}

/** 'RecordAllocation' query type */
export interface IRecordAllocationQuery {
  params: IRecordAllocationParams;
  result: IRecordAllocationResult;
}

const recordAllocationIR: any = {"usedParamSet":{"allocationKind":true,"resourceId":true,"leaseId":true,"metadata":true,"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"allocationKind","required":true,"transform":{"type":"scalar"},"locs":[{"a":192,"b":207}]},{"name":"resourceId","required":true,"transform":{"type":"scalar"},"locs":[{"a":210,"b":221}]},{"name":"leaseId","required":false,"transform":{"type":"scalar"},"locs":[{"a":224,"b":231}]},{"name":"metadata","required":true,"transform":{"type":"scalar"},"locs":[{"a":247,"b":256}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":312,"b":322}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":346,"b":361}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":379,"b":388}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":409,"b":420}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":438,"b":447}]}],"statement":"INSERT INTO hosted_agent_operation_allocations\n  (operation, idempotency_key, tenant_id, allocation_kind, resource_id, lease_id, state, metadata)\nSELECT operation, idempotency_key, tenant_id, :allocationKind!, :resourceId!, :leaseId, 'allocated', :metadata!::jsonb\nFROM hosted_agent_operations\nWHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!\n  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'\nON CONFLICT (operation, idempotency_key, allocation_kind, resource_id)\nDO UPDATE SET updated_at = hosted_agent_operation_allocations.updated_at\nRETURNING allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,\n  allocated_at, updated_at, reclaimed_at"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_operation_allocations
 *   (operation, idempotency_key, tenant_id, allocation_kind, resource_id, lease_id, state, metadata)
 * SELECT operation, idempotency_key, tenant_id, :allocationKind!, :resourceId!, :leaseId, 'allocated', :metadata!::jsonb
 * FROM hosted_agent_operations
 * WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
 *   AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'
 * ON CONFLICT (operation, idempotency_key, allocation_kind, resource_id)
 * DO UPDATE SET updated_at = hosted_agent_operation_allocations.updated_at
 * RETURNING allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,
 *   allocated_at, updated_at, reclaimed_at
 * ```
 */
export const recordAllocation = new PreparedQuery<IRecordAllocationParams,IRecordAllocationResult>(recordAllocationIR);


/** 'UpdateAllocationState' parameters type */
export interface IUpdateAllocationStateParams {
  allocationId: NumberOrString;
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  state: string;
  tenantId: string;
  workerId: string;
}

/** 'UpdateAllocationState' return type */
export interface IUpdateAllocationStateResult {
  allocated_at: Date;
  allocation_id: string | null;
  allocation_kind: string;
  lease_id: string | null;
  metadata: Json;
  reclaimed_at: Date | null;
  resource_id: string;
  state: string;
  updated_at: Date;
}

/** 'UpdateAllocationState' query type */
export interface IUpdateAllocationStateQuery {
  params: IUpdateAllocationStateParams;
  result: IUpdateAllocationStateResult;
}

const updateAllocationStateIR: any = {"usedParamSet":{"state":true,"allocationId":true,"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"state","required":true,"transform":{"type":"scalar"},"locs":[{"a":68,"b":74},{"a":102,"b":108}]},{"name":"allocationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":224,"b":237}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":430,"b":440}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":476,"b":491}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":519,"b":528}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":559,"b":570}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":598,"b":607}]}],"statement":"UPDATE hosted_agent_operation_allocations AS allocation\nSET state = :state!, reclaimed_at = CASE WHEN :state! = 'reclaimed' THEN now() ELSE NULL END\nFROM hosted_agent_operations AS operation\nWHERE allocation.allocation_id = :allocationId!::bigint\n  AND allocation.operation = operation.operation AND allocation.idempotency_key = operation.idempotency_key\n  AND allocation.tenant_id = operation.tenant_id AND operation.operation = :operation!\n  AND operation.idempotency_key = :idempotencyKey! AND operation.tenant_id = :tenantId!\n  AND operation.generation = :generation! AND operation.worker_id = :workerId! AND operation.state = 'in_progress'\nRETURNING allocation.allocation_id::text, allocation.allocation_kind, allocation.resource_id,\n  allocation.lease_id, allocation.state, allocation.metadata, allocation.allocated_at,\n  allocation.updated_at, allocation.reclaimed_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_operation_allocations AS allocation
 * SET state = :state!, reclaimed_at = CASE WHEN :state! = 'reclaimed' THEN now() ELSE NULL END
 * FROM hosted_agent_operations AS operation
 * WHERE allocation.allocation_id = :allocationId!::bigint
 *   AND allocation.operation = operation.operation AND allocation.idempotency_key = operation.idempotency_key
 *   AND allocation.tenant_id = operation.tenant_id AND operation.operation = :operation!
 *   AND operation.idempotency_key = :idempotencyKey! AND operation.tenant_id = :tenantId!
 *   AND operation.generation = :generation! AND operation.worker_id = :workerId! AND operation.state = 'in_progress'
 * RETURNING allocation.allocation_id::text, allocation.allocation_kind, allocation.resource_id,
 *   allocation.lease_id, allocation.state, allocation.metadata, allocation.allocated_at,
 *   allocation.updated_at, allocation.reclaimed_at
 * ```
 */
export const updateAllocationState = new PreparedQuery<IUpdateAllocationStateParams,IUpdateAllocationStateResult>(updateAllocationStateIR);


/** 'ListAllocations' parameters type */
export interface IListAllocationsParams {
  idempotencyKey: string;
  limit: NumberOrString;
  operation: string;
  tenantId: string;
}

/** 'ListAllocations' return type */
export interface IListAllocationsResult {
  allocated_at: Date;
  allocation_id: string | null;
  allocation_kind: string;
  lease_id: string | null;
  metadata: Json;
  reclaimed_at: Date | null;
  resource_id: string;
  state: string;
  updated_at: Date;
}

/** 'ListAllocations' query type */
export interface IListAllocationsQuery {
  params: IListAllocationsParams;
  result: IListAllocationsResult;
}

const listAllocationsIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"limit":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":184,"b":194}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":218,"b":233}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":251,"b":260}]},{"name":"limit","required":true,"transform":{"type":"scalar"},"locs":[{"a":291,"b":297}]}],"statement":"SELECT allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,\n  allocated_at, updated_at, reclaimed_at\nFROM hosted_agent_operation_allocations\nWHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!\nORDER BY allocation_id LIMIT :limit!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,
 *   allocated_at, updated_at, reclaimed_at
 * FROM hosted_agent_operation_allocations
 * WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
 * ORDER BY allocation_id LIMIT :limit!
 * ```
 */
export const listAllocations = new PreparedQuery<IListAllocationsParams,IListAllocationsResult>(listAllocationsIR);


/** 'HasUnreclaimedAllocation' parameters type */
export interface IHasUnreclaimedAllocationParams {
  allocationKind: string;
  resourceId: string;
}

/** 'HasUnreclaimedAllocation' return type */
export interface IHasUnreclaimedAllocationResult {
  present: number | null;
}

/** 'HasUnreclaimedAllocation' query type */
export interface IHasUnreclaimedAllocationQuery {
  params: IHasUnreclaimedAllocationParams;
  result: IHasUnreclaimedAllocationResult;
}

const hasUnreclaimedAllocationIR: any = {"usedParamSet":{"allocationKind":true,"resourceId":true},"params":[{"name":"allocationKind","required":true,"transform":{"type":"scalar"},"locs":[{"a":197,"b":212}]},{"name":"resourceId","required":true,"transform":{"type":"scalar"},"locs":[{"a":243,"b":254}]}],"statement":"SELECT 1 AS present FROM hosted_agent_operation_allocations AS allocation\nJOIN hosted_agent_operations AS operation USING (operation, idempotency_key, tenant_id)\nWHERE allocation.allocation_kind = :allocationKind! AND allocation.resource_id = :resourceId!\n  AND allocation.state <> 'reclaimed' AND operation.state = 'in_progress' LIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present FROM hosted_agent_operation_allocations AS allocation
 * JOIN hosted_agent_operations AS operation USING (operation, idempotency_key, tenant_id)
 * WHERE allocation.allocation_kind = :allocationKind! AND allocation.resource_id = :resourceId!
 *   AND allocation.state <> 'reclaimed' AND operation.state = 'in_progress' LIMIT 1
 * ```
 */
export const hasUnreclaimedAllocation = new PreparedQuery<IHasUnreclaimedAllocationParams,IHasUnreclaimedAllocationResult>(hasUnreclaimedAllocationIR);


/** 'BindPrimaryLease' parameters type */
export interface IBindPrimaryLeaseParams {
  generation: NumberOrString;
  idempotencyKey: string;
  leaseId: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'BindPrimaryLease' return type */
export type IBindPrimaryLeaseResult = void;

/** 'BindPrimaryLease' query type */
export interface IBindPrimaryLeaseQuery {
  params: IBindPrimaryLeaseParams;
  result: IBindPrimaryLeaseResult;
}

const bindPrimaryLeaseIR: any = {"usedParamSet":{"leaseId":true,"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":54,"b":62},{"a":299,"b":307}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":82,"b":92}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":116,"b":131}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":149,"b":158}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":179,"b":190}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":208,"b":217}]}],"statement":"UPDATE hosted_agent_operations SET primary_lease_id = :leaseId!\nWHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!\n  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'\n  AND (primary_lease_id IS NULL OR primary_lease_id = :leaseId!)"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_operations SET primary_lease_id = :leaseId!
 * WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
 *   AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'
 *   AND (primary_lease_id IS NULL OR primary_lease_id = :leaseId!)
 * ```
 */
export const bindPrimaryLease = new PreparedQuery<IBindPrimaryLeaseParams,IBindPrimaryLeaseResult>(bindPrimaryLeaseIR);


/** 'BindResultLease' parameters type */
export interface IBindResultLeaseParams {
  generation: NumberOrString;
  idempotencyKey: string;
  leaseId: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'BindResultLease' return type */
export type IBindResultLeaseResult = void;

/** 'BindResultLease' query type */
export interface IBindResultLeaseQuery {
  params: IBindResultLeaseParams;
  result: IBindResultLeaseResult;
}

const bindResultLeaseIR: any = {"usedParamSet":{"leaseId":true,"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":53,"b":61},{"a":296,"b":304}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":81,"b":91}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":115,"b":130}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":148,"b":157}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":178,"b":189}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":207,"b":216}]}],"statement":"UPDATE hosted_agent_operations SET result_lease_id = :leaseId!\nWHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!\n  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'\n  AND (result_lease_id IS NULL OR result_lease_id = :leaseId!)"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_operations SET result_lease_id = :leaseId!
 * WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
 *   AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'
 *   AND (result_lease_id IS NULL OR result_lease_id = :leaseId!)
 * ```
 */
export const bindResultLease = new PreparedQuery<IBindResultLeaseParams,IBindResultLeaseResult>(bindResultLeaseIR);


/** 'AdoptAllocations' parameters type */
export interface IAdoptAllocationsParams {
  allocationIds: NumberOrStringArray;
  idempotencyKey: string;
  leaseId: string;
  operation: string;
  tenantId: string;
}

/** 'AdoptAllocations' return type */
export interface IAdoptAllocationsResult {
  allocated_at: Date;
  allocation_id: string | null;
  allocation_kind: string;
  lease_id: string | null;
  metadata: Json;
  reclaimed_at: Date | null;
  resource_id: string;
  state: string;
  updated_at: Date;
}

/** 'AdoptAllocations' query type */
export interface IAdoptAllocationsQuery {
  params: IAdoptAllocationsParams;
  result: IAdoptAllocationsResult;
}

const adoptAllocationsIR: any = {"usedParamSet":{"leaseId":true,"operation":true,"idempotencyKey":true,"tenantId":true,"allocationIds":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":57,"b":65},{"a":321,"b":329}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":104,"b":114}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":138,"b":153}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":171,"b":180}]},{"name":"allocationIds","required":true,"transform":{"type":"scalar"},"locs":[{"a":208,"b":222}]}],"statement":"UPDATE hosted_agent_operation_allocations SET lease_id = :leaseId!, state = 'adopted'\nWHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!\n  AND allocation_id = ANY(:allocationIds!::bigint[])\n  AND (state IN ('allocated', 'reclaim_pending') OR (state = 'adopted' AND lease_id = :leaseId!))\nRETURNING allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,\n  allocated_at, updated_at, reclaimed_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_operation_allocations SET lease_id = :leaseId!, state = 'adopted'
 * WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
 *   AND allocation_id = ANY(:allocationIds!::bigint[])
 *   AND (state IN ('allocated', 'reclaim_pending') OR (state = 'adopted' AND lease_id = :leaseId!))
 * RETURNING allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,
 *   allocated_at, updated_at, reclaimed_at
 * ```
 */
export const adoptAllocations = new PreparedQuery<IAdoptAllocationsParams,IAdoptAllocationsResult>(adoptAllocationsIR);


/** 'ClaimStaleOperations' parameters type */
export interface IClaimStaleOperationsParams {
  excludedOperations?: stringArray | null | void;
  limit: NumberOrString;
  operationFilter?: string | null | void;
  staleBefore: DateOrString;
  subtypeFilter?: string | null | void;
  tenantId?: string | null | void;
  workerId: string;
}

/** 'ClaimStaleOperations' return type */
export interface IClaimStaleOperationsResult {
  generation: string | null;
  idempotency_key: string;
  operation: string;
  operation_subtype: string | null;
  previous_worker_id: string | null;
  primary_lease_id: string | null;
  request_hash: string;
  result_lease_id: string | null;
  tenant_id: string;
  worker_id: string | null;
}

/** 'ClaimStaleOperations' query type */
export interface IClaimStaleOperationsQuery {
  params: IClaimStaleOperationsParams;
  result: IClaimStaleOperationsResult;
}

const claimStaleOperationsIR: any = {"usedParamSet":{"staleBefore":true,"tenantId":true,"operationFilter":true,"subtypeFilter":true,"excludedOperations":true,"limit":true,"workerId":true},"params":[{"name":"staleBefore","required":true,"transform":{"type":"scalar"},"locs":[{"a":179,"b":191}]},{"name":"tenantId","required":false,"transform":{"type":"scalar"},"locs":[{"a":202,"b":210},{"a":241,"b":249}]},{"name":"operationFilter","required":false,"transform":{"type":"scalar"},"locs":[{"a":261,"b":276},{"a":307,"b":322}]},{"name":"subtypeFilter","required":false,"transform":{"type":"scalar"},"locs":[{"a":334,"b":347},{"a":367,"b":380},{"a":451,"b":464}]},{"name":"excludedOperations","required":false,"transform":{"type":"scalar"},"locs":[{"a":476,"b":494},{"a":536,"b":554}]},{"name":"limit","required":true,"transform":{"type":"scalar"},"locs":[{"a":664,"b":670}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":773,"b":782}]}],"statement":"WITH candidates AS (\n  SELECT operation, idempotency_key, tenant_id, worker_id FROM hosted_agent_operations\n  WHERE state = 'in_progress' AND COALESCE(heartbeat_at, started_at) < :staleBefore!\n    AND (:tenantId::text IS NULL OR tenant_id = :tenantId)\n    AND (:operationFilter::text IS NULL OR operation = :operationFilter)\n    AND (:subtypeFilter::text IS NULL OR (:subtypeFilter = 'none' AND operation_subtype IS NULL)\n      OR operation_subtype = :subtypeFilter)\n    AND (:excludedOperations::text[] IS NULL OR NOT (operation = ANY(:excludedOperations)))\n  ORDER BY COALESCE(heartbeat_at, started_at), operation, idempotency_key\n  FOR UPDATE SKIP LOCKED LIMIT :limit!\n)\nUPDATE hosted_agent_operations AS operation\nSET generation = operation.generation + 1, worker_id = :workerId!, heartbeat_at = now()\nFROM candidates WHERE operation.operation = candidates.operation\n  AND operation.idempotency_key = candidates.idempotency_key AND operation.tenant_id = candidates.tenant_id\nRETURNING operation.operation, operation.idempotency_key, operation.tenant_id,\n  operation.operation_subtype, operation.request_hash, operation.generation::text,\n  candidates.worker_id AS previous_worker_id, operation.worker_id,\n  operation.primary_lease_id, operation.result_lease_id"};

/**
 * Query generated from SQL:
 * ```
 * WITH candidates AS (
 *   SELECT operation, idempotency_key, tenant_id, worker_id FROM hosted_agent_operations
 *   WHERE state = 'in_progress' AND COALESCE(heartbeat_at, started_at) < :staleBefore!
 *     AND (:tenantId::text IS NULL OR tenant_id = :tenantId)
 *     AND (:operationFilter::text IS NULL OR operation = :operationFilter)
 *     AND (:subtypeFilter::text IS NULL OR (:subtypeFilter = 'none' AND operation_subtype IS NULL)
 *       OR operation_subtype = :subtypeFilter)
 *     AND (:excludedOperations::text[] IS NULL OR NOT (operation = ANY(:excludedOperations)))
 *   ORDER BY COALESCE(heartbeat_at, started_at), operation, idempotency_key
 *   FOR UPDATE SKIP LOCKED LIMIT :limit!
 * )
 * UPDATE hosted_agent_operations AS operation
 * SET generation = operation.generation + 1, worker_id = :workerId!, heartbeat_at = now()
 * FROM candidates WHERE operation.operation = candidates.operation
 *   AND operation.idempotency_key = candidates.idempotency_key AND operation.tenant_id = candidates.tenant_id
 * RETURNING operation.operation, operation.idempotency_key, operation.tenant_id,
 *   operation.operation_subtype, operation.request_hash, operation.generation::text,
 *   candidates.worker_id AS previous_worker_id, operation.worker_id,
 *   operation.primary_lease_id, operation.result_lease_id
 * ```
 */
export const claimStaleOperations = new PreparedQuery<IClaimStaleOperationsParams,IClaimStaleOperationsResult>(claimStaleOperationsIR);


/** 'LockExistingLeases' parameters type */
export interface ILockExistingLeasesParams {
  leaseIds: stringArray;
  tenantId: string;
}

/** 'LockExistingLeases' return type */
export interface ILockExistingLeasesResult {
  lease_id: string;
}

/** 'LockExistingLeases' query type */
export interface ILockExistingLeasesQuery {
  params: ILockExistingLeasesParams;
  result: ILockExistingLeasesResult;
}

const lockExistingLeasesIR: any = {"usedParamSet":{"tenantId":true,"leaseIds":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":59,"b":68}]},{"name":"leaseIds","required":true,"transform":{"type":"scalar"},"locs":[{"a":89,"b":98}]}],"statement":"SELECT lease_id FROM hosted_agent_leases\nWHERE tenant_id = :tenantId! AND lease_id = ANY(:leaseIds!::text[])\nORDER BY lease_id FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id FROM hosted_agent_leases
 * WHERE tenant_id = :tenantId! AND lease_id = ANY(:leaseIds!::text[])
 * ORDER BY lease_id FOR UPDATE
 * ```
 */
export const lockExistingLeases = new PreparedQuery<ILockExistingLeasesParams,ILockExistingLeasesResult>(lockExistingLeasesIR);


/** 'CompleteOperation' parameters type */
export interface ICompleteOperationParams {
  generation: NumberOrString;
  idempotencyKey: string;
  logicalResponse: Json;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'CompleteOperation' return type */
export type ICompleteOperationResult = void;

/** 'CompleteOperation' query type */
export interface ICompleteOperationQuery {
  params: ICompleteOperationParams;
  result: ICompleteOperationResult;
}

const completeOperationIR: any = {"usedParamSet":{"logicalResponse":true,"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"logicalResponse","required":true,"transform":{"type":"scalar"},"locs":[{"a":75,"b":91}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":205,"b":215}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":239,"b":254}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":272,"b":281}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":302,"b":313}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":331,"b":340}]}],"statement":"UPDATE hosted_agent_operations\nSET state = 'succeeded', logical_response = :logicalResponse!::jsonb, error_code = NULL,\n  error_message = NULL, completed_at = now(), heartbeat_at = now()\nWHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!\n  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_operations
 * SET state = 'succeeded', logical_response = :logicalResponse!::jsonb, error_code = NULL,
 *   error_message = NULL, completed_at = now(), heartbeat_at = now()
 * WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
 *   AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'
 * ```
 */
export const completeOperation = new PreparedQuery<ICompleteOperationParams,ICompleteOperationResult>(completeOperationIR);


/** 'FailOperation' parameters type */
export interface IFailOperationParams {
  errorCode: string;
  errorMessage: string;
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'FailOperation' return type */
export type IFailOperationResult = void;

/** 'FailOperation' query type */
export interface IFailOperationQuery {
  params: IFailOperationParams;
  result: IFailOperationResult;
}

const failOperationIR: any = {"usedParamSet":{"errorCode":true,"errorMessage":true,"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"errorCode","required":true,"transform":{"type":"scalar"},"locs":[{"a":100,"b":110}]},{"name":"errorMessage","required":true,"transform":{"type":"scalar"},"locs":[{"a":131,"b":144}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":208,"b":218}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":242,"b":257}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":275,"b":284}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":305,"b":316}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":334,"b":343}]}],"statement":"UPDATE hosted_agent_operations\nSET state = 'failed_terminal', logical_response = NULL, error_code = :errorCode!,\n  error_message = :errorMessage!, completed_at = now(), heartbeat_at = now()\nWHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!\n  AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_operations
 * SET state = 'failed_terminal', logical_response = NULL, error_code = :errorCode!,
 *   error_message = :errorMessage!, completed_at = now(), heartbeat_at = now()
 * WHERE operation = :operation! AND idempotency_key = :idempotencyKey! AND tenant_id = :tenantId!
 *   AND generation = :generation! AND worker_id = :workerId! AND state = 'in_progress'
 * ```
 */
export const failOperation = new PreparedQuery<IFailOperationParams,IFailOperationResult>(failOperationIR);
