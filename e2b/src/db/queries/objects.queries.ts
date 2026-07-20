/** Types generated for queries found in "src/db/queries/objects.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NumberOrString = number | string;

export type stringArray = (string)[];

/** 'InsertPatchArtifact' parameters type */
export interface IInsertPatchArtifactParams {
  agentId: string;
  artifactId: string;
  artifactObjectId: string;
  baseManifestObjectId: string;
  baseSnapshotId: string;
  changedFiles: number;
  checksum: string;
  currentManifestObjectId: string;
  currentSnapshotId: string;
  expiresAt: DateOrString;
  sizeBytes: NumberOrString;
  sourceLeaseId: string;
  state: string;
  tenantId: string;
}

/** 'InsertPatchArtifact' return type */
export type IInsertPatchArtifactResult = void;

/** 'InsertPatchArtifact' query type */
export interface IInsertPatchArtifactQuery {
  params: IInsertPatchArtifactParams;
  result: IInsertPatchArtifactResult;
}

const insertPatchArtifactIR: any = {"usedParamSet":{"artifactId":true,"tenantId":true,"agentId":true,"sourceLeaseId":true,"baseSnapshotId":true,"currentSnapshotId":true,"baseManifestObjectId":true,"currentManifestObjectId":true,"artifactObjectId":true,"checksum":true,"changedFiles":true,"sizeBytes":true,"state":true,"expiresAt":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":271,"b":282}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":285,"b":294}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":297,"b":305}]},{"name":"sourceLeaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":308,"b":322}]},{"name":"baseSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":325,"b":340}]},{"name":"currentSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":343,"b":361}]},{"name":"baseManifestObjectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":366,"b":387}]},{"name":"currentManifestObjectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":390,"b":414}]},{"name":"artifactObjectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":417,"b":434}]},{"name":"checksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":437,"b":446}]},{"name":"changedFiles","required":true,"transform":{"type":"scalar"},"locs":[{"a":451,"b":464}]},{"name":"sizeBytes","required":true,"transform":{"type":"scalar"},"locs":[{"a":467,"b":477}]},{"name":"state","required":true,"transform":{"type":"scalar"},"locs":[{"a":480,"b":486}]},{"name":"expiresAt","required":true,"transform":{"type":"scalar"},"locs":[{"a":489,"b":499}]}],"statement":"INSERT INTO hosted_agent_artifacts\n  (artifact_id, tenant_id, agent_id, source_lease_id, base_snapshot_id, current_snapshot_id,\n   base_manifest_object_id, current_manifest_object_id, artifact_object_id, checksum,\n   changed_files, size_bytes, state, expires_at)\nVALUES (:artifactId!, :tenantId!, :agentId!, :sourceLeaseId!, :baseSnapshotId!, :currentSnapshotId!,\n  :baseManifestObjectId!, :currentManifestObjectId!, :artifactObjectId!, :checksum!,\n  :changedFiles!, :sizeBytes!, :state!, :expiresAt!)\nON CONFLICT (artifact_id) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_artifacts
 *   (artifact_id, tenant_id, agent_id, source_lease_id, base_snapshot_id, current_snapshot_id,
 *    base_manifest_object_id, current_manifest_object_id, artifact_object_id, checksum,
 *    changed_files, size_bytes, state, expires_at)
 * VALUES (:artifactId!, :tenantId!, :agentId!, :sourceLeaseId!, :baseSnapshotId!, :currentSnapshotId!,
 *   :baseManifestObjectId!, :currentManifestObjectId!, :artifactObjectId!, :checksum!,
 *   :changedFiles!, :sizeBytes!, :state!, :expiresAt!)
 * ON CONFLICT (artifact_id) DO NOTHING
 * ```
 */
export const insertPatchArtifact = new PreparedQuery<IInsertPatchArtifactParams,IInsertPatchArtifactResult>(insertPatchArtifactIR);


/** 'GetAuthorizedPatchArtifact' parameters type */
export interface IGetAuthorizedPatchArtifactParams {
  agentId: string;
  artifactId: string;
  at: DateOrString;
  tenantId: string;
}

/** 'GetAuthorizedPatchArtifact' return type */
export interface IGetAuthorizedPatchArtifactResult {
  agent_id: string;
  artifact_id: string;
  artifact_object_id: string;
  base_manifest_object_id: string;
  base_snapshot_id: string;
  changed_files: number;
  checksum: string;
  created_at: Date;
  current_manifest_object_id: string;
  current_snapshot_id: string;
  expires_at: Date;
  owner_agent_id: string | null;
  size_bytes: string | null;
  source_lease_id: string;
  state: string;
  tenant_id: string;
}

/** 'GetAuthorizedPatchArtifact' query type */
export interface IGetAuthorizedPatchArtifactQuery {
  params: IGetAuthorizedPatchArtifactParams;
  result: IGetAuthorizedPatchArtifactResult;
}

const getAuthorizedPatchArtifactIR: any = {"usedParamSet":{"artifactId":true,"tenantId":true,"agentId":true,"at":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":440,"b":451}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":471,"b":480}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":499,"b":507},{"a":760,"b":768}]},{"name":"at","required":true,"transform":{"type":"scalar"},"locs":[{"a":557,"b":560}]}],"statement":"SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,\n  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,\n  a.current_manifest_object_id, a.artifact_object_id, a.checksum,\n  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at\nFROM hosted_agent_artifacts a\nJOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id\nWHERE a.artifact_id = :artifactId! AND a.tenant_id = :tenantId! AND a.agent_id = :agentId!\n  AND a.state = 'available' AND (a.expires_at > :at! OR EXISTS (\n    SELECT 1 FROM hosted_agent_artifact_references retained\n    WHERE retained.artifact_id = a.artifact_id\n      AND retained.reference_kind = 'codex_thread' AND retained.reference_id = :agentId!))"};

/**
 * Query generated from SQL:
 * ```
 * SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
 *   a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
 *   a.current_manifest_object_id, a.artifact_object_id, a.checksum,
 *   a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
 * FROM hosted_agent_artifacts a
 * JOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
 * WHERE a.artifact_id = :artifactId! AND a.tenant_id = :tenantId! AND a.agent_id = :agentId!
 *   AND a.state = 'available' AND (a.expires_at > :at! OR EXISTS (
 *     SELECT 1 FROM hosted_agent_artifact_references retained
 *     WHERE retained.artifact_id = a.artifact_id
 *       AND retained.reference_kind = 'codex_thread' AND retained.reference_id = :agentId!))
 * ```
 */
export const getAuthorizedPatchArtifact = new PreparedQuery<IGetAuthorizedPatchArtifactParams,IGetAuthorizedPatchArtifactResult>(getAuthorizedPatchArtifactIR);


/** 'GetOwnerAuthorizedPatchArtifact' parameters type */
export interface IGetOwnerAuthorizedPatchArtifactParams {
  artifactId: string;
  at: DateOrString;
  ownerAgentId: string;
  tenantId: string;
}

/** 'GetOwnerAuthorizedPatchArtifact' return type */
export interface IGetOwnerAuthorizedPatchArtifactResult {
  agent_id: string;
  artifact_id: string;
  artifact_object_id: string;
  base_manifest_object_id: string;
  base_snapshot_id: string;
  changed_files: number;
  checksum: string;
  created_at: Date;
  current_manifest_object_id: string;
  current_snapshot_id: string;
  expires_at: Date;
  owner_agent_id: string | null;
  size_bytes: string | null;
  source_lease_id: string;
  state: string;
  tenant_id: string;
}

/** 'GetOwnerAuthorizedPatchArtifact' query type */
export interface IGetOwnerAuthorizedPatchArtifactQuery {
  params: IGetOwnerAuthorizedPatchArtifactParams;
  result: IGetOwnerAuthorizedPatchArtifactResult;
}

const getOwnerAuthorizedPatchArtifactIR: any = {"usedParamSet":{"artifactId":true,"tenantId":true,"ownerAgentId":true,"at":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":440,"b":451}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":471,"b":480}]},{"name":"ownerAgentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":505,"b":518}]},{"name":"at","required":true,"transform":{"type":"scalar"},"locs":[{"a":568,"b":571}]}],"statement":"SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,\n  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,\n  a.current_manifest_object_id, a.artifact_object_id, a.checksum,\n  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at\nFROM hosted_agent_artifacts a\nJOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id\nWHERE a.artifact_id = :artifactId! AND a.tenant_id = :tenantId! AND l.owner_agent_id = :ownerAgentId!\n  AND a.state = 'available' AND (a.expires_at > :at! OR EXISTS (\n    SELECT 1 FROM hosted_agent_artifact_references retained\n    WHERE retained.artifact_id = a.artifact_id AND retained.reference_kind = 'codex_thread'))"};

/**
 * Query generated from SQL:
 * ```
 * SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
 *   a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
 *   a.current_manifest_object_id, a.artifact_object_id, a.checksum,
 *   a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
 * FROM hosted_agent_artifacts a
 * JOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
 * WHERE a.artifact_id = :artifactId! AND a.tenant_id = :tenantId! AND l.owner_agent_id = :ownerAgentId!
 *   AND a.state = 'available' AND (a.expires_at > :at! OR EXISTS (
 *     SELECT 1 FROM hosted_agent_artifact_references retained
 *     WHERE retained.artifact_id = a.artifact_id AND retained.reference_kind = 'codex_thread'))
 * ```
 */
export const getOwnerAuthorizedPatchArtifact = new PreparedQuery<IGetOwnerAuthorizedPatchArtifactParams,IGetOwnerAuthorizedPatchArtifactResult>(getOwnerAuthorizedPatchArtifactIR);


/** 'FindPatchArtifactForReconciliation' parameters type */
export interface IFindPatchArtifactForReconciliationParams {
  artifactId: string;
  tenantId: string;
}

/** 'FindPatchArtifactForReconciliation' return type */
export interface IFindPatchArtifactForReconciliationResult {
  agent_id: string;
  artifact_id: string;
  artifact_object_id: string;
  base_manifest_object_id: string;
  base_snapshot_id: string;
  changed_files: number;
  checksum: string;
  created_at: Date;
  current_manifest_object_id: string;
  current_snapshot_id: string;
  expires_at: Date;
  owner_agent_id: string | null;
  size_bytes: string | null;
  source_lease_id: string;
  state: string;
  tenant_id: string;
}

/** 'FindPatchArtifactForReconciliation' query type */
export interface IFindPatchArtifactForReconciliationQuery {
  params: IFindPatchArtifactForReconciliationParams;
  result: IFindPatchArtifactForReconciliationResult;
}

const findPatchArtifactForReconciliationIR: any = {"usedParamSet":{"artifactId":true,"tenantId":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":536,"b":547}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":567,"b":576}]}],"statement":"SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,\n  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,\n  a.current_manifest_object_id, a.artifact_object_id, a.checksum,\n  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at\nFROM hosted_agent_artifacts a\nJOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id\nJOIN hosted_agent_objects o ON o.object_id = a.artifact_object_id AND o.tenant_id = a.tenant_id\nWHERE a.artifact_id = :artifactId! AND a.tenant_id = :tenantId! AND a.state = 'available'\n  AND o.kind = 'patch_artifact' AND o.state = 'available' AND o.checksum = a.checksum\nFOR SHARE OF a, o"};

/**
 * Query generated from SQL:
 * ```
 * SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
 *   a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
 *   a.current_manifest_object_id, a.artifact_object_id, a.checksum,
 *   a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
 * FROM hosted_agent_artifacts a
 * JOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
 * JOIN hosted_agent_objects o ON o.object_id = a.artifact_object_id AND o.tenant_id = a.tenant_id
 * WHERE a.artifact_id = :artifactId! AND a.tenant_id = :tenantId! AND a.state = 'available'
 *   AND o.kind = 'patch_artifact' AND o.state = 'available' AND o.checksum = a.checksum
 * FOR SHARE OF a, o
 * ```
 */
export const findPatchArtifactForReconciliation = new PreparedQuery<IFindPatchArtifactForReconciliationParams,IFindPatchArtifactForReconciliationResult>(findPatchArtifactForReconciliationIR);


/** 'AddPatchArtifactReference' parameters type */
export interface IAddPatchArtifactReferenceParams {
  artifactId: string;
  referenceId: string;
  referenceKind: string;
  retainUntil?: DateOrString | null | void;
  tenantId: string;
}

/** 'AddPatchArtifactReference' return type */
export type IAddPatchArtifactReferenceResult = void;

/** 'AddPatchArtifactReference' query type */
export interface IAddPatchArtifactReferenceQuery {
  params: IAddPatchArtifactReferenceParams;
  result: IAddPatchArtifactReferenceResult;
}

const addPatchArtifactReferenceIR: any = {"usedParamSet":{"referenceKind":true,"referenceId":true,"retainUntil":true,"artifactId":true,"tenantId":true},"params":[{"name":"referenceKind","required":true,"transform":{"type":"scalar"},"locs":[{"a":123,"b":137}]},{"name":"referenceId","required":true,"transform":{"type":"scalar"},"locs":[{"a":140,"b":152}]},{"name":"retainUntil","required":false,"transform":{"type":"scalar"},"locs":[{"a":155,"b":166}]},{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":216,"b":227}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":245,"b":254}]}],"statement":"INSERT INTO hosted_agent_artifact_references (artifact_id, reference_kind, reference_id, retain_until)\nSELECT artifact_id, :referenceKind!, :referenceId!, :retainUntil FROM hosted_agent_artifacts\nWHERE artifact_id = :artifactId! AND tenant_id = :tenantId! AND state = 'available' AND expires_at > now()\nON CONFLICT (artifact_id, reference_kind, reference_id) DO UPDATE SET retain_until = CASE\n  WHEN hosted_agent_artifact_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL\n  ELSE GREATEST(hosted_agent_artifact_references.retain_until, EXCLUDED.retain_until) END"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_artifact_references (artifact_id, reference_kind, reference_id, retain_until)
 * SELECT artifact_id, :referenceKind!, :referenceId!, :retainUntil FROM hosted_agent_artifacts
 * WHERE artifact_id = :artifactId! AND tenant_id = :tenantId! AND state = 'available' AND expires_at > now()
 * ON CONFLICT (artifact_id, reference_kind, reference_id) DO UPDATE SET retain_until = CASE
 *   WHEN hosted_agent_artifact_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
 *   ELSE GREATEST(hosted_agent_artifact_references.retain_until, EXCLUDED.retain_until) END
 * ```
 */
export const addPatchArtifactReference = new PreparedQuery<IAddPatchArtifactReferenceParams,IAddPatchArtifactReferenceResult>(addPatchArtifactReferenceIR);


/** 'LockCodexReferenceSet' parameters type */
export interface ILockCodexReferenceSetParams {
  agentId: string;
  tenantId: string;
}

/** 'LockCodexReferenceSet' return type */
export interface ILockCodexReferenceSetResult {
  cleared_at: Date | null;
  desired_hash: string;
  lease_id: string;
  revision: string | null;
}

/** 'LockCodexReferenceSet' query type */
export interface ILockCodexReferenceSetQuery {
  params: ILockCodexReferenceSetParams;
  result: ILockCodexReferenceSetResult;
}

const lockCodexReferenceSetIR: any = {"usedParamSet":{"tenantId":true,"agentId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":115,"b":124}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":141,"b":149}]}],"statement":"SELECT lease_id, revision::text, desired_hash, cleared_at FROM hosted_agent_codex_reference_sets\nWHERE tenant_id = :tenantId! AND agent_id = :agentId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id, revision::text, desired_hash, cleared_at FROM hosted_agent_codex_reference_sets
 * WHERE tenant_id = :tenantId! AND agent_id = :agentId! FOR UPDATE
 * ```
 */
export const lockCodexReferenceSet = new PreparedQuery<ILockCodexReferenceSetParams,ILockCodexReferenceSetResult>(lockCodexReferenceSetIR);


/** 'InsertCodexReferenceSet' parameters type */
export interface IInsertCodexReferenceSetParams {
  agentId: string;
  artifactId?: string | null | void;
  baseSnapshotId: string;
  desiredHash: string;
  latestSnapshotId: string;
  leaseId: string;
  revision: NumberOrString;
  tenantId: string;
}

/** 'InsertCodexReferenceSet' return type */
export type IInsertCodexReferenceSetResult = void;

/** 'InsertCodexReferenceSet' query type */
export interface IInsertCodexReferenceSetQuery {
  params: IInsertCodexReferenceSetParams;
  result: IInsertCodexReferenceSetResult;
}

const insertCodexReferenceSetIR: any = {"usedParamSet":{"tenantId":true,"agentId":true,"leaseId":true,"baseSnapshotId":true,"latestSnapshotId":true,"artifactId":true,"revision":true,"desiredHash":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":154,"b":163}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":165,"b":173}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":175,"b":183}]},{"name":"baseSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":185,"b":200}]},{"name":"latestSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":202,"b":219}]},{"name":"artifactId","required":false,"transform":{"type":"scalar"},"locs":[{"a":221,"b":231}]},{"name":"revision","required":true,"transform":{"type":"scalar"},"locs":[{"a":233,"b":242}]},{"name":"desiredHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":244,"b":256}]}],"statement":"INSERT INTO hosted_agent_codex_reference_sets\n(tenant_id,agent_id,lease_id,base_snapshot_id,latest_snapshot_id,artifact_id,revision,desired_hash)\nVALUES (:tenantId!,:agentId!,:leaseId!,:baseSnapshotId!,:latestSnapshotId!,:artifactId,:revision!,:desiredHash!)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_codex_reference_sets
 * (tenant_id,agent_id,lease_id,base_snapshot_id,latest_snapshot_id,artifact_id,revision,desired_hash)
 * VALUES (:tenantId!,:agentId!,:leaseId!,:baseSnapshotId!,:latestSnapshotId!,:artifactId,:revision!,:desiredHash!)
 * ```
 */
export const insertCodexReferenceSet = new PreparedQuery<IInsertCodexReferenceSetParams,IInsertCodexReferenceSetResult>(insertCodexReferenceSetIR);


/** 'UpdateCodexReferenceSet' parameters type */
export interface IUpdateCodexReferenceSetParams {
  agentId: string;
  artifactId?: string | null | void;
  baseSnapshotId: string;
  desiredHash: string;
  latestSnapshotId: string;
  leaseId: string;
  revision: NumberOrString;
  tenantId: string;
}

/** 'UpdateCodexReferenceSet' return type */
export type IUpdateCodexReferenceSetResult = void;

/** 'UpdateCodexReferenceSet' query type */
export interface IUpdateCodexReferenceSetQuery {
  params: IUpdateCodexReferenceSetParams;
  result: IUpdateCodexReferenceSetResult;
}

const updateCodexReferenceSetIR: any = {"usedParamSet":{"leaseId":true,"baseSnapshotId":true,"latestSnapshotId":true,"artifactId":true,"revision":true,"desiredHash":true,"tenantId":true,"agentId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":54,"b":62}]},{"name":"baseSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":81,"b":96}]},{"name":"latestSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":118,"b":135}]},{"name":"artifactId","required":false,"transform":{"type":"scalar"},"locs":[{"a":149,"b":159}]},{"name":"revision","required":true,"transform":{"type":"scalar"},"locs":[{"a":170,"b":179}]},{"name":"desiredHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":194,"b":206}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":224,"b":233}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":248,"b":256}]}],"statement":"UPDATE hosted_agent_codex_reference_sets SET lease_id=:leaseId!,base_snapshot_id=:baseSnapshotId!,\nlatest_snapshot_id=:latestSnapshotId!,artifact_id=:artifactId,revision=:revision!,desired_hash=:desiredHash!\nWHERE tenant_id=:tenantId! AND agent_id=:agentId!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_codex_reference_sets SET lease_id=:leaseId!,base_snapshot_id=:baseSnapshotId!,
 * latest_snapshot_id=:latestSnapshotId!,artifact_id=:artifactId,revision=:revision!,desired_hash=:desiredHash!
 * WHERE tenant_id=:tenantId! AND agent_id=:agentId!
 * ```
 */
export const updateCodexReferenceSet = new PreparedQuery<IUpdateCodexReferenceSetParams,IUpdateCodexReferenceSetResult>(updateCodexReferenceSetIR);


/** 'AddCodexSnapshotReferences' parameters type */
export interface IAddCodexSnapshotReferencesParams {
  agentId: string;
  snapshotIds: stringArray;
  tenantId: string;
}

/** 'AddCodexSnapshotReferences' return type */
export type IAddCodexSnapshotReferencesResult = void;

/** 'AddCodexSnapshotReferences' query type */
export interface IAddCodexSnapshotReferencesQuery {
  params: IAddCodexSnapshotReferencesParams;
  result: IAddCodexSnapshotReferencesResult;
}

const addCodexSnapshotReferencesIR: any = {"usedParamSet":{"agentId":true,"tenantId":true,"snapshotIds":true},"params":[{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":120,"b":128}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":174,"b":183}]},{"name":"snapshotIds","required":true,"transform":{"type":"scalar"},"locs":[{"a":205,"b":217}]}],"statement":"INSERT INTO hosted_agent_snapshot_references(snapshot_id,reference_kind,reference_id)\nSELECT snapshot_id,'codex_thread',:agentId! FROM hosted_agent_snapshots\nWHERE tenant_id=:tenantId! AND snapshot_id=ANY(:snapshotIds!::text[])\nON CONFLICT(snapshot_id,reference_kind,reference_id) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_snapshot_references(snapshot_id,reference_kind,reference_id)
 * SELECT snapshot_id,'codex_thread',:agentId! FROM hosted_agent_snapshots
 * WHERE tenant_id=:tenantId! AND snapshot_id=ANY(:snapshotIds!::text[])
 * ON CONFLICT(snapshot_id,reference_kind,reference_id) DO NOTHING
 * ```
 */
export const addCodexSnapshotReferences = new PreparedQuery<IAddCodexSnapshotReferencesParams,IAddCodexSnapshotReferencesResult>(addCodexSnapshotReferencesIR);


/** 'DeleteOtherCodexSnapshotReferences' parameters type */
export interface IDeleteOtherCodexSnapshotReferencesParams {
  agentId: string;
  snapshotIds: stringArray;
  tenantId: string;
}

/** 'DeleteOtherCodexSnapshotReferences' return type */
export type IDeleteOtherCodexSnapshotReferencesResult = void;

/** 'DeleteOtherCodexSnapshotReferences' query type */
export interface IDeleteOtherCodexSnapshotReferencesQuery {
  params: IDeleteOtherCodexSnapshotReferencesParams;
  result: IDeleteOtherCodexSnapshotReferencesResult;
}

const deleteOtherCodexSnapshotReferencesIR: any = {"usedParamSet":{"tenantId":true,"agentId":true,"snapshotIds":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":128,"b":137}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":194,"b":202}]},{"name":"snapshotIds","required":true,"transform":{"type":"scalar"},"locs":[{"a":227,"b":239}]}],"statement":"DELETE FROM hosted_agent_snapshot_references r USING hosted_agent_snapshots s\nWHERE r.snapshot_id=s.snapshot_id AND s.tenant_id=:tenantId! AND r.reference_kind='codex_thread'\nAND r.reference_id=:agentId! AND r.snapshot_id<>ALL(:snapshotIds!::text[])"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM hosted_agent_snapshot_references r USING hosted_agent_snapshots s
 * WHERE r.snapshot_id=s.snapshot_id AND s.tenant_id=:tenantId! AND r.reference_kind='codex_thread'
 * AND r.reference_id=:agentId! AND r.snapshot_id<>ALL(:snapshotIds!::text[])
 * ```
 */
export const deleteOtherCodexSnapshotReferences = new PreparedQuery<IDeleteOtherCodexSnapshotReferencesParams,IDeleteOtherCodexSnapshotReferencesResult>(deleteOtherCodexSnapshotReferencesIR);


/** 'DeleteCodexArtifactReferences' parameters type */
export interface IDeleteCodexArtifactReferencesParams {
  agentId: string;
  tenantId: string;
}

/** 'DeleteCodexArtifactReferences' return type */
export type IDeleteCodexArtifactReferencesResult = void;

/** 'DeleteCodexArtifactReferences' query type */
export interface IDeleteCodexArtifactReferencesQuery {
  params: IDeleteCodexArtifactReferencesParams;
  result: IDeleteCodexArtifactReferencesResult;
}

const deleteCodexArtifactReferencesIR: any = {"usedParamSet":{"tenantId":true,"agentId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":128,"b":137}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":194,"b":202}]}],"statement":"DELETE FROM hosted_agent_artifact_references r USING hosted_agent_artifacts a\nWHERE r.artifact_id=a.artifact_id AND a.tenant_id=:tenantId! AND r.reference_kind='codex_thread'\nAND r.reference_id=:agentId!"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM hosted_agent_artifact_references r USING hosted_agent_artifacts a
 * WHERE r.artifact_id=a.artifact_id AND a.tenant_id=:tenantId! AND r.reference_kind='codex_thread'
 * AND r.reference_id=:agentId!
 * ```
 */
export const deleteCodexArtifactReferences = new PreparedQuery<IDeleteCodexArtifactReferencesParams,IDeleteCodexArtifactReferencesResult>(deleteCodexArtifactReferencesIR);


/** 'AddCodexArtifactReference' parameters type */
export interface IAddCodexArtifactReferenceParams {
  agentId: string;
  artifactId: string;
}

/** 'AddCodexArtifactReference' return type */
export type IAddCodexArtifactReferenceResult = void;

/** 'AddCodexArtifactReference' query type */
export interface IAddCodexArtifactReferenceQuery {
  params: IAddCodexArtifactReferenceParams;
  result: IAddCodexArtifactReferenceResult;
}

const addCodexArtifactReferenceIR: any = {"usedParamSet":{"artifactId":true,"agentId":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":93,"b":104}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":121,"b":129}]}],"statement":"INSERT INTO hosted_agent_artifact_references(artifact_id,reference_kind,reference_id)\nVALUES(:artifactId!,'codex_thread',:agentId!) ON CONFLICT(artifact_id,reference_kind,reference_id) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_artifact_references(artifact_id,reference_kind,reference_id)
 * VALUES(:artifactId!,'codex_thread',:agentId!) ON CONFLICT(artifact_id,reference_kind,reference_id) DO NOTHING
 * ```
 */
export const addCodexArtifactReference = new PreparedQuery<IAddCodexArtifactReferenceParams,IAddCodexArtifactReferenceResult>(addCodexArtifactReferenceIR);


/** 'DeleteOtherCodexArtifactReferences' parameters type */
export interface IDeleteOtherCodexArtifactReferencesParams {
  agentId: string;
  artifactId: string;
  tenantId: string;
}

/** 'DeleteOtherCodexArtifactReferences' return type */
export type IDeleteOtherCodexArtifactReferencesResult = void;

/** 'DeleteOtherCodexArtifactReferences' query type */
export interface IDeleteOtherCodexArtifactReferencesQuery {
  params: IDeleteOtherCodexArtifactReferencesParams;
  result: IDeleteOtherCodexArtifactReferencesResult;
}

const deleteOtherCodexArtifactReferencesIR: any = {"usedParamSet":{"tenantId":true,"agentId":true,"artifactId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":128,"b":137}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":194,"b":202}]},{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":223,"b":234}]}],"statement":"DELETE FROM hosted_agent_artifact_references r USING hosted_agent_artifacts a\nWHERE r.artifact_id=a.artifact_id AND a.tenant_id=:tenantId! AND r.reference_kind='codex_thread'\nAND r.reference_id=:agentId! AND r.artifact_id<>:artifactId!"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM hosted_agent_artifact_references r USING hosted_agent_artifacts a
 * WHERE r.artifact_id=a.artifact_id AND a.tenant_id=:tenantId! AND r.reference_kind='codex_thread'
 * AND r.reference_id=:agentId! AND r.artifact_id<>:artifactId!
 * ```
 */
export const deleteOtherCodexArtifactReferences = new PreparedQuery<IDeleteOtherCodexArtifactReferencesParams,IDeleteOtherCodexArtifactReferencesResult>(deleteOtherCodexArtifactReferencesIR);


/** 'DeleteCodexObjectReferences' parameters type */
export interface IDeleteCodexObjectReferencesParams {
  agentId: string;
  tenantId: string;
}

/** 'DeleteCodexObjectReferences' return type */
export type IDeleteCodexObjectReferencesResult = void;

/** 'DeleteCodexObjectReferences' query type */
export interface IDeleteCodexObjectReferencesQuery {
  params: IDeleteCodexObjectReferencesParams;
  result: IDeleteCodexObjectReferencesResult;
}

const deleteCodexObjectReferencesIR: any = {"usedParamSet":{"tenantId":true,"agentId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":120,"b":129}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":186,"b":194}]}],"statement":"DELETE FROM hosted_agent_object_references r USING hosted_agent_objects o\nWHERE r.object_id=o.object_id AND o.tenant_id=:tenantId! AND r.reference_kind='codex_thread'\nAND r.reference_id=:agentId!"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM hosted_agent_object_references r USING hosted_agent_objects o
 * WHERE r.object_id=o.object_id AND o.tenant_id=:tenantId! AND r.reference_kind='codex_thread'
 * AND r.reference_id=:agentId!
 * ```
 */
export const deleteCodexObjectReferences = new PreparedQuery<IDeleteCodexObjectReferencesParams,IDeleteCodexObjectReferencesResult>(deleteCodexObjectReferencesIR);


/** 'CopyCodexSnapshotObjectReferences' parameters type */
export interface ICopyCodexSnapshotObjectReferencesParams {
  agentId: string;
  baseSnapshotId: string;
  snapshotIds: stringArray;
  tenantId: string;
}

/** 'CopyCodexSnapshotObjectReferences' return type */
export type ICopyCodexSnapshotObjectReferencesResult = void;

/** 'CopyCodexSnapshotObjectReferences' query type */
export interface ICopyCodexSnapshotObjectReferencesQuery {
  params: ICopyCodexSnapshotObjectReferencesParams;
  result: ICopyCodexSnapshotObjectReferencesResult;
}

const copyCodexSnapshotObjectReferencesIR: any = {"usedParamSet":{"agentId":true,"baseSnapshotId":true,"snapshotIds":true,"tenantId":true},"params":[{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":124,"b":132}]},{"name":"baseSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":164,"b":179}]},{"name":"snapshotIds","required":true,"transform":{"type":"scalar"},"locs":[{"a":390,"b":402}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":429,"b":438}]}],"statement":"INSERT INTO hosted_agent_object_references(object_id,reference_kind,reference_id,purpose)\nSELECT r.object_id,'codex_thread',:agentId!,left(CASE WHEN r.reference_id=:baseSnapshotId!\nTHEN 'base_'||r.purpose ELSE 'latest_'||r.purpose END,128)\nFROM hosted_agent_object_references r JOIN hosted_agent_objects o ON o.object_id=r.object_id\nWHERE r.reference_kind='snapshot' AND r.reference_id=ANY(:snapshotIds!::text[])\nAND o.tenant_id=:tenantId! AND o.state='available'\nON CONFLICT(object_id,reference_kind,reference_id,purpose) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_object_references(object_id,reference_kind,reference_id,purpose)
 * SELECT r.object_id,'codex_thread',:agentId!,left(CASE WHEN r.reference_id=:baseSnapshotId!
 * THEN 'base_'||r.purpose ELSE 'latest_'||r.purpose END,128)
 * FROM hosted_agent_object_references r JOIN hosted_agent_objects o ON o.object_id=r.object_id
 * WHERE r.reference_kind='snapshot' AND r.reference_id=ANY(:snapshotIds!::text[])
 * AND o.tenant_id=:tenantId! AND o.state='available'
 * ON CONFLICT(object_id,reference_kind,reference_id,purpose) DO NOTHING
 * ```
 */
export const copyCodexSnapshotObjectReferences = new PreparedQuery<ICopyCodexSnapshotObjectReferencesParams,ICopyCodexSnapshotObjectReferencesResult>(copyCodexSnapshotObjectReferencesIR);


/** 'CopyCodexArtifactObjectReferences' parameters type */
export interface ICopyCodexArtifactObjectReferencesParams {
  agentId: string;
  artifactId: string;
  tenantId: string;
}

/** 'CopyCodexArtifactObjectReferences' return type */
export type ICopyCodexArtifactObjectReferencesResult = void;

/** 'CopyCodexArtifactObjectReferences' query type */
export interface ICopyCodexArtifactObjectReferencesQuery {
  params: ICopyCodexArtifactObjectReferencesParams;
  result: ICopyCodexArtifactObjectReferencesResult;
}

const copyCodexArtifactObjectReferencesIR: any = {"usedParamSet":{"agentId":true,"artifactId":true,"tenantId":true},"params":[{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":124,"b":132}]},{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":313,"b":324}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":342,"b":351}]}],"statement":"INSERT INTO hosted_agent_object_references(object_id,reference_kind,reference_id,purpose)\nSELECT r.object_id,'codex_thread',:agentId!,left('artifact_'||r.purpose,128)\nFROM hosted_agent_object_references r JOIN hosted_agent_objects o ON o.object_id=r.object_id\nWHERE r.reference_kind='artifact' AND r.reference_id=:artifactId! AND o.tenant_id=:tenantId! AND o.state='available'\nON CONFLICT(object_id,reference_kind,reference_id,purpose) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_object_references(object_id,reference_kind,reference_id,purpose)
 * SELECT r.object_id,'codex_thread',:agentId!,left('artifact_'||r.purpose,128)
 * FROM hosted_agent_object_references r JOIN hosted_agent_objects o ON o.object_id=r.object_id
 * WHERE r.reference_kind='artifact' AND r.reference_id=:artifactId! AND o.tenant_id=:tenantId! AND o.state='available'
 * ON CONFLICT(object_id,reference_kind,reference_id,purpose) DO NOTHING
 * ```
 */
export const copyCodexArtifactObjectReferences = new PreparedQuery<ICopyCodexArtifactObjectReferencesParams,ICopyCodexArtifactObjectReferencesResult>(copyCodexArtifactObjectReferencesIR);


/** 'ClearCodexReferenceSet' parameters type */
export interface IClearCodexReferenceSetParams {
  agentId: string;
  desiredHash: string;
  revision: NumberOrString;
  tenantId: string;
}

/** 'ClearCodexReferenceSet' return type */
export type IClearCodexReferenceSetResult = void;

/** 'ClearCodexReferenceSet' query type */
export interface IClearCodexReferenceSetQuery {
  params: IClearCodexReferenceSetParams;
  result: IClearCodexReferenceSetResult;
}

const clearCodexReferenceSetIR: any = {"usedParamSet":{"revision":true,"desiredHash":true,"tenantId":true,"agentId":true},"params":[{"name":"revision","required":true,"transform":{"type":"scalar"},"locs":[{"a":54,"b":63}]},{"name":"desiredHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":78,"b":90}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":125,"b":134}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":149,"b":157}]}],"statement":"UPDATE hosted_agent_codex_reference_sets SET revision=:revision!,desired_hash=:desiredHash!,cleared_at=now()\nWHERE tenant_id=:tenantId! AND agent_id=:agentId!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_codex_reference_sets SET revision=:revision!,desired_hash=:desiredHash!,cleared_at=now()
 * WHERE tenant_id=:tenantId! AND agent_id=:agentId!
 * ```
 */
export const clearCodexReferenceSet = new PreparedQuery<IClearCodexReferenceSetParams,IClearCodexReferenceSetResult>(clearCodexReferenceSetIR);


/** 'RemoveReleasedLeaseRoots' parameters type */
export interface IRemoveReleasedLeaseRootsParams {
  leaseId: string;
}

/** 'RemoveReleasedLeaseRoots' return type */
export type IRemoveReleasedLeaseRootsResult = void;

/** 'RemoveReleasedLeaseRoots' query type */
export interface IRemoveReleasedLeaseRootsQuery {
  params: IRemoveReleasedLeaseRootsParams;
  result: IRemoveReleasedLeaseRootsResult;
}

const removeReleasedLeaseRootsIR: any = {"usedParamSet":{"leaseId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":64,"b":72}]}],"statement":"DELETE FROM hosted_agent_snapshot_references WHERE reference_id=:leaseId!\nAND reference_kind IN ('lease_base','lease_latest','lease_restore_source')"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM hosted_agent_snapshot_references WHERE reference_id=:leaseId!
 * AND reference_kind IN ('lease_base','lease_latest','lease_restore_source')
 * ```
 */
export const removeReleasedLeaseRoots = new PreparedQuery<IRemoveReleasedLeaseRootsParams,IRemoveReleasedLeaseRootsResult>(removeReleasedLeaseRootsIR);


/** 'AuthorizeCodexLease' parameters type */
export interface IAuthorizeCodexLeaseParams {
  agentId: string;
  leaseId: string;
  tenantId: string;
}

/** 'AuthorizeCodexLease' return type */
export interface IAuthorizeCodexLeaseResult {
  present: number | null;
}

/** 'AuthorizeCodexLease' query type */
export interface IAuthorizeCodexLeaseQuery {
  params: IAuthorizeCodexLeaseParams;
  result: IAuthorizeCodexLeaseResult;
}

const authorizeCodexLeaseIR: any = {"usedParamSet":{"tenantId":true,"leaseId":true,"agentId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":61,"b":70}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":85,"b":93}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":108,"b":116}]}],"statement":"SELECT 1 AS present FROM hosted_agent_leases WHERE tenant_id=:tenantId! AND lease_id=:leaseId!\nAND agent_id=:agentId! FOR SHARE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present FROM hosted_agent_leases WHERE tenant_id=:tenantId! AND lease_id=:leaseId!
 * AND agent_id=:agentId! FOR SHARE
 * ```
 */
export const authorizeCodexLease = new PreparedQuery<IAuthorizeCodexLeaseParams,IAuthorizeCodexLeaseResult>(authorizeCodexLeaseIR);


/** 'AuthorizeCodexSnapshot' parameters type */
export interface IAuthorizeCodexSnapshotParams {
  agentId: string;
  snapshotId: string;
  tenantId: string;
}

/** 'AuthorizeCodexSnapshot' return type */
export interface IAuthorizeCodexSnapshotResult {
  present: number | null;
}

/** 'AuthorizeCodexSnapshot' query type */
export interface IAuthorizeCodexSnapshotQuery {
  params: IAuthorizeCodexSnapshotParams;
  result: IAuthorizeCodexSnapshotResult;
}

const authorizeCodexSnapshotIR: any = {"usedParamSet":{"tenantId":true,"snapshotId":true,"agentId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":120,"b":129}]},{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":149,"b":160}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":201,"b":209}]}],"statement":"SELECT 1 AS present FROM hosted_agent_snapshots s JOIN hosted_agent_leases l ON l.lease_id=s.lease_id\nWHERE s.tenant_id=:tenantId! AND s.snapshot_id=:snapshotId! AND s.state='available' AND l.agent_id=:agentId! FOR SHARE OF s"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present FROM hosted_agent_snapshots s JOIN hosted_agent_leases l ON l.lease_id=s.lease_id
 * WHERE s.tenant_id=:tenantId! AND s.snapshot_id=:snapshotId! AND s.state='available' AND l.agent_id=:agentId! FOR SHARE OF s
 * ```
 */
export const authorizeCodexSnapshot = new PreparedQuery<IAuthorizeCodexSnapshotParams,IAuthorizeCodexSnapshotResult>(authorizeCodexSnapshotIR);


/** 'AuthorizeCodexArtifact' parameters type */
export interface IAuthorizeCodexArtifactParams {
  agentId: string;
  artifactId: string;
  tenantId: string;
}

/** 'AuthorizeCodexArtifact' return type */
export interface IAuthorizeCodexArtifactResult {
  present: number | null;
}

/** 'AuthorizeCodexArtifact' query type */
export interface IAuthorizeCodexArtifactQuery {
  params: IAuthorizeCodexArtifactParams;
  result: IAuthorizeCodexArtifactResult;
}

const authorizeCodexArtifactIR: any = {"usedParamSet":{"tenantId":true,"artifactId":true,"agentId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":155,"b":164}]},{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":184,"b":195}]},{"name":"agentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":237,"b":245},{"a":267,"b":275}]}],"statement":"SELECT 1 AS present FROM hosted_agent_artifacts a JOIN hosted_agent_leases l\nON l.lease_id=a.source_lease_id AND l.tenant_id=a.tenant_id\nWHERE a.tenant_id=:tenantId! AND a.artifact_id=:artifactId! AND a.state='available'\nAND (a.agent_id=:agentId! OR l.owner_agent_id=:agentId!) FOR SHARE OF a"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present FROM hosted_agent_artifacts a JOIN hosted_agent_leases l
 * ON l.lease_id=a.source_lease_id AND l.tenant_id=a.tenant_id
 * WHERE a.tenant_id=:tenantId! AND a.artifact_id=:artifactId! AND a.state='available'
 * AND (a.agent_id=:agentId! OR l.owner_agent_id=:agentId!) FOR SHARE OF a
 * ```
 */
export const authorizeCodexArtifact = new PreparedQuery<IAuthorizeCodexArtifactParams,IAuthorizeCodexArtifactResult>(authorizeCodexArtifactIR);


/** 'AssertCodexReferencesSynchronized' parameters type */
export interface IAssertCodexReferencesSynchronizedParams {
  leaseId: string;
  tenantId: string;
}

/** 'AssertCodexReferencesSynchronized' return type */
export interface IAssertCodexReferencesSynchronizedResult {
  present: number | null;
}

/** 'AssertCodexReferencesSynchronized' query type */
export interface IAssertCodexReferencesSynchronizedQuery {
  params: IAssertCodexReferencesSynchronizedParams;
  result: IAssertCodexReferencesSynchronizedResult;
}

const assertCodexReferencesSynchronizedIR: any = {"usedParamSet":{"tenantId":true,"leaseId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":185,"b":194}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":211,"b":219}]}],"statement":"SELECT 1 AS present FROM hosted_agent_leases l JOIN hosted_agent_codex_reference_sets r\nON r.tenant_id=l.tenant_id AND r.lease_id=l.lease_id AND r.agent_id=l.agent_id\nWHERE l.tenant_id=:tenantId! AND l.lease_id=:leaseId! AND r.cleared_at IS NULL\nAND r.latest_snapshot_id=l.latest_snapshot_id\nAND EXISTS(SELECT 1 FROM hosted_agent_snapshot_references WHERE snapshot_id=r.base_snapshot_id AND reference_kind='codex_thread' AND reference_id=r.agent_id)\nAND EXISTS(SELECT 1 FROM hosted_agent_snapshot_references WHERE snapshot_id=r.latest_snapshot_id AND reference_kind='codex_thread' AND reference_id=r.agent_id)\nAND (r.artifact_id IS NULL OR EXISTS(SELECT 1 FROM hosted_agent_artifact_references WHERE artifact_id=r.artifact_id AND reference_kind='codex_thread' AND reference_id=r.agent_id))\nAND (r.artifact_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM hosted_agent_artifacts WHERE tenant_id=l.tenant_id AND source_lease_id=l.lease_id AND current_snapshot_id=r.latest_snapshot_id AND state='available'))\nAND NOT EXISTS(SELECT 1 FROM hosted_agent_object_references source WHERE source.reference_kind='snapshot'\nAND source.reference_id IN(r.base_snapshot_id,r.latest_snapshot_id) AND NOT EXISTS(SELECT 1 FROM hosted_agent_object_references rooted\nWHERE rooted.object_id=source.object_id AND rooted.reference_kind='codex_thread' AND rooted.reference_id=r.agent_id))\nAND (r.artifact_id IS NULL OR NOT EXISTS(SELECT 1 FROM hosted_agent_object_references source\nWHERE source.reference_kind='artifact' AND source.reference_id=r.artifact_id AND NOT EXISTS(SELECT 1 FROM hosted_agent_object_references rooted\nWHERE rooted.object_id=source.object_id AND rooted.reference_kind='codex_thread' AND rooted.reference_id=r.agent_id)))\nFOR SHARE OF r"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present FROM hosted_agent_leases l JOIN hosted_agent_codex_reference_sets r
 * ON r.tenant_id=l.tenant_id AND r.lease_id=l.lease_id AND r.agent_id=l.agent_id
 * WHERE l.tenant_id=:tenantId! AND l.lease_id=:leaseId! AND r.cleared_at IS NULL
 * AND r.latest_snapshot_id=l.latest_snapshot_id
 * AND EXISTS(SELECT 1 FROM hosted_agent_snapshot_references WHERE snapshot_id=r.base_snapshot_id AND reference_kind='codex_thread' AND reference_id=r.agent_id)
 * AND EXISTS(SELECT 1 FROM hosted_agent_snapshot_references WHERE snapshot_id=r.latest_snapshot_id AND reference_kind='codex_thread' AND reference_id=r.agent_id)
 * AND (r.artifact_id IS NULL OR EXISTS(SELECT 1 FROM hosted_agent_artifact_references WHERE artifact_id=r.artifact_id AND reference_kind='codex_thread' AND reference_id=r.agent_id))
 * AND (r.artifact_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM hosted_agent_artifacts WHERE tenant_id=l.tenant_id AND source_lease_id=l.lease_id AND current_snapshot_id=r.latest_snapshot_id AND state='available'))
 * AND NOT EXISTS(SELECT 1 FROM hosted_agent_object_references source WHERE source.reference_kind='snapshot'
 * AND source.reference_id IN(r.base_snapshot_id,r.latest_snapshot_id) AND NOT EXISTS(SELECT 1 FROM hosted_agent_object_references rooted
 * WHERE rooted.object_id=source.object_id AND rooted.reference_kind='codex_thread' AND rooted.reference_id=r.agent_id))
 * AND (r.artifact_id IS NULL OR NOT EXISTS(SELECT 1 FROM hosted_agent_object_references source
 * WHERE source.reference_kind='artifact' AND source.reference_id=r.artifact_id AND NOT EXISTS(SELECT 1 FROM hosted_agent_object_references rooted
 * WHERE rooted.object_id=source.object_id AND rooted.reference_kind='codex_thread' AND rooted.reference_id=r.agent_id)))
 * FOR SHARE OF r
 * ```
 */
export const assertCodexReferencesSynchronized = new PreparedQuery<IAssertCodexReferencesSynchronizedParams,IAssertCodexReferencesSynchronizedResult>(assertCodexReferencesSynchronizedIR);


/** 'ReclaimerLockObjectWithKind' parameters type */
export interface IReclaimerLockObjectWithKindParams {
  objectId: string;
  tenantId: string;
}

/** 'ReclaimerLockObjectWithKind' return type */
export interface IReclaimerLockObjectWithKindResult {
  checksum: string;
  kind: string;
  object_id: string;
  state: string;
  storage_bucket: string;
  storage_key: string;
  tenant_id: string;
}

/** 'ReclaimerLockObjectWithKind' query type */
export interface IReclaimerLockObjectWithKindQuery {
  params: IReclaimerLockObjectWithKindParams;
  result: IReclaimerLockObjectWithKindResult;
}

const reclaimerLockObjectWithKindIR: any = {"usedParamSet":{"objectId":true,"tenantId":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":116,"b":125}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":141,"b":150}]}],"statement":"SELECT object_id,tenant_id,kind,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects\nWHERE object_id=:objectId! AND tenant_id=:tenantId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT object_id,tenant_id,kind,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects
 * WHERE object_id=:objectId! AND tenant_id=:tenantId! FOR UPDATE
 * ```
 */
export const reclaimerLockObjectWithKind = new PreparedQuery<IReclaimerLockObjectWithKindParams,IReclaimerLockObjectWithKindResult>(reclaimerLockObjectWithKindIR);


/** 'ReclaimerLockObject' parameters type */
export interface IReclaimerLockObjectParams {
  objectId: string;
  tenantId: string;
}

/** 'ReclaimerLockObject' return type */
export interface IReclaimerLockObjectResult {
  checksum: string;
  object_id: string;
  state: string;
  storage_bucket: string;
  storage_key: string;
  tenant_id: string;
}

/** 'ReclaimerLockObject' query type */
export interface IReclaimerLockObjectQuery {
  params: IReclaimerLockObjectParams;
  result: IReclaimerLockObjectResult;
}

const reclaimerLockObjectIR: any = {"usedParamSet":{"objectId":true,"tenantId":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":111,"b":120}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":136,"b":145}]}],"statement":"SELECT object_id,tenant_id,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects\nWHERE object_id=:objectId! AND tenant_id=:tenantId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT object_id,tenant_id,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects
 * WHERE object_id=:objectId! AND tenant_id=:tenantId! FOR UPDATE
 * ```
 */
export const reclaimerLockObject = new PreparedQuery<IReclaimerLockObjectParams,IReclaimerLockObjectResult>(reclaimerLockObjectIR);


/** 'ReclaimerGetObject' parameters type */
export interface IReclaimerGetObjectParams {
  objectId: string;
  tenantId: string;
}

/** 'ReclaimerGetObject' return type */
export interface IReclaimerGetObjectResult {
  checksum: string;
  object_id: string;
  state: string;
  storage_bucket: string;
  storage_key: string;
  tenant_id: string;
}

/** 'ReclaimerGetObject' query type */
export interface IReclaimerGetObjectQuery {
  params: IReclaimerGetObjectParams;
  result: IReclaimerGetObjectResult;
}

const reclaimerGetObjectIR: any = {"usedParamSet":{"objectId":true,"tenantId":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":111,"b":120}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":136,"b":145}]}],"statement":"SELECT object_id,tenant_id,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects\nWHERE object_id=:objectId! AND tenant_id=:tenantId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT object_id,tenant_id,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects
 * WHERE object_id=:objectId! AND tenant_id=:tenantId!
 * ```
 */
export const reclaimerGetObject = new PreparedQuery<IReclaimerGetObjectParams,IReclaimerGetObjectResult>(reclaimerGetObjectIR);


/** 'ReclaimerHasSharedLocator' parameters type */
export interface IReclaimerHasSharedLocatorParams {
  objectId: string;
  storageBucket: string;
  storageKey: string;
}

/** 'ReclaimerHasSharedLocator' return type */
export interface IReclaimerHasSharedLocatorResult {
  present: number | null;
}

/** 'ReclaimerHasSharedLocator' query type */
export interface IReclaimerHasSharedLocatorQuery {
  params: IReclaimerHasSharedLocatorParams;
  result: IReclaimerHasSharedLocatorResult;
}

const reclaimerHasSharedLocatorIR: any = {"usedParamSet":{"objectId":true,"storageBucket":true,"storageKey":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":63,"b":72}]},{"name":"storageBucket","required":true,"transform":{"type":"scalar"},"locs":[{"a":93,"b":107}]},{"name":"storageKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":125,"b":136}]}],"statement":"SELECT 1 AS present FROM hosted_agent_objects WHERE object_id<>:objectId! AND storage_bucket=:storageBucket!\nAND storage_key=:storageKey! AND state<>'deleted' LIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present FROM hosted_agent_objects WHERE object_id<>:objectId! AND storage_bucket=:storageBucket!
 * AND storage_key=:storageKey! AND state<>'deleted' LIMIT 1
 * ```
 */
export const reclaimerHasSharedLocator = new PreparedQuery<IReclaimerHasSharedLocatorParams,IReclaimerHasSharedLocatorResult>(reclaimerHasSharedLocatorIR);


/** 'ReclaimerMarkObjectDeleted' parameters type */
export interface IReclaimerMarkObjectDeletedParams {
  objectId: string;
}

/** 'ReclaimerMarkObjectDeleted' return type */
export type IReclaimerMarkObjectDeletedResult = void;

/** 'ReclaimerMarkObjectDeleted' query type */
export interface IReclaimerMarkObjectDeletedQuery {
  params: IReclaimerMarkObjectDeletedParams;
  result: IReclaimerMarkObjectDeletedResult;
}

const reclaimerMarkObjectDeletedIR: any = {"usedParamSet":{"objectId":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":64,"b":73}]}],"statement":"UPDATE hosted_agent_objects SET state='deleted' WHERE object_id=:objectId!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_objects SET state='deleted' WHERE object_id=:objectId!
 * ```
 */
export const reclaimerMarkObjectDeleted = new PreparedQuery<IReclaimerMarkObjectDeletedParams,IReclaimerMarkObjectDeletedResult>(reclaimerMarkObjectDeletedIR);


/** 'ReclaimerMarkObjectDeleting' parameters type */
export interface IReclaimerMarkObjectDeletingParams {
  objectId: string;
}

/** 'ReclaimerMarkObjectDeleting' return type */
export type IReclaimerMarkObjectDeletingResult = void;

/** 'ReclaimerMarkObjectDeleting' query type */
export interface IReclaimerMarkObjectDeletingQuery {
  params: IReclaimerMarkObjectDeletingParams;
  result: IReclaimerMarkObjectDeletingResult;
}

const reclaimerMarkObjectDeletingIR: any = {"usedParamSet":{"objectId":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":65,"b":74}]}],"statement":"UPDATE hosted_agent_objects SET state='deleting' WHERE object_id=:objectId!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_objects SET state='deleting' WHERE object_id=:objectId!
 * ```
 */
export const reclaimerMarkObjectDeleting = new PreparedQuery<IReclaimerMarkObjectDeletingParams,IReclaimerMarkObjectDeletingResult>(reclaimerMarkObjectDeletingIR);


/** 'ReclaimerListDeletingObjects' parameters type */
export interface IReclaimerListDeletingObjectsParams {
  limit: NumberOrString;
  tenantId: string;
}

/** 'ReclaimerListDeletingObjects' return type */
export interface IReclaimerListDeletingObjectsResult {
  checksum: string;
  object_id: string;
  state: string;
  storage_bucket: string;
  storage_key: string;
  tenant_id: string;
}

/** 'ReclaimerListDeletingObjects' query type */
export interface IReclaimerListDeletingObjectsQuery {
  params: IReclaimerListDeletingObjectsParams;
  result: IReclaimerListDeletingObjectsResult;
}

const reclaimerListDeletingObjectsIR: any = {"usedParamSet":{"tenantId":true,"limit":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":111,"b":120}]},{"name":"limit","required":true,"transform":{"type":"scalar"},"locs":[{"a":168,"b":174}]}],"statement":"SELECT object_id,tenant_id,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects\nWHERE tenant_id=:tenantId! AND state='deleting' ORDER BY object_id LIMIT :limit!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT object_id,tenant_id,storage_bucket,storage_key,checksum,state FROM hosted_agent_objects
 * WHERE tenant_id=:tenantId! AND state='deleting' ORDER BY object_id LIMIT :limit!
 * ```
 */
export const reclaimerListDeletingObjects = new PreparedQuery<IReclaimerListDeletingObjectsParams,IReclaimerListDeletingObjectsResult>(reclaimerListDeletingObjectsIR);


/** 'ReclaimerClaimOperationObjects' parameters type */
export interface IReclaimerClaimOperationObjectsParams {
  generation: NumberOrString;
  idempotencyKey: string;
  limit: NumberOrString;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'ReclaimerClaimOperationObjects' return type */
export interface IReclaimerClaimOperationObjectsResult {
  allocation_id: string | null;
  resource_id: string;
}

/** 'ReclaimerClaimOperationObjects' query type */
export interface IReclaimerClaimOperationObjectsQuery {
  params: IReclaimerClaimOperationObjectsParams;
  result: IReclaimerClaimOperationObjectsResult;
}

const reclaimerClaimOperationObjectsIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true,"limit":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":263,"b":273}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":297,"b":312}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":330,"b":339}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":436,"b":447}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":466,"b":475}]},{"name":"limit","required":true,"transform":{"type":"scalar"},"locs":[{"a":563,"b":569}]}],"statement":"WITH candidates AS (SELECT a.allocation_id FROM hosted_agent_operation_allocations a\nJOIN hosted_agent_operations op USING(operation,idempotency_key,tenant_id)\nJOIN hosted_agent_objects o ON o.object_id=a.resource_id AND o.tenant_id=a.tenant_id\nWHERE a.operation=:operation! AND a.idempotency_key=:idempotencyKey! AND a.tenant_id=:tenantId!\nAND a.allocation_kind='object' AND a.state IN('allocated','reclaim_pending')\nAND op.generation=:generation! AND op.worker_id=:workerId! AND op.state='in_progress'\nORDER BY a.allocation_id FOR UPDATE OF a SKIP LOCKED LIMIT :limit!)\nUPDATE hosted_agent_operation_allocations a SET state='reclaim_pending' FROM candidates\nWHERE a.allocation_id=candidates.allocation_id RETURNING a.allocation_id::text,a.resource_id"};

/**
 * Query generated from SQL:
 * ```
 * WITH candidates AS (SELECT a.allocation_id FROM hosted_agent_operation_allocations a
 * JOIN hosted_agent_operations op USING(operation,idempotency_key,tenant_id)
 * JOIN hosted_agent_objects o ON o.object_id=a.resource_id AND o.tenant_id=a.tenant_id
 * WHERE a.operation=:operation! AND a.idempotency_key=:idempotencyKey! AND a.tenant_id=:tenantId!
 * AND a.allocation_kind='object' AND a.state IN('allocated','reclaim_pending')
 * AND op.generation=:generation! AND op.worker_id=:workerId! AND op.state='in_progress'
 * ORDER BY a.allocation_id FOR UPDATE OF a SKIP LOCKED LIMIT :limit!)
 * UPDATE hosted_agent_operation_allocations a SET state='reclaim_pending' FROM candidates
 * WHERE a.allocation_id=candidates.allocation_id RETURNING a.allocation_id::text,a.resource_id
 * ```
 */
export const reclaimerClaimOperationObjects = new PreparedQuery<IReclaimerClaimOperationObjectsParams,IReclaimerClaimOperationObjectsResult>(reclaimerClaimOperationObjectsIR);


/** 'ReclaimerLockPreparation' parameters type */
export interface IReclaimerLockPreparationParams {
  idempotencyKey: string;
  operation: string;
  preparationId: string;
  tenantId: string;
}

/** 'ReclaimerLockPreparation' return type */
export interface IReclaimerLockPreparationResult {
  state: string;
}

/** 'ReclaimerLockPreparation' query type */
export interface IReclaimerLockPreparationQuery {
  params: IReclaimerLockPreparationParams;
  result: IReclaimerLockPreparationResult;
}

const reclaimerLockPreparationIR: any = {"usedParamSet":{"preparationId":true,"operation":true,"idempotencyKey":true,"tenantId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":75,"b":89}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":105,"b":115}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":137,"b":152}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":168,"b":177}]}],"statement":"SELECT state FROM hosted_agent_workspace_preparations WHERE preparation_id=:preparationId!\nAND operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT state FROM hosted_agent_workspace_preparations WHERE preparation_id=:preparationId!
 * AND operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId! FOR UPDATE
 * ```
 */
export const reclaimerLockPreparation = new PreparedQuery<IReclaimerLockPreparationParams,IReclaimerLockPreparationResult>(reclaimerLockPreparationIR);


/** 'ReclaimerClaimPreparationObjects' parameters type */
export interface IReclaimerClaimPreparationObjectsParams {
  idempotencyKey: string;
  limit: NumberOrString;
  operation: string;
  preparationId: string;
  tenantId: string;
}

/** 'ReclaimerClaimPreparationObjects' return type */
export interface IReclaimerClaimPreparationObjectsResult {
  allocation_id: string | null;
  resource_id: string;
}

/** 'ReclaimerClaimPreparationObjects' query type */
export interface IReclaimerClaimPreparationObjectsQuery {
  params: IReclaimerClaimPreparationObjectsParams;
  result: IReclaimerClaimPreparationObjectsResult;
}

const reclaimerClaimPreparationObjectsIR: any = {"usedParamSet":{"preparationId":true,"operation":true,"idempotencyKey":true,"tenantId":true,"limit":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":372,"b":386}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":404,"b":414}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":438,"b":453}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":471,"b":480}]},{"name":"limit","required":true,"transform":{"type":"scalar"},"locs":[{"a":648,"b":654}]}],"statement":"WITH candidates AS (SELECT a.allocation_id FROM hosted_agent_workspace_preparation_objects p\nJOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id AND a.operation=p.operation\nAND a.idempotency_key=p.idempotency_key AND a.tenant_id=p.tenant_id\nJOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id\nWHERE p.preparation_id=:preparationId! AND p.operation=:operation! AND p.idempotency_key=:idempotencyKey!\nAND p.tenant_id=:tenantId! AND a.allocation_kind='object' AND a.resource_id=p.object_id\nAND a.state IN('allocated','reclaim_pending') ORDER BY a.allocation_id FOR UPDATE OF a SKIP LOCKED LIMIT :limit!)\nUPDATE hosted_agent_operation_allocations a SET state='reclaim_pending' FROM candidates\nWHERE a.allocation_id=candidates.allocation_id RETURNING a.allocation_id::text,a.resource_id"};

/**
 * Query generated from SQL:
 * ```
 * WITH candidates AS (SELECT a.allocation_id FROM hosted_agent_workspace_preparation_objects p
 * JOIN hosted_agent_operation_allocations a ON a.allocation_id=p.allocation_id AND a.operation=p.operation
 * AND a.idempotency_key=p.idempotency_key AND a.tenant_id=p.tenant_id
 * JOIN hosted_agent_objects o ON o.object_id=p.object_id AND o.tenant_id=p.tenant_id
 * WHERE p.preparation_id=:preparationId! AND p.operation=:operation! AND p.idempotency_key=:idempotencyKey!
 * AND p.tenant_id=:tenantId! AND a.allocation_kind='object' AND a.resource_id=p.object_id
 * AND a.state IN('allocated','reclaim_pending') ORDER BY a.allocation_id FOR UPDATE OF a SKIP LOCKED LIMIT :limit!)
 * UPDATE hosted_agent_operation_allocations a SET state='reclaim_pending' FROM candidates
 * WHERE a.allocation_id=candidates.allocation_id RETURNING a.allocation_id::text,a.resource_id
 * ```
 */
export const reclaimerClaimPreparationObjects = new PreparedQuery<IReclaimerClaimPreparationObjectsParams,IReclaimerClaimPreparationObjectsResult>(reclaimerClaimPreparationObjectsIR);


/** 'ReclaimerPreparationOutstanding' parameters type */
export interface IReclaimerPreparationOutstandingParams {
  preparationId: string;
}

/** 'ReclaimerPreparationOutstanding' return type */
export interface IReclaimerPreparationOutstandingResult {
  outstanding: string | null;
}

/** 'ReclaimerPreparationOutstanding' query type */
export interface IReclaimerPreparationOutstandingQuery {
  params: IReclaimerPreparationOutstandingParams;
  result: IReclaimerPreparationOutstandingResult;
}

const reclaimerPreparationOutstandingIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":318,"b":332}]}],"statement":"SELECT count(*) FILTER(WHERE a.state<>'reclaimed')::text AS outstanding\nFROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a\nON a.allocation_id=p.allocation_id AND a.operation=p.operation AND a.idempotency_key=p.idempotency_key\nAND a.tenant_id=p.tenant_id WHERE p.preparation_id=:preparationId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT count(*) FILTER(WHERE a.state<>'reclaimed')::text AS outstanding
 * FROM hosted_agent_workspace_preparation_objects p JOIN hosted_agent_operation_allocations a
 * ON a.allocation_id=p.allocation_id AND a.operation=p.operation AND a.idempotency_key=p.idempotency_key
 * AND a.tenant_id=p.tenant_id WHERE p.preparation_id=:preparationId!
 * ```
 */
export const reclaimerPreparationOutstanding = new PreparedQuery<IReclaimerPreparationOutstandingParams,IReclaimerPreparationOutstandingResult>(reclaimerPreparationOutstandingIR);


/** 'ReclaimerFinalizePreparation' parameters type */
export interface IReclaimerFinalizePreparationParams {
  preparationId: string;
}

/** 'ReclaimerFinalizePreparation' return type */
export type IReclaimerFinalizePreparationResult = void;

/** 'ReclaimerFinalizePreparation' query type */
export interface IReclaimerFinalizePreparationQuery {
  params: IReclaimerFinalizePreparationParams;
  result: IReclaimerFinalizePreparationResult;
}

const reclaimerFinalizePreparationIR: any = {"usedParamSet":{"preparationId":true},"params":[{"name":"preparationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":123,"b":137}]}],"statement":"UPDATE hosted_agent_workspace_preparations SET state='reclaimed',reclaimed_at=now(),committed_at=NULL\nWHERE preparation_id=:preparationId! AND state='reclaim_pending'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_workspace_preparations SET state='reclaimed',reclaimed_at=now(),committed_at=NULL
 * WHERE preparation_id=:preparationId! AND state='reclaim_pending'
 * ```
 */
export const reclaimerFinalizePreparation = new PreparedQuery<IReclaimerFinalizePreparationParams,IReclaimerFinalizePreparationResult>(reclaimerFinalizePreparationIR);


/** 'ReclaimerLockOwnedAllocation' parameters type */
export interface IReclaimerLockOwnedAllocationParams {
  allocationId: NumberOrString;
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  resourceId: string;
  tenantId: string;
  workerId: string;
}

/** 'ReclaimerLockOwnedAllocation' return type */
export interface IReclaimerLockOwnedAllocationResult {
  state: string;
}

/** 'ReclaimerLockOwnedAllocation' query type */
export interface IReclaimerLockOwnedAllocationQuery {
  params: IReclaimerLockOwnedAllocationParams;
  result: IReclaimerLockOwnedAllocationResult;
}

const reclaimerLockOwnedAllocationIR: any = {"usedParamSet":{"allocationId":true,"operation":true,"idempotencyKey":true,"tenantId":true,"resourceId":true,"generation":true,"workerId":true},"params":[{"name":"allocationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":154,"b":167}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":193,"b":203}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":227,"b":242}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":260,"b":269}]},{"name":"resourceId","required":true,"transform":{"type":"scalar"},"locs":[{"a":320,"b":331}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":351,"b":362}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":381,"b":390}]}],"statement":"SELECT a.state FROM hosted_agent_operation_allocations a JOIN hosted_agent_operations op\nUSING(operation,idempotency_key,tenant_id) WHERE a.allocation_id=:allocationId!::bigint\nAND a.operation=:operation! AND a.idempotency_key=:idempotencyKey! AND a.tenant_id=:tenantId!\nAND a.allocation_kind='object' AND a.resource_id=:resourceId! AND op.generation=:generation!\nAND op.worker_id=:workerId! AND op.state='in_progress' FOR UPDATE OF a,op"};

/**
 * Query generated from SQL:
 * ```
 * SELECT a.state FROM hosted_agent_operation_allocations a JOIN hosted_agent_operations op
 * USING(operation,idempotency_key,tenant_id) WHERE a.allocation_id=:allocationId!::bigint
 * AND a.operation=:operation! AND a.idempotency_key=:idempotencyKey! AND a.tenant_id=:tenantId!
 * AND a.allocation_kind='object' AND a.resource_id=:resourceId! AND op.generation=:generation!
 * AND op.worker_id=:workerId! AND op.state='in_progress' FOR UPDATE OF a,op
 * ```
 */
export const reclaimerLockOwnedAllocation = new PreparedQuery<IReclaimerLockOwnedAllocationParams,IReclaimerLockOwnedAllocationResult>(reclaimerLockOwnedAllocationIR);


/** 'ReclaimerLockAllocation' parameters type */
export interface IReclaimerLockAllocationParams {
  allocationId: NumberOrString;
}

/** 'ReclaimerLockAllocation' return type */
export interface IReclaimerLockAllocationResult {
  state: string;
}

/** 'ReclaimerLockAllocation' query type */
export interface IReclaimerLockAllocationQuery {
  params: IReclaimerLockAllocationParams;
  result: IReclaimerLockAllocationResult;
}

const reclaimerLockAllocationIR: any = {"usedParamSet":{"allocationId":true},"params":[{"name":"allocationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":73,"b":86}]}],"statement":"SELECT state FROM hosted_agent_operation_allocations WHERE allocation_id=:allocationId!::bigint FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT state FROM hosted_agent_operation_allocations WHERE allocation_id=:allocationId!::bigint FOR UPDATE
 * ```
 */
export const reclaimerLockAllocation = new PreparedQuery<IReclaimerLockAllocationParams,IReclaimerLockAllocationResult>(reclaimerLockAllocationIR);


/** 'ReclaimerMarkObjectAllocationsReclaimed' parameters type */
export interface IReclaimerMarkObjectAllocationsReclaimedParams {
  objectId: string;
  tenantId: string;
}

/** 'ReclaimerMarkObjectAllocationsReclaimed' return type */
export type IReclaimerMarkObjectAllocationsReclaimedResult = void;

/** 'ReclaimerMarkObjectAllocationsReclaimed' query type */
export interface IReclaimerMarkObjectAllocationsReclaimedQuery {
  params: IReclaimerMarkObjectAllocationsReclaimedParams;
  result: IReclaimerMarkObjectAllocationsReclaimedResult;
}

const reclaimerMarkObjectAllocationsReclaimedIR: any = {"usedParamSet":{"tenantId":true,"objectId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":99,"b":108}]},{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":155,"b":164}]}],"statement":"UPDATE hosted_agent_operation_allocations SET state='reclaimed',reclaimed_at=now()\nWHERE tenant_id=:tenantId! AND allocation_kind='object' AND resource_id=:objectId! AND state='reclaim_pending'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_operation_allocations SET state='reclaimed',reclaimed_at=now()
 * WHERE tenant_id=:tenantId! AND allocation_kind='object' AND resource_id=:objectId! AND state='reclaim_pending'
 * ```
 */
export const reclaimerMarkObjectAllocationsReclaimed = new PreparedQuery<IReclaimerMarkObjectAllocationsReclaimedParams,IReclaimerMarkObjectAllocationsReclaimedResult>(reclaimerMarkObjectAllocationsReclaimedIR);


/** 'ReclaimerHasDurableReference' parameters type */
export interface IReclaimerHasDurableReferenceParams {
  objectId: string;
}

/** 'ReclaimerHasDurableReference' return type */
export interface IReclaimerHasDurableReferenceResult {
  present: number | null;
}

/** 'ReclaimerHasDurableReference' query type */
export interface IReclaimerHasDurableReferenceQuery {
  params: IReclaimerHasDurableReferenceParams;
  result: IReclaimerHasDurableReferenceResult;
}

const reclaimerHasDurableReferenceIR: any = {"usedParamSet":{"objectId":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":94,"b":103},{"a":184,"b":193},{"a":277,"b":286},{"a":310,"b":319},{"a":399,"b":408},{"a":440,"b":449},{"a":473,"b":482}]}],"statement":"SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM hosted_agent_object_references WHERE object_id=:objectId!)\nOR EXISTS(SELECT 1 FROM hosted_agent_source_snapshots WHERE archive_object_id=:objectId!)\nOR EXISTS(SELECT 1 FROM hosted_agent_snapshots WHERE workspace_archive_object_id=:objectId! OR manifest_object_id=:objectId!)\nOR EXISTS(SELECT 1 FROM hosted_agent_artifacts WHERE base_manifest_object_id=:objectId!\nOR current_manifest_object_id=:objectId! OR artifact_object_id=:objectId!)"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM hosted_agent_object_references WHERE object_id=:objectId!)
 * OR EXISTS(SELECT 1 FROM hosted_agent_source_snapshots WHERE archive_object_id=:objectId!)
 * OR EXISTS(SELECT 1 FROM hosted_agent_snapshots WHERE workspace_archive_object_id=:objectId! OR manifest_object_id=:objectId!)
 * OR EXISTS(SELECT 1 FROM hosted_agent_artifacts WHERE base_manifest_object_id=:objectId!
 * OR current_manifest_object_id=:objectId! OR artifact_object_id=:objectId!)
 * ```
 */
export const reclaimerHasDurableReference = new PreparedQuery<IReclaimerHasDurableReferenceParams,IReclaimerHasDurableReferenceResult>(reclaimerHasDurableReferenceIR);


/** 'ReclaimerMarkAllocationReclaimed' parameters type */
export interface IReclaimerMarkAllocationReclaimedParams {
  allocationId: NumberOrString;
}

/** 'ReclaimerMarkAllocationReclaimed' return type */
export type IReclaimerMarkAllocationReclaimedResult = void;

/** 'ReclaimerMarkAllocationReclaimed' query type */
export interface IReclaimerMarkAllocationReclaimedQuery {
  params: IReclaimerMarkAllocationReclaimedParams;
  result: IReclaimerMarkAllocationReclaimedResult;
}

const reclaimerMarkAllocationReclaimedIR: any = {"usedParamSet":{"allocationId":true},"params":[{"name":"allocationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":103,"b":116}]}],"statement":"UPDATE hosted_agent_operation_allocations SET state='reclaimed',reclaimed_at=now()\nWHERE allocation_id=:allocationId!::bigint AND state='reclaim_pending'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_operation_allocations SET state='reclaimed',reclaimed_at=now()
 * WHERE allocation_id=:allocationId!::bigint AND state='reclaim_pending'
 * ```
 */
export const reclaimerMarkAllocationReclaimed = new PreparedQuery<IReclaimerMarkAllocationReclaimedParams,IReclaimerMarkAllocationReclaimedResult>(reclaimerMarkAllocationReclaimedIR);


/** 'ReclaimerOwnsOperation' parameters type */
export interface IReclaimerOwnsOperationParams {
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'ReclaimerOwnsOperation' return type */
export interface IReclaimerOwnsOperationResult {
  present: number | null;
}

/** 'ReclaimerOwnsOperation' query type */
export interface IReclaimerOwnsOperationQuery {
  params: IReclaimerOwnsOperationParams;
  result: IReclaimerOwnsOperationResult;
}

const reclaimerOwnsOperationIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":65,"b":75}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":97,"b":112}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":128,"b":137}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":154,"b":165}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":181,"b":190}]}],"statement":"SELECT 1 AS present FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!\nAND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress'"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!
 * AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress'
 * ```
 */
export const reclaimerOwnsOperation = new PreparedQuery<IReclaimerOwnsOperationParams,IReclaimerOwnsOperationResult>(reclaimerOwnsOperationIR);


/** 'ReclaimerOwnsOperationForUpdate' parameters type */
export interface IReclaimerOwnsOperationForUpdateParams {
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'ReclaimerOwnsOperationForUpdate' return type */
export interface IReclaimerOwnsOperationForUpdateResult {
  present: number | null;
}

/** 'ReclaimerOwnsOperationForUpdate' query type */
export interface IReclaimerOwnsOperationForUpdateQuery {
  params: IReclaimerOwnsOperationForUpdateParams;
  result: IReclaimerOwnsOperationForUpdateResult;
}

const reclaimerOwnsOperationForUpdateIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":65,"b":75}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":97,"b":112}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":128,"b":137}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":154,"b":165}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":181,"b":190}]}],"statement":"SELECT 1 AS present FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!\nAND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress' FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!
 * AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress' FOR UPDATE
 * ```
 */
export const reclaimerOwnsOperationForUpdate = new PreparedQuery<IReclaimerOwnsOperationForUpdateParams,IReclaimerOwnsOperationForUpdateResult>(reclaimerOwnsOperationForUpdateIR);


/** 'ExpireAvailablePatchArtifacts' parameters type */
export interface IExpireAvailablePatchArtifactsParams {
  at: DateOrString;
  tenantId: string;
}

/** 'ExpireAvailablePatchArtifacts' return type */
export type IExpireAvailablePatchArtifactsResult = void;

/** 'ExpireAvailablePatchArtifacts' query type */
export interface IExpireAvailablePatchArtifactsQuery {
  params: IExpireAvailablePatchArtifactsParams;
  result: IExpireAvailablePatchArtifactsResult;
}

const expireAvailablePatchArtifactsIR: any = {"usedParamSet":{"tenantId":true,"at":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":70,"b":79}]},{"name":"at","required":true,"transform":{"type":"scalar"},"locs":[{"a":123,"b":126}]}],"statement":"UPDATE hosted_agent_artifacts SET state = 'expired'\nWHERE tenant_id = :tenantId! AND state = 'available' AND expires_at <= :at!\n  AND NOT EXISTS (SELECT 1 FROM hosted_agent_artifact_references retained\n    WHERE retained.artifact_id = hosted_agent_artifacts.artifact_id\n      AND retained.reference_kind = 'codex_thread')"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_artifacts SET state = 'expired'
 * WHERE tenant_id = :tenantId! AND state = 'available' AND expires_at <= :at!
 *   AND NOT EXISTS (SELECT 1 FROM hosted_agent_artifact_references retained
 *     WHERE retained.artifact_id = hosted_agent_artifacts.artifact_id
 *       AND retained.reference_kind = 'codex_thread')
 * ```
 */
export const expireAvailablePatchArtifacts = new PreparedQuery<IExpireAvailablePatchArtifactsParams,IExpireAvailablePatchArtifactsResult>(expireAvailablePatchArtifactsIR);


/** 'GetPatchArtifact' parameters type */
export interface IGetPatchArtifactParams {
  artifactId: string;
}

/** 'GetPatchArtifact' return type */
export interface IGetPatchArtifactResult {
  agent_id: string;
  artifact_id: string;
  artifact_object_id: string;
  base_manifest_object_id: string;
  base_snapshot_id: string;
  changed_files: number;
  checksum: string;
  created_at: Date;
  current_manifest_object_id: string;
  current_snapshot_id: string;
  expires_at: Date;
  owner_agent_id: string | null;
  size_bytes: string | null;
  source_lease_id: string;
  state: string;
  tenant_id: string;
}

/** 'GetPatchArtifact' query type */
export interface IGetPatchArtifactQuery {
  params: IGetPatchArtifactParams;
  result: IGetPatchArtifactResult;
}

const getPatchArtifactIR: any = {"usedParamSet":{"artifactId":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":442,"b":453}]}],"statement":"SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,\n  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,\n  a.current_manifest_object_id, a.artifact_object_id, a.checksum,\n  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at\nFROM hosted_agent_artifacts a JOIN hosted_agent_leases l\n  ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id\nWHERE a.artifact_id = :artifactId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
 *   a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
 *   a.current_manifest_object_id, a.artifact_object_id, a.checksum,
 *   a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
 * FROM hosted_agent_artifacts a JOIN hosted_agent_leases l
 *   ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
 * WHERE a.artifact_id = :artifactId!
 * ```
 */
export const getPatchArtifact = new PreparedQuery<IGetPatchArtifactParams,IGetPatchArtifactResult>(getPatchArtifactIR);


/** 'LockPatchArtifact' parameters type */
export interface ILockPatchArtifactParams {
  artifactId: string;
}

/** 'LockPatchArtifact' return type */
export interface ILockPatchArtifactResult {
  agent_id: string;
  artifact_id: string;
  artifact_object_id: string;
  base_manifest_object_id: string;
  base_snapshot_id: string;
  changed_files: number;
  checksum: string;
  created_at: Date;
  current_manifest_object_id: string;
  current_snapshot_id: string;
  expires_at: Date;
  owner_agent_id: string | null;
  size_bytes: string | null;
  source_lease_id: string;
  state: string;
  tenant_id: string;
}

/** 'LockPatchArtifact' query type */
export interface ILockPatchArtifactQuery {
  params: ILockPatchArtifactParams;
  result: ILockPatchArtifactResult;
}

const lockPatchArtifactIR: any = {"usedParamSet":{"artifactId":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":442,"b":453}]}],"statement":"SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,\n  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,\n  a.current_manifest_object_id, a.artifact_object_id, a.checksum,\n  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at\nFROM hosted_agent_artifacts a JOIN hosted_agent_leases l\n  ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id\nWHERE a.artifact_id = :artifactId! FOR UPDATE OF a"};

/**
 * Query generated from SQL:
 * ```
 * SELECT a.artifact_id, a.tenant_id, a.agent_id, l.owner_agent_id, a.source_lease_id,
 *   a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
 *   a.current_manifest_object_id, a.artifact_object_id, a.checksum,
 *   a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at
 * FROM hosted_agent_artifacts a JOIN hosted_agent_leases l
 *   ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
 * WHERE a.artifact_id = :artifactId! FOR UPDATE OF a
 * ```
 */
export const lockPatchArtifact = new PreparedQuery<ILockPatchArtifactParams,ILockPatchArtifactResult>(lockPatchArtifactIR);


/** 'LockPatchArtifactSourceLease' parameters type */
export interface ILockPatchArtifactSourceLeaseParams {
  leaseId: string;
  tenantId: string;
}

/** 'LockPatchArtifactSourceLease' return type */
export interface ILockPatchArtifactSourceLeaseResult {
  agent_id: string;
  base_snapshot_id: string | null;
  latest_snapshot_id: string | null;
  owner_agent_id: string | null;
  state: string;
}

/** 'LockPatchArtifactSourceLease' query type */
export interface ILockPatchArtifactSourceLeaseQuery {
  params: ILockPatchArtifactSourceLeaseParams;
  result: ILockPatchArtifactSourceLeaseResult;
}

const lockPatchArtifactSourceLeaseIR: any = {"usedParamSet":{"leaseId":true,"tenantId":true},"params":[{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":119,"b":127}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":145,"b":154}]}],"statement":"SELECT agent_id, owner_agent_id, base_snapshot_id, latest_snapshot_id, state\nFROM hosted_agent_leases WHERE lease_id = :leaseId! AND tenant_id = :tenantId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT agent_id, owner_agent_id, base_snapshot_id, latest_snapshot_id, state
 * FROM hosted_agent_leases WHERE lease_id = :leaseId! AND tenant_id = :tenantId! FOR UPDATE
 * ```
 */
export const lockPatchArtifactSourceLease = new PreparedQuery<ILockPatchArtifactSourceLeaseParams,ILockPatchArtifactSourceLeaseResult>(lockPatchArtifactSourceLeaseIR);


/** 'SharePatchArtifactSnapshots' parameters type */
export interface ISharePatchArtifactSnapshotsParams {
  snapshotIds: stringArray;
  tenantId: string;
}

/** 'SharePatchArtifactSnapshots' return type */
export interface ISharePatchArtifactSnapshotsResult {
  expires_at: Date | null;
  lease_id: string;
  manifest_checksum: string;
  manifest_object_id: string;
  snapshot_id: string;
  state: string;
}

/** 'SharePatchArtifactSnapshots' query type */
export interface ISharePatchArtifactSnapshotsQuery {
  params: ISharePatchArtifactSnapshotsParams;
  result: ISharePatchArtifactSnapshotsResult;
}

const sharePatchArtifactSnapshotsIR: any = {"usedParamSet":{"tenantId":true,"snapshotIds":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":133,"b":142}]},{"name":"snapshotIds","required":true,"transform":{"type":"scalar"},"locs":[{"a":166,"b":178}]}],"statement":"SELECT snapshot_id, lease_id, manifest_object_id, manifest_checksum, state, expires_at\nFROM hosted_agent_snapshots WHERE tenant_id = :tenantId! AND snapshot_id = ANY(:snapshotIds!::text[]) FOR SHARE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT snapshot_id, lease_id, manifest_object_id, manifest_checksum, state, expires_at
 * FROM hosted_agent_snapshots WHERE tenant_id = :tenantId! AND snapshot_id = ANY(:snapshotIds!::text[]) FOR SHARE
 * ```
 */
export const sharePatchArtifactSnapshots = new PreparedQuery<ISharePatchArtifactSnapshotsParams,ISharePatchArtifactSnapshotsResult>(sharePatchArtifactSnapshotsIR);


/** 'SharePatchArtifactObjects' parameters type */
export interface ISharePatchArtifactObjectsParams {
  objectIds: stringArray;
}

/** 'SharePatchArtifactObjects' return type */
export interface ISharePatchArtifactObjectsResult {
  checksum: string;
  expires_at: Date | null;
  kind: string;
  object_id: string;
  size_bytes: string | null;
  state: string;
  tenant_id: string;
}

/** 'SharePatchArtifactObjects' query type */
export interface ISharePatchArtifactObjectsQuery {
  params: ISharePatchArtifactObjectsParams;
  result: ISharePatchArtifactObjectsResult;
}

const sharePatchArtifactObjectsIR: any = {"usedParamSet":{"objectIds":true},"params":[{"name":"objectIds","required":true,"transform":{"type":"scalar"},"locs":[{"a":129,"b":139}]}],"statement":"SELECT object_id, tenant_id, kind, checksum, size_bytes::text, state, expires_at\nFROM hosted_agent_objects WHERE object_id = ANY(:objectIds!::text[]) FOR SHARE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT object_id, tenant_id, kind, checksum, size_bytes::text, state, expires_at
 * FROM hosted_agent_objects WHERE object_id = ANY(:objectIds!::text[]) FOR SHARE
 * ```
 */
export const sharePatchArtifactObjects = new PreparedQuery<ISharePatchArtifactObjectsParams,ISharePatchArtifactObjectsResult>(sharePatchArtifactObjectsIR);


/** 'RetainPatchArtifactObject' parameters type */
export interface IRetainPatchArtifactObjectParams {
  artifactId: string;
  objectId: string;
  purpose: string;
  retainUntil: DateOrString;
}

/** 'RetainPatchArtifactObject' return type */
export type IRetainPatchArtifactObjectResult = void;

/** 'RetainPatchArtifactObject' query type */
export interface IRetainPatchArtifactObjectQuery {
  params: IRetainPatchArtifactObjectParams;
  result: IRetainPatchArtifactObjectResult;
}

const retainPatchArtifactObjectIR: any = {"usedParamSet":{"objectId":true,"artifactId":true,"purpose":true,"retainUntil":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":116,"b":125}]},{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":140,"b":151}]},{"name":"purpose","required":true,"transform":{"type":"scalar"},"locs":[{"a":154,"b":162}]},{"name":"retainUntil","required":true,"transform":{"type":"scalar"},"locs":[{"a":165,"b":177}]}],"statement":"INSERT INTO hosted_agent_object_references (object_id, reference_kind, reference_id, purpose, retain_until)\nVALUES (:objectId!, 'artifact', :artifactId!, :purpose!, :retainUntil!)\nON CONFLICT (object_id, reference_kind, reference_id, purpose) DO UPDATE SET retain_until = CASE\n  WHEN hosted_agent_object_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL\n  ELSE GREATEST(hosted_agent_object_references.retain_until, EXCLUDED.retain_until) END"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_object_references (object_id, reference_kind, reference_id, purpose, retain_until)
 * VALUES (:objectId!, 'artifact', :artifactId!, :purpose!, :retainUntil!)
 * ON CONFLICT (object_id, reference_kind, reference_id, purpose) DO UPDATE SET retain_until = CASE
 *   WHEN hosted_agent_object_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
 *   ELSE GREATEST(hosted_agent_object_references.retain_until, EXCLUDED.retain_until) END
 * ```
 */
export const retainPatchArtifactObject = new PreparedQuery<IRetainPatchArtifactObjectParams,IRetainPatchArtifactObjectResult>(retainPatchArtifactObjectIR);


/** 'RetainPatchArtifactSnapshots' parameters type */
export interface IRetainPatchArtifactSnapshotsParams {
  artifactId: string;
  baseSnapshotId: string;
  currentSnapshotId: string;
  retainUntil: DateOrString;
}

/** 'RetainPatchArtifactSnapshots' return type */
export type IRetainPatchArtifactSnapshotsResult = void;

/** 'RetainPatchArtifactSnapshots' query type */
export interface IRetainPatchArtifactSnapshotsQuery {
  params: IRetainPatchArtifactSnapshotsParams;
  result: IRetainPatchArtifactSnapshotsResult;
}

const retainPatchArtifactSnapshotsIR: any = {"usedParamSet":{"baseSnapshotId":true,"artifactId":true,"retainUntil":true,"currentSnapshotId":true},"params":[{"name":"baseSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":111,"b":126}]},{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":146,"b":157},{"a":220,"b":231}]},{"name":"retainUntil","required":true,"transform":{"type":"scalar"},"locs":[{"a":160,"b":172},{"a":234,"b":246}]},{"name":"currentSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":179,"b":197}]}],"statement":"INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id, retain_until)\nVALUES (:baseSnapshotId!, 'artifact_base', :artifactId!, :retainUntil!),\n  (:currentSnapshotId!, 'artifact_current', :artifactId!, :retainUntil!)\nON CONFLICT (snapshot_id, reference_kind, reference_id) DO UPDATE SET retain_until = CASE\n  WHEN hosted_agent_snapshot_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL\n  ELSE GREATEST(hosted_agent_snapshot_references.retain_until, EXCLUDED.retain_until) END"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id, retain_until)
 * VALUES (:baseSnapshotId!, 'artifact_base', :artifactId!, :retainUntil!),
 *   (:currentSnapshotId!, 'artifact_current', :artifactId!, :retainUntil!)
 * ON CONFLICT (snapshot_id, reference_kind, reference_id) DO UPDATE SET retain_until = CASE
 *   WHEN hosted_agent_snapshot_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
 *   ELSE GREATEST(hosted_agent_snapshot_references.retain_until, EXCLUDED.retain_until) END
 * ```
 */
export const retainPatchArtifactSnapshots = new PreparedQuery<IRetainPatchArtifactSnapshotsParams,IRetainPatchArtifactSnapshotsResult>(retainPatchArtifactSnapshotsIR);


/** 'RetainPatchArtifact' parameters type */
export interface IRetainPatchArtifactParams {
  artifactId: string;
  referenceId: string;
  referenceKind: string;
  retainUntil: DateOrString;
}

/** 'RetainPatchArtifact' return type */
export type IRetainPatchArtifactResult = void;

/** 'RetainPatchArtifact' query type */
export interface IRetainPatchArtifactQuery {
  params: IRetainPatchArtifactParams;
  result: IRetainPatchArtifactResult;
}

const retainPatchArtifactIR: any = {"usedParamSet":{"artifactId":true,"referenceKind":true,"referenceId":true,"retainUntil":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":111,"b":122}]},{"name":"referenceKind","required":true,"transform":{"type":"scalar"},"locs":[{"a":125,"b":139}]},{"name":"referenceId","required":true,"transform":{"type":"scalar"},"locs":[{"a":142,"b":154}]},{"name":"retainUntil","required":true,"transform":{"type":"scalar"},"locs":[{"a":157,"b":169}]}],"statement":"INSERT INTO hosted_agent_artifact_references (artifact_id, reference_kind, reference_id, retain_until)\nVALUES (:artifactId!, :referenceKind!, :referenceId!, :retainUntil!)\nON CONFLICT (artifact_id, reference_kind, reference_id) DO UPDATE SET retain_until = CASE\n  WHEN hosted_agent_artifact_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL\n  ELSE GREATEST(hosted_agent_artifact_references.retain_until, EXCLUDED.retain_until) END"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_artifact_references (artifact_id, reference_kind, reference_id, retain_until)
 * VALUES (:artifactId!, :referenceKind!, :referenceId!, :retainUntil!)
 * ON CONFLICT (artifact_id, reference_kind, reference_id) DO UPDATE SET retain_until = CASE
 *   WHEN hosted_agent_artifact_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
 *   ELSE GREATEST(hosted_agent_artifact_references.retain_until, EXCLUDED.retain_until) END
 * ```
 */
export const retainPatchArtifact = new PreparedQuery<IRetainPatchArtifactParams,IRetainPatchArtifactResult>(retainPatchArtifactIR);


/** 'StateInsertObject' parameters type */
export interface IStateInsertObjectParams {
  checksum: string;
  expiresAt?: DateOrString | null | void;
  kind: string;
  objectId: string;
  sizeBytes: NumberOrString;
  state: string;
  storageBucket: string;
  storageKey: string;
  tenantId: string;
}

/** 'StateInsertObject' return type */
export type IStateInsertObjectResult = void;

/** 'StateInsertObject' query type */
export interface IStateInsertObjectQuery {
  params: IStateInsertObjectParams;
  result: IStateInsertObjectResult;
}

const stateInsertObjectIR: any = {"usedParamSet":{"objectId":true,"tenantId":true,"kind":true,"storageBucket":true,"storageKey":true,"checksum":true,"sizeBytes":true,"state":true,"expiresAt":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":142,"b":151}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":154,"b":163}]},{"name":"kind","required":true,"transform":{"type":"scalar"},"locs":[{"a":166,"b":171}]},{"name":"storageBucket","required":true,"transform":{"type":"scalar"},"locs":[{"a":174,"b":188}]},{"name":"storageKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":191,"b":202}]},{"name":"checksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":205,"b":214}]},{"name":"sizeBytes","required":true,"transform":{"type":"scalar"},"locs":[{"a":217,"b":227}]},{"name":"state","required":true,"transform":{"type":"scalar"},"locs":[{"a":232,"b":238}]},{"name":"expiresAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":241,"b":250}]}],"statement":"INSERT INTO hosted_agent_objects\n  (object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes, state, expires_at)\nVALUES (:objectId!, :tenantId!, :kind!, :storageBucket!, :storageKey!, :checksum!, :sizeBytes!,\n  :state!, :expiresAt)\nON CONFLICT (object_id) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_objects
 *   (object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes, state, expires_at)
 * VALUES (:objectId!, :tenantId!, :kind!, :storageBucket!, :storageKey!, :checksum!, :sizeBytes!,
 *   :state!, :expiresAt)
 * ON CONFLICT (object_id) DO NOTHING
 * ```
 */
export const stateInsertObject = new PreparedQuery<IStateInsertObjectParams,IStateInsertObjectResult>(stateInsertObjectIR);


/** 'StateLockObjectById' parameters type */
export interface IStateLockObjectByIdParams {
  objectId: string;
}

/** 'StateLockObjectById' return type */
export interface IStateLockObjectByIdResult {
  checksum: string;
  expires_at: Date | null;
  kind: string;
  object_id: string;
  size_bytes: string | null;
  state: string;
  storage_bucket: string;
  storage_key: string;
  tenant_id: string;
}

/** 'StateLockObjectById' query type */
export interface IStateLockObjectByIdQuery {
  params: IStateLockObjectByIdParams;
  result: IStateLockObjectByIdResult;
}

const stateLockObjectByIdIR: any = {"usedParamSet":{"objectId":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":154,"b":163}]}],"statement":"SELECT object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes::text, state, expires_at\nFROM hosted_agent_objects WHERE object_id = :objectId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes::text, state, expires_at
 * FROM hosted_agent_objects WHERE object_id = :objectId! FOR UPDATE
 * ```
 */
export const stateLockObjectById = new PreparedQuery<IStateLockObjectByIdParams,IStateLockObjectByIdResult>(stateLockObjectByIdIR);


/** 'StateLockObjectByTenant' parameters type */
export interface IStateLockObjectByTenantParams {
  objectId: string;
  tenantId: string;
}

/** 'StateLockObjectByTenant' return type */
export interface IStateLockObjectByTenantResult {
  checksum: string;
  expires_at: Date | null;
  kind: string;
  object_id: string;
  size_bytes: string | null;
  state: string;
  storage_bucket: string;
  storage_key: string;
  tenant_id: string;
}

/** 'StateLockObjectByTenant' query type */
export interface IStateLockObjectByTenantQuery {
  params: IStateLockObjectByTenantParams;
  result: IStateLockObjectByTenantResult;
}

const stateLockObjectByTenantIR: any = {"usedParamSet":{"objectId":true,"tenantId":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":154,"b":163}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":181,"b":190}]}],"statement":"SELECT object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes::text, state, expires_at\nFROM hosted_agent_objects WHERE object_id = :objectId! AND tenant_id = :tenantId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes::text, state, expires_at
 * FROM hosted_agent_objects WHERE object_id = :objectId! AND tenant_id = :tenantId! FOR UPDATE
 * ```
 */
export const stateLockObjectByTenant = new PreparedQuery<IStateLockObjectByTenantParams,IStateLockObjectByTenantResult>(stateLockObjectByTenantIR);


/** 'StateAddSnapshotReference' parameters type */
export interface IStateAddSnapshotReferenceParams {
  referenceId: string;
  referenceKind: string;
  retainUntil?: DateOrString | null | void;
  snapshotId: string;
  tenantId: string;
}

/** 'StateAddSnapshotReference' return type */
export interface IStateAddSnapshotReferenceResult {
  affected: number | null;
}

/** 'StateAddSnapshotReference' query type */
export interface IStateAddSnapshotReferenceQuery {
  params: IStateAddSnapshotReferenceParams;
  result: IStateAddSnapshotReferenceResult;
}

const stateAddSnapshotReferenceIR: any = {"usedParamSet":{"referenceKind":true,"referenceId":true,"retainUntil":true,"snapshotId":true,"tenantId":true},"params":[{"name":"referenceKind","required":true,"transform":{"type":"scalar"},"locs":[{"a":125,"b":139}]},{"name":"referenceId","required":true,"transform":{"type":"scalar"},"locs":[{"a":142,"b":154}]},{"name":"retainUntil","required":false,"transform":{"type":"scalar"},"locs":[{"a":157,"b":168}]},{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":218,"b":229}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":247,"b":256}]}],"statement":"INSERT INTO hosted_agent_snapshot_references\n  (snapshot_id, reference_kind, reference_id, retain_until)\nSELECT snapshot_id, :referenceKind!, :referenceId!, :retainUntil\nFROM hosted_agent_snapshots WHERE snapshot_id = :snapshotId! AND tenant_id = :tenantId!\nON CONFLICT (snapshot_id, reference_kind, reference_id)\nDO UPDATE SET retain_until = CASE\n  WHEN hosted_agent_snapshot_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL\n  ELSE GREATEST(hosted_agent_snapshot_references.retain_until, EXCLUDED.retain_until) END\nRETURNING 1 AS affected"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_snapshot_references
 *   (snapshot_id, reference_kind, reference_id, retain_until)
 * SELECT snapshot_id, :referenceKind!, :referenceId!, :retainUntil
 * FROM hosted_agent_snapshots WHERE snapshot_id = :snapshotId! AND tenant_id = :tenantId!
 * ON CONFLICT (snapshot_id, reference_kind, reference_id)
 * DO UPDATE SET retain_until = CASE
 *   WHEN hosted_agent_snapshot_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
 *   ELSE GREATEST(hosted_agent_snapshot_references.retain_until, EXCLUDED.retain_until) END
 * RETURNING 1 AS affected
 * ```
 */
export const stateAddSnapshotReference = new PreparedQuery<IStateAddSnapshotReferenceParams,IStateAddSnapshotReferenceResult>(stateAddSnapshotReferenceIR);


/** 'StateGetSourceTenant' parameters type */
export interface IStateGetSourceTenantParams {
  sourceSnapshotId: string;
}

/** 'StateGetSourceTenant' return type */
export interface IStateGetSourceTenantResult {
  tenant_id: string;
}

/** 'StateGetSourceTenant' query type */
export interface IStateGetSourceTenantQuery {
  params: IStateGetSourceTenantParams;
  result: IStateGetSourceTenantResult;
}

const stateGetSourceTenantIR: any = {"usedParamSet":{"sourceSnapshotId":true},"params":[{"name":"sourceSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":79,"b":96}]}],"statement":"SELECT tenant_id FROM hosted_agent_source_snapshots WHERE source_snapshot_id = :sourceSnapshotId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT tenant_id FROM hosted_agent_source_snapshots WHERE source_snapshot_id = :sourceSnapshotId!
 * ```
 */
export const stateGetSourceTenant = new PreparedQuery<IStateGetSourceTenantParams,IStateGetSourceTenantResult>(stateGetSourceTenantIR);


/** 'StateInsertSourceSnapshot' parameters type */
export interface IStateInsertSourceSnapshotParams {
  archiveObjectId: string;
  checksum: string;
  cwdUri: string;
  expiresAt: DateOrString;
  sourceSnapshotId: string;
  state: string;
  tenantId: string;
  workspaceRootUris: Json;
}

/** 'StateInsertSourceSnapshot' return type */
export type IStateInsertSourceSnapshotResult = void;

/** 'StateInsertSourceSnapshot' query type */
export interface IStateInsertSourceSnapshotQuery {
  params: IStateInsertSourceSnapshotParams;
  result: IStateInsertSourceSnapshotResult;
}

const stateInsertSourceSnapshotIR: any = {"usedParamSet":{"sourceSnapshotId":true,"tenantId":true,"archiveObjectId":true,"checksum":true,"cwdUri":true,"workspaceRootUris":true,"state":true,"expiresAt":true},"params":[{"name":"sourceSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":165,"b":182}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":185,"b":194}]},{"name":"archiveObjectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":197,"b":213}]},{"name":"checksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":216,"b":225}]},{"name":"cwdUri","required":true,"transform":{"type":"scalar"},"locs":[{"a":228,"b":235}]},{"name":"workspaceRootUris","required":true,"transform":{"type":"scalar"},"locs":[{"a":240,"b":258}]},{"name":"state","required":true,"transform":{"type":"scalar"},"locs":[{"a":268,"b":274}]},{"name":"expiresAt","required":true,"transform":{"type":"scalar"},"locs":[{"a":277,"b":287}]}],"statement":"INSERT INTO hosted_agent_source_snapshots\n  (source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,\n   workspace_root_uris, state, expires_at)\nVALUES (:sourceSnapshotId!, :tenantId!, :archiveObjectId!, :checksum!, :cwdUri!,\n  :workspaceRootUris!::jsonb, :state!, :expiresAt!)\nON CONFLICT DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_source_snapshots
 *   (source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
 *    workspace_root_uris, state, expires_at)
 * VALUES (:sourceSnapshotId!, :tenantId!, :archiveObjectId!, :checksum!, :cwdUri!,
 *   :workspaceRootUris!::jsonb, :state!, :expiresAt!)
 * ON CONFLICT DO NOTHING
 * ```
 */
export const stateInsertSourceSnapshot = new PreparedQuery<IStateInsertSourceSnapshotParams,IStateInsertSourceSnapshotResult>(stateInsertSourceSnapshotIR);


/** 'StateLockSourceById' parameters type */
export interface IStateLockSourceByIdParams {
  sourceSnapshotId: string;
}

/** 'StateLockSourceById' return type */
export interface IStateLockSourceByIdResult {
  archive_object_id: string;
  checksum: string;
  cwd_uri: string;
  expires_at: Date;
  source_snapshot_id: string;
  state: string;
  tenant_id: string;
  workspace_root_uris: Json;
}

/** 'StateLockSourceById' query type */
export interface IStateLockSourceByIdQuery {
  params: IStateLockSourceByIdParams;
  result: IStateLockSourceByIdResult;
}

const stateLockSourceByIdIR: any = {"usedParamSet":{"sourceSnapshotId":true},"params":[{"name":"sourceSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":179,"b":196}]}],"statement":"SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,\n  workspace_root_uris, state, expires_at\nFROM hosted_agent_source_snapshots WHERE source_snapshot_id = :sourceSnapshotId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
 *   workspace_root_uris, state, expires_at
 * FROM hosted_agent_source_snapshots WHERE source_snapshot_id = :sourceSnapshotId! FOR UPDATE
 * ```
 */
export const stateLockSourceById = new PreparedQuery<IStateLockSourceByIdParams,IStateLockSourceByIdResult>(stateLockSourceByIdIR);


/** 'StateLockSourceByChecksum' parameters type */
export interface IStateLockSourceByChecksumParams {
  checksum: string;
  tenantId: string;
}

/** 'StateLockSourceByChecksum' return type */
export interface IStateLockSourceByChecksumResult {
  archive_object_id: string;
  checksum: string;
  cwd_uri: string;
  expires_at: Date;
  source_snapshot_id: string;
  state: string;
  tenant_id: string;
  workspace_root_uris: Json;
}

/** 'StateLockSourceByChecksum' query type */
export interface IStateLockSourceByChecksumQuery {
  params: IStateLockSourceByChecksumParams;
  result: IStateLockSourceByChecksumResult;
}

const stateLockSourceByChecksumIR: any = {"usedParamSet":{"tenantId":true,"checksum":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":170,"b":179}]},{"name":"checksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":196,"b":205}]}],"statement":"SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,\n  workspace_root_uris, state, expires_at\nFROM hosted_agent_source_snapshots\nWHERE tenant_id = :tenantId! AND checksum = :checksum! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
 *   workspace_root_uris, state, expires_at
 * FROM hosted_agent_source_snapshots
 * WHERE tenant_id = :tenantId! AND checksum = :checksum! FOR UPDATE
 * ```
 */
export const stateLockSourceByChecksum = new PreparedQuery<IStateLockSourceByChecksumParams,IStateLockSourceByChecksumResult>(stateLockSourceByChecksumIR);


/** 'StateFindAuthorizedSource' parameters type */
export interface IStateFindAuthorizedSourceParams {
  at: DateOrString;
  sourceSnapshotId: string;
  tenantId: string;
}

/** 'StateFindAuthorizedSource' return type */
export interface IStateFindAuthorizedSourceResult {
  archive_object_id: string;
  checksum: string;
  cwd_uri: string;
  expires_at: Date;
  source_snapshot_id: string;
  state: string;
  tenant_id: string;
  workspace_root_uris: Json;
}

/** 'StateFindAuthorizedSource' query type */
export interface IStateFindAuthorizedSourceQuery {
  params: IStateFindAuthorizedSourceParams;
  result: IStateFindAuthorizedSourceResult;
}

const stateFindAuthorizedSourceIR: any = {"usedParamSet":{"sourceSnapshotId":true,"tenantId":true,"at":true},"params":[{"name":"sourceSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":179,"b":196}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":214,"b":223}]},{"name":"at","required":true,"transform":{"type":"scalar"},"locs":[{"a":268,"b":271}]}],"statement":"SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,\n  workspace_root_uris, state, expires_at\nFROM hosted_agent_source_snapshots\nWHERE source_snapshot_id = :sourceSnapshotId! AND tenant_id = :tenantId!\n  AND state = 'available' AND expires_at > :at!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
 *   workspace_root_uris, state, expires_at
 * FROM hosted_agent_source_snapshots
 * WHERE source_snapshot_id = :sourceSnapshotId! AND tenant_id = :tenantId!
 *   AND state = 'available' AND expires_at > :at!
 * ```
 */
export const stateFindAuthorizedSource = new PreparedQuery<IStateFindAuthorizedSourceParams,IStateFindAuthorizedSourceResult>(stateFindAuthorizedSourceIR);


/** 'StateLockAuthorizedSource' parameters type */
export interface IStateLockAuthorizedSourceParams {
  at: DateOrString;
  checksum: string;
  sourceSnapshotId: string;
  tenantId: string;
}

/** 'StateLockAuthorizedSource' return type */
export interface IStateLockAuthorizedSourceResult {
  archive_object_id: string;
  checksum: string;
  cwd_uri: string;
  expires_at: Date;
  source_snapshot_id: string;
  state: string;
  tenant_id: string;
  workspace_root_uris: Json;
}

/** 'StateLockAuthorizedSource' query type */
export interface IStateLockAuthorizedSourceQuery {
  params: IStateLockAuthorizedSourceParams;
  result: IStateLockAuthorizedSourceResult;
}

const stateLockAuthorizedSourceIR: any = {"usedParamSet":{"sourceSnapshotId":true,"tenantId":true,"checksum":true,"at":true},"params":[{"name":"sourceSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":179,"b":196}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":214,"b":223}]},{"name":"checksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":240,"b":249}]},{"name":"at","required":true,"transform":{"type":"scalar"},"locs":[{"a":294,"b":297}]}],"statement":"SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,\n  workspace_root_uris, state, expires_at\nFROM hosted_agent_source_snapshots\nWHERE source_snapshot_id = :sourceSnapshotId! AND tenant_id = :tenantId! AND checksum = :checksum!\n  AND state = 'available' AND expires_at > :at! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
 *   workspace_root_uris, state, expires_at
 * FROM hosted_agent_source_snapshots
 * WHERE source_snapshot_id = :sourceSnapshotId! AND tenant_id = :tenantId! AND checksum = :checksum!
 *   AND state = 'available' AND expires_at > :at! FOR UPDATE
 * ```
 */
export const stateLockAuthorizedSource = new PreparedQuery<IStateLockAuthorizedSourceParams,IStateLockAuthorizedSourceResult>(stateLockAuthorizedSourceIR);


/** 'StateFindAuthorizedSourceByChecksum' parameters type */
export interface IStateFindAuthorizedSourceByChecksumParams {
  at: DateOrString;
  checksum: string;
  tenantId: string;
}

/** 'StateFindAuthorizedSourceByChecksum' return type */
export interface IStateFindAuthorizedSourceByChecksumResult {
  archive_object_id: string;
  checksum: string;
  cwd_uri: string;
  expires_at: Date;
  source_snapshot_id: string;
  state: string;
  tenant_id: string;
  workspace_root_uris: Json;
}

/** 'StateFindAuthorizedSourceByChecksum' query type */
export interface IStateFindAuthorizedSourceByChecksumQuery {
  params: IStateFindAuthorizedSourceByChecksumParams;
  result: IStateFindAuthorizedSourceByChecksumResult;
}

const stateFindAuthorizedSourceByChecksumIR: any = {"usedParamSet":{"tenantId":true,"checksum":true,"at":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":170,"b":179}]},{"name":"checksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":196,"b":205}]},{"name":"at","required":true,"transform":{"type":"scalar"},"locs":[{"a":250,"b":253}]}],"statement":"SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,\n  workspace_root_uris, state, expires_at\nFROM hosted_agent_source_snapshots\nWHERE tenant_id = :tenantId! AND checksum = :checksum!\n  AND state = 'available' AND expires_at > :at!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
 *   workspace_root_uris, state, expires_at
 * FROM hosted_agent_source_snapshots
 * WHERE tenant_id = :tenantId! AND checksum = :checksum!
 *   AND state = 'available' AND expires_at > :at!
 * ```
 */
export const stateFindAuthorizedSourceByChecksum = new PreparedQuery<IStateFindAuthorizedSourceByChecksumParams,IStateFindAuthorizedSourceByChecksumResult>(stateFindAuthorizedSourceByChecksumIR);


/** 'StateUpsertObjectReference' parameters type */
export interface IStateUpsertObjectReferenceParams {
  objectId: string;
  purpose: string;
  referenceId: string;
  referenceKind: string;
  retainUntil?: DateOrString | null | void;
}

/** 'StateUpsertObjectReference' return type */
export type IStateUpsertObjectReferenceResult = void;

/** 'StateUpsertObjectReference' query type */
export interface IStateUpsertObjectReferenceQuery {
  params: IStateUpsertObjectReferenceParams;
  result: IStateUpsertObjectReferenceResult;
}

const stateUpsertObjectReferenceIR: any = {"usedParamSet":{"objectId":true,"referenceKind":true,"referenceId":true,"purpose":true,"retainUntil":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":118,"b":127}]},{"name":"referenceKind","required":true,"transform":{"type":"scalar"},"locs":[{"a":130,"b":144}]},{"name":"referenceId","required":true,"transform":{"type":"scalar"},"locs":[{"a":147,"b":159}]},{"name":"purpose","required":true,"transform":{"type":"scalar"},"locs":[{"a":162,"b":170}]},{"name":"retainUntil","required":false,"transform":{"type":"scalar"},"locs":[{"a":173,"b":184}]}],"statement":"INSERT INTO hosted_agent_object_references\n  (object_id, reference_kind, reference_id, purpose, retain_until)\nVALUES (:objectId!, :referenceKind!, :referenceId!, :purpose!, :retainUntil)\nON CONFLICT (object_id, reference_kind, reference_id, purpose)\nDO UPDATE SET retain_until = CASE\n  WHEN hosted_agent_object_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL\n  ELSE GREATEST(hosted_agent_object_references.retain_until, EXCLUDED.retain_until) END"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_object_references
 *   (object_id, reference_kind, reference_id, purpose, retain_until)
 * VALUES (:objectId!, :referenceKind!, :referenceId!, :purpose!, :retainUntil)
 * ON CONFLICT (object_id, reference_kind, reference_id, purpose)
 * DO UPDATE SET retain_until = CASE
 *   WHEN hosted_agent_object_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
 *   ELSE GREATEST(hosted_agent_object_references.retain_until, EXCLUDED.retain_until) END
 * ```
 */
export const stateUpsertObjectReference = new PreparedQuery<IStateUpsertObjectReferenceParams,IStateUpsertObjectReferenceResult>(stateUpsertObjectReferenceIR);


/** 'StateLockAvailableObject' parameters type */
export interface IStateLockAvailableObjectParams {
  expectedKind?: string | null | void;
  objectId: string;
  tenantId: string;
}

/** 'StateLockAvailableObject' return type */
export interface IStateLockAvailableObjectResult {
  found: number | null;
}

/** 'StateLockAvailableObject' query type */
export interface IStateLockAvailableObjectQuery {
  params: IStateLockAvailableObjectParams;
  result: IStateLockAvailableObjectResult;
}

const stateLockAvailableObjectIR: any = {"usedParamSet":{"objectId":true,"tenantId":true,"expectedKind":true},"params":[{"name":"objectId","required":true,"transform":{"type":"scalar"},"locs":[{"a":62,"b":71}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":89,"b":98}]},{"name":"expectedKind","required":false,"transform":{"type":"scalar"},"locs":[{"a":131,"b":143},{"a":169,"b":181}]}],"statement":"SELECT 1 AS found FROM hosted_agent_objects\nWHERE object_id = :objectId! AND tenant_id = :tenantId! AND state = 'available'\n  AND (:expectedKind::text IS NULL OR kind = :expectedKind)\nFOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS found FROM hosted_agent_objects
 * WHERE object_id = :objectId! AND tenant_id = :tenantId! AND state = 'available'
 *   AND (:expectedKind::text IS NULL OR kind = :expectedKind)
 * FOR UPDATE
 * ```
 */
export const stateLockAvailableObject = new PreparedQuery<IStateLockAvailableObjectParams,IStateLockAvailableObjectResult>(stateLockAvailableObjectIR);
