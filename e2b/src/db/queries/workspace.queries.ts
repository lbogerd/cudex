/** Types generated for queries found in "src/db/queries/workspace.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NumberOrString = number | string;

/** 'GetWorkspacePreparationForOperation' parameters type */
export interface IGetWorkspacePreparationForOperationParams {
  idempotencyKey: string;
  operation: string;
  tenantId: string;
}

/** 'GetWorkspacePreparationForOperation' return type */
export interface IGetWorkspacePreparationForOperationResult {
  associated_object_count: string | null;
  committed_at: Date | null;
  created_at: Date;
  created_generation: string;
  expected_object_count: number;
  idempotency_key: string;
  intent: Json;
  intent_hash: string;
  lease_id: string;
  operation: string;
  preparation_id: string;
  reclaimed_at: Date | null;
  snapshot_id: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'GetWorkspacePreparationForOperation' query type */
export interface IGetWorkspacePreparationForOperationQuery {
  params: IGetWorkspacePreparationForOperationParams;
  result: IGetWorkspacePreparationForOperationResult;
}

const getWorkspacePreparationForOperationIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":239,"b":249}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":271,"b":286}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":302,"b":311}]}],"statement":"SELECT preparation.*,(SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects a\n WHERE a.preparation_id=preparation.preparation_id) associated_object_count\nFROM hosted_agent_workspace_preparations preparation WHERE operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT preparation.*,(SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects a
 *  WHERE a.preparation_id=preparation.preparation_id) associated_object_count
 * FROM hosted_agent_workspace_preparations preparation WHERE operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId!
 * ```
 */
export const getWorkspacePreparationForOperation = new PreparedQuery<IGetWorkspacePreparationForOperationParams,IGetWorkspacePreparationForOperationResult>(getWorkspacePreparationForOperationIR);


/** 'InsertWorkspacePreparation' parameters type */
export interface IInsertWorkspacePreparationParams {
  expectedObjectCount: number;
  generation: NumberOrString;
  idempotencyKey: string;
  intent: Json;
  intentHash: string;
  leaseId?: string | null | void;
  operation: string;
  preparationId: string;
  snapshotId?: string | null | void;
  sourceSnapshotId?: string | null | void;
  tenantId: string;
}

/** 'InsertWorkspacePreparation' return type */
export type IInsertWorkspacePreparationResult = void;

/** 'InsertWorkspacePreparation' query type */
export interface IInsertWorkspacePreparationQuery {
  params: IInsertWorkspacePreparationParams;
  result: IInsertWorkspacePreparationResult;
}

const insertWorkspacePreparationIR: any = {"usedParamSet":{"preparationId":true,"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"intentHash":true,"intent":true,"leaseId":true,"snapshotId":true,"sourceSnapshotId":true,"expectedObjectCount":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":213,"b":227}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":229,"b":239}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":241,"b":256}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":258,"b":267}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":269,"b":280}]},{"name":"intentHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":282,"b":293}]},{"name":"intent","required":true,"transform":{"type":"scalar"},"locs":[{"a":295,"b":302}]},{"name":"leaseId","required":false,"transform":{"type":"scalar"},"locs":[{"a":311,"b":318}]},{"name":"snapshotId","required":false,"transform":{"type":"scalar"},"locs":[{"a":320,"b":330}]},{"name":"sourceSnapshotId","required":false,"transform":{"type":"scalar"},"locs":[{"a":332,"b":348}]},{"name":"expectedObjectCount","required":true,"transform":{"type":"scalar"},"locs":[{"a":350,"b":370}]}],"statement":"INSERT INTO hosted_agent_workspace_preparations(preparation_id,operation,idempotency_key,tenant_id,created_generation,intent_hash,intent,lease_id,snapshot_id,source_snapshot_id,expected_object_count,state)\nVALUES(:preparationId!,:operation!,:idempotencyKey!,:tenantId!,:generation!,:intentHash!,:intent!::jsonb,:leaseId,:snapshotId,:sourceSnapshotId,:expectedObjectCount!,'publishing') ON CONFLICT DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_workspace_preparations(preparation_id,operation,idempotency_key,tenant_id,created_generation,intent_hash,intent,lease_id,snapshot_id,source_snapshot_id,expected_object_count,state)
 * VALUES(:preparationId!,:operation!,:idempotencyKey!,:tenantId!,:generation!,:intentHash!,:intent!::jsonb,:leaseId,:snapshotId,:sourceSnapshotId,:expectedObjectCount!,'publishing') ON CONFLICT DO NOTHING
 * ```
 */
export const insertWorkspacePreparation = new PreparedQuery<IInsertWorkspacePreparationParams,IInsertWorkspacePreparationResult>(insertWorkspacePreparationIR);


/** 'InsertWorkspacePreparationObject' parameters type */
export interface IInsertWorkspacePreparationObjectParams {
  allocationId: NumberOrString;
  idempotencyKey: string;
  objectId: string;
  operation: string;
  preparationId: string;
  purpose: string;
  tenantId: string;
}

/** 'InsertWorkspacePreparationObject' return type */
export type IInsertWorkspacePreparationObjectResult = void;

/** 'InsertWorkspacePreparationObject' query type */
export interface IInsertWorkspacePreparationObjectQuery {
  params: IInsertWorkspacePreparationObjectParams;
  result: IInsertWorkspacePreparationObjectResult;
}

const insertWorkspacePreparationObjectIR: any = {"usedParamSet":{"preparationId":true,"operation":true,"idempotencyKey":true,"tenantId":true,"purpose":true,"objectId":true,"allocationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":146,"b":160}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":162,"b":172},{"a":469,"b":479}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":174,"b":189},{"a":503,"b":518}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":191,"b":200},{"a":352,"b":361},{"a":536,"b":545}]},{"name":"purpose","required":true,"transform":{"type":"scalar"},"locs":[{"a":230,"b":238},{"a":398,"b":406}]},{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":325,"b":334},{"a":596,"b":605}]},{"name":"allocationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":430,"b":443}]}],"statement":"INSERT INTO hosted_agent_workspace_preparation_objects(preparation_id,operation,idempotency_key,tenant_id,allocation_id,object_id,purpose)\nSELECT :preparationId!,:operation!,:idempotencyKey!,:tenantId!,a.allocation_id,o.object_id,:purpose!\nFROM hosted_agent_operation_allocations a JOIN hosted_agent_objects o ON o.object_id=:objectId! AND o.tenant_id=:tenantId! AND o.state='available' AND o.kind=:purpose!\nWHERE a.allocation_id=:allocationId!::bigint AND a.operation=:operation! AND a.idempotency_key=:idempotencyKey! AND a.tenant_id=:tenantId! AND a.allocation_kind='object' AND a.resource_id=:objectId! AND a.state='allocated' ON CONFLICT DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_workspace_preparation_objects(preparation_id,operation,idempotency_key,tenant_id,allocation_id,object_id,purpose)
 * SELECT :preparationId!,:operation!,:idempotencyKey!,:tenantId!,a.allocation_id,o.object_id,:purpose!
 * FROM hosted_agent_operation_allocations a JOIN hosted_agent_objects o ON o.object_id=:objectId! AND o.tenant_id=:tenantId! AND o.state='available' AND o.kind=:purpose!
 * WHERE a.allocation_id=:allocationId!::bigint AND a.operation=:operation! AND a.idempotency_key=:idempotencyKey! AND a.tenant_id=:tenantId! AND a.allocation_kind='object' AND a.resource_id=:objectId! AND a.state='allocated' ON CONFLICT DO NOTHING
 * ```
 */
export const insertWorkspacePreparationObject = new PreparedQuery<IInsertWorkspacePreparationObjectParams,IInsertWorkspacePreparationObjectResult>(insertWorkspacePreparationObjectIR);


/** 'GetWorkspacePreparationObject' parameters type */
export interface IGetWorkspacePreparationObjectParams {
  allocationId: NumberOrString;
  preparationId: string;
}

/** 'GetWorkspacePreparationObject' return type */
export interface IGetWorkspacePreparationObjectResult {
  allocation_id: string | null;
  allocation_state: string;
  object_checksum: string;
  object_expires_at: Date | null;
  object_id: string;
  object_kind: string;
  object_size_bytes: string | null;
  object_state: string;
  preparation_id: string;
  purpose: string;
  storage_bucket: string;
  storage_key: string;
  tenant_id: string;
}

/** 'GetWorkspacePreparationObject' query type */
export interface IGetWorkspacePreparationObjectQuery {
  params: IGetWorkspacePreparationObjectParams;
  result: IGetWorkspacePreparationObjectResult;
}

const getWorkspacePreparationObjectIR: any = {"usedParamSet":{"preparationId":true,"allocationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":504,"b":518}]},{"name":"allocationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":540,"b":553}]}],"statement":"SELECT p.preparation_id,p.tenant_id,p.allocation_id::text,p.object_id,p.purpose,o.checksum object_checksum,o.size_bytes::text object_size_bytes,o.expires_at object_expires_at,o.storage_bucket,o.storage_key,o.kind object_kind,o.state object_state,a.state allocation_state\nFROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id\nWHERE p.preparation_id=:preparationId! AND p.allocation_id=:allocationId!::bigint"};

/**
 * Query generated from SQL:
 * ```
 * SELECT p.preparation_id,p.tenant_id,p.allocation_id::text,p.object_id,p.purpose,o.checksum object_checksum,o.size_bytes::text object_size_bytes,o.expires_at object_expires_at,o.storage_bucket,o.storage_key,o.kind object_kind,o.state object_state,a.state allocation_state
 * FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id
 * WHERE p.preparation_id=:preparationId! AND p.allocation_id=:allocationId!::bigint
 * ```
 */
export const getWorkspacePreparationObject = new PreparedQuery<IGetWorkspacePreparationObjectParams,IGetWorkspacePreparationObjectResult>(getWorkspacePreparationObjectIR);


/** 'LockWorkspacePreparationObject' parameters type */
export interface ILockWorkspacePreparationObjectParams {
  objectId: string;
  preparationId: string;
}

/** 'LockWorkspacePreparationObject' return type */
export interface ILockWorkspacePreparationObjectResult {
  allocation_id: string | null;
  allocation_state: string;
  object_checksum: string;
  object_expires_at: Date | null;
  object_id: string;
  object_kind: string;
  object_size_bytes: string | null;
  object_state: string;
  preparation_id: string;
  purpose: string;
  storage_bucket: string;
  storage_key: string;
  tenant_id: string;
}

/** 'LockWorkspacePreparationObject' query type */
export interface ILockWorkspacePreparationObjectQuery {
  params: ILockWorkspacePreparationObjectParams;
  result: ILockWorkspacePreparationObjectResult;
}

const lockWorkspacePreparationObjectIR: any = {"usedParamSet":{"preparationId":true,"objectId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":532,"b":546}]},{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":564,"b":573}]}],"statement":"SELECT p.preparation_id,p.tenant_id,p.allocation_id::text,p.object_id,p.purpose,o.checksum object_checksum,o.size_bytes::text object_size_bytes,o.expires_at object_expires_at,o.storage_bucket,o.storage_key,o.kind object_kind,o.state object_state,a.state allocation_state\nFROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id AND a.tenant_id=p.tenant_id JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id\nWHERE p.preparation_id=:preparationId! AND p.object_id=:objectId! FOR UPDATE OF p,a,o"};

/**
 * Query generated from SQL:
 * ```
 * SELECT p.preparation_id,p.tenant_id,p.allocation_id::text,p.object_id,p.purpose,o.checksum object_checksum,o.size_bytes::text object_size_bytes,o.expires_at object_expires_at,o.storage_bucket,o.storage_key,o.kind object_kind,o.state object_state,a.state allocation_state
 * FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id AND a.tenant_id=p.tenant_id JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id
 * WHERE p.preparation_id=:preparationId! AND p.object_id=:objectId! FOR UPDATE OF p,a,o
 * ```
 */
export const lockWorkspacePreparationObject = new PreparedQuery<ILockWorkspacePreparationObjectParams,ILockWorkspacePreparationObjectResult>(lockWorkspacePreparationObjectIR);


/** 'MarkWorkspacePreparationPrepared' parameters type */
export interface IMarkWorkspacePreparationPreparedParams {
  preparationId: string;
}

/** 'MarkWorkspacePreparationPrepared' return type */
export type IMarkWorkspacePreparationPreparedResult = void;

/** 'MarkWorkspacePreparationPrepared' query type */
export interface IMarkWorkspacePreparationPreparedQuery {
  params: IMarkWorkspacePreparationPreparedParams;
  result: IMarkWorkspacePreparationPreparedResult;
}

const markWorkspacePreparationPreparedIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":85,"b":99}]}],"statement":"UPDATE hosted_agent_workspace_preparations SET state='prepared' WHERE preparation_id=:preparationId!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_workspace_preparations SET state='prepared' WHERE preparation_id=:preparationId!
 * ```
 */
export const markWorkspacePreparationPrepared = new PreparedQuery<IMarkWorkspacePreparationPreparedParams,IMarkWorkspacePreparationPreparedResult>(markWorkspacePreparationPreparedIR);


/** 'MarkWorkspacePreparationCommitted' parameters type */
export interface IMarkWorkspacePreparationCommittedParams {
  preparationId: string;
}

/** 'MarkWorkspacePreparationCommitted' return type */
export type IMarkWorkspacePreparationCommittedResult = void;

/** 'MarkWorkspacePreparationCommitted' query type */
export interface IMarkWorkspacePreparationCommittedQuery {
  params: IMarkWorkspacePreparationCommittedParams;
  result: IMarkWorkspacePreparationCommittedResult;
}

const markWorkspacePreparationCommittedIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":123,"b":137}]}],"statement":"UPDATE hosted_agent_workspace_preparations SET state='committed',committed_at=now(),reclaimed_at=NULL WHERE preparation_id=:preparationId! AND state='prepared'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_workspace_preparations SET state='committed',committed_at=now(),reclaimed_at=NULL WHERE preparation_id=:preparationId! AND state='prepared'
 * ```
 */
export const markWorkspacePreparationCommitted = new PreparedQuery<IMarkWorkspacePreparationCommittedParams,IMarkWorkspacePreparationCommittedResult>(markWorkspacePreparationCommittedIR);


/** 'MarkWorkspacePreparationReclaimPending' parameters type */
export interface IMarkWorkspacePreparationReclaimPendingParams {
  preparationId: string;
}

/** 'MarkWorkspacePreparationReclaimPending' return type */
export type IMarkWorkspacePreparationReclaimPendingResult = void;

/** 'MarkWorkspacePreparationReclaimPending' query type */
export interface IMarkWorkspacePreparationReclaimPendingQuery {
  params: IMarkWorkspacePreparationReclaimPendingParams;
  result: IMarkWorkspacePreparationReclaimPendingResult;
}

const markWorkspacePreparationReclaimPendingIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":92,"b":106}]}],"statement":"UPDATE hosted_agent_workspace_preparations SET state='reclaim_pending' WHERE preparation_id=:preparationId!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_workspace_preparations SET state='reclaim_pending' WHERE preparation_id=:preparationId!
 * ```
 */
export const markWorkspacePreparationReclaimPending = new PreparedQuery<IMarkWorkspacePreparationReclaimPendingParams,IMarkWorkspacePreparationReclaimPendingResult>(markWorkspacePreparationReclaimPendingIR);


/** 'HasOutstandingWorkspaceAllocations' parameters type */
export interface IHasOutstandingWorkspaceAllocationsParams {
  preparationId: string;
}

/** 'HasOutstandingWorkspaceAllocations' return type */
export interface IHasOutstandingWorkspaceAllocationsResult {
  outstanding: number | null;
}

/** 'HasOutstandingWorkspaceAllocations' query type */
export interface IHasOutstandingWorkspaceAllocationsQuery {
  params: IHasOutstandingWorkspaceAllocationsParams;
  result: IHasOutstandingWorkspaceAllocationsResult;
}

const hasOutstandingWorkspaceAllocationsIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":174,"b":188}]}],"statement":"SELECT 1 AS outstanding FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id WHERE p.preparation_id=:preparationId! AND a.state<>'reclaimed' LIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS outstanding FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id WHERE p.preparation_id=:preparationId! AND a.state<>'reclaimed' LIMIT 1
 * ```
 */
export const hasOutstandingWorkspaceAllocations = new PreparedQuery<IHasOutstandingWorkspaceAllocationsParams,IHasOutstandingWorkspaceAllocationsResult>(hasOutstandingWorkspaceAllocationsIR);


/** 'MarkWorkspacePreparationReclaimed' parameters type */
export interface IMarkWorkspacePreparationReclaimedParams {
  preparationId: string;
}

/** 'MarkWorkspacePreparationReclaimed' return type */
export type IMarkWorkspacePreparationReclaimedResult = void;

/** 'MarkWorkspacePreparationReclaimed' query type */
export interface IMarkWorkspacePreparationReclaimedQuery {
  params: IMarkWorkspacePreparationReclaimedParams;
  result: IMarkWorkspacePreparationReclaimedResult;
}

const markWorkspacePreparationReclaimedIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":123,"b":137}]}],"statement":"UPDATE hosted_agent_workspace_preparations SET state='reclaimed',reclaimed_at=now(),committed_at=NULL WHERE preparation_id=:preparationId!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_workspace_preparations SET state='reclaimed',reclaimed_at=now(),committed_at=NULL WHERE preparation_id=:preparationId!
 * ```
 */
export const markWorkspacePreparationReclaimed = new PreparedQuery<IMarkWorkspacePreparationReclaimedParams,IMarkWorkspacePreparationReclaimedResult>(markWorkspacePreparationReclaimedIR);


/** 'OwnsWorkspacePreparationOperation' parameters type */
export interface IOwnsWorkspacePreparationOperationParams {
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'OwnsWorkspacePreparationOperation' return type */
export interface IOwnsWorkspacePreparationOperationResult {
  owned: number | null;
}

/** 'OwnsWorkspacePreparationOperation' query type */
export interface IOwnsWorkspacePreparationOperationQuery {
  params: IOwnsWorkspacePreparationOperationParams;
  result: IOwnsWorkspacePreparationOperationResult;
}

const ownsWorkspacePreparationOperationIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":63,"b":73}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":95,"b":110}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":126,"b":135}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":152,"b":163}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":179,"b":188}]}],"statement":"SELECT 1 AS owned FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress' FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS owned FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress' FOR UPDATE
 * ```
 */
export const ownsWorkspacePreparationOperation = new PreparedQuery<IOwnsWorkspacePreparationOperationParams,IOwnsWorkspacePreparationOperationResult>(ownsWorkspacePreparationOperationIR);


/** 'GetWorkspacePreparation' parameters type */
export interface IGetWorkspacePreparationParams {
  preparationId: string;
}

/** 'GetWorkspacePreparation' return type */
export interface IGetWorkspacePreparationResult {
  associated_object_count: string | null;
  committed_at: Date | null;
  created_at: Date;
  created_generation: string;
  expected_object_count: number;
  idempotency_key: string;
  intent: Json;
  intent_hash: string;
  lease_id: string;
  operation: string;
  preparation_id: string;
  reclaimed_at: Date | null;
  snapshot_id: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'GetWorkspacePreparation' query type */
export interface IGetWorkspacePreparationQuery {
  params: IGetWorkspacePreparationParams;
  result: IGetWorkspacePreparationResult;
}

const getWorkspacePreparationIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":243,"b":257}]}],"statement":"SELECT preparation.*,(SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects a WHERE a.preparation_id=preparation.preparation_id) associated_object_count FROM hosted_agent_workspace_preparations preparation WHERE preparation_id=:preparationId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT preparation.*,(SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects a WHERE a.preparation_id=preparation.preparation_id) associated_object_count FROM hosted_agent_workspace_preparations preparation WHERE preparation_id=:preparationId!
 * ```
 */
export const getWorkspacePreparation = new PreparedQuery<IGetWorkspacePreparationParams,IGetWorkspacePreparationResult>(getWorkspacePreparationIR);


/** 'LockWorkspacePreparation' parameters type */
export interface ILockWorkspacePreparationParams {
  preparationId: string;
}

/** 'LockWorkspacePreparation' return type */
export interface ILockWorkspacePreparationResult {
  associated_object_count: string | null;
  committed_at: Date | null;
  created_at: Date;
  created_generation: string;
  expected_object_count: number;
  idempotency_key: string;
  intent: Json;
  intent_hash: string;
  lease_id: string;
  operation: string;
  preparation_id: string;
  reclaimed_at: Date | null;
  snapshot_id: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'LockWorkspacePreparation' query type */
export interface ILockWorkspacePreparationQuery {
  params: ILockWorkspacePreparationParams;
  result: ILockWorkspacePreparationResult;
}

const lockWorkspacePreparationIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":243,"b":257}]}],"statement":"SELECT preparation.*,(SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects a WHERE a.preparation_id=preparation.preparation_id) associated_object_count FROM hosted_agent_workspace_preparations preparation WHERE preparation_id=:preparationId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT preparation.*,(SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects a WHERE a.preparation_id=preparation.preparation_id) associated_object_count FROM hosted_agent_workspace_preparations preparation WHERE preparation_id=:preparationId! FOR UPDATE
 * ```
 */
export const lockWorkspacePreparation = new PreparedQuery<ILockWorkspacePreparationParams,ILockWorkspacePreparationResult>(lockWorkspacePreparationIR);


/** 'ListWorkspacePreparationAllocationIds' parameters type */
export interface IListWorkspacePreparationAllocationIdsParams {
  idempotencyKey: string;
  operation: string;
  tenantId: string;
}

/** 'ListWorkspacePreparationAllocationIds' return type */
export interface IListWorkspacePreparationAllocationIdsResult {
  allocation_id: string | null;
}

/** 'ListWorkspacePreparationAllocationIds' query type */
export interface IListWorkspacePreparationAllocationIdsQuery {
  params: IListWorkspacePreparationAllocationIdsParams;
  result: IListWorkspacePreparationAllocationIdsResult;
}

const listWorkspacePreparationAllocationIdsIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":245,"b":255}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":289,"b":304}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":332,"b":341}]}],"statement":"SELECT p.allocation_id::text FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_workspace_preparations preparation ON preparation.preparation_id=p.preparation_id AND preparation.tenant_id=p.tenant_id WHERE preparation.operation=:operation! AND preparation.idempotency_key=:idempotencyKey! AND preparation.tenant_id=:tenantId! ORDER BY p.allocation_id"};

/**
 * Query generated from SQL:
 * ```
 * SELECT p.allocation_id::text FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_workspace_preparations preparation ON preparation.preparation_id=p.preparation_id AND preparation.tenant_id=p.tenant_id WHERE preparation.operation=:operation! AND preparation.idempotency_key=:idempotencyKey! AND preparation.tenant_id=:tenantId! ORDER BY p.allocation_id
 * ```
 */
export const listWorkspacePreparationAllocationIds = new PreparedQuery<IListWorkspacePreparationAllocationIdsParams,IListWorkspacePreparationAllocationIdsResult>(listWorkspacePreparationAllocationIdsIR);


/** 'LockWorkspacePreparationObjects' parameters type */
export interface ILockWorkspacePreparationObjectsParams {
  preparationId: string;
}

/** 'LockWorkspacePreparationObjects' return type */
export interface ILockWorkspacePreparationObjectsResult {
  allocation_id: string | null;
  allocation_state: string;
  object_checksum: string;
  object_expires_at: Date | null;
  object_id: string;
  object_kind: string;
  object_size_bytes: string | null;
  object_state: string;
  preparation_id: string;
  purpose: string;
  storage_bucket: string;
  storage_key: string;
  tenant_id: string;
}

/** 'LockWorkspacePreparationObjects' query type */
export interface ILockWorkspacePreparationObjectsQuery {
  params: ILockWorkspacePreparationObjectsParams;
  result: ILockWorkspacePreparationObjectsResult;
}

const lockWorkspacePreparationObjectsIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":532,"b":546}]}],"statement":"SELECT p.preparation_id,p.tenant_id,p.allocation_id::text,p.object_id,p.purpose,o.checksum object_checksum,o.size_bytes::text object_size_bytes,o.expires_at object_expires_at,o.storage_bucket,o.storage_key,o.kind object_kind,o.state object_state,a.state allocation_state\nFROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id AND a.tenant_id=p.tenant_id JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id\nWHERE p.preparation_id=:preparationId! AND a.allocation_kind='object' ORDER BY p.allocation_id,p.object_id FOR UPDATE OF p,a,o"};

/**
 * Query generated from SQL:
 * ```
 * SELECT p.preparation_id,p.tenant_id,p.allocation_id::text,p.object_id,p.purpose,o.checksum object_checksum,o.size_bytes::text object_size_bytes,o.expires_at object_expires_at,o.storage_bucket,o.storage_key,o.kind object_kind,o.state object_state,a.state allocation_state
 * FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id AND a.tenant_id=p.tenant_id JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id
 * WHERE p.preparation_id=:preparationId! AND a.allocation_kind='object' ORDER BY p.allocation_id,p.object_id FOR UPDATE OF p,a,o
 * ```
 */
export const lockWorkspacePreparationObjects = new PreparedQuery<ILockWorkspacePreparationObjectsParams,ILockWorkspacePreparationObjectsResult>(lockWorkspacePreparationObjectsIR);
