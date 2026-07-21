/** Types generated for queries found in "src/db/queries/patches.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type NumberOrString = number | string;

export type stringArray = (string)[];

/** 'ResolvePatchExportLease' parameters type */
export interface IResolvePatchExportLeaseParams {
  leaseId: string;
  tenantId: string;
}

/** 'ResolvePatchExportLease' return type */
export interface IResolvePatchExportLeaseResult {
  agent_id: string;
  base_snapshot_id: string | null;
  latest_snapshot_id: string | null;
  lease_id: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  source_snapshot_id: string | null;
  state: string;
}

/** 'ResolvePatchExportLease' query type */
export interface IResolvePatchExportLeaseQuery {
  params: IResolvePatchExportLeaseParams;
  result: IResolvePatchExportLeaseResult;
}

const resolvePatchExportLeaseIR: any = {"usedParamSet":{"tenantId":true,"leaseId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":168,"b":177}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":194,"b":202}]}],"statement":"SELECT lease_id, agent_id, owner_agent_id, owner_lease_id, source_snapshot_id,\n  base_snapshot_id, latest_snapshot_id, state\nFROM hosted_agent_leases WHERE tenant_id = :tenantId! AND lease_id = :leaseId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id, agent_id, owner_agent_id, owner_lease_id, source_snapshot_id,
 *   base_snapshot_id, latest_snapshot_id, state
 * FROM hosted_agent_leases WHERE tenant_id = :tenantId! AND lease_id = :leaseId!
 * ```
 */
export const resolvePatchExportLease = new PreparedQuery<IResolvePatchExportLeaseParams,IResolvePatchExportLeaseResult>(resolvePatchExportLeaseIR);


/** 'ResolvePatchExportSnapshotMaterial' parameters type */
export interface IResolvePatchExportSnapshotMaterialParams {
  leaseId: string;
  snapshotId: string;
  tenantId: string;
}

/** 'ResolvePatchExportSnapshotMaterial' return type */
export interface IResolvePatchExportSnapshotMaterialResult {
  checksum: string;
  kind: string;
  lease_id: string;
  manifest_checksum: string;
  manifest_object_id: string;
  object_expires_at: Date | null;
  object_id: string;
  object_state: string;
  purpose: string;
  size_bytes: string | null;
  snapshot_expires_at: Date | null;
  snapshot_id: string;
  snapshot_state: string;
  storage_bucket: string;
  storage_key: string;
}

/** 'ResolvePatchExportSnapshotMaterial' query type */
export interface IResolvePatchExportSnapshotMaterialQuery {
  params: IResolvePatchExportSnapshotMaterialParams;
  result: IResolvePatchExportSnapshotMaterialResult;
}

const resolvePatchExportSnapshotMaterialIR: any = {"usedParamSet":{"tenantId":true,"leaseId":true,"snapshotId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":774,"b":783}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":809,"b":817}]},{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":846,"b":857}]}],"statement":"SELECT snapshot.snapshot_id, snapshot.lease_id, snapshot.manifest_object_id,\n  snapshot.manifest_checksum, snapshot.state AS snapshot_state,\n  snapshot.expires_at AS snapshot_expires_at,\n  object_row.object_id, object_row.kind, object_row.storage_bucket,\n  object_row.storage_key, object_row.checksum, object_row.size_bytes::text,\n  object_row.state AS object_state, object_row.expires_at AS object_expires_at,\n  reference.purpose\nFROM hosted_agent_snapshots AS snapshot\nJOIN hosted_agent_object_references AS reference\n  ON reference.reference_kind = 'snapshot' AND reference.reference_id = snapshot.snapshot_id\nJOIN hosted_agent_objects AS object_row\n  ON object_row.object_id = reference.object_id AND object_row.tenant_id = snapshot.tenant_id\nWHERE snapshot.tenant_id = :tenantId! AND snapshot.lease_id = :leaseId! AND snapshot.snapshot_id = :snapshotId!\n  AND reference.purpose IN ('manifest', 'content_blob')\nORDER BY object_row.object_id"};

/**
 * Query generated from SQL:
 * ```
 * SELECT snapshot.snapshot_id, snapshot.lease_id, snapshot.manifest_object_id,
 *   snapshot.manifest_checksum, snapshot.state AS snapshot_state,
 *   snapshot.expires_at AS snapshot_expires_at,
 *   object_row.object_id, object_row.kind, object_row.storage_bucket,
 *   object_row.storage_key, object_row.checksum, object_row.size_bytes::text,
 *   object_row.state AS object_state, object_row.expires_at AS object_expires_at,
 *   reference.purpose
 * FROM hosted_agent_snapshots AS snapshot
 * JOIN hosted_agent_object_references AS reference
 *   ON reference.reference_kind = 'snapshot' AND reference.reference_id = snapshot.snapshot_id
 * JOIN hosted_agent_objects AS object_row
 *   ON object_row.object_id = reference.object_id AND object_row.tenant_id = snapshot.tenant_id
 * WHERE snapshot.tenant_id = :tenantId! AND snapshot.lease_id = :leaseId! AND snapshot.snapshot_id = :snapshotId!
 *   AND reference.purpose IN ('manifest', 'content_blob')
 * ORDER BY object_row.object_id
 * ```
 */
export const resolvePatchExportSnapshotMaterial = new PreparedQuery<IResolvePatchExportSnapshotMaterialParams,IResolvePatchExportSnapshotMaterialResult>(resolvePatchExportSnapshotMaterialIR);


/** 'LockPatchApplyTarget' parameters type */
export interface ILockPatchApplyTargetParams {
  leaseId: string;
  tenantId: string;
}

/** 'LockPatchApplyTarget' return type */
export interface ILockPatchApplyTargetResult {
  agent_id: string;
  latest_snapshot_id: string | null;
  lease_id: string;
  provider_sandbox_id: string | null;
  state: string;
}

/** 'LockPatchApplyTarget' query type */
export interface ILockPatchApplyTargetQuery {
  params: ILockPatchApplyTargetParams;
  result: ILockPatchApplyTargetResult;
}

const lockPatchApplyTargetIR: any = {"usedParamSet":{"tenantId":true,"leaseId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":117,"b":126}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":143,"b":151}]}],"statement":"SELECT lease_id, agent_id, provider_sandbox_id, latest_snapshot_id, state\nFROM hosted_agent_leases WHERE tenant_id = :tenantId! AND lease_id = :leaseId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT lease_id, agent_id, provider_sandbox_id, latest_snapshot_id, state
 * FROM hosted_agent_leases WHERE tenant_id = :tenantId! AND lease_id = :leaseId! FOR UPDATE
 * ```
 */
export const lockPatchApplyTarget = new PreparedQuery<ILockPatchApplyTargetParams,ILockPatchApplyTargetResult>(lockPatchApplyTargetIR);


/** 'SharePatchApplyArtifact' parameters type */
export interface ISharePatchApplyArtifactParams {
  artifactId: string;
  tenantId: string;
}

/** 'SharePatchApplyArtifact' return type */
export interface ISharePatchApplyArtifactResult {
  agent_id: string;
  artifact_id: string;
  artifact_object_id: string;
  base_manifest_object_id: string;
  base_snapshot_id: string;
  changed_files: number;
  checksum: string;
  current_manifest_object_id: string;
  current_snapshot_id: string;
  expires_at: Date;
  size_bytes: string | null;
  source_agent_id: string;
  source_lease_id: string;
  source_owner_agent_id: string | null;
  source_owner_lease_id: string | null;
  state: string;
}

/** 'SharePatchApplyArtifact' query type */
export interface ISharePatchApplyArtifactQuery {
  params: ISharePatchApplyArtifactParams;
  result: ISharePatchApplyArtifactResult;
}

const sharePatchApplyArtifactIR: any = {"usedParamSet":{"tenantId":true,"artifactId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":659,"b":668}]},{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":697,"b":708}]}],"statement":"SELECT artifact.artifact_id, artifact.agent_id, artifact.source_lease_id,\n artifact.base_snapshot_id, artifact.current_snapshot_id, artifact.base_manifest_object_id,\n artifact.current_manifest_object_id, artifact.artifact_object_id, artifact.checksum,\n artifact.changed_files, artifact.size_bytes::text, artifact.state, artifact.expires_at,\n source.agent_id AS source_agent_id, source.owner_agent_id AS source_owner_agent_id,\n source.owner_lease_id AS source_owner_lease_id\nFROM hosted_agent_artifacts artifact JOIN hosted_agent_leases source\n ON source.lease_id = artifact.source_lease_id AND source.tenant_id = artifact.tenant_id\nWHERE artifact.tenant_id = :tenantId! AND artifact.artifact_id = :artifactId!\nFOR SHARE OF artifact, source"};

/**
 * Query generated from SQL:
 * ```
 * SELECT artifact.artifact_id, artifact.agent_id, artifact.source_lease_id,
 *  artifact.base_snapshot_id, artifact.current_snapshot_id, artifact.base_manifest_object_id,
 *  artifact.current_manifest_object_id, artifact.artifact_object_id, artifact.checksum,
 *  artifact.changed_files, artifact.size_bytes::text, artifact.state, artifact.expires_at,
 *  source.agent_id AS source_agent_id, source.owner_agent_id AS source_owner_agent_id,
 *  source.owner_lease_id AS source_owner_lease_id
 * FROM hosted_agent_artifacts artifact JOIN hosted_agent_leases source
 *  ON source.lease_id = artifact.source_lease_id AND source.tenant_id = artifact.tenant_id
 * WHERE artifact.tenant_id = :tenantId! AND artifact.artifact_id = :artifactId!
 * FOR SHARE OF artifact, source
 * ```
 */
export const sharePatchApplyArtifact = new PreparedQuery<ISharePatchApplyArtifactParams,ISharePatchApplyArtifactResult>(sharePatchApplyArtifactIR);


/** 'HasRetainedPatchArtifact' parameters type */
export interface IHasRetainedPatchArtifactParams {
  artifactId: string;
}

/** 'HasRetainedPatchArtifact' return type */
export interface IHasRetainedPatchArtifactResult {
  retained: number | null;
}

/** 'HasRetainedPatchArtifact' query type */
export interface IHasRetainedPatchArtifactQuery {
  params: IHasRetainedPatchArtifactParams;
  result: IHasRetainedPatchArtifactResult;
}

const hasRetainedPatchArtifactIR: any = {"usedParamSet":{"artifactId":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":79,"b":90}]}],"statement":"SELECT 1 AS retained FROM hosted_agent_artifact_references\nWHERE artifact_id = :artifactId! AND reference_kind = 'codex_thread' LIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS retained FROM hosted_agent_artifact_references
 * WHERE artifact_id = :artifactId! AND reference_kind = 'codex_thread' LIMIT 1
 * ```
 */
export const hasRetainedPatchArtifact = new PreparedQuery<IHasRetainedPatchArtifactParams,IHasRetainedPatchArtifactResult>(hasRetainedPatchArtifactIR);


/** 'SharePatchArtifactOwnership' parameters type */
export interface ISharePatchArtifactOwnershipParams {
  artifactId: string;
}

/** 'SharePatchArtifactOwnership' return type */
export interface ISharePatchArtifactOwnershipResult {
  reference_id: string;
  reference_kind: string;
  retain_until: Date | null;
}

/** 'SharePatchArtifactOwnership' query type */
export interface ISharePatchArtifactOwnershipQuery {
  params: ISharePatchArtifactOwnershipParams;
  result: ISharePatchArtifactOwnershipResult;
}

const sharePatchArtifactOwnershipIR: any = {"usedParamSet":{"artifactId":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":108,"b":119}]}],"statement":"SELECT reference_kind, reference_id, retain_until FROM hosted_agent_artifact_references\nWHERE artifact_id = :artifactId! AND reference_kind = 'owner_agent' FOR SHARE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT reference_kind, reference_id, retain_until FROM hosted_agent_artifact_references
 * WHERE artifact_id = :artifactId! AND reference_kind = 'owner_agent' FOR SHARE
 * ```
 */
export const sharePatchArtifactOwnership = new PreparedQuery<ISharePatchArtifactOwnershipParams,ISharePatchArtifactOwnershipResult>(sharePatchArtifactOwnershipIR);


/** 'SharePatchApplySnapshots' parameters type */
export interface ISharePatchApplySnapshotsParams {
  snapshotIds: stringArray;
  tenantId: string;
}

/** 'SharePatchApplySnapshots' return type */
export interface ISharePatchApplySnapshotsResult {
  expires_at: Date | null;
  lease_id: string;
  manifest_checksum: string;
  manifest_object_id: string;
  snapshot_id: string;
  state: string;
  workspace_archive_object_id: string;
}

/** 'SharePatchApplySnapshots' query type */
export interface ISharePatchApplySnapshotsQuery {
  params: ISharePatchApplySnapshotsParams;
  result: ISharePatchApplySnapshotsResult;
}

const sharePatchApplySnapshotsIR: any = {"usedParamSet":{"tenantId":true,"snapshotIds":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":163,"b":172}]},{"name":"snapshotIds","required":true,"transform":{"type":"scalar"},"locs":[{"a":196,"b":208}]}],"statement":"SELECT snapshot_id, lease_id, workspace_archive_object_id, manifest_object_id,\n manifest_checksum, state, expires_at FROM hosted_agent_snapshots\nWHERE tenant_id = :tenantId! AND snapshot_id = ANY(:snapshotIds!::text[]) FOR SHARE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT snapshot_id, lease_id, workspace_archive_object_id, manifest_object_id,
 *  manifest_checksum, state, expires_at FROM hosted_agent_snapshots
 * WHERE tenant_id = :tenantId! AND snapshot_id = ANY(:snapshotIds!::text[]) FOR SHARE
 * ```
 */
export const sharePatchApplySnapshots = new PreparedQuery<ISharePatchApplySnapshotsParams,ISharePatchApplySnapshotsResult>(sharePatchApplySnapshotsIR);


/** 'SharePatchArtifactSnapshotReferences' parameters type */
export interface ISharePatchArtifactSnapshotReferencesParams {
  artifactId: string;
}

/** 'SharePatchArtifactSnapshotReferences' return type */
export interface ISharePatchArtifactSnapshotReferencesResult {
  reference_kind: string;
  retain_until: Date | null;
  snapshot_id: string;
}

/** 'SharePatchArtifactSnapshotReferences' query type */
export interface ISharePatchArtifactSnapshotReferencesQuery {
  params: ISharePatchArtifactSnapshotReferencesParams;
  result: ISharePatchArtifactSnapshotReferencesResult;
}

const sharePatchArtifactSnapshotReferencesIR: any = {"usedParamSet":{"artifactId":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":108,"b":119}]}],"statement":"SELECT snapshot_id, reference_kind, retain_until FROM hosted_agent_snapshot_references\nWHERE reference_id = :artifactId! AND reference_kind IN ('artifact_base', 'artifact_current') FOR SHARE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT snapshot_id, reference_kind, retain_until FROM hosted_agent_snapshot_references
 * WHERE reference_id = :artifactId! AND reference_kind IN ('artifact_base', 'artifact_current') FOR SHARE
 * ```
 */
export const sharePatchArtifactSnapshotReferences = new PreparedQuery<ISharePatchArtifactSnapshotReferencesParams,ISharePatchArtifactSnapshotReferencesResult>(sharePatchArtifactSnapshotReferencesIR);


/** 'SharePatchApplySnapshot' parameters type */
export interface ISharePatchApplySnapshotParams {
  snapshotId: string;
  tenantId: string;
}

/** 'SharePatchApplySnapshot' return type */
export interface ISharePatchApplySnapshotResult {
  expires_at: Date | null;
  lease_id: string;
  manifest_checksum: string;
  manifest_object_id: string;
  snapshot_id: string;
  state: string;
  workspace_archive_object_id: string;
}

/** 'SharePatchApplySnapshot' query type */
export interface ISharePatchApplySnapshotQuery {
  params: ISharePatchApplySnapshotParams;
  result: ISharePatchApplySnapshotResult;
}

const sharePatchApplySnapshotIR: any = {"usedParamSet":{"tenantId":true,"snapshotId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":163,"b":172}]},{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":192,"b":203}]}],"statement":"SELECT snapshot_id, lease_id, workspace_archive_object_id, manifest_object_id,\n manifest_checksum, state, expires_at FROM hosted_agent_snapshots\nWHERE tenant_id = :tenantId! AND snapshot_id = :snapshotId! FOR SHARE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT snapshot_id, lease_id, workspace_archive_object_id, manifest_object_id,
 *  manifest_checksum, state, expires_at FROM hosted_agent_snapshots
 * WHERE tenant_id = :tenantId! AND snapshot_id = :snapshotId! FOR SHARE
 * ```
 */
export const sharePatchApplySnapshot = new PreparedQuery<ISharePatchApplySnapshotParams,ISharePatchApplySnapshotResult>(sharePatchApplySnapshotIR);


/** 'HasLatestSnapshotReference' parameters type */
export interface IHasLatestSnapshotReferenceParams {
  leaseId: string;
  snapshotId: string;
}

/** 'HasLatestSnapshotReference' return type */
export interface IHasLatestSnapshotReferenceResult {
  retained: number | null;
}

/** 'HasLatestSnapshotReference' query type */
export interface IHasLatestSnapshotReferenceQuery {
  params: IHasLatestSnapshotReferenceParams;
  result: IHasLatestSnapshotReferenceResult;
}

const hasLatestSnapshotReferenceIR: any = {"usedParamSet":{"snapshotId":true,"leaseId":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":79,"b":90}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":147,"b":155}]}],"statement":"SELECT 1 AS retained FROM hosted_agent_snapshot_references\nWHERE snapshot_id = :snapshotId! AND reference_kind = 'lease_latest' AND reference_id = :leaseId! FOR SHARE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS retained FROM hosted_agent_snapshot_references
 * WHERE snapshot_id = :snapshotId! AND reference_kind = 'lease_latest' AND reference_id = :leaseId! FOR SHARE
 * ```
 */
export const hasLatestSnapshotReference = new PreparedQuery<IHasLatestSnapshotReferenceParams,IHasLatestSnapshotReferenceResult>(hasLatestSnapshotReferenceIR);


/** 'SharePatchApplyObjectReferences' parameters type */
export interface ISharePatchApplyObjectReferencesParams {
  referenceId: string;
  referenceKind: string;
  tenantId: string;
}

/** 'SharePatchApplyObjectReferences' return type */
export interface ISharePatchApplyObjectReferencesResult {
  checksum: string;
  expires_at: Date | null;
  kind: string;
  object_id: string;
  purpose: string;
  retain_until: Date | null;
  size_bytes: string | null;
  state: string;
  storage_bucket: string;
  storage_key: string;
}

/** 'SharePatchApplyObjectReferences' query type */
export interface ISharePatchApplyObjectReferencesQuery {
  params: ISharePatchApplyObjectReferencesParams;
  result: ISharePatchApplyObjectReferencesResult;
}

const sharePatchApplyObjectReferencesIR: any = {"usedParamSet":{"tenantId":true,"referenceKind":true,"referenceId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":391,"b":400}]},{"name":"referenceKind","required":true,"transform":{"type":"scalar"},"locs":[{"a":433,"b":447}]},{"name":"referenceId","required":true,"transform":{"type":"scalar"},"locs":[{"a":479,"b":491}]}],"statement":"SELECT reference.purpose, reference.retain_until, object_row.object_id,\n object_row.kind, object_row.storage_bucket, object_row.storage_key, object_row.checksum,\n object_row.size_bytes::text, object_row.state, object_row.expires_at\nFROM hosted_agent_object_references reference JOIN hosted_agent_objects object_row\n ON object_row.object_id = reference.object_id\nWHERE object_row.tenant_id = :tenantId! AND reference.reference_kind = :referenceKind!\n AND reference.reference_id = :referenceId!\nORDER BY reference.purpose, object_row.object_id FOR SHARE OF object_row, reference"};

/**
 * Query generated from SQL:
 * ```
 * SELECT reference.purpose, reference.retain_until, object_row.object_id,
 *  object_row.kind, object_row.storage_bucket, object_row.storage_key, object_row.checksum,
 *  object_row.size_bytes::text, object_row.state, object_row.expires_at
 * FROM hosted_agent_object_references reference JOIN hosted_agent_objects object_row
 *  ON object_row.object_id = reference.object_id
 * WHERE object_row.tenant_id = :tenantId! AND reference.reference_kind = :referenceKind!
 *  AND reference.reference_id = :referenceId!
 * ORDER BY reference.purpose, object_row.object_id FOR SHARE OF object_row, reference
 * ```
 */
export const sharePatchApplyObjectReferences = new PreparedQuery<ISharePatchApplyObjectReferencesParams,ISharePatchApplyObjectReferencesResult>(sharePatchApplyObjectReferencesIR);


/** 'CreatePatchApplication' parameters type */
export interface ICreatePatchApplicationParams {
  applicationId: string;
  artifactId: string;
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  resultArchiveChecksum: string;
  resultArchiveSizeBytes: NumberOrString;
  resultManifestChecksum: string;
  resultSnapshotId: string;
  sourceTargetSnapshotId: string;
  targetLeaseId: string;
  targetProviderSandboxId: string;
  tenantId: string;
  workerId: string;
}

/** 'CreatePatchApplication' return type */
export type ICreatePatchApplicationResult = void;

/** 'CreatePatchApplication' query type */
export interface ICreatePatchApplicationQuery {
  params: ICreatePatchApplicationParams;
  result: ICreatePatchApplicationResult;
}

const createPatchApplicationIR: any = {"usedParamSet":{"applicationId":true,"generation":true,"targetLeaseId":true,"artifactId":true,"sourceTargetSnapshotId":true,"targetProviderSandboxId":true,"resultSnapshotId":true,"resultManifestChecksum":true,"resultArchiveChecksum":true,"resultArchiveSizeBytes":true,"operation":true,"idempotencyKey":true,"tenantId":true,"workerId":true},"params":[{"name":"applicationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":320,"b":334}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":376,"b":387},{"a":718,"b":729}]},{"name":"targetLeaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":390,"b":404},{"a":802,"b":816}]},{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":408,"b":419}]},{"name":"sourceTargetSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":422,"b":445}]},{"name":"targetProviderSandboxId","required":true,"transform":{"type":"scalar"},"locs":[{"a":448,"b":472}]},{"name":"resultSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":475,"b":492}]},{"name":"resultManifestChecksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":496,"b":519}]},{"name":"resultArchiveChecksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":522,"b":544}]},{"name":"resultArchiveSizeBytes","required":true,"transform":{"type":"scalar"},"locs":[{"a":547,"b":570}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":628,"b":638}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":660,"b":675}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":692,"b":701}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":745,"b":754}]}],"statement":"INSERT INTO hosted_agent_patch_applications\n (application_id, operation, idempotency_key, tenant_id, created_generation, target_lease_id,\n artifact_id, source_target_snapshot_id, target_provider_sandbox_id, result_snapshot_id,\n result_manifest_checksum, result_archive_checksum, result_archive_size_bytes, phase)\nSELECT :applicationId!, operation, idempotency_key, tenant_id, :generation!, :targetLeaseId!,\n :artifactId!, :sourceTargetSnapshotId!, :targetProviderSandboxId!, :resultSnapshotId!,\n :resultManifestChecksum!, :resultArchiveChecksum!, :resultArchiveSizeBytes!, 'planned'\nFROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!\n AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId!\n AND state='in_progress' AND primary_lease_id=:targetLeaseId! ON CONFLICT DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO hosted_agent_patch_applications
 *  (application_id, operation, idempotency_key, tenant_id, created_generation, target_lease_id,
 *  artifact_id, source_target_snapshot_id, target_provider_sandbox_id, result_snapshot_id,
 *  result_manifest_checksum, result_archive_checksum, result_archive_size_bytes, phase)
 * SELECT :applicationId!, operation, idempotency_key, tenant_id, :generation!, :targetLeaseId!,
 *  :artifactId!, :sourceTargetSnapshotId!, :targetProviderSandboxId!, :resultSnapshotId!,
 *  :resultManifestChecksum!, :resultArchiveChecksum!, :resultArchiveSizeBytes!, 'planned'
 * FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!
 *  AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId!
 *  AND state='in_progress' AND primary_lease_id=:targetLeaseId! ON CONFLICT DO NOTHING
 * ```
 */
export const createPatchApplication = new PreparedQuery<ICreatePatchApplicationParams,ICreatePatchApplicationResult>(createPatchApplicationIR);


/** 'OwnsPatchApplicationOperation' parameters type */
export interface IOwnsPatchApplicationOperationParams {
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'OwnsPatchApplicationOperation' return type */
export interface IOwnsPatchApplicationOperationResult {
  owned: number | null;
}

/** 'OwnsPatchApplicationOperation' query type */
export interface IOwnsPatchApplicationOperationQuery {
  params: IOwnsPatchApplicationOperationParams;
  result: IOwnsPatchApplicationOperationResult;
}

const ownsPatchApplicationOperationIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":63,"b":73}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":95,"b":110}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":127,"b":136}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":153,"b":164}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":180,"b":189}]}],"statement":"SELECT 1 AS owned FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!\n AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress' FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS owned FROM hosted_agent_operations WHERE operation=:operation! AND idempotency_key=:idempotencyKey!
 *  AND tenant_id=:tenantId! AND generation=:generation! AND worker_id=:workerId! AND state='in_progress' FOR UPDATE
 * ```
 */
export const ownsPatchApplicationOperation = new PreparedQuery<IOwnsPatchApplicationOperationParams,IOwnsPatchApplicationOperationResult>(ownsPatchApplicationOperationIR);


/** 'GetPatchApplicationForOperation' parameters type */
export interface IGetPatchApplicationForOperationParams {
  idempotencyKey: string;
  operation: string;
  tenantId: string;
}

/** 'GetPatchApplicationForOperation' return type */
export interface IGetPatchApplicationForOperationResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string | null;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string | null;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'GetPatchApplicationForOperation' query type */
export interface IGetPatchApplicationForOperationQuery {
  params: IGetPatchApplicationForOperationParams;
  result: IGetPatchApplicationForOperationResult;
}

const getPatchApplicationForOperationIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":874,"b":884}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":919,"b":934}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":962,"b":971}]}],"statement":"SELECT application.application_id,application.operation,application.idempotency_key,application.tenant_id,\n application.created_generation::text,application.target_lease_id,application.artifact_id,\n application.source_target_snapshot_id,application.target_provider_sandbox_id,application.result_snapshot_id,\n application.result_manifest_checksum,application.result_archive_checksum,application.result_archive_size_bytes::text,\n application.rollback_allocation_id::text,application.rollback_provider_snapshot_id,application.phase,\n application.error_message,application.created_at,application.updated_at,application.rollback_ready_at,\n application.swap_started_at,application.swapped_at,application.checkpointed_at,\n application.rollback_started_at,application.rolled_back_at,application.failed_at\nFROM hosted_agent_patch_applications application WHERE application.operation=:operation!\n AND application.idempotency_key=:idempotencyKey! AND application.tenant_id=:tenantId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT application.application_id,application.operation,application.idempotency_key,application.tenant_id,
 *  application.created_generation::text,application.target_lease_id,application.artifact_id,
 *  application.source_target_snapshot_id,application.target_provider_sandbox_id,application.result_snapshot_id,
 *  application.result_manifest_checksum,application.result_archive_checksum,application.result_archive_size_bytes::text,
 *  application.rollback_allocation_id::text,application.rollback_provider_snapshot_id,application.phase,
 *  application.error_message,application.created_at,application.updated_at,application.rollback_ready_at,
 *  application.swap_started_at,application.swapped_at,application.checkpointed_at,
 *  application.rollback_started_at,application.rolled_back_at,application.failed_at
 * FROM hosted_agent_patch_applications application WHERE application.operation=:operation!
 *  AND application.idempotency_key=:idempotencyKey! AND application.tenant_id=:tenantId!
 * ```
 */
export const getPatchApplicationForOperation = new PreparedQuery<IGetPatchApplicationForOperationParams,IGetPatchApplicationForOperationResult>(getPatchApplicationForOperationIR);


/** 'LockPatchApplication' parameters type */
export interface ILockPatchApplicationParams {
  applicationId: string;
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'LockPatchApplication' return type */
export interface ILockPatchApplicationResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string | null;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string | null;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'LockPatchApplication' query type */
export interface ILockPatchApplicationQuery {
  params: ILockPatchApplicationParams;
  result: ILockPatchApplicationResult;
}

const lockPatchApplicationIR: any = {"usedParamSet":{"applicationId":true,"tenantId":true,"operation":true,"idempotencyKey":true,"generation":true,"workerId":true},"params":[{"name":"applicationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":962,"b":976}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":1005,"b":1014}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":1040,"b":1050}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":1083,"b":1098}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":1125,"b":1136}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":1163,"b":1172}]}],"statement":"SELECT application.application_id,application.operation,application.idempotency_key,application.tenant_id,\n application.created_generation::text,application.target_lease_id,application.artifact_id,\n application.source_target_snapshot_id,application.target_provider_sandbox_id,application.result_snapshot_id,\n application.result_manifest_checksum,application.result_archive_checksum,application.result_archive_size_bytes::text,\n application.rollback_allocation_id::text,application.rollback_provider_snapshot_id,application.phase,\n application.error_message,application.created_at,application.updated_at,application.rollback_ready_at,\n application.swap_started_at,application.swapped_at,application.checkpointed_at,\n application.rollback_started_at,application.rolled_back_at,application.failed_at\nFROM hosted_agent_patch_applications application JOIN hosted_agent_operations operation\n USING(operation,idempotency_key,tenant_id) WHERE application.application_id=:applicationId!\n AND application.tenant_id=:tenantId! AND operation.operation=:operation!\n AND operation.idempotency_key=:idempotencyKey! AND operation.generation=:generation!\n AND operation.worker_id=:workerId! AND operation.state='in_progress' FOR UPDATE OF application,operation"};

/**
 * Query generated from SQL:
 * ```
 * SELECT application.application_id,application.operation,application.idempotency_key,application.tenant_id,
 *  application.created_generation::text,application.target_lease_id,application.artifact_id,
 *  application.source_target_snapshot_id,application.target_provider_sandbox_id,application.result_snapshot_id,
 *  application.result_manifest_checksum,application.result_archive_checksum,application.result_archive_size_bytes::text,
 *  application.rollback_allocation_id::text,application.rollback_provider_snapshot_id,application.phase,
 *  application.error_message,application.created_at,application.updated_at,application.rollback_ready_at,
 *  application.swap_started_at,application.swapped_at,application.checkpointed_at,
 *  application.rollback_started_at,application.rolled_back_at,application.failed_at
 * FROM hosted_agent_patch_applications application JOIN hosted_agent_operations operation
 *  USING(operation,idempotency_key,tenant_id) WHERE application.application_id=:applicationId!
 *  AND application.tenant_id=:tenantId! AND operation.operation=:operation!
 *  AND operation.idempotency_key=:idempotencyKey! AND operation.generation=:generation!
 *  AND operation.worker_id=:workerId! AND operation.state='in_progress' FOR UPDATE OF application,operation
 * ```
 */
export const lockPatchApplication = new PreparedQuery<ILockPatchApplicationParams,ILockPatchApplicationResult>(lockPatchApplicationIR);


/** 'LockPatchApplicationForOperation' parameters type */
export interface ILockPatchApplicationForOperationParams {
  generation: NumberOrString;
  idempotencyKey: string;
  operation: string;
  tenantId: string;
  workerId: string;
}

/** 'LockPatchApplicationForOperation' return type */
export interface ILockPatchApplicationForOperationResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string | null;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string | null;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'LockPatchApplicationForOperation' query type */
export interface ILockPatchApplicationForOperationQuery {
  params: ILockPatchApplicationForOperationParams;
  result: ILockPatchApplicationForOperationResult;
}

const lockPatchApplicationForOperationIR: any = {"usedParamSet":{"operation":true,"idempotencyKey":true,"tenantId":true,"generation":true,"workerId":true},"params":[{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":955,"b":965}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":998,"b":1013}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":1039,"b":1048}]},{"name":"generation","required":true,"transform":{"type":"scalar"},"locs":[{"a":1076,"b":1087}]},{"name":"workerId","required":true,"transform":{"type":"scalar"},"locs":[{"a":1113,"b":1122}]}],"statement":"SELECT application.application_id,application.operation,application.idempotency_key,application.tenant_id,\n application.created_generation::text,application.target_lease_id,application.artifact_id,\n application.source_target_snapshot_id,application.target_provider_sandbox_id,application.result_snapshot_id,\n application.result_manifest_checksum,application.result_archive_checksum,application.result_archive_size_bytes::text,\n application.rollback_allocation_id::text,application.rollback_provider_snapshot_id,application.phase,\n application.error_message,application.created_at,application.updated_at,application.rollback_ready_at,\n application.swap_started_at,application.swapped_at,application.checkpointed_at,\n application.rollback_started_at,application.rolled_back_at,application.failed_at\nFROM hosted_agent_patch_applications application JOIN hosted_agent_operations operation\n USING(operation,idempotency_key,tenant_id) WHERE operation.operation=:operation!\n AND operation.idempotency_key=:idempotencyKey! AND operation.tenant_id=:tenantId!\n AND operation.generation=:generation! AND operation.worker_id=:workerId!\n AND operation.state='in_progress' FOR UPDATE OF application,operation"};

/**
 * Query generated from SQL:
 * ```
 * SELECT application.application_id,application.operation,application.idempotency_key,application.tenant_id,
 *  application.created_generation::text,application.target_lease_id,application.artifact_id,
 *  application.source_target_snapshot_id,application.target_provider_sandbox_id,application.result_snapshot_id,
 *  application.result_manifest_checksum,application.result_archive_checksum,application.result_archive_size_bytes::text,
 *  application.rollback_allocation_id::text,application.rollback_provider_snapshot_id,application.phase,
 *  application.error_message,application.created_at,application.updated_at,application.rollback_ready_at,
 *  application.swap_started_at,application.swapped_at,application.checkpointed_at,
 *  application.rollback_started_at,application.rolled_back_at,application.failed_at
 * FROM hosted_agent_patch_applications application JOIN hosted_agent_operations operation
 *  USING(operation,idempotency_key,tenant_id) WHERE operation.operation=:operation!
 *  AND operation.idempotency_key=:idempotencyKey! AND operation.tenant_id=:tenantId!
 *  AND operation.generation=:generation! AND operation.worker_id=:workerId!
 *  AND operation.state='in_progress' FOR UPDATE OF application,operation
 * ```
 */
export const lockPatchApplicationForOperation = new PreparedQuery<ILockPatchApplicationForOperationParams,ILockPatchApplicationForOperationResult>(lockPatchApplicationForOperationIR);


/** 'ValidatePatchRollbackAllocation' parameters type */
export interface IValidatePatchRollbackAllocationParams {
  allocationId: NumberOrString;
  idempotencyKey: string;
  leaseId: string;
  operation: string;
  providerSnapshotId: string;
  tenantId: string;
}

/** 'ValidatePatchRollbackAllocation' return type */
export interface IValidatePatchRollbackAllocationResult {
  valid: number | null;
}

/** 'ValidatePatchRollbackAllocation' query type */
export interface IValidatePatchRollbackAllocationQuery {
  params: IValidatePatchRollbackAllocationParams;
  result: IValidatePatchRollbackAllocationResult;
}

const validatePatchRollbackAllocationIR: any = {"usedParamSet":{"allocationId":true,"operation":true,"idempotencyKey":true,"tenantId":true,"providerSnapshotId":true,"leaseId":true},"params":[{"name":"allocationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":78,"b":91}]},{"name":"operation","required":true,"transform":{"type":"scalar"},"locs":[{"a":116,"b":126}]},{"name":"idempotencyKey","required":true,"transform":{"type":"scalar"},"locs":[{"a":148,"b":163}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":179,"b":188}]},{"name":"providerSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":247,"b":266}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":281,"b":289}]}],"statement":"SELECT 1 AS valid FROM hosted_agent_operation_allocations WHERE allocation_id=:allocationId!::bigint\n AND operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId!\n AND allocation_kind='provider_snapshot' AND resource_id=:providerSnapshotId! AND lease_id=:leaseId!\n AND state='allocated' AND metadata->>'purpose'='patch_apply_rollback' FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS valid FROM hosted_agent_operation_allocations WHERE allocation_id=:allocationId!::bigint
 *  AND operation=:operation! AND idempotency_key=:idempotencyKey! AND tenant_id=:tenantId!
 *  AND allocation_kind='provider_snapshot' AND resource_id=:providerSnapshotId! AND lease_id=:leaseId!
 *  AND state='allocated' AND metadata->>'purpose'='patch_apply_rollback' FOR UPDATE
 * ```
 */
export const validatePatchRollbackAllocation = new PreparedQuery<IValidatePatchRollbackAllocationParams,IValidatePatchRollbackAllocationResult>(validatePatchRollbackAllocationIR);


/** 'ValidatePatchApplicationCheckpoint' parameters type */
export interface IValidatePatchApplicationCheckpointParams {
  archiveChecksum: string;
  archiveSizeBytes: NumberOrString;
  leaseId: string;
  manifestChecksum: string;
  snapshotId: string;
  tenantId: string;
}

/** 'ValidatePatchApplicationCheckpoint' return type */
export interface IValidatePatchApplicationCheckpointResult {
  valid: number | null;
}

/** 'ValidatePatchApplicationCheckpoint' query type */
export interface IValidatePatchApplicationCheckpointQuery {
  params: IValidatePatchApplicationCheckpointParams;
  result: IValidatePatchApplicationCheckpointResult;
}

const validatePatchApplicationCheckpointIR: any = {"usedParamSet":{"snapshotId":true,"leaseId":true,"tenantId":true,"manifestChecksum":true,"archiveChecksum":true,"archiveSizeBytes":true},"params":[{"name":"snapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":323,"b":334}]},{"name":"leaseId","required":true,"transform":{"type":"scalar"},"locs":[{"a":358,"b":366}]},{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":391,"b":400}]},{"name":"manifestChecksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":465,"b":482}]},{"name":"archiveChecksum","required":true,"transform":{"type":"scalar"},"locs":[{"a":662,"b":678}]},{"name":"archiveSizeBytes","required":true,"transform":{"type":"scalar"},"locs":[{"a":704,"b":721}]}],"statement":"SELECT 1 AS valid FROM hosted_agent_snapshots snapshot JOIN hosted_agent_leases lease\n ON lease.lease_id=snapshot.lease_id AND lease.tenant_id=snapshot.tenant_id JOIN hosted_agent_objects archive\n ON archive.object_id=snapshot.workspace_archive_object_id AND archive.tenant_id=snapshot.tenant_id\nWHERE snapshot.snapshot_id=:snapshotId! AND snapshot.lease_id=:leaseId! AND snapshot.tenant_id=:tenantId!\n AND snapshot.state='available' AND snapshot.manifest_checksum=:manifestChecksum!\n AND lease.latest_snapshot_id=snapshot.snapshot_id AND lease.state IN('active','paused')\n AND archive.kind='workspace_archive' AND archive.state='available' AND archive.checksum=:archiveChecksum!\n AND archive.size_bytes=:archiveSizeBytes! FOR SHARE OF snapshot,lease,archive"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS valid FROM hosted_agent_snapshots snapshot JOIN hosted_agent_leases lease
 *  ON lease.lease_id=snapshot.lease_id AND lease.tenant_id=snapshot.tenant_id JOIN hosted_agent_objects archive
 *  ON archive.object_id=snapshot.workspace_archive_object_id AND archive.tenant_id=snapshot.tenant_id
 * WHERE snapshot.snapshot_id=:snapshotId! AND snapshot.lease_id=:leaseId! AND snapshot.tenant_id=:tenantId!
 *  AND snapshot.state='available' AND snapshot.manifest_checksum=:manifestChecksum!
 *  AND lease.latest_snapshot_id=snapshot.snapshot_id AND lease.state IN('active','paused')
 *  AND archive.kind='workspace_archive' AND archive.state='available' AND archive.checksum=:archiveChecksum!
 *  AND archive.size_bytes=:archiveSizeBytes! FOR SHARE OF snapshot,lease,archive
 * ```
 */
export const validatePatchApplicationCheckpoint = new PreparedQuery<IValidatePatchApplicationCheckpointParams,IValidatePatchApplicationCheckpointResult>(validatePatchApplicationCheckpointIR);


/** 'MarkPatchRollbackReady' parameters type */
export interface IMarkPatchRollbackReadyParams {
  allocationId: NumberOrString;
  applicationId: string;
  providerSnapshotId: string;
}

/** 'MarkPatchRollbackReady' return type */
export interface IMarkPatchRollbackReadyResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'MarkPatchRollbackReady' query type */
export interface IMarkPatchRollbackReadyQuery {
  params: IMarkPatchRollbackReadyParams;
  result: IMarkPatchRollbackReadyResult;
}

const markPatchRollbackReadyIR: any = {"usedParamSet":{"allocationId":true,"providerSnapshotId":true,"applicationId":true},"params":[{"name":"allocationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":89,"b":102}]},{"name":"providerSnapshotId","required":true,"transform":{"type":"scalar"},"locs":[{"a":144,"b":163}]},{"name":"applicationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":210,"b":224}]}],"statement":"UPDATE hosted_agent_patch_applications SET phase='rollback_ready',rollback_allocation_id=:allocationId!::bigint,\n rollback_provider_snapshot_id=:providerSnapshotId!,rollback_ready_at=now() WHERE application_id=:applicationId!\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_patch_applications SET phase='rollback_ready',rollback_allocation_id=:allocationId!::bigint,
 *  rollback_provider_snapshot_id=:providerSnapshotId!,rollback_ready_at=now() WHERE application_id=:applicationId!
 * RETURNING *
 * ```
 */
export const markPatchRollbackReady = new PreparedQuery<IMarkPatchRollbackReadyParams,IMarkPatchRollbackReadyResult>(markPatchRollbackReadyIR);


/** 'MarkPatchSwapStarted' parameters type */
export interface IMarkPatchSwapStartedParams {
  applicationId: string;
}

/** 'MarkPatchSwapStarted' return type */
export interface IMarkPatchSwapStartedResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'MarkPatchSwapStarted' query type */
export interface IMarkPatchSwapStartedQuery {
  params: IMarkPatchSwapStartedParams;
  result: IMarkPatchSwapStartedResult;
}

const markPatchSwapStartedIR: any = {"usedParamSet":{"applicationId":true},"params":[{"name":"applicationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":107,"b":121}]}],"statement":"UPDATE hosted_agent_patch_applications SET phase='swap_started',swap_started_at=now() WHERE application_id=:applicationId! RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_patch_applications SET phase='swap_started',swap_started_at=now() WHERE application_id=:applicationId! RETURNING *
 * ```
 */
export const markPatchSwapStarted = new PreparedQuery<IMarkPatchSwapStartedParams,IMarkPatchSwapStartedResult>(markPatchSwapStartedIR);


/** 'MarkPatchSwapped' parameters type */
export interface IMarkPatchSwappedParams {
  applicationId: string;
}

/** 'MarkPatchSwapped' return type */
export interface IMarkPatchSwappedResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'MarkPatchSwapped' query type */
export interface IMarkPatchSwappedQuery {
  params: IMarkPatchSwappedParams;
  result: IMarkPatchSwappedResult;
}

const markPatchSwappedIR: any = {"usedParamSet":{"applicationId":true},"params":[{"name":"applicationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":97,"b":111}]}],"statement":"UPDATE hosted_agent_patch_applications SET phase='swapped',swapped_at=now() WHERE application_id=:applicationId! RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_patch_applications SET phase='swapped',swapped_at=now() WHERE application_id=:applicationId! RETURNING *
 * ```
 */
export const markPatchSwapped = new PreparedQuery<IMarkPatchSwappedParams,IMarkPatchSwappedResult>(markPatchSwappedIR);


/** 'MarkPatchCheckpointed' parameters type */
export interface IMarkPatchCheckpointedParams {
  applicationId: string;
}

/** 'MarkPatchCheckpointed' return type */
export interface IMarkPatchCheckpointedResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'MarkPatchCheckpointed' query type */
export interface IMarkPatchCheckpointedQuery {
  params: IMarkPatchCheckpointedParams;
  result: IMarkPatchCheckpointedResult;
}

const markPatchCheckpointedIR: any = {"usedParamSet":{"applicationId":true},"params":[{"name":"applicationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":107,"b":121}]}],"statement":"UPDATE hosted_agent_patch_applications SET phase='checkpointed',checkpointed_at=now() WHERE application_id=:applicationId! RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_patch_applications SET phase='checkpointed',checkpointed_at=now() WHERE application_id=:applicationId! RETURNING *
 * ```
 */
export const markPatchCheckpointed = new PreparedQuery<IMarkPatchCheckpointedParams,IMarkPatchCheckpointedResult>(markPatchCheckpointedIR);


/** 'MarkPatchRollbackStarted' parameters type */
export interface IMarkPatchRollbackStartedParams {
  applicationId: string;
  errorMessage: string;
}

/** 'MarkPatchRollbackStarted' return type */
export interface IMarkPatchRollbackStartedResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'MarkPatchRollbackStarted' query type */
export interface IMarkPatchRollbackStartedQuery {
  params: IMarkPatchRollbackStartedParams;
  result: IMarkPatchRollbackStartedResult;
}

const markPatchRollbackStartedIR: any = {"usedParamSet":{"errorMessage":true,"applicationId":true},"params":[{"name":"errorMessage","required":true,"transform":{"type":"scalar"},"locs":[{"a":108,"b":121}]},{"name":"applicationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":144,"b":158}]}],"statement":"UPDATE hosted_agent_patch_applications SET phase='rollback_started',rollback_started_at=now(),error_message=:errorMessage! WHERE application_id=:applicationId! RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_patch_applications SET phase='rollback_started',rollback_started_at=now(),error_message=:errorMessage! WHERE application_id=:applicationId! RETURNING *
 * ```
 */
export const markPatchRollbackStarted = new PreparedQuery<IMarkPatchRollbackStartedParams,IMarkPatchRollbackStartedResult>(markPatchRollbackStartedIR);


/** 'MarkPatchRolledBack' parameters type */
export interface IMarkPatchRolledBackParams {
  applicationId: string;
}

/** 'MarkPatchRolledBack' return type */
export interface IMarkPatchRolledBackResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'MarkPatchRolledBack' query type */
export interface IMarkPatchRolledBackQuery {
  params: IMarkPatchRolledBackParams;
  result: IMarkPatchRolledBackResult;
}

const markPatchRolledBackIR: any = {"usedParamSet":{"applicationId":true},"params":[{"name":"applicationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":105,"b":119}]}],"statement":"UPDATE hosted_agent_patch_applications SET phase='rolled_back',rolled_back_at=now() WHERE application_id=:applicationId! RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_patch_applications SET phase='rolled_back',rolled_back_at=now() WHERE application_id=:applicationId! RETURNING *
 * ```
 */
export const markPatchRolledBack = new PreparedQuery<IMarkPatchRolledBackParams,IMarkPatchRolledBackResult>(markPatchRolledBackIR);


/** 'MarkPatchFailed' parameters type */
export interface IMarkPatchFailedParams {
  applicationId: string;
  errorMessage: string;
}

/** 'MarkPatchFailed' return type */
export interface IMarkPatchFailedResult {
  application_id: string;
  artifact_id: string;
  checkpointed_at: Date | null;
  created_at: Date;
  created_generation: string;
  error_message: string | null;
  failed_at: Date | null;
  idempotency_key: string;
  operation: string;
  phase: string;
  result_archive_checksum: string;
  result_archive_size_bytes: string;
  result_manifest_checksum: string;
  result_snapshot_id: string;
  rollback_allocation_id: string | null;
  rollback_provider_snapshot_id: string | null;
  rollback_ready_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  source_target_snapshot_id: string;
  swap_started_at: Date | null;
  swapped_at: Date | null;
  target_lease_id: string;
  target_provider_sandbox_id: string;
  tenant_id: string;
  updated_at: Date;
}

/** 'MarkPatchFailed' query type */
export interface IMarkPatchFailedQuery {
  params: IMarkPatchFailedParams;
  result: IMarkPatchFailedResult;
}

const markPatchFailedIR: any = {"usedParamSet":{"errorMessage":true,"applicationId":true},"params":[{"name":"errorMessage","required":true,"transform":{"type":"scalar"},"locs":[{"a":88,"b":101}]},{"name":"applicationId","required":true,"transform":{"type":"scalar"},"locs":[{"a":124,"b":138}]}],"statement":"UPDATE hosted_agent_patch_applications SET phase='failed',failed_at=now(),error_message=:errorMessage! WHERE application_id=:applicationId! RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE hosted_agent_patch_applications SET phase='failed',failed_at=now(),error_message=:errorMessage! WHERE application_id=:applicationId! RETURNING *
 * ```
 */
export const markPatchFailed = new PreparedQuery<IMarkPatchFailedParams,IMarkPatchFailedResult>(markPatchFailedIR);


/** 'ResolveLocalRootPatchArtifact' parameters type */
export interface IResolveLocalRootPatchArtifactParams {
  artifactId: string;
  tenantId: string;
}

/** 'ResolveLocalRootPatchArtifact' return type */
export interface IResolveLocalRootPatchArtifactResult {
  agent_id: string;
  artifact_id: string;
  artifact_object_id: string;
  base_manifest_object_id: string;
  base_snapshot_id: string;
  changed_files: number;
  checksum: string;
  current_manifest_object_id: string;
  current_snapshot_id: string;
  expires_at: Date;
  lease_agent_id: string;
  lease_base_snapshot_id: string | null;
  lease_latest_snapshot_id: string | null;
  lease_state: string;
  owner_agent_id: string | null;
  owner_lease_id: string | null;
  size_bytes: string | null;
  source_lease_id: string;
  source_snapshot_id: string | null;
  state: string;
}

/** 'ResolveLocalRootPatchArtifact' query type */
export interface IResolveLocalRootPatchArtifactQuery {
  params: IResolveLocalRootPatchArtifactParams;
  result: IResolveLocalRootPatchArtifactResult;
}

const resolveLocalRootPatchArtifactIR: any = {"usedParamSet":{"tenantId":true,"artifactId":true},"params":[{"name":"tenantId","required":true,"transform":{"type":"scalar"},"locs":[{"a":728,"b":737}]},{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":764,"b":775}]}],"statement":"SELECT artifact.artifact_id,artifact.agent_id,artifact.source_lease_id,artifact.base_snapshot_id,\n artifact.current_snapshot_id,artifact.base_manifest_object_id,artifact.current_manifest_object_id,\n artifact.artifact_object_id,artifact.checksum,artifact.changed_files,artifact.size_bytes::text,\n artifact.state,artifact.expires_at,lease.agent_id lease_agent_id,lease.owner_agent_id,\n lease.owner_lease_id,lease.source_snapshot_id,lease.base_snapshot_id lease_base_snapshot_id,\n lease.latest_snapshot_id lease_latest_snapshot_id,lease.state lease_state\nFROM hosted_agent_artifacts artifact JOIN hosted_agent_leases lease\n ON lease.lease_id=artifact.source_lease_id AND lease.tenant_id=artifact.tenant_id\nWHERE artifact.tenant_id=:tenantId! AND artifact.artifact_id=:artifactId! FOR SHARE OF artifact,lease"};

/**
 * Query generated from SQL:
 * ```
 * SELECT artifact.artifact_id,artifact.agent_id,artifact.source_lease_id,artifact.base_snapshot_id,
 *  artifact.current_snapshot_id,artifact.base_manifest_object_id,artifact.current_manifest_object_id,
 *  artifact.artifact_object_id,artifact.checksum,artifact.changed_files,artifact.size_bytes::text,
 *  artifact.state,artifact.expires_at,lease.agent_id lease_agent_id,lease.owner_agent_id,
 *  lease.owner_lease_id,lease.source_snapshot_id,lease.base_snapshot_id lease_base_snapshot_id,
 *  lease.latest_snapshot_id lease_latest_snapshot_id,lease.state lease_state
 * FROM hosted_agent_artifacts artifact JOIN hosted_agent_leases lease
 *  ON lease.lease_id=artifact.source_lease_id AND lease.tenant_id=artifact.tenant_id
 * WHERE artifact.tenant_id=:tenantId! AND artifact.artifact_id=:artifactId! FOR SHARE OF artifact,lease
 * ```
 */
export const resolveLocalRootPatchArtifact = new PreparedQuery<IResolveLocalRootPatchArtifactParams,IResolveLocalRootPatchArtifactResult>(resolveLocalRootPatchArtifactIR);


/** 'ShareLocalPatchArtifactRetention' parameters type */
export interface IShareLocalPatchArtifactRetentionParams {
  artifactId: string;
}

/** 'ShareLocalPatchArtifactRetention' return type */
export interface IShareLocalPatchArtifactRetentionResult {
  reference_id: string;
  reference_kind: string;
  retain_until: Date | null;
}

/** 'ShareLocalPatchArtifactRetention' query type */
export interface IShareLocalPatchArtifactRetentionQuery {
  params: IShareLocalPatchArtifactRetentionParams;
  result: IShareLocalPatchArtifactRetentionResult;
}

const shareLocalPatchArtifactRetentionIR: any = {"usedParamSet":{"artifactId":true},"params":[{"name":"artifactId","required":true,"transform":{"type":"scalar"},"locs":[{"a":104,"b":115}]}],"statement":"SELECT reference_kind,reference_id,retain_until FROM hosted_agent_artifact_references\nWHERE artifact_id=:artifactId! FOR SHARE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT reference_kind,reference_id,retain_until FROM hosted_agent_artifact_references
 * WHERE artifact_id=:artifactId! FOR SHARE
 * ```
 */
export const shareLocalPatchArtifactRetention = new PreparedQuery<IShareLocalPatchArtifactRetentionParams,IShareLocalPatchArtifactRetentionResult>(shareLocalPatchArtifactRetentionIR);
