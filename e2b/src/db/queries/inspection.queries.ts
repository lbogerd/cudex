/** Types generated for queries found in "src/db/queries/inspection.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** 'InspectPocLeases' parameters type */
export interface IInspectPocLeasesParams {
  tenantId: string;
}

/** 'InspectPocLeases' return type */
export interface IInspectPocLeasesResult {
  agent_id: string;
  base_snapshot_id: string | null;
  environment_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  provider_sandbox_id: string | null;
  state: string;
}

/** 'InspectPocLeases' query type */
export interface IInspectPocLeasesQuery {
  params: IInspectPocLeasesParams;
  result: IInspectPocLeasesResult;
}

const inspectPocLeasesIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":185,"b":194}]}],"statement":"SELECT lease_id, environment_id, agent_id, owner_agent_id, owner_lease_id,\n  provider_sandbox_id, base_snapshot_id, latest_snapshot_id, state\nFROM hosted_agent_leases WHERE tenant_id = :tenantId! ORDER BY created_at"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id, environment_id, agent_id, owner_agent_id, owner_lease_id,
 *   provider_sandbox_id, base_snapshot_id, latest_snapshot_id, state
 * FROM hosted_agent_leases WHERE tenant_id = :tenantId! ORDER BY created_at
 * ```
 */
export const inspectPocLeases = new PreparedQuery<IInspectPocLeasesParams,IInspectPocLeasesResult>(inspectPocLeasesIR);


/** 'InspectPocOperations' parameters type */
export interface IInspectPocOperationsParams {
  tenantId: string;
}

/** 'InspectPocOperations' return type */
export interface IInspectPocOperationsResult {
  operation: string;
  primary_lease_id: string | null;
  result_lease_id: string | null;
  state: string;
}

/** 'InspectPocOperations' query type */
export interface IInspectPocOperationsQuery {
  params: IInspectPocOperationsParams;
  result: IInspectPocOperationsResult;
}

const inspectPocOperationsIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":106,"b":115}]}],"statement":"SELECT operation, state, primary_lease_id, result_lease_id\nFROM hosted_agent_operations WHERE tenant_id = :tenantId! ORDER BY started_at"};

/**
 * Query generated from SQL:
 * ```
 * SELECT operation, state, primary_lease_id, result_lease_id
 * FROM hosted_agent_operations WHERE tenant_id = :tenantId! ORDER BY started_at
 * ```
 */
export const inspectPocOperations = new PreparedQuery<IInspectPocOperationsParams,IInspectPocOperationsResult>(inspectPocOperationsIR);


/** 'InspectPocSnapshots' parameters type */
export interface IInspectPocSnapshotsParams {
  tenantId: string;
}

/** 'InspectPocSnapshots' return type */
export interface IInspectPocSnapshotsResult {
  lease_id: string;
  provider_snapshot_id: string | null;
  snapshot_id: string;
  state: string;
}

/** 'InspectPocSnapshots' query type */
export interface IInspectPocSnapshotsQuery {
  params: IInspectPocSnapshotsParams;
  result: IInspectPocSnapshotsResult;
}

const inspectPocSnapshotsIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":104,"b":113}]}],"statement":"SELECT snapshot_id, lease_id, provider_snapshot_id, state\nFROM hosted_agent_snapshots WHERE tenant_id = :tenantId! ORDER BY created_at"};

/**
 * Query generated from SQL:
 * ```
 * SELECT snapshot_id, lease_id, provider_snapshot_id, state
 * FROM hosted_agent_snapshots WHERE tenant_id = :tenantId! ORDER BY created_at
 * ```
 */
export const inspectPocSnapshots = new PreparedQuery<IInspectPocSnapshotsParams,IInspectPocSnapshotsResult>(inspectPocSnapshotsIR);


/** 'InspectPocArtifacts' parameters type */
export interface IInspectPocArtifactsParams {
  tenantId: string;
}

/** 'InspectPocArtifacts' return type */
export interface IInspectPocArtifactsResult {
  agent_id: string;
  artifact_id: string;
  source_lease_id: string;
  state: string;
}

/** 'InspectPocArtifacts' query type */
export interface IInspectPocArtifactsQuery {
  params: IInspectPocArtifactsParams;
  result: IInspectPocArtifactsResult;
}

const inspectPocArtifactsIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":99,"b":108}]}],"statement":"SELECT artifact_id, agent_id, source_lease_id, state\nFROM hosted_agent_artifacts WHERE tenant_id = :tenantId! ORDER BY created_at"};

/**
 * Query generated from SQL:
 * ```
 * SELECT artifact_id, agent_id, source_lease_id, state
 * FROM hosted_agent_artifacts WHERE tenant_id = :tenantId! ORDER BY created_at
 * ```
 */
export const inspectPocArtifacts = new PreparedQuery<IInspectPocArtifactsParams,IInspectPocArtifactsResult>(inspectPocArtifactsIR);


/** 'InspectPocPatchApplications' parameters type */
export interface IInspectPocPatchApplicationsParams {
  tenantId: string;
}

/** 'InspectPocPatchApplications' return type */
export interface IInspectPocPatchApplicationsResult {
  application_id: string;
  artifact_id: string;
  phase: string;
  result_snapshot_id: string;
  source_target_snapshot_id: string;
  target_lease_id: string;
}

/** 'InspectPocPatchApplications' query type */
export interface IInspectPocPatchApplicationsQuery {
  params: IInspectPocPatchApplicationsParams;
  result: IInspectPocPatchApplicationsResult;
}

const inspectPocPatchApplicationsIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":161,"b":170}]}],"statement":"SELECT application_id, target_lease_id, artifact_id, source_target_snapshot_id, result_snapshot_id, phase\nFROM hosted_agent_patch_applications WHERE tenant_id = :tenantId! ORDER BY created_at"};

/**
 * Query generated from SQL:
 * ```
 * SELECT application_id, target_lease_id, artifact_id, source_target_snapshot_id, result_snapshot_id, phase
 * FROM hosted_agent_patch_applications WHERE tenant_id = :tenantId! ORDER BY created_at
 * ```
 */
export const inspectPocPatchApplications = new PreparedQuery<IInspectPocPatchApplicationsParams,IInspectPocPatchApplicationsResult>(inspectPocPatchApplicationsIR);


/** 'InspectPocAllocations' parameters type */
export interface IInspectPocAllocationsParams {
  tenantId: string;
}

/** 'InspectPocAllocations' return type */
export interface IInspectPocAllocationsResult {
  allocation_kind: string;
  lease_id: string | null;
  resource_id: string;
  state: string;
}

/** 'InspectPocAllocations' query type */
export interface IInspectPocAllocationsQuery {
  params: IInspectPocAllocationsParams;
  result: IInspectPocAllocationsResult;
}

const inspectPocAllocationsIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":111,"b":120}]}],"statement":"SELECT allocation_kind, resource_id, lease_id, state\nFROM hosted_agent_operation_allocations WHERE tenant_id = :tenantId! ORDER BY allocation_id"};

/**
 * Query generated from SQL:
 * ```
 * SELECT allocation_kind, resource_id, lease_id, state
 * FROM hosted_agent_operation_allocations WHERE tenant_id = :tenantId! ORDER BY allocation_id
 * ```
 */
export const inspectPocAllocations = new PreparedQuery<IInspectPocAllocationsParams,IInspectPocAllocationsResult>(inspectPocAllocationsIR);


/** 'InspectPocLiveTickets' parameters type */
export interface IInspectPocLiveTicketsParams {
  tenantId: string;
}

/** 'InspectPocLiveTickets' return type */
export interface IInspectPocLiveTicketsResult {
  count: string | null;
}

/** 'InspectPocLiveTickets' query type */
export interface IInspectPocLiveTicketsQuery {
  params: IInspectPocLiveTicketsParams;
  result: IInspectPocLiveTicketsResult;
}

const inspectPocLiveTicketsIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":161,"b":170}]}],"statement":"SELECT count(*)::text AS count FROM hosted_agent_tickets AS ticket\nJOIN hosted_agent_leases AS lease ON lease.lease_id = ticket.lease_id\nWHERE lease.tenant_id = :tenantId! AND ticket.revoked_at IS NULL AND ticket.consumed_at IS NULL\n  AND ticket.expires_at > now()"};

/**
 * Query generated from SQL:
 * ```
 * SELECT count(*)::text AS count FROM hosted_agent_tickets AS ticket
 * JOIN hosted_agent_leases AS lease ON lease.lease_id = ticket.lease_id
 * WHERE lease.tenant_id = :tenantId! AND ticket.revoked_at IS NULL AND ticket.consumed_at IS NULL
 *   AND ticket.expires_at > now()
 * ```
 */
export const inspectPocLiveTickets = new PreparedQuery<IInspectPocLiveTicketsParams,IInspectPocLiveTicketsResult>(inspectPocLiveTicketsIR);


/** 'InspectPocInteractions' parameters type */
export interface IInspectPocInteractionsParams {
  tenantId: string;
}

/** 'InspectPocInteractions' return type */
export interface IInspectPocInteractionsResult {
  connection_generation: string | null;
  lease_id: string;
  process_id: string | null;
  state: string;
}

/** 'InspectPocInteractions' query type */
export interface IInspectPocInteractionsQuery {
  params: IInspectPocInteractionsParams;
  result: IInspectPocInteractionsResult;
}

const inspectPocInteractionsIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":119,"b":128}]}],"statement":"SELECT lease_id, connection_generation::text, process_id, state\nFROM hosted_agent_lease_interactions WHERE tenant_id = :tenantId! ORDER BY created_at"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id, connection_generation::text, process_id, state
 * FROM hosted_agent_lease_interactions WHERE tenant_id = :tenantId! ORDER BY created_at
 * ```
 */
export const inspectPocInteractions = new PreparedQuery<IInspectPocInteractionsParams,IInspectPocInteractionsResult>(inspectPocInteractionsIR);


/** 'FindActivePocSandbox' parameters type */
export interface IFindActivePocSandboxParams {
  providerSandboxId: string;
  tenantId: string;
}

/** 'FindActivePocSandbox' return type */
export interface IFindActivePocSandboxResult {
  lease_id: string;
}

/** 'FindActivePocSandbox' query type */
export interface IFindActivePocSandboxQuery {
  params: IFindActivePocSandboxParams;
  result: IFindActivePocSandboxResult;
}

const findActivePocSandboxIR: any = {"usedParamSet":{"tenantId":true,"providerSandboxId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":59,"b":68}]},{"name":"providerSandboxId","required":true,"transform":{"type":"scalar"},"locs":[{"a":96,"b":114}]}],"statement":"SELECT lease_id FROM hosted_agent_leases\nWHERE tenant_id = :tenantId! AND provider_sandbox_id = :providerSandboxId! AND state = 'active' LIMIT 2"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id FROM hosted_agent_leases
 * WHERE tenant_id = :tenantId! AND provider_sandbox_id = :providerSandboxId! AND state = 'active' LIMIT 2
 * ```
 */
export const findActivePocSandbox = new PreparedQuery<IFindActivePocSandboxParams,IFindActivePocSandboxResult>(findActivePocSandboxIR);


/** 'InspectPocUnsettled' parameters type */
export interface IInspectPocUnsettledParams {
  tenantId: string;
}

/** 'InspectPocUnsettled' return type */
export interface IInspectPocUnsettledResult {
  leases: number | null;
  operations: number | null;
}

/** 'InspectPocUnsettled' query type */
export interface IInspectPocUnsettledQuery {
  params: IInspectPocUnsettledParams;
  result: IInspectPocUnsettledResult;
}

const inspectPocUnsettledIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":82,"b":91},{"a":208,"b":217}]}],"statement":"SELECT\n  (SELECT count(*)::integer FROM hosted_agent_leases\n    WHERE tenant_id = :tenantId! AND state <> 'released') AS leases,\n  (SELECT count(*)::integer FROM hosted_agent_operations\n    WHERE tenant_id = :tenantId! AND state = 'in_progress') AS operations"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *   (SELECT count(*)::integer FROM hosted_agent_leases
 *     WHERE tenant_id = :tenantId! AND state <> 'released') AS leases,
 *   (SELECT count(*)::integer FROM hosted_agent_operations
 *     WHERE tenant_id = :tenantId! AND state = 'in_progress') AS operations
 * ```
 */
export const inspectPocUnsettled = new PreparedQuery<IInspectPocUnsettledParams,IInspectPocUnsettledResult>(inspectPocUnsettledIR);


/** 'ListPocProviderSnapshots' parameters type */
export interface IListPocProviderSnapshotsParams {
  tenantId: string;
}

/** 'ListPocProviderSnapshots' return type */
export interface IListPocProviderSnapshotsResult {
  provider_snapshot_id: string | null;
}

/** 'ListPocProviderSnapshots' query type */
export interface IListPocProviderSnapshotsQuery {
  params: IListPocProviderSnapshotsParams;
  result: IListPocProviderSnapshotsResult;
}

const listPocProviderSnapshotsIR: any = {"usedParamSet":{"tenantId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":83,"b":92}]}],"statement":"SELECT DISTINCT provider_snapshot_id FROM hosted_agent_snapshots\nWHERE tenant_id = :tenantId! AND provider_snapshot_id IS NOT NULL\nORDER BY provider_snapshot_id LIMIT 1001"};

/**
 * Query generated from SQL:
 * ```
 * SELECT DISTINCT provider_snapshot_id FROM hosted_agent_snapshots
 * WHERE tenant_id = :tenantId! AND provider_snapshot_id IS NOT NULL
 * ORDER BY provider_snapshot_id LIMIT 1001
 * ```
 */
export const listPocProviderSnapshots = new PreparedQuery<IListPocProviderSnapshotsParams,IListPocProviderSnapshotsResult>(listPocProviderSnapshotsIR);


/** 'ProbeDatabase' parameters type */
export type IProbeDatabaseParams = void;

/** 'ProbeDatabase' return type */
export interface IProbeDatabaseResult {
  available: number | null;
}

/** 'ProbeDatabase' query type */
export interface IProbeDatabaseQuery {
  params: IProbeDatabaseParams;
  result: IProbeDatabaseResult;
}

const probeDatabaseIR: any = {"usedParamSet":{},"params":[],"statement":"SELECT 1 AS available"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS available
 * ```
 */
export const probeDatabase = new PreparedQuery<IProbeDatabaseParams,IProbeDatabaseResult>(probeDatabaseIR);
