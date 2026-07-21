/** Types generated for queries found in "src/db/queries/lifecycle.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NumberOrString = number | string;

/** 'GetLease' parameters type */
export interface IGetLeaseParams {
  leaseId: string;
  tenantId: string;
}

/** 'GetLease' return type */
export interface IGetLeaseResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'GetLease' query type */
export interface IGetLeaseQuery {
  params: IGetLeaseParams;
  result: IGetLeaseResult;
}

const getLeaseIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":397,"b":405}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":423,"b":432}]}],"statement":"SELECT lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at\nFROM hosted_agent_leases WHERE lease_id = :leaseId! AND tenant_id = :tenantId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * FROM hosted_agent_leases WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
 * ```
 */
export const getLease = new PreparedQuery<IGetLeaseParams,IGetLeaseResult>(getLeaseIR);


/** 'InsertLease' parameters type */
export interface IInsertLeaseParams {
  agentId: string;
  cwdUri: string;
  environmentId: string;
  leaseId: string;
  ownerAgentId?: string | null | void;
  ownerLeaseId?: string | null | void;
  policyVersion: NumberOrString;
  providerSandboxId: string;
  restoreSourceLeaseId?: string | null | void;
  restoreSourceSnapshotId?: string | null | void;
  sandboxTemplate: string;
  sourceSnapshotId?: string | null | void;
  tenantId: string;
  toolPolicy: Json;
  workspaceRootUris: Json;
}

/** 'InsertLease' return type */
export type IInsertLeaseResult = void;

/** 'InsertLease' query type */
export interface IInsertLeaseQuery {
  params: IInsertLeaseParams;
  result: IInsertLeaseResult;
}

const insertLeaseIR: any = {"usedParamSet":{"leaseId":true,"environmentId":true,"tenantId":true,"agentId":true,"ownerAgentId":true,"ownerLeaseId":true,"sourceSnapshotId":true,"restoreSourceLeaseId":true,"restoreSourceSnapshotId":true,"providerSandboxId":true,"sandboxTemplate":true,"cwdUri":true,"workspaceRootUris":true,"toolPolicy":true,"policyVersion":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":306,"b":314}]},{"name":"environmentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":317,"b":331}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":334,"b":343}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":346,"b":354}]},{"name":"ownerAgentId","required":false,"transform":{"type":"scalar"},"locs":[{"a":357,"b":369}]},{"name":"ownerLeaseId","required":false,"transform":{"type":"scalar"},"locs":[{"a":372,"b":384}]},{"name":"sourceSnapshotId","required":false,"transform":{"type":"scalar"},"locs":[{"a":389,"b":405}]},{"name":"restoreSourceLeaseId","required":false,"transform":{"type":"scalar"},"locs":[{"a":408,"b":428}]},{"name":"restoreSourceSnapshotId","required":false,"transform":{"type":"scalar"},"locs":[{"a":431,"b":454}]},{"name":"providerSandboxId","required":true,"transform":{"type":"scalar"},"locs":[{"a":457,"b":475}]},{"name":"sandboxTemplate","required":true,"transform":{"type":"scalar"},"locs":[{"a":480,"b":496}]},{"name":"cwdUri","required":true,"transform":{"type":"scalar"},"locs":[{"a":499,"b":506}]},{"name":"workspaceRootUris","required":true,"transform":{"type":"scalar"},"locs":[{"a":509,"b":527}]},{"name":"toolPolicy","required":true,"transform":{"type":"scalar"},"locs":[{"a":553,"b":564}]},{"name":"policyVersion","required":true,"transform":{"type":"scalar"},"locs":[{"a":576,"b":590}]}],"statement":"INSERT INTO hosted_agent_leases\n  (lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id,\n   provider_sandbox_id, sandbox_template, cwd_uri, workspace_root_uris, state, tool_policy, policy_version)\nVALUES (:leaseId!, :environmentId!, :tenantId!, :agentId!, :ownerAgentId, :ownerLeaseId,\n  :sourceSnapshotId, :restoreSourceLeaseId, :restoreSourceSnapshotId, :providerSandboxId!,\n  :sandboxTemplate!, :cwdUri!, :workspaceRootUris!::jsonb, 'provisioning', :toolPolicy!::jsonb,\n  :policyVersion!)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_leases
 *   (lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *    source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id,
 *    provider_sandbox_id, sandbox_template, cwd_uri, workspace_root_uris, state, tool_policy, policy_version)
 * VALUES (:leaseId!, :environmentId!, :tenantId!, :agentId!, :ownerAgentId, :ownerLeaseId,
 *   :sourceSnapshotId, :restoreSourceLeaseId, :restoreSourceSnapshotId, :providerSandboxId!,
 *   :sandboxTemplate!, :cwdUri!, :workspaceRootUris!::jsonb, 'provisioning', :toolPolicy!::jsonb,
 *   :policyVersion!)
 * ```
 */
export const insertLease = new PreparedQuery<IInsertLeaseParams,IInsertLeaseResult>(insertLeaseIR);


/** 'InsertLeaseBaseReferences' parameters type */
export interface IInsertLeaseBaseReferencesParams {
  leaseId: string;
  snapshotId: string;
}

/** 'InsertLeaseBaseReferences' return type */
export type IInsertLeaseBaseReferencesResult = void;

/** 'InsertLeaseBaseReferences' query type */
export interface IInsertLeaseBaseReferencesQuery {
  params: IInsertLeaseBaseReferencesParams;
  result: IInsertLeaseBaseReferencesResult;
}

const insertLeaseBaseReferencesIR: any = {"usedParamSet":{"snapshotId":true,"leaseId":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":97,"b":108},{"a":138,"b":149}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":125,"b":133},{"a":168,"b":176}]}],"statement":"INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)\nVALUES (:snapshotId!, 'lease_base', :leaseId!), (:snapshotId!, 'lease_latest', :leaseId!)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
 * VALUES (:snapshotId!, 'lease_base', :leaseId!), (:snapshotId!, 'lease_latest', :leaseId!)
 * ```
 */
export const insertLeaseBaseReferences = new PreparedQuery<IInsertLeaseBaseReferencesParams,IInsertLeaseBaseReferencesResult>(insertLeaseBaseReferencesIR);


/** 'InsertLeaseRestoreSourceReference' parameters type */
export interface IInsertLeaseRestoreSourceReferenceParams {
  leaseId: string;
  snapshotId: string;
}

/** 'InsertLeaseRestoreSourceReference' return type */
export type IInsertLeaseRestoreSourceReferenceResult = void;

/** 'InsertLeaseRestoreSourceReference' query type */
export interface IInsertLeaseRestoreSourceReferenceQuery {
  params: IInsertLeaseRestoreSourceReferenceParams;
  result: IInsertLeaseRestoreSourceReferenceResult;
}

const insertLeaseRestoreSourceReferenceIR: any = {"usedParamSet":{"snapshotId":true,"leaseId":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":97,"b":108}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":135,"b":143}]}],"statement":"INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)\nVALUES (:snapshotId!, 'lease_restore_source', :leaseId!)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
 * VALUES (:snapshotId!, 'lease_restore_source', :leaseId!)
 * ```
 */
export const insertLeaseRestoreSourceReference = new PreparedQuery<IInsertLeaseRestoreSourceReferenceParams,IInsertLeaseRestoreSourceReferenceResult>(insertLeaseRestoreSourceReferenceIR);


/** 'ActivateLease' parameters type */
export interface IActivateLeaseParams {
  leaseId: string;
  snapshotId: string;
  tenantId: string;
}

/** 'ActivateLease' return type */
export interface IActivateLeaseResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'ActivateLease' query type */
export interface IActivateLeaseQuery {
  params: IActivateLeaseParams;
  result: IActivateLeaseResult;
}

const activateLeaseIR: any = {"usedParamSet":{"snapshotId":true,"leaseId":true,"tenantId":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":50,"b":61},{"a":85,"b":96}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":133,"b":141}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":159,"b":168}]}],"statement":"UPDATE hosted_agent_leases\nSET base_snapshot_id = :snapshotId!, latest_snapshot_id = :snapshotId!, state = 'active'\nWHERE lease_id = :leaseId! AND tenant_id = :tenantId!\nRETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_leases
 * SET base_snapshot_id = :snapshotId!, latest_snapshot_id = :snapshotId!, state = 'active'
 * WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
 * RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * ```
 */
export const activateLease = new PreparedQuery<IActivateLeaseParams,IActivateLeaseResult>(activateLeaseIR);


/** 'FindRestoreReplacementForUpdate' parameters type */
export interface IFindRestoreReplacementForUpdateParams {
  sourceLeaseId: string;
  tenantId: string;
}

/** 'FindRestoreReplacementForUpdate' return type */
export interface IFindRestoreReplacementForUpdateResult {
  lease_id: string;
}

/** 'FindRestoreReplacementForUpdate' query type */
export interface IFindRestoreReplacementForUpdateQuery {
  params: IFindRestoreReplacementForUpdateParams;
  result: IFindRestoreReplacementForUpdateResult;
}

const findRestoreReplacementForUpdateIR: any = {"usedParamSet":{"sourceLeaseId":true,"tenantId":true},"params":[{"name":"sourceLeaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":73,"b":87}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":105,"b":114}]}],"statement":"SELECT lease_id FROM hosted_agent_leases\nWHERE restore_source_lease_id = :sourceLeaseId! AND tenant_id = :tenantId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id FROM hosted_agent_leases
 * WHERE restore_source_lease_id = :sourceLeaseId! AND tenant_id = :tenantId! FOR UPDATE
 * ```
 */
export const findRestoreReplacementForUpdate = new PreparedQuery<IFindRestoreReplacementForUpdateParams,IFindRestoreReplacementForUpdateResult>(findRestoreReplacementForUpdateIR);


/** 'ReleaseLostRestoreSource' parameters type */
export interface IReleaseLostRestoreSourceParams {
  leaseId: string;
  tenantId: string;
}

/** 'ReleaseLostRestoreSource' return type */
export type IReleaseLostRestoreSourceResult = void;

/** 'ReleaseLostRestoreSource' query type */
export interface IReleaseLostRestoreSourceQuery {
  params: IReleaseLostRestoreSourceParams;
  result: IReleaseLostRestoreSourceResult;
}

const releaseLostRestoreSourceIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":88,"b":96}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":114,"b":123}]}],"statement":"UPDATE hosted_agent_leases SET state = 'released', released_at = now()\nWHERE lease_id = :leaseId! AND tenant_id = :tenantId! AND state = 'lost'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_leases SET state = 'released', released_at = now()
 * WHERE lease_id = :leaseId! AND tenant_id = :tenantId! AND state = 'lost'
 * ```
 */
export const releaseLostRestoreSource = new PreparedQuery<IReleaseLostRestoreSourceParams,IReleaseLostRestoreSourceResult>(releaseLostRestoreSourceIR);


/** 'DeleteLatestSnapshotReference' parameters type */
export interface IDeleteLatestSnapshotReferenceParams {
  leaseId: string;
}

/** 'DeleteLatestSnapshotReference' return type */
export type IDeleteLatestSnapshotReferenceResult = void;

/** 'DeleteLatestSnapshotReference' query type */
export interface IDeleteLatestSnapshotReferenceQuery {
  params: IDeleteLatestSnapshotReferenceParams;
  result: IDeleteLatestSnapshotReferenceResult;
}

const deleteLatestSnapshotReferenceIR: any = {"usedParamSet":{"leaseId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":102,"b":110}]}],"statement":"DELETE FROM hosted_agent_snapshot_references\nWHERE reference_kind = 'lease_latest' AND reference_id = :leaseId!"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM hosted_agent_snapshot_references
 * WHERE reference_kind = 'lease_latest' AND reference_id = :leaseId!
 * ```
 */
export const deleteLatestSnapshotReference = new PreparedQuery<IDeleteLatestSnapshotReferenceParams,IDeleteLatestSnapshotReferenceResult>(deleteLatestSnapshotReferenceIR);


/** 'InsertLatestSnapshotReference' parameters type */
export interface IInsertLatestSnapshotReferenceParams {
  leaseId: string;
  snapshotId: string;
}

/** 'InsertLatestSnapshotReference' return type */
export type IInsertLatestSnapshotReferenceResult = void;

/** 'InsertLatestSnapshotReference' query type */
export interface IInsertLatestSnapshotReferenceQuery {
  params: IInsertLatestSnapshotReferenceParams;
  result: IInsertLatestSnapshotReferenceResult;
}

const insertLatestSnapshotReferenceIR: any = {"usedParamSet":{"snapshotId":true,"leaseId":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":97,"b":108}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":127,"b":135}]}],"statement":"INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)\nVALUES (:snapshotId!, 'lease_latest', :leaseId!)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
 * VALUES (:snapshotId!, 'lease_latest', :leaseId!)
 * ```
 */
export const insertLatestSnapshotReference = new PreparedQuery<IInsertLatestSnapshotReferenceParams,IInsertLatestSnapshotReferenceResult>(insertLatestSnapshotReferenceIR);


/** 'SetLatestSnapshot' parameters type */
export interface ISetLatestSnapshotParams {
  leaseId: string;
  snapshotId: string;
  tenantId: string;
}

/** 'SetLatestSnapshot' return type */
export type ISetLatestSnapshotResult = void;

/** 'SetLatestSnapshot' query type */
export interface ISetLatestSnapshotQuery {
  params: ISetLatestSnapshotParams;
  result: ISetLatestSnapshotResult;
}

const setLatestSnapshotIR: any = {"usedParamSet":{"snapshotId":true,"leaseId":true,"tenantId":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":52,"b":63}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":82,"b":90}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":108,"b":117}]}],"statement":"UPDATE hosted_agent_leases SET latest_snapshot_id = :snapshotId!\nWHERE lease_id = :leaseId! AND tenant_id = :tenantId!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_leases SET latest_snapshot_id = :snapshotId!
 * WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
 * ```
 */
export const setLatestSnapshot = new PreparedQuery<ISetLatestSnapshotParams,ISetLatestSnapshotResult>(setLatestSnapshotIR);


/** 'LockLease' parameters type */
export interface ILockLeaseParams {
  leaseId: string;
  tenantId: string;
}

/** 'LockLease' return type */
export interface ILockLeaseResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'LockLease' query type */
export interface ILockLeaseQuery {
  params: ILockLeaseParams;
  result: ILockLeaseResult;
}

const lockLeaseIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":397,"b":405}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":423,"b":432}]}],"statement":"SELECT lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at\nFROM hosted_agent_leases WHERE lease_id = :leaseId! AND tenant_id = :tenantId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * FROM hosted_agent_leases WHERE lease_id = :leaseId! AND tenant_id = :tenantId! FOR UPDATE
 * ```
 */
export const lockLease = new PreparedQuery<ILockLeaseParams,ILockLeaseResult>(lockLeaseIR);


/** 'ActiveLeaseTarget' parameters type */
export interface IActiveLeaseTargetParams {
  leaseId: string;
}

/** 'ActiveLeaseTarget' return type */
export interface IActiveLeaseTargetResult {
  connection_generation: string | null;
  provider_sandbox_id: string | null;
}

/** 'ActiveLeaseTarget' query type */
export interface IActiveLeaseTargetQuery {
  params: IActiveLeaseTargetParams;
  result: IActiveLeaseTargetResult;
}

const activeLeaseTargetIR: any = {"usedParamSet":{"leaseId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":98,"b":106}]}],"statement":"SELECT provider_sandbox_id, connection_generation::text\nFROM hosted_agent_leases\nWHERE lease_id = :leaseId! AND state = 'active' AND provider_sandbox_id IS NOT NULL"};

/**
 * Query generated from SQL:
 * ```
 * SELECT provider_sandbox_id, connection_generation::text
 * FROM hosted_agent_leases
 * WHERE lease_id = :leaseId! AND state = 'active' AND provider_sandbox_id IS NOT NULL
 * ```
 */
export const activeLeaseTarget = new PreparedQuery<IActiveLeaseTargetParams,IActiveLeaseTargetResult>(activeLeaseTargetIR);


/** 'FindLeaseByProviderSandboxForReconciliation' parameters type */
export interface IFindLeaseByProviderSandboxForReconciliationParams {
  providerSandboxId: string;
}

/** 'FindLeaseByProviderSandboxForReconciliation' return type */
export interface IFindLeaseByProviderSandboxForReconciliationResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'FindLeaseByProviderSandboxForReconciliation' query type */
export interface IFindLeaseByProviderSandboxForReconciliationQuery {
  params: IFindLeaseByProviderSandboxForReconciliationParams;
  result: IFindLeaseByProviderSandboxForReconciliationResult;
}

const findLeaseByProviderSandboxForReconciliationIR: any = {"usedParamSet":{"providerSandboxId":true},"params":[{"name":"providerSandboxId","required":true,"transform":{"type":"scalar"},"locs":[{"a":408,"b":426}]}],"statement":"SELECT lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at\nFROM hosted_agent_leases\nWHERE provider_sandbox_id = :providerSandboxId!\n  AND state IN ('provisioning', 'active', 'paused', 'release_pending')\nORDER BY created_at DESC LIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * FROM hosted_agent_leases
 * WHERE provider_sandbox_id = :providerSandboxId!
 *   AND state IN ('provisioning', 'active', 'paused', 'release_pending')
 * ORDER BY created_at DESC LIMIT 1
 * ```
 */
export const findLeaseByProviderSandboxForReconciliation = new PreparedQuery<IFindLeaseByProviderSandboxForReconciliationParams,IFindLeaseByProviderSandboxForReconciliationResult>(findLeaseByProviderSandboxForReconciliationIR);


/** 'FindSnapshotByProviderIdForReconciliation' parameters type */
export interface IFindSnapshotByProviderIdForReconciliationParams {
  providerSnapshotId: string;
}

/** 'FindSnapshotByProviderIdForReconciliation' return type */
export interface IFindSnapshotByProviderIdForReconciliationResult {
  created_at: Date;
  expires_at: Date | null;
  lease_id: string;
  manifest_checksum: string;
  manifest_object_id: string;
  provider_snapshot_id: string | null;
  snapshot_id: string;
  state: string;
  tenant_id: string;
  workspace_archive_object_id: string;
}

/** 'FindSnapshotByProviderIdForReconciliation' query type */
export interface IFindSnapshotByProviderIdForReconciliationQuery {
  params: IFindSnapshotByProviderIdForReconciliationParams;
  result: IFindSnapshotByProviderIdForReconciliationResult;
}

const findSnapshotByProviderIdForReconciliationIR: any = {"usedParamSet":{"providerSnapshotId":true},"params":[{"name":"providerSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":220,"b":239}]}],"statement":"SELECT snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,\n  manifest_object_id, manifest_checksum, state, expires_at, created_at\nFROM hosted_agent_snapshots\nWHERE provider_snapshot_id = :providerSnapshotId! AND state <> 'deleted'\nORDER BY created_at DESC LIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
 *   manifest_object_id, manifest_checksum, state, expires_at, created_at
 * FROM hosted_agent_snapshots
 * WHERE provider_snapshot_id = :providerSnapshotId! AND state <> 'deleted'
 * ORDER BY created_at DESC LIMIT 1
 * ```
 */
export const findSnapshotByProviderIdForReconciliation = new PreparedQuery<IFindSnapshotByProviderIdForReconciliationParams,IFindSnapshotByProviderIdForReconciliationResult>(findSnapshotByProviderIdForReconciliationIR);


/** 'GetSnapshot' parameters type */
export interface IGetSnapshotParams {
  snapshotId: string;
  tenantId: string;
}

/** 'GetSnapshot' return type */
export interface IGetSnapshotResult {
  created_at: Date;
  expires_at: Date | null;
  lease_id: string;
  manifest_checksum: string;
  manifest_object_id: string;
  provider_snapshot_id: string | null;
  snapshot_id: string;
  state: string;
  tenant_id: string;
  workspace_archive_object_id: string;
}

/** 'GetSnapshot' query type */
export interface IGetSnapshotQuery {
  params: IGetSnapshotParams;
  result: IGetSnapshotResult;
}

const getSnapshotIR: any = {"usedParamSet":{"snapshotId":true,"tenantId":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":211,"b":222}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":240,"b":249}]}],"statement":"SELECT snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,\n  manifest_object_id, manifest_checksum, state, expires_at, created_at\nFROM hosted_agent_snapshots WHERE snapshot_id = :snapshotId! AND tenant_id = :tenantId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
 *   manifest_object_id, manifest_checksum, state, expires_at, created_at
 * FROM hosted_agent_snapshots WHERE snapshot_id = :snapshotId! AND tenant_id = :tenantId!
 * ```
 */
export const getSnapshot = new PreparedQuery<IGetSnapshotParams,IGetSnapshotResult>(getSnapshotIR);


/** 'LockSnapshot' parameters type */
export interface ILockSnapshotParams {
  snapshotId: string;
  tenantId: string;
}

/** 'LockSnapshot' return type */
export interface ILockSnapshotResult {
  created_at: Date;
  expires_at: Date | null;
  lease_id: string;
  manifest_checksum: string;
  manifest_object_id: string;
  provider_snapshot_id: string | null;
  snapshot_id: string;
  state: string;
  tenant_id: string;
  workspace_archive_object_id: string;
}

/** 'LockSnapshot' query type */
export interface ILockSnapshotQuery {
  params: ILockSnapshotParams;
  result: ILockSnapshotResult;
}

const lockSnapshotIR: any = {"usedParamSet":{"snapshotId":true,"tenantId":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":211,"b":222}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":240,"b":249}]}],"statement":"SELECT snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,\n  manifest_object_id, manifest_checksum, state, expires_at, created_at\nFROM hosted_agent_snapshots\nWHERE snapshot_id = :snapshotId! AND tenant_id = :tenantId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
 *   manifest_object_id, manifest_checksum, state, expires_at, created_at
 * FROM hosted_agent_snapshots
 * WHERE snapshot_id = :snapshotId! AND tenant_id = :tenantId! FOR UPDATE
 * ```
 */
export const lockSnapshot = new PreparedQuery<ILockSnapshotParams,ILockSnapshotResult>(lockSnapshotIR);


/** 'InsertSnapshot' parameters type */
export interface IInsertSnapshotParams {
  expiresAt?: DateOrString | null | void;
  leaseId: string;
  manifestChecksum: string;
  manifestObjectId: string;
  providerSnapshotId?: string | null | void;
  snapshotId: string;
  tenantId: string;
  workspaceArchiveObjectId: string;
}

/** 'InsertSnapshot' return type */
export type IInsertSnapshotResult = void;

/** 'InsertSnapshot' query type */
export interface IInsertSnapshotQuery {
  params: IInsertSnapshotParams;
  result: IInsertSnapshotResult;
}

const insertSnapshotIR: any = {"usedParamSet":{"snapshotId":true,"tenantId":true,"leaseId":true,"providerSnapshotId":true,"workspaceArchiveObjectId":true,"manifestObjectId":true,"manifestChecksum":true,"expiresAt":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":192,"b":203}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":206,"b":215}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":218,"b":226}]},{"name":"providerSnapshotId","required":false,"transform":{"type":"scalar"},"locs":[{"a":229,"b":247}]},{"name":"workspaceArchiveObjectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":250,"b":275}]},{"name":"manifestObjectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":280,"b":297}]},{"name":"manifestChecksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":300,"b":317}]},{"name":"expiresAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":333,"b":342}]}],"statement":"INSERT INTO hosted_agent_snapshots\n  (snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,\n   manifest_object_id, manifest_checksum, state, expires_at)\nVALUES (:snapshotId!, :tenantId!, :leaseId!, :providerSnapshotId, :workspaceArchiveObjectId!,\n  :manifestObjectId!, :manifestChecksum!, 'available', :expiresAt)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_snapshots
 *   (snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
 *    manifest_object_id, manifest_checksum, state, expires_at)
 * VALUES (:snapshotId!, :tenantId!, :leaseId!, :providerSnapshotId, :workspaceArchiveObjectId!,
 *   :manifestObjectId!, :manifestChecksum!, 'available', :expiresAt)
 * ```
 */
export const insertSnapshot = new PreparedQuery<IInsertSnapshotParams,IInsertSnapshotResult>(insertSnapshotIR);


/** 'TransitionLeaseState' parameters type */
export interface ITransitionLeaseStateParams {
  leaseId: string;
  next: string;
  tenantId: string;
}

/** 'TransitionLeaseState' return type */
export interface ITransitionLeaseStateResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'TransitionLeaseState' query type */
export interface ITransitionLeaseStateQuery {
  params: ITransitionLeaseStateParams;
  result: ITransitionLeaseStateResult;
}

const transitionLeaseStateIR: any = {"usedParamSet":{"next":true,"leaseId":true,"tenantId":true},"params":[{"name":"next","required":true,"transform":{"type":"scalar"},"locs":[{"a":39,"b":44},{"a":71,"b":76}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":133,"b":141}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":159,"b":168}]}],"statement":"UPDATE hosted_agent_leases\nSET state = :next!, released_at = CASE WHEN :next! = 'released' THEN now() ELSE NULL END\nWHERE lease_id = :leaseId! AND tenant_id = :tenantId!\nRETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_leases
 * SET state = :next!, released_at = CASE WHEN :next! = 'released' THEN now() ELSE NULL END
 * WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
 * RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * ```
 */
export const transitionLeaseState = new PreparedQuery<ITransitionLeaseStateParams,ITransitionLeaseStateResult>(transitionLeaseStateIR);


/** 'RevokeTicketsByLeaseId' parameters type */
export interface IRevokeTicketsByLeaseIdParams {
  leaseId: string;
}

/** 'RevokeTicketsByLeaseId' return type */
export type IRevokeTicketsByLeaseIdResult = void;

/** 'RevokeTicketsByLeaseId' query type */
export interface IRevokeTicketsByLeaseIdQuery {
  params: IRevokeTicketsByLeaseIdParams;
  result: IRevokeTicketsByLeaseIdResult;
}

const revokeTicketsByLeaseIdIR: any = {"usedParamSet":{"leaseId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":90,"b":98}]}],"statement":"UPDATE hosted_agent_tickets SET revoked_at = COALESCE(revoked_at, now())\nWHERE lease_id = :leaseId!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_tickets SET revoked_at = COALESCE(revoked_at, now())
 * WHERE lease_id = :leaseId!
 * ```
 */
export const revokeTicketsByLeaseId = new PreparedQuery<IRevokeTicketsByLeaseIdParams,IRevokeTicketsByLeaseIdResult>(revokeTicketsByLeaseIdIR);


/** 'BeginRelease' parameters type */
export interface IBeginReleaseParams {
  leaseId: string;
  tenantId: string;
}

/** 'BeginRelease' return type */
export interface IBeginReleaseResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'BeginRelease' query type */
export interface IBeginReleaseQuery {
  params: IBeginReleaseParams;
  result: IBeginReleaseResult;
}

const beginReleaseIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":94,"b":102}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":120,"b":129}]}],"statement":"UPDATE hosted_agent_leases SET state = 'release_pending', released_at = NULL\nWHERE lease_id = :leaseId! AND tenant_id = :tenantId!\nRETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_leases SET state = 'release_pending', released_at = NULL
 * WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
 * RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * ```
 */
export const beginRelease = new PreparedQuery<IBeginReleaseParams,IBeginReleaseResult>(beginReleaseIR);


/** 'CompleteReconnect' parameters type */
export interface ICompleteReconnectParams {
  leaseId: string;
  tenantId: string;
}

/** 'CompleteReconnect' return type */
export interface ICompleteReconnectResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'CompleteReconnect' query type */
export interface ICompleteReconnectQuery {
  params: ICompleteReconnectParams;
  result: ICompleteReconnectResult;
}

const completeReconnectIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":136,"b":144}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":162,"b":171}]}],"statement":"UPDATE hosted_agent_leases\nSET state = 'active', released_at = NULL, connection_generation = connection_generation + 1\nWHERE lease_id = :leaseId! AND tenant_id = :tenantId!\nRETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_leases
 * SET state = 'active', released_at = NULL, connection_generation = connection_generation + 1
 * WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
 * RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * ```
 */
export const completeReconnect = new PreparedQuery<ICompleteReconnectParams,ICompleteReconnectResult>(completeReconnectIR);


/** 'RotateReconnectReplayAccess' parameters type */
export interface IRotateReconnectReplayAccessParams {
  leaseId: string;
  tenantId: string;
}

/** 'RotateReconnectReplayAccess' return type */
export interface IRotateReconnectReplayAccessResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'RotateReconnectReplayAccess' query type */
export interface IRotateReconnectReplayAccessQuery {
  params: IRotateReconnectReplayAccessParams;
  result: IRotateReconnectReplayAccessResult;
}

const rotateReconnectReplayAccessIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":98,"b":106}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":124,"b":133}]}],"statement":"UPDATE hosted_agent_leases SET connection_generation = connection_generation + 1\nWHERE lease_id = :leaseId! AND tenant_id = :tenantId!\nRETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_leases SET connection_generation = connection_generation + 1
 * WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
 * RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * ```
 */
export const rotateReconnectReplayAccess = new PreparedQuery<IRotateReconnectReplayAccessParams,IRotateReconnectReplayAccessResult>(rotateReconnectReplayAccessIR);


/** 'MarkLeaseLost' parameters type */
export interface IMarkLeaseLostParams {
  leaseId: string;
  tenantId: string;
}

/** 'MarkLeaseLost' return type */
export interface IMarkLeaseLostResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'MarkLeaseLost' query type */
export interface IMarkLeaseLostQuery {
  params: IMarkLeaseLostParams;
  result: IMarkLeaseLostResult;
}

const markLeaseLostIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":134,"b":142}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":160,"b":169}]}],"statement":"UPDATE hosted_agent_leases\nSET state = 'lost', released_at = NULL, connection_generation = connection_generation + 1\nWHERE lease_id = :leaseId! AND tenant_id = :tenantId!\nRETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_leases
 * SET state = 'lost', released_at = NULL, connection_generation = connection_generation + 1
 * WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
 * RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * ```
 */
export const markLeaseLost = new PreparedQuery<IMarkLeaseLostParams,IMarkLeaseLostResult>(markLeaseLostIR);


/** 'CompleteRelease' parameters type */
export interface ICompleteReleaseParams {
  leaseId: string;
  tenantId: string;
}

/** 'CompleteRelease' return type */
export interface ICompleteReleaseResult {
  agent_id: string;
  base_snapshot_id: string | null;
  connection_generation: string | null;
  cwd_uri: string;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  policy_version: string | null;
  provider_sandbox_id: string | null;
  released_at: Date | null;
  restore_source_lease_id: string | null;
  restore_source_snapshot_id: string | null;
  sandbox_template: string;
  source_snapshot_id: string | null;
  state: string;
  tenant_id: string;
  tool_policy: Json;
  workspace_root_uris: Json;
}

/** 'CompleteRelease' query type */
export interface ICompleteReleaseQuery {
  params: ICompleteReleaseParams;
  result: ICompleteReleaseResult;
}

const completeReleaseIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":88,"b":96}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":114,"b":123}]}],"statement":"UPDATE hosted_agent_leases SET state = 'released', released_at = now()\nWHERE lease_id = :leaseId! AND tenant_id = :tenantId!\nRETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,\n  source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,\n  sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,\n  tool_policy, policy_version::text, connection_generation::text, released_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_leases SET state = 'released', released_at = now()
 * WHERE lease_id = :leaseId! AND tenant_id = :tenantId!
 * RETURNING lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
 *   source_snapshot_id, restore_source_lease_id, restore_source_snapshot_id, provider_sandbox_id,
 *   sandbox_template, cwd_uri, workspace_root_uris, base_snapshot_id, latest_snapshot_id, state,
 *   tool_policy, policy_version::text, connection_generation::text, released_at
 * ```
 */
export const completeRelease = new PreparedQuery<ICompleteReleaseParams,ICompleteReleaseResult>(completeReleaseIR);


/** 'InsertTicket' parameters type */
export interface IInsertTicketParams {
  connectionGeneration: NumberOrString;
  expiresAt: DateOrString;
  leaseId: string;
  purpose: string;
  ticketHash: Buffer;
}

/** 'InsertTicket' return type */
export type IInsertTicketResult = void;

/** 'InsertTicket' query type */
export interface IInsertTicketQuery {
  params: IInsertTicketParams;
  result: IInsertTicketResult;
}

const insertTicketIR: any = {"usedParamSet":{"ticketHash":true,"leaseId":true,"purpose":true,"expiresAt":true,"connectionGeneration":true},"params":[{"name":"ticketHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":111,"b":122}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":125,"b":133}]},{"name":"purpose","required":true,"transform":{"type":"scalar"},"locs":[{"a":136,"b":144}]},{"name":"expiresAt","required":true,"transform":{"type":"scalar"},"locs":[{"a":147,"b":157}]},{"name":"connectionGeneration","required":true,"transform":{"type":"scalar"},"locs":[{"a":160,"b":181}]}],"statement":"INSERT INTO hosted_agent_tickets\n  (ticket_hash, lease_id, purpose, expires_at, connection_generation)\nVALUES (:ticketHash!, :leaseId!, :purpose!, :expiresAt!, :connectionGeneration!)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_tickets
 *   (ticket_hash, lease_id, purpose, expires_at, connection_generation)
 * VALUES (:ticketHash!, :leaseId!, :purpose!, :expiresAt!, :connectionGeneration!)
 * ```
 */
export const insertTicket = new PreparedQuery<IInsertTicketParams,IInsertTicketResult>(insertTicketIR);


/** 'ConsumeTicket' parameters type */
export interface IConsumeTicketParams {
  at: DateOrString;
  leaseId: string;
  purpose: string;
  tenantId: string;
  ticketHash: Buffer;
}

/** 'ConsumeTicket' return type */
export interface IConsumeTicketResult {
  connection_generation: string | null;
}

/** 'ConsumeTicket' query type */
export interface IConsumeTicketQuery {
  params: IConsumeTicketParams;
  result: IConsumeTicketResult;
}

const consumeTicketIR: any = {"usedParamSet":{"at":true,"ticketHash":true,"leaseId":true,"purpose":true,"tenantId":true},"params":[{"name":"at","required":true,"transform":{"type":"scalar"},"locs":[{"a":56,"b":59},{"a":451,"b":454}]},{"name":"ticketHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":122,"b":133}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":157,"b":165}]},{"name":"purpose","required":true,"transform":{"type":"scalar"},"locs":[{"a":190,"b":198}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":261,"b":270}]}],"statement":"UPDATE hosted_agent_tickets AS ticket\nSET consumed_at = :at!\nFROM hosted_agent_leases AS lease\nWHERE ticket.ticket_hash = :ticketHash! AND ticket.lease_id = :leaseId!\n  AND ticket.purpose = :purpose! AND ticket.lease_id = lease.lease_id\n  AND lease.tenant_id = :tenantId! AND lease.state = 'active'\n  AND ticket.connection_generation = lease.connection_generation\n  AND ticket.consumed_at IS NULL AND ticket.revoked_at IS NULL AND ticket.expires_at > :at!\nRETURNING ticket.connection_generation::text"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_tickets AS ticket
 * SET consumed_at = :at!
 * FROM hosted_agent_leases AS lease
 * WHERE ticket.ticket_hash = :ticketHash! AND ticket.lease_id = :leaseId!
 *   AND ticket.purpose = :purpose! AND ticket.lease_id = lease.lease_id
 *   AND lease.tenant_id = :tenantId! AND lease.state = 'active'
 *   AND ticket.connection_generation = lease.connection_generation
 *   AND ticket.consumed_at IS NULL AND ticket.revoked_at IS NULL AND ticket.expires_at > :at!
 * RETURNING ticket.connection_generation::text
 * ```
 */
export const consumeTicket = new PreparedQuery<IConsumeTicketParams,IConsumeTicketResult>(consumeTicketIR);


/** 'RevokeLeaseTickets' parameters type */
export interface IRevokeLeaseTicketsParams {
  leaseId: string;
  tenantId: string;
}

/** 'RevokeLeaseTickets' return type */
export interface IRevokeLeaseTicketsResult {
  affected: number | null;
}

/** 'RevokeLeaseTickets' query type */
export interface IRevokeLeaseTicketsQuery {
  params: IRevokeLeaseTicketsParams;
  result: IRevokeLeaseTicketsResult;
}

const revokeLeaseTicketsIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":184,"b":192}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":218,"b":227}]}],"statement":"UPDATE hosted_agent_tickets AS ticket SET revoked_at = COALESCE(ticket.revoked_at, now())\nFROM hosted_agent_leases AS lease\nWHERE ticket.lease_id = lease.lease_id AND lease.lease_id = :leaseId!\n  AND lease.tenant_id = :tenantId! AND ticket.revoked_at IS NULL\nRETURNING 1 AS affected"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_tickets AS ticket SET revoked_at = COALESCE(ticket.revoked_at, now())
 * FROM hosted_agent_leases AS lease
 * WHERE ticket.lease_id = lease.lease_id AND lease.lease_id = :leaseId!
 *   AND lease.tenant_id = :tenantId! AND ticket.revoked_at IS NULL
 * RETURNING 1 AS affected
 * ```
 */
export const revokeLeaseTickets = new PreparedQuery<IRevokeLeaseTicketsParams,IRevokeLeaseTicketsResult>(revokeLeaseTicketsIR);


/** 'CleanupTickets' parameters type */
export interface ICleanupTicketsParams {
  before: DateOrString;
  limit: NumberOrString;
}

/** 'CleanupTickets' return type */
export interface ICleanupTicketsResult {
  affected: number | null;
}

/** 'CleanupTickets' query type */
export interface ICleanupTicketsQuery {
  params: ICleanupTicketsParams;
  result: ICleanupTicketsResult;
}

const cleanupTicketsIR: any = {"usedParamSet":{"before":true,"limit":true},"params":[{"name":"before","required":true,"transform":{"type":"scalar"},"locs":[{"a":110,"b":117},{"a":136,"b":143},{"a":161,"b":168}]},{"name":"limit","required":true,"transform":{"type":"scalar"},"locs":[{"a":178,"b":184}]}],"statement":"DELETE FROM hosted_agent_tickets WHERE ctid IN (\n  SELECT ctid FROM hosted_agent_tickets\n  WHERE expires_at < :before! OR consumed_at < :before! OR revoked_at < :before!\n  LIMIT :limit!\n)\nRETURNING 1 AS affected"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM hosted_agent_tickets WHERE ctid IN (
 *   SELECT ctid FROM hosted_agent_tickets
 *   WHERE expires_at < :before! OR consumed_at < :before! OR revoked_at < :before!
 *   LIMIT :limit!
 * )
 * RETURNING 1 AS affected
 * ```
 */
export const cleanupTickets = new PreparedQuery<ICleanupTicketsParams,ICleanupTicketsResult>(cleanupTicketsIR);
