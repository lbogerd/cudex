import type { Pool, PoolClient } from 'pg'
import type { IDatabaseConnection } from '@pgtyped/runtime'
import { addPatchArtifactReference, expireAvailablePatchArtifacts, findPatchArtifactForReconciliation,
  getAuthorizedPatchArtifact, getOwnerAuthorizedPatchArtifact, getPatchArtifact, insertPatchArtifact,
  lockPatchArtifact, lockPatchArtifactSourceLease, retainPatchArtifact, retainPatchArtifactObject,
  retainPatchArtifactSnapshots, sharePatchArtifactObjects, sharePatchArtifactSnapshots,
} from './db/queries/objects.queries.js'
import { begin, commit, rollbackQuietly } from './db/primitives.js'
import {
  canonicalJson,
  createWorkspaceManifest,
  diffWorkspaceManifests,
  workspaceManifestChecksum,
  type WorkspaceManifest,
} from './workspace-manifest.js'

const checksumPattern = /^sha256:[0-9a-f]{64}$/
function connection(value: Pick<PoolClient, 'query'>): IDatabaseConnection { return value as IDatabaseConnection }

export class PatchArtifactConflictError extends Error {}
export class PatchArtifactNotFoundError extends Error {}

export type PatchArtifactState = 'creating' | 'available' | 'expired' | 'deleting' | 'deleted' | 'failed'

export interface PatchArtifact {
  artifactId: string
  tenantId: string
  agentId: string
  ownerAgentId: string | null
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
  ownerAgentId: string | null
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
  owner_agent_id: string | null
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
  l.owner_agent_id, a.source_lease_id,
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
    ['source lease ID', input.sourceLeaseId],
    ['base snapshot ID', input.baseSnapshotId], ['current snapshot ID', input.currentSnapshotId],
    ['base manifest object ID', input.baseManifestObjectId],
    ['current manifest object ID', input.currentManifestObjectId], ['artifact object ID', input.artifactObjectId],
  ] as const) validateId(label, value)
  if (input.ownerAgentId !== null) validateId('owner agent ID', input.ownerAgentId)
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

  async create(input: CreatePatchArtifactInput, executor?: PoolClient): Promise<PatchArtifact> {
    const manifests = validatedInput(input)
    if (executor) return this.createWithClient(executor, input, manifests)
    const client = await this.pool.connect()
    try {
      await begin(client)
      const artifact = await this.createWithClient(client, input, manifests)
      await commit(client)
      return artifact
    } catch (error) {
      await rollbackQuietly(client)
      if ((error as { code?: string }).code === '23503') throw new PatchArtifactNotFoundError('referenced patch state was not found')
      throw error
    } finally {
      client.release()
    }
  }

  private async createWithClient(client: PoolClient, input: CreatePatchArtifactInput,
    manifests: ReturnType<typeof validatedInput>): Promise<PatchArtifact> {
    try {
      const existing = await this.artifactById(client, input.artifactId, true)
      if (existing) {
        if (!sameIdentity(existing, input)) throw new PatchArtifactConflictError('artifact identity conflicts with its durable record')
        await this.validateSnapshots(client, input, manifests)
        await this.validateObjects(client, input, manifests)
        await this.addReferences(client, input, manifests.contentObjectIds)
        return fromRow(existing)
      }

      await this.validateLeaseAndSnapshots(client, input, manifests)
      await this.validateObjects(client, input, manifests)
      await insertPatchArtifact.run(input, connection(client))
      const row = await this.artifactById(client, input.artifactId, true)
      if (!row || !sameIdentity(row, input)) throw new PatchArtifactConflictError('artifact identity conflicts with its durable record')
      await this.addReferences(client, input, manifests.contentObjectIds)
      return fromRow(row)
    } catch (error) {
      if ((error as { code?: string }).code === '23503') throw new PatchArtifactNotFoundError('referenced patch state was not found')
      throw error
    }
  }

  async getAuthorized(tenantId: string, artifactId: string, agentId: string, at = new Date()): Promise<PatchArtifact | null> {
    validateId('tenant ID', tenantId); validateId('artifact ID', artifactId); validateId('agent ID', agentId); validateDate('authorization time', at)
    const [row] = await getAuthorizedPatchArtifact.run({ artifactId, tenantId, agentId, at }, connection(this.pool))
    return row ? fromRow(row as ArtifactRow) : null
  }

  async getAuthorizedForOwner(tenantId: string, artifactId: string, ownerAgentId: string, at = new Date()): Promise<PatchArtifact | null> {
    validateId('tenant ID', tenantId); validateId('artifact ID', artifactId); validateId('owner agent ID', ownerAgentId); validateDate('authorization time', at)
    const [row] = await getOwnerAuthorizedPatchArtifact.run({ artifactId, tenantId, ownerAgentId, at }, connection(this.pool))
    return row ? fromRow(row as ArtifactRow) : null
  }

  /** Exact tenant-scoped durable read for fenced recovery; wall-clock expiry does not rewrite commit history. */
  async findForReconciliation(tenantId: string, artifactId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<PatchArtifact | null> {
    validateId('tenant ID', tenantId); validateId('artifact ID', artifactId)
    const [row] = await findPatchArtifactForReconciliation.run({ artifactId, tenantId }, connection(executor))
    return row ? fromRow(row as ArtifactRow) : null
  }

  async addReference(input: { tenantId: string; artifactId: string; referenceKind: 'codex_thread' | 'owner_agent' | 'operation'; referenceId: string; retainUntil?: Date | null }): Promise<void> {
    validateId('tenant ID', input.tenantId); validateId('artifact ID', input.artifactId); validateId('reference ID', input.referenceId)
    if (input.retainUntil) validateDate('retention expiry', input.retainUntil)
    const result = await addPatchArtifactReference.runWithCounts({ ...input, retainUntil: input.retainUntil ?? null }, connection(this.pool))
    if (result.rowCount !== 1) throw new PatchArtifactNotFoundError('artifact was not found')
  }

  async expireAvailable(tenantId: string, at = new Date()): Promise<number> {
    validateId('tenant ID', tenantId); validateDate('expiry time', at)
    return (await expireAvailablePatchArtifacts.runWithCounts({ tenantId, at }, connection(this.pool))).rowCount
  }

  private async artifactById(client: PoolClient, artifactId: string, lock: boolean): Promise<ArtifactRow | null> {
    const [row] = await (lock ? lockPatchArtifact : getPatchArtifact).run({ artifactId }, connection(client))
    return row as ArtifactRow | undefined ?? null
  }

  private async validateLeaseAndSnapshots(client: PoolClient, input: CreatePatchArtifactInput, manifests: { base: WorkspaceManifest; current: WorkspaceManifest }): Promise<void> {
    const [lease] = await lockPatchArtifactSourceLease.run({ leaseId: input.sourceLeaseId, tenantId: input.tenantId }, connection(client))
    if (!lease) throw new PatchArtifactNotFoundError('source lease was not found')
    if (lease.agent_id !== input.agentId || lease.owner_agent_id !== input.ownerAgentId
      || lease.base_snapshot_id !== input.baseSnapshotId || lease.latest_snapshot_id !== input.currentSnapshotId) {
      throw new PatchArtifactConflictError('artifact lineage does not match the source lease')
    }
    if (!['active', 'paused'].includes(lease.state)) throw new PatchArtifactConflictError('source lease cannot export a new artifact')

    await this.validateSnapshots(client, input, manifests)
  }

  private async validateSnapshots(client: PoolClient, input: CreatePatchArtifactInput, manifests: { base: WorkspaceManifest; current: WorkspaceManifest }): Promise<void> {
    const snapshots = await sharePatchArtifactSnapshots.run({ tenantId: input.tenantId,
      snapshotIds: [input.baseSnapshotId, input.currentSnapshotId] }, connection(client))
    const byId = new Map(snapshots.map(snapshot => [snapshot.snapshot_id, snapshot]))
    for (const [snapshotId, objectId, manifest] of [
      [input.baseSnapshotId, input.baseManifestObjectId, manifests.base],
      [input.currentSnapshotId, input.currentManifestObjectId, manifests.current],
    ] as const) {
      const snapshot = byId.get(snapshotId)
      if (!snapshot) throw new PatchArtifactNotFoundError('artifact snapshot was not found')
      if (snapshot.lease_id !== input.sourceLeaseId || snapshot.manifest_object_id !== objectId
        || snapshot.manifest_checksum !== workspaceManifestChecksum(manifest) || snapshot.state !== 'available'
        || (snapshot.expires_at !== null && snapshot.expires_at.getTime() <= Date.now())) {
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
    const rows = await sharePatchArtifactObjects.run({ objectIds: ids }, connection(client))
    const objects = new Map(rows.map(object => [object.object_id, object]))
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
      await retainPatchArtifactObject.run({ objectId, artifactId: input.artifactId, purpose,
        retainUntil: input.expiresAt }, connection(client))
    }
    for (const objectId of contentObjectIds) {
      await retainPatchArtifactObject.run({ objectId, artifactId: input.artifactId, purpose: 'content_blob',
        retainUntil: input.expiresAt }, connection(client))
    }
    await retainPatchArtifactSnapshots.run({ baseSnapshotId: input.baseSnapshotId,
      currentSnapshotId: input.currentSnapshotId, artifactId: input.artifactId,
      retainUntil: input.expiresAt }, connection(client))
    const retentionKind = input.ownerAgentId === null ? 'codex_thread' : 'owner_agent'
    const retentionId = input.ownerAgentId ?? input.agentId
    await retainPatchArtifact.run({ artifactId: input.artifactId, referenceKind: retentionKind,
      referenceId: retentionId, retainUntil: input.expiresAt }, connection(client))
  }
}
