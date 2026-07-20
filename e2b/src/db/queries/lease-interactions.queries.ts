/** Types generated for queries found in "src/db/queries/lease-interactions.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type NumberOrString = number | string;

/** 'InsertLeaseInteraction' parameters type */
export interface IInsertLeaseInteractionParams {
  connectionGeneration: NumberOrString;
  interactionId: string;
  interactionKind: string;
  leaseId: string;
  processId?: string | null | void;
  sessionId: string;
  tenantId: string;
}

/** 'InsertLeaseInteraction' return type */
export interface IInsertLeaseInteractionResult {
  connection_generation: string | null;
  created_at: Date;
  detached_at: Date | null;
  finished_at: Date | null;
  interaction_id: string;
  interaction_kind: string;
  lease_id: string;
  process_id: string | null;
  session_id: string;
  state: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'InsertLeaseInteraction' query type */
export interface IInsertLeaseInteractionQuery {
  params: IInsertLeaseInteractionParams;
  result: IInsertLeaseInteractionResult;
}

const insertLeaseInteractionIR: any = {"usedParamSet":{"interactionId":true,"tenantId":true,"leaseId":true,"connectionGeneration":true,"sessionId":true,"interactionKind":true,"processId":true},"params":[{"name":"interactionId","required":true,"transform":{"type":"scalar"},"locs":[{"a":167,"b":181}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":184,"b":193}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":196,"b":204}]},{"name":"connectionGeneration","required":true,"transform":{"type":"scalar"},"locs":[{"a":207,"b":228}]},{"name":"sessionId","required":true,"transform":{"type":"scalar"},"locs":[{"a":233,"b":243}]},{"name":"interactionKind","required":true,"transform":{"type":"scalar"},"locs":[{"a":246,"b":262}]},{"name":"processId","required":false,"transform":{"type":"scalar"},"locs":[{"a":265,"b":274}]}],"statement":"INSERT INTO hosted_agent_lease_interactions\n  (interaction_id, tenant_id, lease_id, connection_generation,\n   session_id, interaction_kind, process_id, state)\nVALUES (:interactionId!, :tenantId!, :leaseId!, :connectionGeneration!,\n  :sessionId!, :interactionKind!, :processId, 'active')\nON CONFLICT (interaction_id) DO NOTHING\nRETURNING interaction_id, tenant_id, lease_id, connection_generation::text,\n  session_id, interaction_kind, process_id, state, created_at, updated_at,\n  detached_at, finished_at"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_lease_interactions
 *   (interaction_id, tenant_id, lease_id, connection_generation,
 *    session_id, interaction_kind, process_id, state)
 * VALUES (:interactionId!, :tenantId!, :leaseId!, :connectionGeneration!,
 *   :sessionId!, :interactionKind!, :processId, 'active')
 * ON CONFLICT (interaction_id) DO NOTHING
 * RETURNING interaction_id, tenant_id, lease_id, connection_generation::text,
 *   session_id, interaction_kind, process_id, state, created_at, updated_at,
 *   detached_at, finished_at
 * ```
 */
export const insertLeaseInteraction = new PreparedQuery<IInsertLeaseInteractionParams,IInsertLeaseInteractionResult>(insertLeaseInteractionIR);


/** 'HasUnfinishedLeaseInteraction' parameters type */
export interface IHasUnfinishedLeaseInteractionParams {
  codeModeProcessId: string;
  leaseId: string;
  tenantId: string;
}

/** 'HasUnfinishedLeaseInteraction' return type */
export interface IHasUnfinishedLeaseInteractionResult {
  present: number | null;
}

/** 'HasUnfinishedLeaseInteraction' query type */
export interface IHasUnfinishedLeaseInteractionQuery {
  params: IHasUnfinishedLeaseInteractionParams;
  result: IHasUnfinishedLeaseInteractionResult;
}

const hasUnfinishedLeaseInteractionIR: any = {"usedParamSet":{"tenantId":true,"leaseId":true,"codeModeProcessId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":75,"b":84}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":101,"b":109}]},{"name":"codeModeProcessId","required":true,"transform":{"type":"scalar"},"locs":[{"a":192,"b":210}]}],"statement":"SELECT 1 AS present FROM hosted_agent_lease_interactions\nWHERE tenant_id = :tenantId! AND lease_id = :leaseId! AND state <> 'finished'\n  AND NOT (interaction_kind = 'process' AND process_id = :codeModeProcessId!)\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present FROM hosted_agent_lease_interactions
 * WHERE tenant_id = :tenantId! AND lease_id = :leaseId! AND state <> 'finished'
 *   AND NOT (interaction_kind = 'process' AND process_id = :codeModeProcessId!)
 * LIMIT 1
 * ```
 */
export const hasUnfinishedLeaseInteraction = new PreparedQuery<IHasUnfinishedLeaseInteractionParams,IHasUnfinishedLeaseInteractionResult>(hasUnfinishedLeaseInteractionIR);


/** 'ListUnfinishedLeaseInteractions' parameters type */
export interface IListUnfinishedLeaseInteractionsParams {
  interactionKind: string;
  leaseId: string;
  sessionId: string;
  tenantId: string;
}

/** 'ListUnfinishedLeaseInteractions' return type */
export interface IListUnfinishedLeaseInteractionsResult {
  connection_generation: string | null;
  created_at: Date;
  detached_at: Date | null;
  finished_at: Date | null;
  interaction_id: string;
  interaction_kind: string;
  lease_id: string;
  process_id: string | null;
  session_id: string;
  state: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'ListUnfinishedLeaseInteractions' query type */
export interface IListUnfinishedLeaseInteractionsQuery {
  params: IListUnfinishedLeaseInteractionsParams;
  result: IListUnfinishedLeaseInteractionsResult;
}

const listUnfinishedLeaseInteractionsIR: any = {"usedParamSet":{"tenantId":true,"leaseId":true,"sessionId":true,"interactionKind":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":230,"b":239}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":256,"b":264}]},{"name":"sessionId","required":true,"transform":{"type":"scalar"},"locs":[{"a":285,"b":295}]},{"name":"interactionKind","required":true,"transform":{"type":"scalar"},"locs":[{"a":320,"b":336}]}],"statement":"SELECT interaction_id, tenant_id, lease_id, connection_generation::text,\n  session_id, interaction_kind, process_id, state, created_at, updated_at,\n  detached_at, finished_at\nFROM hosted_agent_lease_interactions\nWHERE tenant_id = :tenantId! AND lease_id = :leaseId!\n  AND session_id = :sessionId! AND interaction_kind = :interactionKind! AND state <> 'finished'\nORDER BY interaction_id\nFOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT interaction_id, tenant_id, lease_id, connection_generation::text,
 *   session_id, interaction_kind, process_id, state, created_at, updated_at,
 *   detached_at, finished_at
 * FROM hosted_agent_lease_interactions
 * WHERE tenant_id = :tenantId! AND lease_id = :leaseId!
 *   AND session_id = :sessionId! AND interaction_kind = :interactionKind! AND state <> 'finished'
 * ORDER BY interaction_id
 * FOR UPDATE
 * ```
 */
export const listUnfinishedLeaseInteractions = new PreparedQuery<IListUnfinishedLeaseInteractionsParams,IListUnfinishedLeaseInteractionsResult>(listUnfinishedLeaseInteractionsIR);


/** 'UpdateLeaseInteraction' parameters type */
export interface IUpdateLeaseInteractionParams {
  interactionId: string;
  state: string;
}

/** 'UpdateLeaseInteraction' return type */
export interface IUpdateLeaseInteractionResult {
  connection_generation: string | null;
  created_at: Date;
  detached_at: Date | null;
  finished_at: Date | null;
  interaction_id: string;
  interaction_kind: string;
  lease_id: string;
  process_id: string | null;
  session_id: string;
  state: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'UpdateLeaseInteraction' query type */
export interface IUpdateLeaseInteractionQuery {
  params: IUpdateLeaseInteractionParams;
  result: IUpdateLeaseInteractionResult;
}

const updateLeaseInteractionIR: any = {"usedParamSet":{"state":true,"interactionId":true},"params":[{"name":"state","required":true,"transform":{"type":"scalar"},"locs":[{"a":51,"b":57},{"a":88,"b":94},{"a":131,"b":137},{"a":210,"b":216}]},{"name":"interactionId","required":true,"transform":{"type":"scalar"},"locs":[{"a":279,"b":293}]}],"statement":"UPDATE hosted_agent_lease_interactions\nSET state = :state!,\n    detached_at = CASE WHEN :state! = 'detached' THEN now()\n      WHEN :state! = 'active' THEN NULL ELSE detached_at END,\n    finished_at = CASE WHEN :state! = 'finished' THEN now() ELSE NULL END\nWHERE interaction_id = :interactionId!\nRETURNING interaction_id, tenant_id, lease_id, connection_generation::text,\n  session_id, interaction_kind, process_id, state, created_at, updated_at,\n  detached_at, finished_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_lease_interactions
 * SET state = :state!,
 *     detached_at = CASE WHEN :state! = 'detached' THEN now()
 *       WHEN :state! = 'active' THEN NULL ELSE detached_at END,
 *     finished_at = CASE WHEN :state! = 'finished' THEN now() ELSE NULL END
 * WHERE interaction_id = :interactionId!
 * RETURNING interaction_id, tenant_id, lease_id, connection_generation::text,
 *   session_id, interaction_kind, process_id, state, created_at, updated_at,
 *   detached_at, finished_at
 * ```
 */
export const updateLeaseInteraction = new PreparedQuery<IUpdateLeaseInteractionParams,IUpdateLeaseInteractionResult>(updateLeaseInteractionIR);


/** 'SelectLeaseInteractionForUpdate' parameters type */
export interface ISelectLeaseInteractionForUpdateParams {
  interactionId: string;
}

/** 'SelectLeaseInteractionForUpdate' return type */
export interface ISelectLeaseInteractionForUpdateResult {
  connection_generation: string | null;
  created_at: Date;
  detached_at: Date | null;
  finished_at: Date | null;
  interaction_id: string;
  interaction_kind: string;
  lease_id: string;
  process_id: string | null;
  session_id: string;
  state: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'SelectLeaseInteractionForUpdate' query type */
export interface ISelectLeaseInteractionForUpdateQuery {
  params: ISelectLeaseInteractionForUpdateParams;
  result: ISelectLeaseInteractionForUpdateResult;
}

const selectLeaseInteractionForUpdateIR: any = {"usedParamSet":{"interactionId":true},"params":[{"name":"interactionId","required":true,"transform":{"type":"scalar"},"locs":[{"a":235,"b":249}]}],"statement":"SELECT interaction_id, tenant_id, lease_id, connection_generation::text,\n  session_id, interaction_kind, process_id, state, created_at, updated_at,\n  detached_at, finished_at\nFROM hosted_agent_lease_interactions\nWHERE interaction_id = :interactionId!\nFOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT interaction_id, tenant_id, lease_id, connection_generation::text,
 *   session_id, interaction_kind, process_id, state, created_at, updated_at,
 *   detached_at, finished_at
 * FROM hosted_agent_lease_interactions
 * WHERE interaction_id = :interactionId!
 * FOR UPDATE
 * ```
 */
export const selectLeaseInteractionForUpdate = new PreparedQuery<ISelectLeaseInteractionForUpdateParams,ISelectLeaseInteractionForUpdateResult>(selectLeaseInteractionForUpdateIR);
