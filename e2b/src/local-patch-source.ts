import { createHash } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type { IDatabaseConnection } from '@pgtyped/runtime'
import { beginRepeatableRead, commit, rollbackQuietly } from './db/primitives.js'
import { S3BlobStore, type ObjectStore } from './blob-store.js'
import { parsePatchArtifact, type SerializedPatchArtifact } from './patch-artifact.js'
import { PostgresPatchArtifactRepository } from './postgres-artifacts.js'
import { PostgresPatchExportSourceResolver } from './postgres-patch-export-source.js'
import { PostgresPatchExportCoordinator } from './postgres-patch-export.js'
import { PostgresObjectReclaimer } from './postgres-object-reclaimer.js'
import { PostgresDurableState } from './postgres-state.js'
import { PostgresJournal } from './postgres-store.js'
import { PocDatabaseInspector, PocProviderInspector, type PocLeaseInspection } from './poc-inspector.js'
import { canonicalJson, parseWorkspaceManifest, workspaceManifestChecksum } from './workspace-manifest.js'
import { resolveLocalRootPatchArtifact, shareLocalPatchArtifactRetention,
  sharePatchApplyObjectReferences, sharePatchApplySnapshots,
  sharePatchArtifactSnapshotReferences } from './db/queries/patches.queries.js'

function connection(client: PoolClient): IDatabaseConnection { return client as IDatabaseConnection }

interface RootArtifactRow {
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
  lease_agent_id: string
  owner_agent_id: string | null
  owner_lease_id: string | null
  source_snapshot_id: string | null
  lease_base_snapshot_id: string | null
  lease_latest_snapshot_id: string | null
  lease_state: string
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

export interface LocalPatchContentObject {
  objectId: string
  checksum: string
  sizeBytes: number
  bytes: Uint8Array
}

export interface ResolvedRootPatch {
  artifactId: string
  serialized: SerializedPatchArtifact
  contentObjects: LocalPatchContentObject[]
  expiresAt: Date
}

export interface ResolveRootPatchInput {
  runId: string
  databaseUrl: string
  sourceSnapshotId: string
  root: PocLeaseInspection
  provider: { apiKey: string; apiUrl: string; domain: string; validateApiKey?: boolean }
  objectStore: { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string }
}

function size(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('root patch object size is invalid')
  return parsed
}

function sameLease(left: PocLeaseInspection, right: PocLeaseInspection): boolean {
  return left.leaseId === right.leaseId && left.agentId === right.agentId
    && left.ownerAgentId === right.ownerAgentId && left.ownerLeaseId === right.ownerLeaseId
    && left.providerSandboxId === right.providerSandboxId && left.baseSnapshotId === right.baseSnapshotId
    && left.latestSnapshotId === right.latestSnapshotId && left.state === right.state
}

async function rowsForArtifact(client: PoolClient, tenantId: string,
  artifactId: string): Promise<ObjectRow[]> {
  return await sharePatchApplyObjectReferences.run({ tenantId, referenceKind: 'artifact',
    referenceId: artifactId }, connection(client)) as ObjectRow[]
}

async function verifiedBytes(store: ObjectStore, row: ObjectRow, at: Date): Promise<Uint8Array> {
  if (row.state !== 'available' || (row.expires_at !== null && row.expires_at <= at)
    || !/^sha256:[0-9a-f]{64}$/u.test(row.checksum)) throw new Error('root patch object is unavailable')
  const physicalId = row.checksum.slice('sha256:'.length)
  const location = store.location(physicalId)
  if (location.storageBucket !== row.storage_bucket || location.storageKey !== row.storage_key) {
    throw new Error('root patch object location is invalid')
  }
  const bytes = await store.get(physicalId)
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (actual !== row.checksum || bytes.byteLength !== size(row.size_bytes)) {
    throw new Error('root patch object identity is invalid')
  }
  return bytes
}

async function resolveMaterial(client: PoolClient, store: ObjectStore, tenantId: string,
  input: ResolveRootPatchInput, response: { artifactId: string; agentId: string; baseSnapshotId: string;
    checksum: string; changedFiles: number; sizeBytes: number }): Promise<ResolvedRootPatch> {
  const [artifactRow] = await resolveLocalRootPatchArtifact.run({ tenantId,
    artifactId: response.artifactId }, connection(client))
  const artifact = artifactRow as RootArtifactRow | undefined
  const now = new Date()
  if (!artifact || artifact.artifact_id !== response.artifactId
    || artifact.agent_id !== response.agentId || artifact.agent_id !== input.root.agentId
    || artifact.lease_agent_id !== input.root.agentId || artifact.source_lease_id !== input.root.leaseId
    || artifact.owner_agent_id !== null || artifact.owner_lease_id !== null
    || artifact.source_snapshot_id !== input.sourceSnapshotId
    || artifact.base_snapshot_id !== response.baseSnapshotId
    || artifact.base_snapshot_id !== input.root.baseSnapshotId
    || artifact.current_snapshot_id !== input.root.latestSnapshotId
    || artifact.lease_base_snapshot_id !== input.root.baseSnapshotId
    || artifact.lease_latest_snapshot_id !== input.root.latestSnapshotId
    || !['active', 'paused'].includes(artifact.lease_state)
    || artifact.state !== 'available' || artifact.expires_at <= now
    || artifact.checksum !== response.checksum || artifact.changed_files !== response.changedFiles
    || size(artifact.size_bytes) !== response.sizeBytes) throw new Error('root patch artifact identity is invalid')

  const retention = await shareLocalPatchArtifactRetention.run({ artifactId: artifact.artifact_id }, connection(client))
  if (retention.length !== 1 || retention[0]!.reference_kind !== 'codex_thread'
    || retention[0]!.reference_id !== input.root.agentId
    || (retention[0]!.retain_until !== null && retention[0]!.retain_until! < artifact.expires_at)) {
    throw new Error('root patch artifact retention is invalid')
  }

  const snapshots = await sharePatchApplySnapshots.run({ tenantId,
    snapshotIds: [artifact.base_snapshot_id, artifact.current_snapshot_id] }, connection(client))
  const snapshotById = new Map(snapshots.map(row => [row.snapshot_id, row as SnapshotRow]))
  for (const [snapshotId, manifestObjectId] of [
    [artifact.base_snapshot_id, artifact.base_manifest_object_id],
    [artifact.current_snapshot_id, artifact.current_manifest_object_id],
  ] as const) {
    const snapshot = snapshotById.get(snapshotId)
    if (!snapshot || snapshot.lease_id !== input.root.leaseId
      || snapshot.manifest_object_id !== manifestObjectId || snapshot.state !== 'available'
      || (snapshot.expires_at !== null && snapshot.expires_at <= now)) {
      throw new Error('root patch snapshot lineage is invalid')
    }
  }
  const snapshotReferences = await sharePatchArtifactSnapshotReferences.run(
    { artifactId: artifact.artifact_id }, connection(client))
  const expectedSnapshotReferences = new Set([
    `${artifact.base_snapshot_id}\u0000artifact_base`, `${artifact.current_snapshot_id}\u0000artifact_current`,
  ])
  if (snapshotReferences.length !== expectedSnapshotReferences.size
    || snapshotReferences.some(row => !expectedSnapshotReferences.has(`${row.snapshot_id}\u0000${row.reference_kind}`)
      || (row.retain_until !== null && row.retain_until < artifact.expires_at))) {
    throw new Error('root patch snapshot retention is invalid')
  }

  const rows = await rowsForArtifact(client, tenantId, artifact.artifact_id)
  if (rows.some(row => !['base_manifest', 'current_manifest', 'patch_artifact', 'content_blob'].includes(row.purpose)
    || (row.retain_until !== null && row.retain_until < artifact.expires_at))) {
    throw new Error('root patch object graph is invalid')
  }
  const exact = (purpose: string, objectId: string): ObjectRow => {
    const matches = rows.filter(row => row.purpose === purpose && row.object_id === objectId)
    if (matches.length !== 1 || rows.some(row => row.purpose === purpose && row.object_id !== objectId)) {
      throw new Error('root patch object graph is invalid')
    }
    return matches[0]!
  }
  const artifactObject = exact('patch_artifact', artifact.artifact_object_id)
  if (artifactObject.kind !== 'patch_artifact' || artifactObject.checksum !== artifact.checksum) {
    throw new Error('root patch artifact object is invalid')
  }
  const serialized = parsePatchArtifact(await verifiedBytes(store, artifactObject, now), artifact.checksum)
  if (serialized.artifact.agentId !== artifact.agent_id
    || serialized.artifact.baseSnapshotId !== artifact.base_snapshot_id
    || serialized.artifact.currentSnapshotId !== artifact.current_snapshot_id
    || serialized.changedFiles !== artifact.changed_files || serialized.sizeBytes !== size(artifact.size_bytes)) {
    throw new Error('root patch serialized metadata is invalid')
  }
  for (const [purpose, objectId, snapshotId, manifest] of [
    ['base_manifest', artifact.base_manifest_object_id, artifact.base_snapshot_id, serialized.artifact.baseManifest],
    ['current_manifest', artifact.current_manifest_object_id, artifact.current_snapshot_id, serialized.artifact.currentManifest],
  ] as const) {
    const row = exact(purpose, objectId)
    const snapshot = snapshotById.get(snapshotId)!
    if (row.kind !== 'manifest' || row.checksum !== snapshot.manifest_checksum
      || workspaceManifestChecksum(manifest) !== snapshot.manifest_checksum) {
      throw new Error('root patch manifest identity is invalid')
    }
    const stored = parseWorkspaceManifest(
      await verifiedBytes(store, row, now), snapshotId, snapshot.manifest_checksum)
    if (canonicalJson(stored) !== canonicalJson(manifest)) throw new Error('root patch manifest material is invalid')
  }
  const expectedContents = new Set(serialized.contentObjectIds)
  const contentRows = rows.filter(row => row.purpose === 'content_blob')
  if (contentRows.length !== expectedContents.size
    || new Set(contentRows.map(row => row.object_id)).size !== expectedContents.size
    || contentRows.some(row => !expectedContents.has(row.object_id) || row.kind !== 'content_blob')) {
    throw new Error('root patch content graph is invalid')
  }
  const contentObjects: LocalPatchContentObject[] = []
  for (const row of contentRows) contentObjects.push({ objectId: row.object_id, checksum: row.checksum,
    sizeBytes: size(row.size_bytes), bytes: await verifiedBytes(store, row, now) })
  return { artifactId: artifact.artifact_id, serialized, contentObjects, expiresAt: artifact.expires_at }
}

/**
 * Resolves the pilot's exact root artifact directly from local PostgreSQL and
 * object storage. No patch material is exposed through a download endpoint.
 */
export async function resolveRootPatch(input: ResolveRootPatchInput): Promise<ResolvedRootPatch> {
  if (!/^\d{14}-[0-9a-f]{12}$/u.test(input.runId)) throw new Error('invalid root patch run ID')
  const tenantId = `poc-${input.runId}`
  const managedBy = `cudex-poc-${input.runId}`
  const store = new S3BlobStore({ bucket: input.objectStore.bucket, endpoint: input.objectStore.endpoint,
    region: 'garage', forcePathStyle: true,
    credentials: { accessKeyId: input.objectStore.accessKeyId,
      secretAccessKey: input.objectStore.secretAccessKey } })
  const pool = new Pool({ connectionString: input.databaseUrl })
  try {
    return await resolveRootPatchFromStores(input, pool, store, async database => {
      const inventory = await new PocProviderInspector(input.provider, managedBy, tenantId).inspect(database)
      return Boolean(input.root.providerSandboxId
        && inventory.managedSandboxIds.includes(input.root.providerSandboxId))
    })
  } finally { await pool.end() }
}

/** Composable exact resolver used by the fake-provider acceptance harness. */
export async function resolveRootPatchFromStores(input: ResolveRootPatchInput, pool: Pool,
  store: ObjectStore, verifyProviderOwnership: (database: Awaited<ReturnType<PocDatabaseInspector['inspect']>>)
    => Promise<boolean>): Promise<ResolvedRootPatch> {
  if (!/^\d{14}-[0-9a-f]{12}$/u.test(input.runId)) throw new Error('invalid root patch run ID')
  const tenantId = `poc-${input.runId}`
  const database = await new PocDatabaseInspector(pool, tenantId).inspect()
  const roots = database.leases.filter(lease => lease.ownerAgentId === null && lease.ownerLeaseId === null)
  if (roots.length !== 1 || !sameLease(roots[0]!, input.root) || !input.root.providerSandboxId) {
    throw new Error('root patch lease identity is invalid')
  }
  if (!await verifyProviderOwnership(database)) throw new Error('root patch provider ownership is invalid')
  const journal = new PostgresJournal(pool)
  const state = new PostgresDurableState(pool)
  const artifacts = new PostgresPatchArtifactRepository(pool)
  const reclaimer = new PostgresObjectReclaimer(pool, store)
  const coordinator = new PostgresPatchExportCoordinator(journal, state,
    new PostgresPatchExportSourceResolver(pool, store), artifacts, store, reclaimer,
    { tenantId, workerId: `cudex-root-return-${input.runId}` })
  const response = await coordinator.exportRootPatch({ leaseId: input.root.leaseId,
    agentId: input.root.agentId, baseSnapshotId: input.root.baseSnapshotId!,
    idempotencyKey: `cudex-root-return-${input.runId}` }, input.sourceSnapshotId)
  const client = await pool.connect()
  try {
    await beginRepeatableRead(client)
    const material = await resolveMaterial(client, store, tenantId, input, response)
    await commit(client)
    return material
  } catch (error) {
    await rollbackQuietly(client)
    throw error
  } finally { client.release() }
}
