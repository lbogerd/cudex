import type { Pool, PoolClient } from 'pg'
import {
  canonicalJson,
  createWorkspaceManifest,
  diffWorkspaceManifests,
  workspaceManifestChecksum,
  type WorkspaceManifest,
} from './workspace-manifest.js'

const checksumPattern = /^sha256:[0-9a-f]{64}$/

export class PatchArtifactConflictError extends Error {}
export class PatchArtifactNotFoundError extends Error {}

export type PatchArtifactState = 'creating' | 'available' | 'expired' | 'deleting' | 'deleted' | 'failed'

export interface PatchArtifact {
  artifactId: string
  tenantId: string
  agentId: string
  ownerAgentId: string
  sourceLeaseId: string
  baseSnapshotId: string
  currentSnapshotId: string
  baseManifestObjectId: string
  currentManifestObjectId: string
  artifactObjectId: string
  checksum: string
  changedFiles: number
  sizeBytes: number
  state: PatchArtifactState
  expiresAt: Date
  createdAt: Date
}

export interface CreatePatchArtifactInput {
  artifactId: string
  tenantId: string
  agentId: string
  ownerAgentId: string
  sourceLeaseId: string
  baseSnapshotId: string
  currentSnapshotId: string
  baseManifestObjectId: string
  currentManifestObjectId: string
  artifactObjectId: string
  contentObjects: Array<{ path: string; objectId: string }>
  checksum: string
  changedFiles: number
  sizeBytes: number
  state: 'available'
  expiresAt: Date
  baseManifest: WorkspaceManifest
  currentManifest: WorkspaceManifest
}

interface ArtifactRow {
  artifact_id: string
  tenant_id: string
  agent_id: string
  owner_agent_id: string
  source_lease_id: string
  base_snapshot_id: string
  current_snapshot_id: string
  base_manifest_object_id: string
  current_manifest_object_id: string
  artifact_object_id: string
  checksum: string
  changed_files: number
  size_bytes: string
  state: PatchArtifactState
  expires_at: Date
  created_at: Date
}

interface LeaseRow {
  agent_id: string
  owner_agent_id: string | null
  base_snapshot_id: string | null
  latest_snapshot_id: string | null
  state: string
}

interface SnapshotRow {
  snapshot_id: string
  lease_id: string
  manifest_object_id: string
  manifest_checksum: string
  state: string
  expires_at: Date | null
}

interface ObjectRow {
  object_id: string
  tenant_id: string
  kind: string
  checksum: string
  size_bytes: string
  state: string
  expires_at: Date | null
}

const artifactColumns = `a.artifact_id, a.tenant_id, a.agent_id,
  COALESCE(l.owner_agent_id, '') AS owner_agent_id, a.source_lease_id,
  a.base_snapshot_id, a.current_snapshot_id, a.base_manifest_object_id,
  a.current_manifest_object_id, a.artifact_object_id, a.checksum,
  a.changed_files, a.size_bytes::text, a.state, a.expires_at, a.created_at`

function validateId(label: string, value: string): void {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 512) throw new Error(`invalid ${label}`)
}

function validateDate(label: string, value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`invalid ${label}`)
}

function canonicalManifest(manifest: WorkspaceManifest, identity: string): WorkspaceManifest {
  if (manifest.identity !== identity) throw new Error('manifest identity does not match its snapshot')
  const canonical = createWorkspaceManifest(manifest.identity, manifest.entries)
  if (canonicalJson(canonical) !== canonicalJson(manifest)) throw new Error('manifest is not canonical')
  return canonical
}

function validatedInput(input: CreatePatchArtifactInput): {
  base: WorkspaceManifest
  current: WorkspaceManifest
  contentObjectIds: string[]
  contentExpectations: Map<string, { checksum: string; sizeBytes: number }>
} {
  for (const [label, value] of [
    ['artifact ID', input.artifactId], ['tenant ID', input.tenantId], ['agent ID', input.agentId],
    ['owner agent ID', input.ownerAgentId], ['source lease ID', input.sourceLeaseId],
    ['base snapshot ID', input.baseSnapshotId], ['current snapshot ID', input.currentSnapshotId],
    ['base manifest object ID', input.baseManifestObjectId],
    ['current manifest object ID', input.currentManifestObjectId], ['artifact object ID', input.artifactObjectId],
  ] as const) validateId(label, value)
  if (!checksumPattern.test(input.checksum)) throw new Error('invalid artifact checksum')
  if (input.state !== 'available') throw new Error('new patch artifact must be available')
  validateDate('artifact expiry', input.expiresAt)
  if (input.expiresAt.getTime() <= Date.now()) throw new Error('artifact expiry must be in the future')
  if (!Number.isSafeInteger(input.changedFiles) || input.changedFiles < 0 || input.changedFiles > 0x7fffffff) throw new Error('invalid changed-file count')
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('invalid patch size')
  if (!Array.isArray(input.contentObjects) || input.contentObjects.length > 100_000) throw new Error('invalid content objects')
  const contentByPath = new Map<string, string>()
  for (const content of input.contentObjects) {
    if (!content || typeof content.path !== 'string') throw new Error('invalid content object')
    validateId('content object ID', content.objectId)
    if (contentByPath.has(content.path)) throw new Error('duplicate content object path')
    contentByPath.set(content.path, content.objectId)
  }

  const base = canonicalManifest(input.baseManifest, input.baseSnapshotId)
  const current = canonicalManifest(input.currentManifest, input.currentSnapshotId)
  const changes = diffWorkspaceManifests(base, current)
  const contentExpectations = new Map<string, { checksum: string; sizeBytes: number }>()
  const usedPaths = new Set<string>()
  let sizeBytes = 0
  for (const change of changes) {
    if (change.current?.type !== 'file') {
      if (contentByPath.has(change.path)) throw new Error('non-file change cannot reference content')
      continue
    }
    sizeBytes += change.current.sizeBytes
    if (!Number.isSafeInteger(sizeBytes)) throw new Error('artifact size is not a safe integer')
    const objectId = contentByPath.get(change.path)
    if (!objectId) throw new Error('changed file does not have a content object')
    usedPaths.add(change.path)
    const expected = { checksum: change.current.digest, sizeBytes: change.current.sizeBytes }
    const prior = contentExpectations.get(objectId)
    if (prior && (prior.checksum !== expected.checksum || prior.sizeBytes !== expected.sizeBytes)) {
      throw new Error('content object has inconsistent file identity')
    }
    contentExpectations.set(objectId, expected)
  }
  if (usedPaths.size !== contentByPath.size) throw new Error('artifact contains an unused content object')
  if (changes.length !== input.changedFiles || sizeBytes !== input.sizeBytes) throw new Error('artifact count or size does not match its manifests')
  const contentObjectIds = [...contentExpectations.keys()].sort()
  return { base, current, contentObjectIds, contentExpectations }
}

function fromRow(row: ArtifactRow): PatchArtifact {
  return {
    artifactId: row.artifact_id, tenantId: row.tenant_id, agentId: row.agent_id,
    ownerAgentId: row.owner_agent_id, sourceLeaseId: row.source_lease_id,
    baseSnapshotId: row.base_snapshot_id, currentSnapshotId: row.current_snapshot_id,
    baseManifestObjectId: row.base_manifest_object_id,
    currentManifestObjectId: row.current_manifest_object_id,
    artifactObjectId: row.artifact_object_id, checksum: row.checksum,
    changedFiles: row.changed_files, sizeBytes: Number(row.size_bytes), state: row.state,
    expiresAt: row.expires_at, createdAt: row.created_at,
  }
}

function sameIdentity(row: ArtifactRow, input: CreatePatchArtifactInput): boolean {
  return row.tenant_id === input.tenantId && row.agent_id === input.agentId
    && row.owner_agent_id === input.ownerAgentId && row.source_lease_id === input.sourceLeaseId
    && row.base_snapshot_id === input.baseSnapshotId && row.current_snapshot_id === input.currentSnapshotId
    && row.base_manifest_object_id === input.baseManifestObjectId
    && row.current_manifest_object_id === input.currentManifestObjectId
    && row.artifact_object_id === input.artifactObjectId && row.checksum === input.checksum
    && row.changed_files === input.changedFiles && Number(row.size_bytes) === input.sizeBytes
    && row.expires_at.getTime() === input.expiresAt.getTime()
}

export class PostgresPatchArtifactRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreatePatchArtifactInput): Promise<PatchArtifact> {
    const manifests = validatedInput(input)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const existing = await this.artifactById(client, input.artifactId, true)
      if (existing) {
        if (!sameIdentity(existing, input)) throw new PatchArtifactConflictError('artifact identity conflicts with its durable record')
        await this.validateSnapshots(client, input, manifests)
        await this.validateObjects(client, input, manifests)
        await this.addReferences(client, input, manifests.contentObjectIds)
        await client.query('COMMIT')
        return fromRow(existing)
      }

      await this.validateLeaseAndSnapshots(client, input, manifests)
      await this.validateObjects(client, input, manifests)
      await client.query(`
        INSERT INTO hosted_agent_artifacts
          (artifact_id, tenant_id, agent_id, source_lease_id, base_snapshot_id,
           current_snapshot_id, base_manifest_object_id, current_manifest_object_id,
           artifact_object_id, checksum, changed_files, size_bytes, state, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (artifact_id) DO NOTHING
      `, [input.artifactId, input.tenantId, input.agentId, input.sourceLeaseId,
        input.baseSnapshotId, input.currentSnapshotId, input.baseManifestObjectId,
        input.currentManifestObjectId, input.artifactObjectId, input.checksum,
        input.changedFiles, input.sizeBytes, input.state, input.expiresAt])
      const row = await this.artifactById(client, input.artifactId, true)
      if (!row || !sameIdentity(row, input)) throw new PatchArtifactConflictError('artifact identity conflicts with its durable record')
      await this.addReferences(client, input, manifests.contentObjectIds)
      await client.query('COMMIT')
      return fromRow(row)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      if ((error as { code?: string }).code === '23503') throw new PatchArtifactNotFoundError('referenced patch state was not found')
      throw error
    } finally {
      client.release()
    }
  }

  async getAuthorized(tenantId: string, artifactId: string, agentId: string, at = new Date()): Promise<PatchArtifact | null> {
    validateId('tenant ID', tenantId); validateId('artifact ID', artifactId); validateId('agent ID', agentId); validateDate('authorization time', at)
    const result = await this.pool.query<ArtifactRow>(`
      SELECT ${artifactColumns}
      FROM hosted_agent_artifacts a
      JOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
      WHERE a.artifact_id = $1 AND a.tenant_id = $2 AND a.agent_id = $3
        AND a.state = 'available' AND a.expires_at > $4
    `, [artifactId, tenantId, agentId, at])
    return result.rows[0] ? fromRow(result.rows[0]) : null
  }

  async getAuthorizedForOwner(tenantId: string, artifactId: string, ownerAgentId: string, at = new Date()): Promise<PatchArtifact | null> {
    validateId('tenant ID', tenantId); validateId('artifact ID', artifactId); validateId('owner agent ID', ownerAgentId); validateDate('authorization time', at)
    const result = await this.pool.query<ArtifactRow>(`
      SELECT ${artifactColumns}
      FROM hosted_agent_artifacts a
      JOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
      WHERE a.artifact_id = $1 AND a.tenant_id = $2 AND l.owner_agent_id = $3
        AND a.state = 'available' AND a.expires_at > $4
    `, [artifactId, tenantId, ownerAgentId, at])
    return result.rows[0] ? fromRow(result.rows[0]) : null
  }

  async addReference(input: { tenantId: string; artifactId: string; referenceKind: 'codex_thread' | 'owner_agent' | 'operation'; referenceId: string; retainUntil?: Date | null }): Promise<void> {
    validateId('tenant ID', input.tenantId); validateId('artifact ID', input.artifactId); validateId('reference ID', input.referenceId)
    if (input.retainUntil) validateDate('retention expiry', input.retainUntil)
    const result = await this.pool.query(`
      INSERT INTO hosted_agent_artifact_references
        (artifact_id, reference_kind, reference_id, retain_until)
      SELECT artifact_id, $3, $4, $5 FROM hosted_agent_artifacts
      WHERE artifact_id = $2 AND tenant_id = $1 AND state = 'available' AND expires_at > now()
      ON CONFLICT (artifact_id, reference_kind, reference_id)
      DO UPDATE SET retain_until = CASE
        WHEN hosted_agent_artifact_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
        ELSE GREATEST(hosted_agent_artifact_references.retain_until, EXCLUDED.retain_until)
      END
    `, [input.tenantId, input.artifactId, input.referenceKind, input.referenceId, input.retainUntil ?? null])
    if (result.rowCount !== 1) throw new PatchArtifactNotFoundError('artifact was not found')
  }

  async expireAvailable(tenantId: string, at = new Date()): Promise<number> {
    validateId('tenant ID', tenantId); validateDate('expiry time', at)
    const result = await this.pool.query(`
      UPDATE hosted_agent_artifacts SET state = 'expired'
      WHERE tenant_id = $1 AND state = 'available' AND expires_at <= $2
    `, [tenantId, at])
    return result.rowCount ?? 0
  }

  private async artifactById(client: PoolClient, artifactId: string, lock: boolean): Promise<ArtifactRow | null> {
    const result = await client.query<ArtifactRow>(`
      SELECT ${artifactColumns}
      FROM hosted_agent_artifacts a
      JOIN hosted_agent_leases l ON l.lease_id = a.source_lease_id AND l.tenant_id = a.tenant_id
      WHERE a.artifact_id = $1 ${lock ? 'FOR UPDATE OF a' : ''}
    `, [artifactId])
    return result.rows[0] ?? null
  }

  private async validateLeaseAndSnapshots(client: PoolClient, input: CreatePatchArtifactInput, manifests: { base: WorkspaceManifest; current: WorkspaceManifest }): Promise<void> {
    const leaseResult = await client.query<LeaseRow>(`
      SELECT agent_id, owner_agent_id, base_snapshot_id, latest_snapshot_id, state
      FROM hosted_agent_leases WHERE lease_id = $1 AND tenant_id = $2 FOR UPDATE
    `, [input.sourceLeaseId, input.tenantId])
    const lease = leaseResult.rows[0]
    if (!lease) throw new PatchArtifactNotFoundError('source lease was not found')
    if (lease.agent_id !== input.agentId || lease.owner_agent_id !== input.ownerAgentId
      || lease.base_snapshot_id !== input.baseSnapshotId || lease.latest_snapshot_id !== input.currentSnapshotId) {
      throw new PatchArtifactConflictError('artifact lineage does not match the source lease')
    }
    if (!['active', 'paused'].includes(lease.state)) throw new PatchArtifactConflictError('source lease cannot export a new artifact')

    await this.validateSnapshots(client, input, manifests)
  }

  private async validateSnapshots(client: PoolClient, input: CreatePatchArtifactInput, manifests: { base: WorkspaceManifest; current: WorkspaceManifest }): Promise<void> {
    const snapshots = await client.query<SnapshotRow>(`
      SELECT snapshot_id, lease_id, manifest_object_id, manifest_checksum, state, expires_at
      FROM hosted_agent_snapshots
      WHERE tenant_id = $1 AND snapshot_id = ANY($2::text[]) FOR SHARE
    `, [input.tenantId, [input.baseSnapshotId, input.currentSnapshotId]])
    const byId = new Map(snapshots.rows.map(snapshot => [snapshot.snapshot_id, snapshot]))
    for (const [snapshotId, objectId, manifest] of [
      [input.baseSnapshotId, input.baseManifestObjectId, manifests.base],
      [input.currentSnapshotId, input.currentManifestObjectId, manifests.current],
    ] as const) {
      const snapshot = byId.get(snapshotId)
      if (!snapshot) throw new PatchArtifactNotFoundError('artifact snapshot was not found')
      if (snapshot.lease_id !== input.sourceLeaseId || snapshot.manifest_object_id !== objectId
        || snapshot.manifest_checksum !== workspaceManifestChecksum(manifest) || snapshot.state !== 'available') {
        throw new PatchArtifactConflictError('artifact snapshot identity does not match its manifest')
      }
    }
  }

  private async validateObjects(client: PoolClient, input: CreatePatchArtifactInput, manifests: {
    base: WorkspaceManifest
    current: WorkspaceManifest
    contentObjectIds: string[]
    contentExpectations: Map<string, { checksum: string; sizeBytes: number }>
  }): Promise<void> {
    const ids = [input.baseManifestObjectId, input.currentManifestObjectId, input.artifactObjectId, ...manifests.contentObjectIds]
    const result = await client.query<ObjectRow>(`
      SELECT object_id, tenant_id, kind, checksum, size_bytes::text, state, expires_at
      FROM hosted_agent_objects WHERE object_id = ANY($1::text[]) FOR SHARE
    `, [ids])
    const objects = new Map(result.rows.map(object => [object.object_id, object]))
    for (const [id, kind] of [[input.baseManifestObjectId, 'manifest'], [input.currentManifestObjectId, 'manifest'], [input.artifactObjectId, 'patch_artifact']] as const) {
      const object = objects.get(id)
      if (!object || object.tenant_id !== input.tenantId || object.kind !== kind || object.state !== 'available') {
        throw new PatchArtifactNotFoundError('authorized artifact object was not found')
      }
      if (object.expires_at && object.expires_at < input.expiresAt) throw new PatchArtifactConflictError('artifact object expires before its artifact')
    }
    if (objects.get(input.artifactObjectId)!.checksum !== input.checksum) throw new PatchArtifactConflictError('artifact checksum does not match its object')
    if (objects.get(input.baseManifestObjectId)!.checksum !== workspaceManifestChecksum(manifests.base)
      || objects.get(input.currentManifestObjectId)!.checksum !== workspaceManifestChecksum(manifests.current)) {
      throw new PatchArtifactConflictError('manifest checksum does not match its object')
    }
    for (const objectId of manifests.contentObjectIds) {
      const object = objects.get(objectId)
      if (!object || object.tenant_id !== input.tenantId || object.kind !== 'content_blob' || object.state !== 'available') {
        throw new PatchArtifactNotFoundError('authorized content object was not found')
      }
      const expected = manifests.contentExpectations.get(objectId)!
      if (object.checksum !== expected.checksum) throw new PatchArtifactConflictError('content object checksum does not match its manifest')
      if (Number(object.size_bytes) !== expected.sizeBytes) throw new PatchArtifactConflictError('content object size does not match its manifest')
      if (object.expires_at && object.expires_at < input.expiresAt) throw new PatchArtifactConflictError('content object expires before its artifact')
    }
  }

  private async addReferences(client: PoolClient, input: CreatePatchArtifactInput, contentObjectIds: readonly string[]): Promise<void> {
    for (const [objectId, purpose] of [
      [input.baseManifestObjectId, 'base_manifest'], [input.currentManifestObjectId, 'current_manifest'],
      [input.artifactObjectId, 'patch_artifact'],
    ] as const) {
      await client.query(`
        INSERT INTO hosted_agent_object_references
          (object_id, reference_kind, reference_id, purpose, retain_until)
        VALUES ($1, 'artifact', $2, $3, $4)
        ON CONFLICT (object_id, reference_kind, reference_id, purpose)
        DO UPDATE SET retain_until = CASE
          WHEN hosted_agent_object_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
          ELSE GREATEST(hosted_agent_object_references.retain_until, EXCLUDED.retain_until)
        END
      `, [objectId, input.artifactId, purpose, input.expiresAt])
    }
    for (const objectId of contentObjectIds) {
      await client.query(`
        INSERT INTO hosted_agent_object_references
          (object_id, reference_kind, reference_id, purpose, retain_until)
        VALUES ($1, 'artifact', $2, 'content_blob', $3)
        ON CONFLICT (object_id, reference_kind, reference_id, purpose)
        DO UPDATE SET retain_until = CASE
          WHEN hosted_agent_object_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
          ELSE GREATEST(hosted_agent_object_references.retain_until, EXCLUDED.retain_until)
        END
      `, [objectId, input.artifactId, input.expiresAt])
    }
    await client.query(`
      INSERT INTO hosted_agent_snapshot_references
        (snapshot_id, reference_kind, reference_id, retain_until)
      VALUES ($1, 'artifact_base', $3, $4), ($2, 'artifact_current', $3, $4)
      ON CONFLICT (snapshot_id, reference_kind, reference_id)
      DO UPDATE SET retain_until = CASE
        WHEN hosted_agent_snapshot_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
        ELSE GREATEST(hosted_agent_snapshot_references.retain_until, EXCLUDED.retain_until)
      END
    `, [input.baseSnapshotId, input.currentSnapshotId, input.artifactId, input.expiresAt])
    await client.query(`
      INSERT INTO hosted_agent_artifact_references
        (artifact_id, reference_kind, reference_id, retain_until)
      VALUES ($1, 'owner_agent', $2, $3)
      ON CONFLICT (artifact_id, reference_kind, reference_id)
      DO UPDATE SET retain_until = CASE
        WHEN hosted_agent_artifact_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
        ELSE GREATEST(hosted_agent_artifact_references.retain_until, EXCLUDED.retain_until)
      END
    `, [input.artifactId, input.ownerAgentId, input.expiresAt])
  }
}
