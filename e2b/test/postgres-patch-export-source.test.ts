import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import {
  PostgresPatchExportSourceResolver,
} from '../src/postgres-patch-export-source.js'
import { PostgresDurableState, type StoredObject } from '../src/postgres-state.js'
import { PostgresReferenceRetention } from '../src/postgres-reference-retention.js'
import { PostgresPatchExportCoordinator } from '../src/postgres-patch-export.js'
import { PostgresPatchArtifactRepository } from '../src/postgres-artifacts.js'
import { PostgresJournal } from '../src/postgres-store.js'
import { PostgresObjectReclaimer } from '../src/postgres-object-reclaimer.js'
import { selectRootLease } from '../src/restore-lineage.js'
import { ServiceError } from '../src/types.js'
import {
  canonicalJson,
  createWorkspaceManifest,
  type WorkspaceEntry,
  type WorkspaceManifest,
} from '../src/workspace-manifest.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const checksum = (bytes: Uint8Array): string => `sha256:${sha256(bytes)}`
const encoded = (value: string): Uint8Array => new TextEncoder().encode(value)

class TrackingObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  readonly locationOverrides = new Map<string, { storageBucket: string; storageKey: string }>()
  readonly gets: string[] = []

  async put(bytes: Uint8Array): Promise<string> {
    const id = sha256(bytes)
    this.values.set(id, Uint8Array.from(bytes))
    return id
  }

  async get(id: string): Promise<Uint8Array> {
    this.gets.push(id)
    const value = this.values.get(id)
    if (!value) throw new Error('missing object')
    return Uint8Array.from(value)
  }

  async delete(id: string): Promise<void> { this.values.delete(id) }

  location(id: string): { storageBucket: string; storageKey: string } {
    return this.locationOverrides.get(id)
      ?? { storageBucket: 'patch-export-test', storageKey: `v1/sha256/${id.slice(0, 2)}/${id}` }
  }
}

interface Fixture {
  admin: Pool
  pool: Pool
  state: PostgresDurableState
  objects: TrackingObjects
  resolver: PostgresPatchExportSourceResolver
  schema: string
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_patch_source_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  await runMigrations(pool)
  const objects = new TrackingObjects()
  return {
    admin, pool, objects, schema, state: new PostgresDurableState(pool),
    resolver: new PostgresPatchExportSourceResolver(pool, objects),
  }
}

async function cleanup(context: Fixture): Promise<void> {
  await context.pool.end()
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

const live = (name: string, fn: (context: Fixture) => Promise<void>) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try { await fn(context) } finally { await cleanup(context) }
})

const file = (path: string, bytes: Uint8Array): WorkspaceEntry => ({
  path, type: 'file', mode: 0o644, digest: checksum(bytes), sizeBytes: bytes.byteLength,
})

interface Prepared {
  baseManifest: WorkspaceManifest
  currentManifest: WorkspaceManifest
  baseContent: StoredObject
  currentContent: StoredObject
  addedContent: StoredObject
  currentManifestObject: StoredObject
}

async function register(context: Fixture, objectId: string, kind: StoredObject['kind'], bytes: Uint8Array,
  sizeDelta = 0): Promise<StoredObject> {
  const physicalId = await context.objects.put(bytes)
  const location = context.objects.location(physicalId)
  const object: StoredObject = {
    objectId, tenantId: 'tenant-1', kind, ...location, checksum: checksum(bytes),
    sizeBytes: bytes.byteLength + sizeDelta, state: 'available', expiresAt: null,
  }
  await context.state.registerObject(object)
  return object
}

async function prepared(context: Fixture, options: {
  root?: boolean
  currentManifestBytes?: (manifest: WorkspaceManifest) => Uint8Array
  currentManifestSizeDelta?: number
} = {}): Promise<Prepared> {
  const baseBytes = encoded('base bytes')
  const currentBytes = encoded('current bytes')
  const addedBytes = Uint8Array.from([0, 255, 1, 2])
  const baseManifest = createWorkspaceManifest('snapshot-base', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/file', baseBytes),
  ])
  const currentManifest = createWorkspaceManifest('snapshot-current', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/file', currentBytes),
    file('roots/added.bin', addedBytes),
  ])
  const baseManifestBytes = encoded(canonicalJson(baseManifest))
  const currentManifestBytes = options.currentManifestBytes?.(currentManifest)
    ?? encoded(canonicalJson(currentManifest))

  const archiveBase = await register(context, 'archive-base', 'workspace_archive', encoded('archive base'))
  const manifestBase = await register(context, 'manifest-base', 'manifest', baseManifestBytes)
  const baseContent = await register(context, 'content-base', 'content_blob', baseBytes)
  const archiveCurrent = await register(context, 'archive-current', 'workspace_archive', encoded('archive current'))
  const currentManifestObject = await register(context, 'manifest-current', 'manifest',
    currentManifestBytes, options.currentManifestSizeDelta ?? 0)
  const currentContent = await register(context, 'content-current', 'content_blob', currentBytes)
  const addedContent = await register(context, 'content-added', 'content_blob', addedBytes)

  if (options.root) {
    const sourceArchive = await register(context, 'source-archive', 'source_archive', encoded('source archive'))
    await context.state.registerSourceSnapshot({ sourceSnapshotId: 'source-original',
      tenantId: 'tenant-1', archiveObjectId: sourceArchive.objectId, checksum: sourceArchive.checksum,
      cwdUri: 'file:///workspace/roots', workspaceRootUris: ['file:///workspace/roots'],
      state: 'available', expiresAt: new Date(Date.now() + 60_000) })
  }

  await context.state.createLeaseWithBaseSnapshot({
    leaseId: 'lease-child', environmentId: 'environment-child', tenantId: 'tenant-1',
    agentId: 'agent-child', ownerAgentId: options.root ? null : 'agent-owner', providerSandboxId: 'sandbox-child',
    sourceSnapshotId: options.root ? 'source-original' : null,
    sandboxTemplate: 'general-v1', cwdUri: 'file:///workspace/roots',
    workspaceRootUris: ['file:///workspace/roots'], toolPolicy: {}, policyVersion: 1,
    baseSnapshot: {
      snapshotId: 'snapshot-base', providerSnapshotId: 'provider-base',
      workspaceArchiveObjectId: archiveBase.objectId, manifestObjectId: manifestBase.objectId,
      manifestChecksum: manifestBase.checksum, contentObjectIds: [baseContent.objectId],
    },
  })
  await context.state.appendCheckpoint('tenant-1', 'lease-child', {
    snapshotId: 'snapshot-current', providerSnapshotId: 'provider-current',
    workspaceArchiveObjectId: archiveCurrent.objectId,
    manifestObjectId: currentManifestObject.objectId,
    manifestChecksum: currentManifestObject.checksum,
    contentObjectIds: [currentContent.objectId, addedContent.objectId],
  })
  return { baseManifest, currentManifest, baseContent, currentContent, addedContent,
    currentManifestObject }
}

const request = {
  tenantId: 'tenant-1', leaseId: 'lease-child', agentId: 'agent-child',
  baseSnapshotId: 'snapshot-base',
}

const serviceFailure = (status: number, message: string) => (error: unknown): boolean =>
  error instanceof ServiceError && error.status === status && error.message === message

live('resolves the exact authorized base/latest manifests and referenced content graph', async context => {
  const setup = await prepared(context)
  const resolved = await context.resolver.resolve(request)

  assert.deepEqual(resolved.lease, {
    leaseId: request.leaseId, agentId: request.agentId, ownerAgentId: 'agent-owner',
    baseSnapshotId: request.baseSnapshotId, latestSnapshotId: 'snapshot-current',
  })
  assert.deepEqual(resolved.base.manifest, setup.baseManifest)
  assert.deepEqual(resolved.current.manifest, setup.currentManifest)
  assert.deepEqual(resolved.base.contentObjects, [{
    objectId: setup.baseContent.objectId, checksum: setup.baseContent.checksum,
    sizeBytes: setup.baseContent.sizeBytes,
  }])
  assert.deepEqual(resolved.current.contentObjects, [setup.addedContent, setup.currentContent]
    .sort((left, right) => left.objectId.localeCompare(right.objectId))
    .map(object => ({ objectId: object.objectId, checksum: object.checksum, sizeBytes: object.sizeBytes })))
  assert.equal(context.objects.gets.length, 5)
})

live('fails closed on agent authorization, requested base, and tenant mismatch', async context => {
  await prepared(context)
  await assert.rejects(context.resolver.resolve({ ...request, agentId: 'agent-other' }),
    serviceFailure(409, 'lease cannot export a patch'))
  await assert.rejects(context.resolver.resolve({ ...request, baseSnapshotId: 'snapshot-current' }),
    serviceFailure(409, 'lease cannot export a patch'))
  await assert.rejects(context.resolver.resolve({ ...request, tenantId: 'tenant-2' }),
    serviceFailure(404, 'lease missing'))
  assert.equal(context.objects.gets.length, 0)
})

live('rejects an expired base or latest snapshot before loading its material', async context => {
  await prepared(context)
  for (const snapshotId of ['snapshot-base', 'snapshot-current']) {
    await context.pool.query(`UPDATE hosted_agent_snapshots SET expires_at = now() - interval '1 second'
      WHERE snapshot_id = $1`, [snapshotId])
    await assert.rejects(context.resolver.resolve(request), serviceFailure(404, 'snapshot missing'))
    await context.pool.query(`UPDATE hosted_agent_snapshots SET expires_at = NULL WHERE snapshot_id = $1`, [snapshotId])
  }
})

live('fails closed on object locator or checksum corruption', async context => {
  const setup = await prepared(context)
  const physicalId = setup.currentManifestObject.checksum.slice('sha256:'.length)
  context.objects.locationOverrides.set(physicalId, {
    storageBucket: 'patch-export-test', storageKey: 'wrong/key',
  })
  await assert.rejects(context.resolver.resolve(request),
    serviceFailure(503, 'patch export object unavailable'))

  context.objects.locationOverrides.delete(physicalId)
  context.objects.values.set(physicalId, encoded('corrupt manifest bytes'))
  await assert.rejects(context.resolver.resolve(request),
    serviceFailure(503, 'patch export object unavailable'))
})

live('fails closed when durable object size does not match verified bytes', async context => {
  await prepared(context, { currentManifestSizeDelta: 1 })
  await assert.rejects(context.resolver.resolve(request),
    serviceFailure(503, 'patch export object unavailable'))
})

live('fails closed on checksummed canonical manifest corruption', async context => {
  await prepared(context, { currentManifestBytes: manifest => encoded(canonicalJson({
    ...manifest, unexpected: true,
  })) })
  await assert.rejects(context.resolver.resolve(request),
    serviceFailure(503, 'patch export source unavailable'))
})

async function restored(context: Fixture, original: Prepared, ownerAgentId: string | null): Promise<void> {
  await context.pool.query("UPDATE hosted_agent_leases SET state='lost' WHERE lease_id='lease-child'")
  const manifest = createWorkspaceManifest('snapshot-restored', original.currentManifest.entries)
  const archive = await register(context, 'archive-restored', 'workspace_archive', encoded('restored archive'))
  const manifestObject = await register(context, 'manifest-restored', 'manifest', encoded(canonicalJson(manifest)))
  await context.state.createLeaseWithBaseSnapshot({ leaseId: 'lease-restored', environmentId: 'environment-restored',
    tenantId: 'tenant-1', agentId: 'agent-child', ownerAgentId, providerSandboxId: 'sandbox-restored',
    restoreSourceLeaseId: 'lease-child', restoreSourceSnapshotId: 'snapshot-current',
    sandboxTemplate: 'general-v1', cwdUri: 'file:///workspace/roots', workspaceRootUris: ['file:///workspace/roots'],
    toolPolicy: {}, policyVersion: 1, baseSnapshot: { snapshotId: 'snapshot-restored', providerSnapshotId: 'provider-restored',
      workspaceArchiveObjectId: archive.objectId, manifestObjectId: manifestObject.objectId,
      manifestChecksum: manifestObject.checksum, contentObjectIds: [original.currentContent.objectId, original.addedContent.objectId] } })
}

for (const root of [false, true]) live(`restored ${root ? 'root' : 'child'} exports and retains its exact ancestral baseline`, async context => {
  const original = await prepared(context, { root })
  const retained = new PostgresReferenceRetention(context.pool, 'tenant-1')
  const initial = await retained.retain({ agentId: 'agent-child', leaseId: 'lease-child', baseSnapshotId: 'snapshot-base',
    latestSnapshotId: 'snapshot-current', artifactId: null, expectedRevision: null })
  await restored(context, original, root ? null : 'agent-owner')
  const next = await retained.retain({ agentId: 'agent-child', leaseId: 'lease-restored', baseSnapshotId: 'snapshot-base',
    latestSnapshotId: 'snapshot-restored', artifactId: null, expectedRevision: initial.revision })
  assert.equal(next.revision, initial.revision + 1)
  const coordinator = new PostgresPatchExportCoordinator(new PostgresJournal(context.pool), context.state,
    context.resolver, new PostgresPatchArtifactRepository(context.pool), context.objects,
    new PostgresObjectReclaimer(context.pool, context.objects), { tenantId: 'tenant-1', workerId: 'restore-test' })
  const request = { leaseId: 'lease-restored', agentId: 'agent-child', baseSnapshotId: 'snapshot-base', idempotencyKey: 'restored-export' }
  const artifact = root ? await coordinator.exportRootPatch(request, 'source-original') : await coordinator.exportPatch(request)
  assert.equal(artifact.baseSnapshotId, 'snapshot-base')
  assert.equal(artifact.changedFiles, 2)
  const source = await context.resolver.resolve({ ...request, tenantId: 'tenant-1',
    ...(root ? { rootSourceSnapshotId: 'source-original' } : {}) })
  assert.deepEqual(source.base.manifest, original.baseManifest)
  if (root) {
    const chosen = await selectRootLease(context.pool, 'tenant-1', [
      { leaseId: 'lease-child', ownerAgentId: null, ownerLeaseId: null },
      { leaseId: 'lease-restored', ownerAgentId: null, ownerLeaseId: null },
    ])
    assert.equal(chosen?.leaseId, 'lease-restored')
  }
})

live('restore ancestry cannot borrow another owner baseline even for the same agent', async context => {
  const original = await prepared(context)
  await restored(context, original, 'different-owner')
  await assert.rejects(context.resolver.resolve({ ...request, leaseId: 'lease-restored' }),
    error => error instanceof ServiceError && error.status === 409)
  const retained = new PostgresReferenceRetention(context.pool, 'tenant-1')
  await assert.rejects(retained.retain({ agentId: 'agent-child', leaseId: 'lease-restored',
    baseSnapshotId: 'snapshot-base', latestSnapshotId: 'snapshot-restored', artifactId: null, expectedRevision: null }),
    error => error instanceof ServiceError && error.status === 409)
  assert.equal(context.objects.gets.length, 0)
})

live('restore ancestry rejects active ancestors before exposing snapshot bytes', async context => {
  const original = await prepared(context)
  await restored(context, original, 'agent-owner')
  await context.pool.query("UPDATE hosted_agent_leases SET state='active' WHERE lease_id='lease-child'")
  await assert.rejects(context.resolver.resolve({ ...request, leaseId: 'lease-restored' }),
    error => error instanceof ServiceError && error.status === 409)
  assert.equal(context.objects.gets.length, 0)
})
