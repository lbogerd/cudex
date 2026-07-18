import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { Header, type HeaderData } from 'tar'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import { PostgresDurableState, type CreateLeaseInput, type Lease, type Snapshot, type SnapshotInput,
  type StoredObject } from '../src/postgres-state.js'
import { ServiceError } from '../src/types.js'
import { workspaceManifestChecksum } from '../src/workspace-manifest.js'
import {
  WorkspaceSnapshotPublisher,
  type CreateBaseWorkspaceSnapshotInput,
} from '../src/workspace-snapshots.js'

interface TarEntry {
  path: string
  type: NonNullable<HeaderData['type']>
  body?: Uint8Array
  mode?: number
  linkpath?: string
}

function tar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? [])
    const header = Buffer.alloc(512)
    new Header({
      path: entry.path,
      type: entry.type,
      mode: entry.mode ?? (entry.type === 'Directory' ? 0o755 : 0o644),
      size: body.byteLength,
      ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }),
    }).encode(header)
    chunks.push(header, body, Buffer.alloc((512 - body.byteLength % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function archive(): Buffer {
  return tar([
    { path: 'roots/', type: 'Directory' },
    { path: 'roots/0/', type: 'Directory' },
    { path: 'roots/0/project/', type: 'Directory' },
    { path: 'roots/0/project/file.bin', type: 'File', mode: 0o755, body: Uint8Array.from([0, 255, 1]) },
    { path: 'roots/0/project/copy.bin', type: 'File', body: Uint8Array.from([0, 255, 1]) },
    { path: 'roots/0/project/link', type: 'SymbolicLink', linkpath: 'file.bin' },
  ])
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

class MemoryObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  puts = 0
  failAt = Number.POSITIVE_INFINITY
  dishonest = false

  async put(bytes: Uint8Array): Promise<string> {
    this.puts += 1
    if (this.puts === this.failAt) throw new Error('physical storage outage')
    const id = digest(bytes)
    this.values.set(id, Uint8Array.from(bytes))
    return this.dishonest ? '0'.repeat(64) : id
  }

  async get(id: string): Promise<Uint8Array> {
    const bytes = this.values.get(id)
    if (!bytes) throw new Error('missing object')
    return Uint8Array.from(bytes)
  }

  async delete(id: string): Promise<void> { this.values.delete(id) }

  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'workspace-test', storageKey: `v1/sha256/${id.slice(0, 2)}/${id}` }
  }
}

function snapshot(tenantId: string, leaseId: string, input: SnapshotInput): Snapshot {
  return {
    ...input,
    tenantId,
    leaseId,
    state: 'available',
    expiresAt: input.expiresAt ?? null,
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
  }
}

function lease(input: CreateLeaseInput): Lease {
  return {
    leaseId: input.leaseId,
    environmentId: input.environmentId,
    tenantId: input.tenantId,
    agentId: input.agentId,
    ownerAgentId: input.ownerAgentId ?? null,
    ownerLeaseId: input.ownerLeaseId ?? null,
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    providerSandboxId: input.providerSandboxId,
    sandboxTemplate: input.sandboxTemplate,
    cwdUri: input.cwdUri,
    workspaceRootUris: [...input.workspaceRootUris],
    baseSnapshotId: input.baseSnapshot.snapshotId,
    latestSnapshotId: input.baseSnapshot.snapshotId,
    state: 'active',
    toolPolicy: structuredClone(input.toolPolicy),
    policyVersion: input.policyVersion,
    releasedAt: null,
  }
}

class MemoryState {
  readonly objects = new Map<string, StoredObject>()
  readonly leases = new Map<string, Lease>()
  readonly snapshots = new Map<string, Snapshot>()
  readonly referencedObjects = new Set<string>()
  registerCalls = 0
  failRegisterAt = Number.POSITIVE_INFINITY
  failBase = false
  failCheckpoint = false

  async withObjectLocationLock<T>(_storageBucket: string, _storageKey: string,
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return fn({} as PoolClient)
  }

  async registerObject(input: StoredObject, _executor?: PoolClient): Promise<StoredObject> {
    this.registerCalls += 1
    if (this.registerCalls === this.failRegisterAt) throw new Error('durable object outage')
    const existing = this.objects.get(input.objectId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(input)) throw new Error('object conflict')
    this.objects.set(input.objectId, { ...input, expiresAt: input.expiresAt && new Date(input.expiresAt) })
    return { ...input, expiresAt: input.expiresAt && new Date(input.expiresAt) }
  }

  async createLeaseWithBaseSnapshot(input: CreateLeaseInput): Promise<{ lease: Lease; snapshot: Snapshot }> {
    if (this.failBase) throw new Error('base transaction outage')
    if (this.leases.has(input.leaseId) || this.snapshots.has(input.baseSnapshot.snapshotId)) throw new Error('base identity conflict')
    this.assertSnapshotObjects(input.baseSnapshot)
    const createdLease = lease(input)
    const createdSnapshot = snapshot(input.tenantId, input.leaseId, input.baseSnapshot)
    this.leases.set(input.leaseId, createdLease)
    this.snapshots.set(input.baseSnapshot.snapshotId, createdSnapshot)
    this.reference(input.baseSnapshot)
    return { lease: structuredClone(createdLease), snapshot: structuredClone(createdSnapshot) }
  }

  async appendCheckpoint(tenantId: string, leaseId: string, input: SnapshotInput): Promise<Snapshot> {
    if (this.failCheckpoint) throw new Error('checkpoint transaction outage')
    const currentLease = this.leases.get(leaseId)
    if (!currentLease || currentLease.tenantId !== tenantId) throw new Error('lease missing')
    this.assertSnapshotObjects(input)
    const created = snapshot(tenantId, leaseId, input)
    currentLease.latestSnapshotId = input.snapshotId
    this.snapshots.set(input.snapshotId, created)
    this.reference(input)
    return structuredClone(created)
  }

  private assertSnapshotObjects(input: SnapshotInput): void {
    if (!this.objects.has(input.workspaceArchiveObjectId) || !this.objects.has(input.manifestObjectId)) {
      throw new Error('snapshot object missing')
    }
  }

  private reference(input: SnapshotInput): void {
    this.referencedObjects.add(input.workspaceArchiveObjectId)
    this.referencedObjects.add(input.manifestObjectId)
    for (const objectId of input.contentObjectIds ?? []) this.referencedObjects.add(objectId)
  }
}

function baseInput(tenantId = 'tenant-a', snapshotId = 'snapshot-base', leaseId = 'lease-a'): CreateBaseWorkspaceSnapshotInput {
  return {
    leaseId,
    environmentId: `environment-${leaseId}`,
    tenantId,
    agentId: `agent-${leaseId}`,
    ownerAgentId: null,
    ownerLeaseId: null,
    sourceSnapshotId: null,
    providerSandboxId: `sandbox-${leaseId}`,
    sandboxTemplate: 'template',
    cwdUri: 'file:///workspace/roots/0/project',
    workspaceRootUris: ['file:///workspace/roots/0/project'],
    toolPolicy: {},
    policyVersion: 1,
    snapshot: { snapshotId, providerSnapshotId: `provider-${snapshotId}`, archive: archive(), expiresAt: null },
  }
}

function fixture() {
  const state = new MemoryState()
  const objects = new MemoryObjects()
  const reclaimed: string[] = []
  let failCleanup = false
  const publisher = new WorkspaceSnapshotPublisher(state, objects, {
    reclaimer: {
      async reclaimUnreferencedWorkspaceObject(_tenantId, objectId, physicalObjectId) {
        reclaimed.push(objectId)
        if (failCleanup) throw new Error('cleanup outage')
        if (state.referencedObjects.has(objectId)) return
        state.objects.delete(objectId)
        const stillOwned = [...state.objects.values()].some(value => value.storageKey.endsWith(physicalObjectId))
        if (!stillOwned) objects.values.delete(physicalObjectId)
      },
    },
  })
  return { state, objects, publisher, reclaimed, setCleanupFailure(value: boolean) { failCleanup = value } }
}

test('publishes a base archive, canonical manifest, deduplicated content, and active lease atomically', async () => {
  const context = fixture()
  const result = await context.publisher.createBase(baseInput())

  assert.equal(result.lease.baseSnapshotId, 'snapshot-base')
  assert.equal(result.lease.latestSnapshotId, 'snapshot-base')
  assert.equal(result.snapshot.manifestChecksum, workspaceManifestChecksum(result.manifest))
  assert.deepEqual(result.contentObjects.map(object => object.path), [
    'roots/0/project/copy.bin', 'roots/0/project/file.bin',
  ])
  assert.equal(new Set(result.contentObjects.map(object => object.objectId)).size, 1)
  assert.equal(context.state.objects.size, 3)
  assert.equal(context.state.referencedObjects.size, 3)
  assert.equal(context.objects.values.size, 3)
  assert.deepEqual(new Set([...context.state.objects.values()].map(object => object.kind)),
    new Set(['workspace_archive', 'manifest', 'content_blob']))
  for (const object of context.state.objects.values()) {
    assert.match(object.objectId, /^workspace_object_[0-9a-f]{64}$/)
    assert.equal(object.tenantId, 'tenant-a')
    assert.equal(object.storageBucket, 'workspace-test')
    assert.equal(object.storageKey.endsWith(object.checksum.slice('sha256:'.length)), true)
  }
  assert.deepEqual(context.reclaimed, [])
})

test('appends a checkpoint only after every archive, manifest, and content object is registered', async () => {
  const context = fixture()
  await context.publisher.createBase(baseInput())
  const result = await context.publisher.appendCheckpoint({
    tenantId: 'tenant-a', leaseId: 'lease-a',
    snapshot: { snapshotId: 'snapshot-current', providerSnapshotId: 'provider-current', archive: archive() },
  })

  assert.equal(result.snapshot.snapshotId, 'snapshot-current')
  assert.equal(context.state.leases.get('lease-a')?.latestSnapshotId, 'snapshot-current')
  assert.notEqual(result.snapshot.manifestObjectId,
    context.state.snapshots.get('snapshot-base')?.manifestObjectId)
  assert.equal(context.state.objects.size, 6)
  assert.equal(context.objects.values.size, 4)
})

test('identical workspace bytes use tenant-owned logical objects over shared physical content', async () => {
  const context = fixture()
  const first = await context.publisher.createBase(baseInput('tenant-a', 'snapshot-a', 'lease-a'))
  const second = await context.publisher.createBase(baseInput('tenant-b', 'snapshot-b', 'lease-b'))

  assert.equal(context.state.objects.size, 6)
  assert.equal(context.objects.values.size, 4)
  assert.notEqual(first.snapshot.workspaceArchiveObjectId, second.snapshot.workspaceArchiveObjectId)
  assert.notEqual(first.contentObjects[0]?.objectId, second.contentObjects[0]?.objectId)
  assert.deepEqual(new Set([...context.state.objects.values()].map(object => object.tenantId)),
    new Set(['tenant-a', 'tenant-b']))
  assert.equal(first.contentObjects[0]?.checksum, second.contentObjects[0]?.checksum)
})

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
test('live PostgreSQL publication retains tenant-owned logical objects over shared physical bytes', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const schema = `hosted_agent_workspace_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await runMigrations(pool)
    const objects = new MemoryObjects()
    const publisher = new WorkspaceSnapshotPublisher(new PostgresDurableState(pool), objects, {
      reclaimer: { reclaimUnreferencedWorkspaceObject: async () => assert.fail('successful publication must not reclaim') },
    })
    const first = await publisher.createBase(baseInput('tenant-a', 'snapshot-a', 'lease-a'))
    const second = await publisher.createBase(baseInput('tenant-b', 'snapshot-b', 'lease-b'))
    const repeated = await publisher.createBase(baseInput('tenant-a', 'snapshot-c', 'lease-c'))
    assert.notEqual(first.contentObjects[0]!.objectId, second.contentObjects[0]!.objectId)
    assert.notEqual(first.contentObjects[0]!.objectId, repeated.contentObjects[0]!.objectId)
    assert.equal(first.contentObjects[0]!.checksum, second.contentObjects[0]!.checksum)
    assert.equal(first.contentObjects[0]!.checksum, repeated.contentObjects[0]!.checksum)
    const counts = await pool.query<{ objects: string; references: string; shared_locations: string }>(`
      SELECT
        (SELECT count(*)::text FROM hosted_agent_objects) AS objects,
        (SELECT count(*)::text FROM hosted_agent_object_references WHERE reference_kind = 'snapshot') AS references,
        (SELECT count(*)::text FROM (
          SELECT storage_bucket, storage_key FROM hosted_agent_objects
          GROUP BY storage_bucket, storage_key HAVING count(*) > 1
        ) shared) AS shared_locations
    `)
    assert.deepEqual(counts.rows[0], { objects: '9', references: '9', shared_locations: '2' })
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})

test('invalid archives and quotas fail before physical or durable publication', async () => {
  const invalid = fixture()
  const input = baseInput()
  input.snapshot.archive = tar([{ path: '../escape', type: 'File', body: Buffer.from('bad') }])
  await assert.rejects(invalid.publisher.createBase(input), error => error instanceof ServiceError && error.status === 400)
  assert.equal(invalid.objects.puts, 0)
  assert.equal(invalid.state.registerCalls, 0)
  assert.deepEqual(invalid.reclaimed, [])

  const quota = fixture()
  const limited = new WorkspaceSnapshotPublisher(quota.state, quota.objects, {
    archiveLimits: {
      maxArchiveBytes: 1,
      maxExtractionRatio: 1,
      maxMetaEntryBytes: 1,
      maxEntries: 1,
      maxFiles: 1,
      maxTotalBytes: 1,
      maxFileBytes: 1,
      maxPathBytes: 1,
      maxPathDepth: 1,
      maxLinkTargetBytes: 1,
      maxManifestBytes: 1,
      maxChanges: 1,
    },
    reclaimer: { reclaimUnreferencedWorkspaceObject: async () => undefined },
  })
  await assert.rejects(limited.createBase(baseInput()), error => error instanceof ServiceError && error.status === 429)
  assert.equal(quota.objects.puts, 0)
  assert.equal(quota.state.registerCalls, 0)
})

test('storage, registration, and snapshot transaction failures invoke ref-aware cleanup', async () => {
  const expectedReclaims = { put: 1, dishonest: 1, register: 2, base: 3, checkpoint: 3 } as const
  for (const point of ['put', 'dishonest', 'register', 'base', 'checkpoint'] as const) {
    const context = fixture()
    if (point === 'put') context.objects.failAt = 2
    if (point === 'dishonest') context.objects.dishonest = true
    if (point === 'register') context.state.failRegisterAt = 2
    if (point === 'base') context.state.failBase = true
    if (point === 'checkpoint') {
      await context.publisher.createBase(baseInput())
      context.reclaimed.length = 0
      context.state.failCheckpoint = true
    }
    const operation = point === 'checkpoint'
      ? context.publisher.appendCheckpoint({ tenantId: 'tenant-a', leaseId: 'lease-a',
          snapshot: { snapshotId: 'snapshot-current', providerSnapshotId: 'provider-current', archive: archive() } })
      : context.publisher.createBase(baseInput())
    await assert.rejects(operation, error => error instanceof ServiceError && error.status === 503
      && !error.message.includes('outage'))
    assert.equal(context.reclaimed.length, expectedReclaims[point])
    if (point !== 'checkpoint') {
      assert.equal(context.state.objects.size, 0)
      assert.equal(context.objects.values.size, 0)
    } else {
      assert.equal(context.state.objects.size, 3)
      assert.equal(context.objects.values.size, 3)
    }
  }
})

test('same snapshot replay conflict cannot reclaim previously committed objects', async () => {
  const context = fixture()
  const input = baseInput()
  const first = await context.publisher.createBase(input)
  await assert.rejects(context.publisher.createBase(input), error => error instanceof ServiceError && error.status === 503)
  assert.equal(context.state.objects.size, 3)
  assert.equal(context.objects.values.size, 3)
  assert.ok(context.state.objects.has(first.snapshot.workspaceArchiveObjectId))
  assert.ok(context.state.objects.has(first.snapshot.manifestObjectId))
  assert.equal(context.reclaimed.length, 3)
})

test('cleanup failure is explicit', async () => {
  const failed = fixture()
  failed.state.failBase = true
  failed.setCleanupFailure(true)
  await assert.rejects(failed.publisher.createBase(baseInput()), /cleanup pending/)

})
