import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import {
  PatchApplyRejectedError,
  PostgresPatchApplySourceResolver,
} from '../src/postgres-patch-apply-source.js'
import { serializePatchArtifact } from '../src/patch-artifact.js'
import { PostgresPatchArtifactRepository } from '../src/postgres-artifacts.js'
import {
  PostgresDurableState,
  type SnapshotInput,
  type StoredObject,
} from '../src/postgres-state.js'
import { ServiceError } from '../src/types.js'
import {
  canonicalJson,
  createWorkspaceManifest,
  type WorkspaceEntry,
  type WorkspaceManifest,
} from '../src/workspace-manifest.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const encoded = (value: string): Uint8Array => new TextEncoder().encode(value)
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const checksum = (value: Uint8Array): string => `sha256:${sha256(value)}`
const file = (path: string, value: Uint8Array): WorkspaceEntry => ({
  path, type: 'file', mode: 0o644, digest: checksum(value), sizeBytes: value.byteLength,
})

class TrackingObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  readonly locationOverrides = new Map<string, { storageBucket: string; storageKey: string }>()

  async put(bytes: Uint8Array): Promise<string> {
    const id = sha256(bytes)
    this.values.set(id, Uint8Array.from(bytes))
    return id
  }

  async get(id: string): Promise<Uint8Array> {
    const value = this.values.get(id)
    if (!value) throw new Error('missing object')
    return Uint8Array.from(value)
  }

  async delete(id: string): Promise<void> { this.values.delete(id) }

  location(id: string): { storageBucket: string; storageKey: string } {
    return this.locationOverrides.get(id)
      ?? { storageBucket: 'patch-apply-test', storageKey: `v1/sha256/${id.slice(0, 2)}/${id}` }
  }
}

interface Fixture {
  admin: Pool
  firstPool: Pool
  secondPool: Pool
  firstState: PostgresDurableState
  secondState: PostgresDurableState
  artifacts: PostgresPatchArtifactRepository
  objects: TrackingObjects
  resolver: PostgresPatchApplySourceResolver
  schema: string
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_patch_apply_source_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const config = { connectionString: databaseUrl, options: `-c search_path=${schema}` }
  const firstPool = new Pool(config); const secondPool = new Pool(config)
  await runMigrations(firstPool)
  const objects = new TrackingObjects()
  return {
    admin, firstPool, secondPool, objects, schema,
    firstState: new PostgresDurableState(firstPool),
    secondState: new PostgresDurableState(secondPool),
    artifacts: new PostgresPatchArtifactRepository(firstPool),
    resolver: new PostgresPatchApplySourceResolver(firstPool, objects),
  }
}

async function cleanup(context: Fixture): Promise<void> {
  await context.firstPool.end(); await context.secondPool.end()
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

const live = (name: string, fn: (context: Fixture) => Promise<void>) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try { await fn(context) } finally { await cleanup(context) }
})

async function register(context: Fixture, objectId: string, kind: StoredObject['kind'],
  bytes: Uint8Array, options: { sizeDelta?: number; expiresAt?: Date | null } = {}):
Promise<StoredObject> {
  const physicalId = await context.objects.put(bytes)
  const object: StoredObject = {
    objectId, tenantId: 'tenant-1', kind, ...context.objects.location(physicalId),
    checksum: checksum(bytes), sizeBytes: bytes.byteLength + (options.sizeDelta ?? 0),
    state: 'available', expiresAt: options.expiresAt ?? null,
  }
  await context.firstState.registerObject(object)
  return object
}

async function snapshot(context: Fixture, prefix: string, manifest: WorkspaceManifest,
  contentObjectIds: string[]): Promise<SnapshotInput> {
  const archive = await register(context, `${prefix}-archive`, 'workspace_archive', encoded(`${prefix} archive`))
  const manifestObject = await register(context, `${prefix}-manifest`, 'manifest',
    encoded(canonicalJson(manifest)))
  return {
    snapshotId: manifest.identity, providerSnapshotId: `${prefix}-provider`,
    workspaceArchiveObjectId: archive.objectId, manifestObjectId: manifestObject.objectId,
    manifestChecksum: manifestObject.checksum, contentObjectIds,
  }
}

interface Prepared {
  baseBytes: Uint8Array
  changedBytes: Uint8Array
  ownerBytes: Uint8Array
  baseManifest: WorkspaceManifest
  currentManifest: WorkspaceManifest
  targetManifest: WorkspaceManifest
  artifactPhysicalId: string
  targetSnapshot: SnapshotInput
}

async function prepared(context: Fixture, targetFile?: Uint8Array): Promise<Prepared> {
  const baseBytes = encoded('base bytes')
  const changedBytes = encoded('changed bytes')
  const ownerBytes = encoded('owner bytes')
  const baseContent = await register(context, 'content-base', 'content_blob', baseBytes)
  const changedContent = await register(context, 'content-changed', 'content_blob', changedBytes)
  const ownerContent = await register(context, 'content-owner', 'content_blob', ownerBytes)
  let targetContent = baseContent
  if (targetFile !== undefined && checksum(targetFile) !== baseContent.checksum) {
    targetContent = await register(context, 'content-target', 'content_blob', targetFile)
  }

  const baseManifest = createWorkspaceManifest('snapshot-child-base', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/file', baseBytes),
  ])
  const currentManifest = createWorkspaceManifest('snapshot-child-current', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/file', changedBytes),
    { path: 'roots/link', type: 'symlink', mode: 0o777, linkTarget: 'file' },
  ])
  const targetManifest = createWorkspaceManifest('snapshot-target', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/file', targetFile ?? baseBytes),
    file('roots/owner', ownerBytes),
  ])
  const targetSnapshot = await snapshot(context, 'target', targetManifest,
    [targetContent.objectId, ownerContent.objectId])
  await context.firstState.createLeaseWithBaseSnapshot({
    leaseId: 'lease-target', environmentId: 'environment-target', tenantId: 'tenant-1',
    agentId: 'agent-owner', providerSandboxId: 'sandbox-target', sandboxTemplate: 'general-v1',
    cwdUri: 'file:///workspace/roots', workspaceRootUris: ['file:///workspace/roots'],
    toolPolicy: {}, policyVersion: 1, baseSnapshot: targetSnapshot,
  })

  const baseSnapshot = await snapshot(context, 'child-base', baseManifest, [baseContent.objectId])
  const currentSnapshot = await snapshot(context, 'child-current', currentManifest,
    [changedContent.objectId])
  await context.firstState.createLeaseWithBaseSnapshot({
    leaseId: 'lease-child', environmentId: 'environment-child', tenantId: 'tenant-1',
    agentId: 'agent-child', ownerAgentId: 'agent-owner', ownerLeaseId: 'lease-target',
    providerSandboxId: 'sandbox-child', sandboxTemplate: 'general-v1',
    cwdUri: 'file:///workspace/roots', workspaceRootUris: ['file:///workspace/roots'],
    toolPolicy: {}, policyVersion: 1, baseSnapshot,
  })
  await context.firstState.appendCheckpoint('tenant-1', 'lease-child', currentSnapshot)

  const serialized = serializePatchArtifact({
    agentId: 'agent-child', baseSnapshotId: baseManifest.identity,
    currentSnapshotId: currentManifest.identity, baseManifest, currentManifest,
    contentObjects: [{ path: 'roots/file', objectId: changedContent.objectId }],
  })
  const artifactPhysicalId = await context.objects.put(serialized.bytes)
  const artifactObject = await register(context, 'artifact-object', 'patch_artifact', serialized.bytes)
  await context.artifacts.create({
    artifactId: 'artifact-1', tenantId: 'tenant-1', agentId: 'agent-child',
    ownerAgentId: 'agent-owner', sourceLeaseId: 'lease-child',
    baseSnapshotId: baseManifest.identity, currentSnapshotId: currentManifest.identity,
    baseManifestObjectId: baseSnapshot.manifestObjectId,
    currentManifestObjectId: currentSnapshot.manifestObjectId,
    artifactObjectId: artifactObject.objectId,
    contentObjects: [{ path: 'roots/file', objectId: changedContent.objectId }],
    checksum: serialized.checksum, changedFiles: serialized.changedFiles,
    sizeBytes: serialized.sizeBytes, state: 'available',
    expiresAt: new Date(Date.now() + 5 * 60_000), baseManifest, currentManifest,
  })
  return { baseBytes, changedBytes, ownerBytes, baseManifest, currentManifest,
    targetManifest, artifactPhysicalId, targetSnapshot }
}

const request = {
  tenantId: 'tenant-1', targetLeaseId: 'lease-target', artifactId: 'artifact-1',
  resultSnapshotId: 'snapshot-result',
}

const serviceFailure = (status: number, message: string) => (error: unknown): boolean =>
  error instanceof ServiceError && error.status === status && error.message === message

live('resolves exact verified material and a complete plan after the child is released', async context => {
  const setup = await prepared(context)
  await context.firstState.beginRelease('tenant-1', 'lease-child')
  await context.firstState.releaseLease('tenant-1', 'lease-child')
  const resolved = await context.resolver.resolve(request)

  assert.deepEqual({
    leaseId: resolved.target.leaseId, agentId: resolved.target.agentId,
    providerSandboxId: resolved.target.providerSandboxId,
    latestSnapshotId: resolved.target.latestSnapshotId,
  }, {
    leaseId: 'lease-target', agentId: 'agent-owner', providerSandboxId: 'sandbox-target',
    latestSnapshotId: 'snapshot-target',
  })
  assert.equal(resolved.artifact.sourceLeaseId, 'lease-child')
  assert.equal(resolved.plan.type, 'ready')
  if (resolved.plan.type !== 'ready') return
  assert.deepEqual(resolved.plan.manifest, createWorkspaceManifest('snapshot-result', [
    ...setup.currentManifest.entries, file('roots/owner', setup.ownerBytes),
  ]))
  assert.deepEqual(resolved.plan.contentObjects.map(value => [value.path, value.objectId]), [
    ['roots/file', 'content-changed'], ['roots/owner', 'content-owner'],
  ])
  assert.deepEqual(resolved.artifact.contentObjects[0]!.bytes, setup.changedBytes)
})

live('returns the complete conflict result without producing a ready mutation plan', async context => {
  await prepared(context, encoded('owner changed the same file'))
  const resolved = await context.resolver.resolve(request)
  assert.deepEqual(resolved.plan, {
    type: 'conflict', paths: ['file:///workspace/roots/file'], total: 1, truncated: false,
  })
})

live('requires the exact owner lease and hides tenant, lease, and expiry mismatches', async context => {
  const setup = await prepared(context)
  const otherManifest = createWorkspaceManifest('snapshot-other-target', setup.targetManifest.entries)
  const otherSnapshot = await snapshot(context, 'other-target', otherManifest,
    ['content-base', 'content-owner'])
  await context.firstState.createLeaseWithBaseSnapshot({
    leaseId: 'lease-other-target', environmentId: 'environment-other-target', tenantId: 'tenant-1',
    agentId: 'agent-owner', providerSandboxId: 'sandbox-other-target', sandboxTemplate: 'general-v1',
    cwdUri: 'file:///workspace/roots', workspaceRootUris: ['file:///workspace/roots'],
    toolPolicy: {}, policyVersion: 1, baseSnapshot: otherSnapshot,
  })
  await assert.rejects(context.resolver.resolve({ ...request, targetLeaseId: 'lease-other-target' }),
    error => error instanceof PatchApplyRejectedError && error.reason === 'artifact is unavailable')
  await assert.rejects(context.resolver.resolve({ ...request, tenantId: 'tenant-2' }),
    serviceFailure(404, 'target lease missing'))

  await context.artifacts.expireAvailable('tenant-1', new Date(Date.now() + 10 * 60_000))
  await assert.rejects(context.resolver.resolve(request),
    error => error instanceof PatchApplyRejectedError && error.reason === 'artifact is unavailable')
})

live('fails closed on missing references, dishonest locators, and corrupt bytes', async context => {
  const setup = await prepared(context)
  const original = context.objects.values.get(setup.artifactPhysicalId)!
  context.objects.locationOverrides.set(setup.artifactPhysicalId, {
    storageBucket: 'patch-apply-test', storageKey: 'wrong/artifact',
  })
  await assert.rejects(context.resolver.resolve(request),
    serviceFailure(503, 'patch apply object unavailable'))

  context.objects.locationOverrides.delete(setup.artifactPhysicalId)
  context.objects.values.set(setup.artifactPhysicalId, encoded('corrupt'))
  await assert.rejects(context.resolver.resolve(request),
    serviceFailure(503, 'patch apply object unavailable'))

  context.objects.values.set(setup.artifactPhysicalId, original)
  await context.firstPool.query(`
    DELETE FROM hosted_agent_object_references
    WHERE reference_kind = 'artifact' AND reference_id = 'artifact-1' AND purpose = 'content_blob'
  `)
  await assert.rejects(context.resolver.resolve(request),
    serviceFailure(503, 'patch apply artifact graph unavailable'))
})

live('caller-owned transactions keep the target latest snapshot fenced across replicas', async context => {
  const setup = await prepared(context)
  const nextManifest = createWorkspaceManifest('snapshot-target-next', setup.targetManifest.entries)
  const nextSnapshot = await snapshot(context, 'target-next', nextManifest,
    ['content-base', 'content-owner'])
  const client = await context.firstPool.connect()
  try {
    await client.query('BEGIN')
    const resolved = await context.resolver.resolve(request, client)
    assert.equal(resolved.target.latestSnapshotId, setup.targetSnapshot.snapshotId)

    let advanced = false
    const advance = context.secondState.appendCheckpoint(
      'tenant-1', 'lease-target', nextSnapshot).then(() => { advanced = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(advanced, false)
    await client.query('COMMIT')
    await advance
    assert.equal((await context.firstState.getLease('tenant-1', 'lease-target'))?.latestSnapshotId,
      nextSnapshot.snapshotId)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
})
