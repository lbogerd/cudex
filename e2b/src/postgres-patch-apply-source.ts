import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ObjectStore } from './blob-store.js'
import {
  planPatchApplication,
  type PatchApplicationPlan,
  type PatchContentMaterial,
} from './patch-apply.js'
import { parsePatchArtifact, type SerializedPatchArtifact } from './patch-artifact.js'
import { ServiceError } from './types.js'
import {
  canonicalJson,
  parseWorkspaceManifest,
  workspaceManifestChecksum,
  type WorkspaceManifest,
} from './workspace-manifest.js'

type Queryable = Pick<PoolClient, 'query'>

interface TargetLeaseRow {
  lease_id: string
  agent_id: string
  provider_sandbox_id: string | null
  latest_snapshot_id: string | null
  state: string
}

interface ArtifactRow {
  artifact_id: string
  agent_id: string
  source_lease_id: string
  base_snapshot_id: string
  current_snapshot_id: string
  base_manifest_object_id: string
  current_manifest_object_id: string
  artifact_object_id: string
  checksum: string
  changed_files: number
  size_bytes: string
  state: string
  expires_at: Date
  source_agent_id: string
  source_owner_agent_id: string | null
  source_owner_lease_id: string | null
}

interface SnapshotRow {
  snapshot_id: string
  lease_id: string
  workspace_archive_object_id: string
  manifest_object_id: string
  manifest_checksum: string
  state: string
  expires_at: Date | null
}

interface ObjectReferenceRow {
  purpose: string
  retain_until: Date | null
  object_id: string
  kind: string
  storage_bucket: string
  storage_key: string
  checksum: string
  size_bytes: string
  state: string
  expires_at: Date | null
}

export interface ResolvedPatchApplyContentObject extends PatchContentMaterial {
  bytes: Uint8Array
}

export interface ResolvedPatchApplySource {
  target: {
    leaseId: string
    agentId: string
    providerSandboxId: string
    latestSnapshotId: string
    manifest: WorkspaceManifest
    contentObjects: ResolvedPatchApplyContentObject[]
  }
  artifact: {
    artifactId: string
    sourceLeaseId: string
    serialized: SerializedPatchArtifact
    contentObjects: ResolvedPatchApplyContentObject[]
    expiresAt: Date
  }
  plan: PatchApplicationPlan
}

export interface ResolvedPatchApplyRecoveryTarget {
  leaseId: string
  agentId: string
  providerSandboxId: string
  latestSnapshotId: string
  archive: Uint8Array
}

/** A stable, non-disclosing apply rejection rather than an infrastructure failure. */
export class PatchApplyRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(reason)
    this.name = 'PatchApplyRejectedError'
  }
}

function validId(value: string): boolean {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
}

function safeSize(value: string): number {
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid durable object size')
  return size
}

/** Resolves an exact owner/source graph while the target lease is transaction-locked. */
export class PostgresPatchApplySourceResolver {
  constructor(private readonly pool: Pool, private readonly objects: ObjectStore) {}

  async resolve(input: {
    tenantId: string
    targetLeaseId: string
    artifactId: string
    resultSnapshotId: string
  }, executor?: PoolClient): Promise<ResolvedPatchApplySource> {
    if (![input.tenantId, input.targetLeaseId, input.artifactId, input.resultSnapshotId].every(validId)) {
      throw new ServiceError(400, 'invalid patch apply source request')
    }
    if (executor) return this.resolveSafely(input, executor)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const source = await this.resolveSafely(input, client)
      await client.query('COMMIT')
      return source
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  /** Resolves only the exact pre-apply target, independent of later artifact expiry. */
  async resolveRecoveryTarget(input: {
    tenantId: string
    targetLeaseId: string
    sourceTargetSnapshotId: string
    targetProviderSandboxId: string
  }, executor?: PoolClient): Promise<ResolvedPatchApplyRecoveryTarget> {
    if (![input.tenantId, input.targetLeaseId, input.sourceTargetSnapshotId,
      input.targetProviderSandboxId].every(validId)) {
      throw new ServiceError(400, 'invalid patch apply recovery request')
    }
    const resolve = async (client: PoolClient): Promise<ResolvedPatchApplyRecoveryTarget> => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`hosted-agent:lease:${input.tenantId}:${input.targetLeaseId}`])
      const targetResult = await client.query<TargetLeaseRow>(`
        SELECT lease_id, agent_id, provider_sandbox_id, latest_snapshot_id, state
        FROM hosted_agent_leases
        WHERE tenant_id = $1 AND lease_id = $2
        FOR UPDATE
      `, [input.tenantId, input.targetLeaseId])
      const target = targetResult.rows[0]
      if (!target || !['active', 'paused'].includes(target.state)
        || target.provider_sandbox_id !== input.targetProviderSandboxId
        || target.latest_snapshot_id !== input.sourceTargetSnapshotId) {
        throw new ServiceError(409, 'patch apply recovery target changed')
      }
      const now = new Date()
      const snapshot = await this.targetSnapshot(client, input.tenantId,
        input.targetLeaseId, input.sourceTargetSnapshotId, now)
      const rows = await this.objectReferences(
        client, input.tenantId, 'snapshot', input.sourceTargetSnapshotId)
      const archives = rows.filter(row => row.purpose === 'workspace_archive'
        && row.object_id === snapshot.workspace_archive_object_id)
      if (archives.length !== 1 || rows.some(row => row.purpose === 'workspace_archive'
        && row.object_id !== snapshot.workspace_archive_object_id)
        || archives[0]!.kind !== 'workspace_archive') {
        throw new ServiceError(503, 'patch apply recovery archive unavailable')
      }
      const archive = await this.verifiedBytes(archives[0]!, now)
      return {
        leaseId: target.lease_id, agentId: target.agent_id,
        providerSandboxId: target.provider_sandbox_id,
        latestSnapshotId: target.latest_snapshot_id,
        archive,
      }
    }
    if (executor) {
      try { return await resolve(executor) }
      catch (error) {
        if (error instanceof ServiceError) throw error
        throw new ServiceError(503, 'patch apply recovery source unavailable')
      }
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const target = await resolve(client)
      await client.query('COMMIT')
      return target
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (error instanceof ServiceError) throw error
      throw new ServiceError(503, 'patch apply recovery source unavailable')
    } finally { client.release() }
  }

  private async resolveSafely(input: {
    tenantId: string
    targetLeaseId: string
    artifactId: string
    resultSnapshotId: string
  }, executor: Queryable): Promise<ResolvedPatchApplySource> {
    try {
      return await this.resolveLocked(input, executor)
    } catch (error) {
      if (error instanceof ServiceError || error instanceof PatchApplyRejectedError) throw error
      throw new ServiceError(503, 'patch apply source unavailable')
    }
  }

  private async resolveLocked(input: {
    tenantId: string
    targetLeaseId: string
    artifactId: string
    resultSnapshotId: string
  }, executor: Queryable): Promise<ResolvedPatchApplySource> {
    await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`hosted-agent:lease:${input.tenantId}:${input.targetLeaseId}`])
    const targetResult = await executor.query<TargetLeaseRow>(`
      SELECT lease_id, agent_id, provider_sandbox_id, latest_snapshot_id, state
      FROM hosted_agent_leases
      WHERE tenant_id = $1 AND lease_id = $2
      FOR UPDATE
    `, [input.tenantId, input.targetLeaseId])
    const target = targetResult.rows[0]
    if (!target) throw new ServiceError(404, 'target lease missing')
    if (!['active', 'paused'].includes(target.state) || target.provider_sandbox_id === null
      || target.latest_snapshot_id === null) {
      throw new ServiceError(409, 'target lease cannot accept a patch')
    }

    const artifactResult = await executor.query<ArtifactRow>(`
      SELECT artifact.artifact_id, artifact.agent_id, artifact.source_lease_id,
             artifact.base_snapshot_id, artifact.current_snapshot_id,
             artifact.base_manifest_object_id, artifact.current_manifest_object_id,
             artifact.artifact_object_id, artifact.checksum, artifact.changed_files,
             artifact.size_bytes::text, artifact.state, artifact.expires_at,
             source.agent_id AS source_agent_id,
             source.owner_agent_id AS source_owner_agent_id,
             source.owner_lease_id AS source_owner_lease_id
      FROM hosted_agent_artifacts AS artifact
      JOIN hosted_agent_leases AS source
        ON source.lease_id = artifact.source_lease_id AND source.tenant_id = artifact.tenant_id
      WHERE artifact.tenant_id = $1 AND artifact.artifact_id = $2
      FOR SHARE OF artifact, source
    `, [input.tenantId, input.artifactId])
    const artifact = artifactResult.rows[0]
    const now = new Date()
    if (!artifact || artifact.state !== 'available' || artifact.expires_at <= now
      || artifact.agent_id !== artifact.source_agent_id
      || artifact.source_owner_agent_id !== target.agent_id
      || artifact.source_owner_lease_id !== target.lease_id) {
      throw new PatchApplyRejectedError('artifact is unavailable')
    }

    await this.verifyArtifactOwnership(executor, artifact, target.agent_id)
    const sourceSnapshots = await this.artifactSnapshots(executor, input.tenantId, artifact, now)
    const artifactRows = await this.objectReferences(
      executor, input.tenantId, 'artifact', artifact.artifact_id)
    const serialized = await this.artifactMaterial(artifact, sourceSnapshots, artifactRows, now)

    const targetSnapshot = await this.targetSnapshot(
      executor, input.tenantId, target.lease_id, target.latest_snapshot_id, now)
    const targetRows = await this.objectReferences(
      executor, input.tenantId, 'snapshot', targetSnapshot.snapshot_id)
    const targetMaterial = await this.snapshotMaterial(targetSnapshot, targetRows, now)

    const artifactContent = await this.contentMaterial(
      artifactRows.filter(row => row.purpose === 'content_blob'), now)
    const plan = planPatchApplication({
      artifact: serialized,
      targetManifest: targetMaterial.manifest,
      resultSnapshotId: input.resultSnapshotId,
      targetContentObjects: targetMaterial.contentObjects,
      artifactContentObjects: artifactContent,
    })
    return {
      target: {
        leaseId: target.lease_id, agentId: target.agent_id,
        providerSandboxId: target.provider_sandbox_id,
        latestSnapshotId: target.latest_snapshot_id,
        manifest: targetMaterial.manifest, contentObjects: targetMaterial.contentObjects,
      },
      artifact: {
        artifactId: artifact.artifact_id, sourceLeaseId: artifact.source_lease_id,
        serialized, contentObjects: artifactContent, expiresAt: artifact.expires_at,
      },
      plan,
    }
  }

  private async verifyArtifactOwnership(executor: Queryable, artifact: ArtifactRow,
    ownerAgentId: string): Promise<void> {
    const result = await executor.query<{ reference_kind: string; reference_id: string;
      retain_until: Date | null }>(`
      SELECT reference_kind, reference_id, retain_until
      FROM hosted_agent_artifact_references
      WHERE artifact_id = $1 AND reference_kind = 'owner_agent'
      FOR SHARE
    `, [artifact.artifact_id])
    if (result.rows.length !== 1 || result.rows[0]!.reference_id !== ownerAgentId
      || (result.rows[0]!.retain_until !== null
        && result.rows[0]!.retain_until < artifact.expires_at)) {
      throw new ServiceError(503, 'patch apply artifact ownership unavailable')
    }
  }

  private async artifactSnapshots(executor: Queryable, tenantId: string, artifact: ArtifactRow,
    now: Date): Promise<Map<string, SnapshotRow>> {
    const result = await executor.query<SnapshotRow>(`
      SELECT snapshot_id, lease_id, workspace_archive_object_id,
             manifest_object_id, manifest_checksum, state, expires_at
      FROM hosted_agent_snapshots
      WHERE tenant_id = $1 AND snapshot_id = ANY($2::text[])
      FOR SHARE
    `, [tenantId, [artifact.base_snapshot_id, artifact.current_snapshot_id]])
    const snapshots = new Map(result.rows.map(row => [row.snapshot_id, row]))
    for (const [snapshotId, manifestObjectId] of [
      [artifact.base_snapshot_id, artifact.base_manifest_object_id],
      [artifact.current_snapshot_id, artifact.current_manifest_object_id],
    ] as const) {
      const snapshot = snapshots.get(snapshotId)
      if (!snapshot || snapshot.lease_id !== artifact.source_lease_id
        || snapshot.manifest_object_id !== manifestObjectId || snapshot.state !== 'available'
        || (snapshot.expires_at !== null && snapshot.expires_at <= now)) {
        throw new ServiceError(503, 'patch apply artifact lineage unavailable')
      }
    }
    const references = await executor.query<{ snapshot_id: string; reference_kind: string;
      retain_until: Date | null }>(`
      SELECT snapshot_id, reference_kind, retain_until
      FROM hosted_agent_snapshot_references
      WHERE reference_id = $1 AND reference_kind IN ('artifact_base', 'artifact_current')
      FOR SHARE
    `, [artifact.artifact_id])
    const expected = new Set([
      `${artifact.base_snapshot_id}\u0000artifact_base`,
      `${artifact.current_snapshot_id}\u0000artifact_current`,
    ])
    const actual = new Set(references.rows.map(row => `${row.snapshot_id}\u0000${row.reference_kind}`))
    if (references.rows.length !== expected.size || actual.size !== expected.size
      || [...expected].some(value => !actual.has(value))
      || references.rows.some(row => row.retain_until !== null
        && row.retain_until < artifact.expires_at)) {
      throw new ServiceError(503, 'patch apply artifact lineage unavailable')
    }
    return snapshots
  }

  private async targetSnapshot(executor: Queryable, tenantId: string, leaseId: string,
    snapshotId: string, now: Date): Promise<SnapshotRow> {
    const result = await executor.query<SnapshotRow>(`
      SELECT snapshot_id, lease_id, workspace_archive_object_id,
             manifest_object_id, manifest_checksum, state, expires_at
      FROM hosted_agent_snapshots
      WHERE tenant_id = $1 AND snapshot_id = $2
      FOR SHARE
    `, [tenantId, snapshotId])
    const snapshot = result.rows[0]
    if (!snapshot || snapshot.lease_id !== leaseId || snapshot.state !== 'available'
      || (snapshot.expires_at !== null && snapshot.expires_at <= now)) {
      throw new ServiceError(409, 'target snapshot cannot accept a patch')
    }
    const latestReference = await executor.query(`
      SELECT 1 FROM hosted_agent_snapshot_references
      WHERE snapshot_id = $1 AND reference_kind = 'lease_latest' AND reference_id = $2
      FOR SHARE
    `, [snapshotId, leaseId])
    if (latestReference.rowCount !== 1) {
      throw new ServiceError(503, 'patch apply target snapshot unavailable')
    }
    return snapshot
  }

  private async objectReferences(executor: Queryable, tenantId: string,
    referenceKind: 'artifact' | 'snapshot', referenceId: string): Promise<ObjectReferenceRow[]> {
    const result = await executor.query<ObjectReferenceRow>(`
      SELECT reference.purpose, reference.retain_until, object_row.object_id,
             object_row.kind, object_row.storage_bucket, object_row.storage_key,
             object_row.checksum, object_row.size_bytes::text, object_row.state,
             object_row.expires_at
      FROM hosted_agent_object_references AS reference
      JOIN hosted_agent_objects AS object_row ON object_row.object_id = reference.object_id
      WHERE object_row.tenant_id = $1 AND reference.reference_kind = $2
        AND reference.reference_id = $3
      ORDER BY reference.purpose, object_row.object_id
      FOR SHARE OF object_row, reference
    `, [tenantId, referenceKind, referenceId])
    return result.rows
  }

  private async artifactMaterial(artifact: ArtifactRow, snapshots: Map<string, SnapshotRow>,
    rows: ObjectReferenceRow[], now: Date): Promise<SerializedPatchArtifact> {
    if (rows.some(row => !['base_manifest', 'current_manifest', 'patch_artifact', 'content_blob']
      .includes(row.purpose))) throw new ServiceError(503, 'patch apply artifact graph unavailable')
    const exact = (purpose: string, objectId: string): ObjectReferenceRow => {
      const matches = rows.filter(row => row.purpose === purpose && row.object_id === objectId)
      if (matches.length !== 1 || rows.some(row => row.purpose === purpose
        && row.object_id !== objectId)) {
        throw new ServiceError(503, 'patch apply artifact graph unavailable')
      }
      return matches[0]!
    }
    const artifactObject = exact('patch_artifact', artifact.artifact_object_id)
    if (artifactObject.kind !== 'patch_artifact' || artifactObject.checksum !== artifact.checksum) {
      throw new ServiceError(503, 'patch apply artifact graph unavailable')
    }
    const bytes = await this.verifiedBytes(artifactObject, now)
    const serialized = parsePatchArtifact(bytes, artifact.checksum)
    if (serialized.artifact.agentId !== artifact.agent_id
      || serialized.artifact.baseSnapshotId !== artifact.base_snapshot_id
      || serialized.artifact.currentSnapshotId !== artifact.current_snapshot_id
      || serialized.changedFiles !== artifact.changed_files
      || serialized.sizeBytes !== safeSize(artifact.size_bytes)) {
      throw new ServiceError(503, 'patch apply artifact metadata unavailable')
    }

    const expectedContents = new Set(serialized.contentObjectIds)
    const contentRows = rows.filter(row => row.purpose === 'content_blob')
    if (contentRows.length !== expectedContents.size
      || new Set(contentRows.map(row => row.object_id)).size !== expectedContents.size
      || contentRows.some(row => !expectedContents.has(row.object_id))) {
      throw new ServiceError(503, 'patch apply artifact graph unavailable')
    }
    for (const [purpose, objectId, snapshotId, manifest] of [
      ['base_manifest', artifact.base_manifest_object_id, artifact.base_snapshot_id,
        serialized.artifact.baseManifest],
      ['current_manifest', artifact.current_manifest_object_id, artifact.current_snapshot_id,
        serialized.artifact.currentManifest],
    ] as const) {
      const row = exact(purpose, objectId)
      const snapshot = snapshots.get(snapshotId)!
      if (row.kind !== 'manifest' || row.checksum !== snapshot.manifest_checksum
        || workspaceManifestChecksum(manifest) !== snapshot.manifest_checksum) {
        throw new ServiceError(503, 'patch apply artifact manifest unavailable')
      }
      const stored = parseWorkspaceManifest(
        await this.verifiedBytes(row, now), snapshotId, snapshot.manifest_checksum)
      if (canonicalJson(stored) !== canonicalJson(manifest)) {
        throw new ServiceError(503, 'patch apply artifact manifest unavailable')
      }
    }
    for (const row of rows) {
      if (row.retain_until !== null && row.retain_until < artifact.expires_at) {
        throw new ServiceError(503, 'patch apply artifact graph unavailable')
      }
    }
    return serialized
  }

  private async snapshotMaterial(snapshot: SnapshotRow, rows: ObjectReferenceRow[], now: Date):
  Promise<{ manifest: WorkspaceManifest; contentObjects: ResolvedPatchApplyContentObject[] }> {
    const relevant = rows.filter(row => row.purpose === 'manifest' || row.purpose === 'content_blob')
    const manifests = relevant.filter(row => row.purpose === 'manifest'
      && row.object_id === snapshot.manifest_object_id)
    if (manifests.length !== 1 || relevant.some(row => row.purpose === 'manifest'
      && row.object_id !== snapshot.manifest_object_id)) {
      throw new ServiceError(503, 'patch apply target manifest unavailable')
    }
    const manifestRow = manifests[0]!
    if (manifestRow.kind !== 'manifest' || manifestRow.checksum !== snapshot.manifest_checksum) {
      throw new ServiceError(503, 'patch apply target manifest unavailable')
    }
    const manifest = parseWorkspaceManifest(
      await this.verifiedBytes(manifestRow, now), snapshot.snapshot_id, snapshot.manifest_checksum)
    const contentRows = relevant.filter(row => row.purpose === 'content_blob')
    if (contentRows.some(row => row.kind !== 'content_blob')
      || new Set(contentRows.map(row => row.object_id)).size !== contentRows.length) {
      throw new ServiceError(503, 'patch apply target content unavailable')
    }
    return { manifest, contentObjects: await this.contentMaterial(contentRows, now) }
  }

  private async contentMaterial(rows: ObjectReferenceRow[],
    now: Date): Promise<ResolvedPatchApplyContentObject[]> {
    const result: ResolvedPatchApplyContentObject[] = []
    for (const row of rows) {
      if (row.kind !== 'content_blob') {
        throw new ServiceError(503, 'patch apply content unavailable')
      }
      const bytes = await this.verifiedBytes(row, now)
      result.push({ objectId: row.object_id, checksum: row.checksum,
        sizeBytes: safeSize(row.size_bytes), bytes })
    }
    return result
  }

  private async verifiedBytes(row: ObjectReferenceRow, now: Date): Promise<Uint8Array> {
    if (row.state !== 'available' || (row.expires_at !== null && row.expires_at <= now)
      || !/^sha256:[0-9a-f]{64}$/u.test(row.checksum)) {
      throw new ServiceError(503, 'patch apply object unavailable')
    }
    const physicalId = row.checksum.slice('sha256:'.length)
    const location = this.objects.location(physicalId)
    if (location.storageBucket !== row.storage_bucket || location.storageKey !== row.storage_key) {
      throw new ServiceError(503, 'patch apply object unavailable')
    }
    const bytes = await this.objects.get(physicalId)
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (checksum !== row.checksum || bytes.byteLength !== safeSize(row.size_bytes)) {
      throw new ServiceError(503, 'patch apply object unavailable')
    }
    return bytes
  }
}
