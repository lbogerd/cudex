import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Header, type HeaderData } from 'tar'
import type { ObjectStore } from '../src/blob-store.js'
import type { SourceSnapshot, StoredObject } from '../src/postgres-state.js'
import { SourceSnapshotLifecycle } from '../src/source-snapshots.js'
import { ServiceError } from '../src/types.js'

interface TarEntry { path: string; type: NonNullable<HeaderData['type']>; body?: Uint8Array; mode?: number; linkpath?: string }
function tar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? []); const header = Buffer.alloc(512)
    new Header({ path: entry.path, type: entry.type, mode: entry.mode ?? (entry.type === 'Directory' ? 0o755 : 0o644),
      size: body.byteLength, ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }) }).encode(header)
    chunks.push(header, body, Buffer.alloc((512 - body.byteLength % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024)); return Buffer.concat(chunks)
}
function validArchive(): Buffer {
  return tar([
    { path: 'roots/', type: 'Directory' }, { path: 'roots/0/', type: 'Directory' },
    { path: 'roots/0/project/', type: 'Directory' }, { path: 'roots/0/project/src/', type: 'Directory' },
    { path: 'roots/0/project/src/file.bin', type: 'File', mode: 0o755, body: Uint8Array.from([0, 255, 1]) },
    { path: 'roots/0/project/link', type: 'SymbolicLink', linkpath: 'src/file.bin' },
  ])
}
const checksum = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

class MemoryObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  puts = 0; gets = 0; dishonest = false; failPut = false
  async put(bytes: Uint8Array): Promise<string> {
    this.puts++
    const id = checksum(bytes).slice('sha256:'.length)
    if (!this.failPut) this.values.set(id, Uint8Array.from(bytes))
    if (this.failPut) throw new Error('object outage')
    return this.dishonest ? '0'.repeat(64) : id
  }
  async get(id: string): Promise<Uint8Array> {
    this.gets++; const value = this.values.get(id); if (!value) throw new Error('missing')
    return Uint8Array.from(value)
  }
  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'source-test', storageKey: `source/v1/sha256/${id.slice(0, 2)}/${id}` }
  }
  delete(id: string): void { this.values.delete(id) }
}

class MemoryState {
  readonly objects = new Map<string, StoredObject>()
  readonly snapshots = new Map<string, SourceSnapshot>()
  registerObjectCalls = 0; registerSnapshotCalls = 0; failObject = false; failSnapshot = false
  async registerObject(input: StoredObject): Promise<StoredObject> {
    this.registerObjectCalls++
    if (this.failObject) throw new Error('database object outage')
    this.objects.set(input.objectId, { ...input }); return { ...input }
  }
  async registerSourceSnapshot(input: SourceSnapshot): Promise<SourceSnapshot> {
    this.registerSnapshotCalls++
    if (this.failSnapshot) throw new Error('database snapshot outage')
    this.snapshots.set(input.sourceSnapshotId, { ...input, workspaceRootUris: [...input.workspaceRootUris], expiresAt: new Date(input.expiresAt) })
    return { ...input, workspaceRootUris: [...input.workspaceRootUris], expiresAt: new Date(input.expiresAt) }
  }
  async findAuthorizedSourceSnapshot(tenantId: string, sourceSnapshotId: string, at = new Date()): Promise<SourceSnapshot | null> {
    const value = this.snapshots.get(sourceSnapshotId)
    if (!value || value.tenantId !== tenantId || value.state !== 'available' || value.expiresAt <= at) return null
    return { ...value, workspaceRootUris: [...value.workspaceRootUris], expiresAt: new Date(value.expiresAt) }
  }
  async findAuthorizedSourceSnapshotByChecksum(tenantId: string, expectedChecksum: string, at = new Date()): Promise<SourceSnapshot | null> {
    const value = [...this.snapshots.values()].find(snapshot => snapshot.tenantId === tenantId
      && snapshot.checksum === expectedChecksum && snapshot.state === 'available' && snapshot.expiresAt > at)
    return value ? { ...value, workspaceRootUris: [...value.workspaceRootUris], expiresAt: new Date(value.expiresAt) } : null
  }
}

function fixture() {
  const state = new MemoryState(); const objects = new MemoryObjects(); const reclaimed: string[] = []
  let currentTime = new Date('2030-01-01T00:00:00.000Z'); let failCleanup = false
  const lifecycle = new SourceSnapshotLifecycle(state, objects, {
    maxTtlMs: 60_000,
    now: () => new Date(currentTime),
    reclaimer: { async reclaimUnreferencedSourceArchive(_tenantId, objectId, storageId) {
      reclaimed.push(objectId); if (failCleanup) throw new Error('cleanup outage'); objects.delete(storageId); state.objects.delete(objectId)
    } },
  })
  const archive = validArchive()
  const input = { archive, checksum: checksum(archive), cwdUri: 'file:///workspace/roots/0/project/src',
    workspaceRootUris: ['file:///workspace/roots/0/project'], expiresAt: new Date(currentTime.getTime() + 30_000) }
  return { state, objects, reclaimed, lifecycle, input,
    setTime(value: Date) { currentTime = value }, setCleanupFailure(value: boolean) { failCleanup = value } }
}

function rejectsStatus(status: number, promise: Promise<unknown>): Promise<void> {
  return assert.rejects(promise, error => error instanceof ServiceError && error.status === status)
}

test('creates and resolves an immutable tenant-authorized source snapshot', async () => {
  const context = fixture(); const created = await context.lifecycle.create({ tenantId: 'tenant-a' }, context.input)
  assert.match(created.sourceSnapshotId, /^source_[0-9a-f]{32}$/)
  assert.equal(created.checksum, context.input.checksum)
  assert.match(created.manifestChecksum, /^sha256:[0-9a-f]{64}$/)
  assert.equal(context.objects.puts, 1)
  assert.equal(context.state.registerObjectCalls, 1)
  assert.equal(context.state.registerSnapshotCalls, 1)
  assert.equal(context.reclaimed.length, 0)
  const physicalId = created.checksum.slice('sha256:'.length)
  const durableObject = [...context.state.objects.values()][0]!
  assert.match(durableObject.objectId, /^source_object_[0-9a-f]{64}$/)
  assert.equal(durableObject.storageKey, `source/v1/sha256/${physicalId.slice(0, 2)}/${physicalId}`)

  context.input.archive.fill(0)
  const resolved = await context.lifecycle.resolve({ tenantId: 'tenant-a' }, created.sourceSnapshotId, created.checksum)
  assert.equal(checksum(resolved.archive), created.checksum)
  assert.deepEqual(resolved.workspaceRootUris, ['file:///workspace/roots/0/project'])
  assert.ok(resolved.manifest.entries.some(entry => entry.path === 'roots/0/project/src/file.bin'))
})

test('identical archives use distinct tenant-owned durable objects over shared content storage', async () => {
  const context = fixture()
  const first = await context.lifecycle.create({ tenantId: 'tenant-a' }, context.input)
  const second = await context.lifecycle.create({ tenantId: 'tenant-b' }, context.input)
  assert.notEqual(first.sourceSnapshotId, second.sourceSnapshotId)
  assert.equal(context.objects.values.size, 1)
  assert.equal(context.state.objects.size, 2)
  const durableObjects = [...context.state.objects.values()]
  assert.notEqual(durableObjects[0]!.objectId, durableObjects[1]!.objectId)
  assert.deepEqual(new Set(durableObjects.map(object => object.tenantId)), new Set(['tenant-a', 'tenant-b']))
})

test('same-tenant replay returns the immutable source identity without another publication', async () => {
  const context = fixture()
  const first = await context.lifecycle.create({ tenantId: 'tenant-a' }, context.input)
  const replay = await context.lifecycle.create({ tenantId: 'tenant-a' }, context.input)
  assert.deepEqual(replay, first)
  assert.equal(context.objects.puts, 1)
  assert.equal(context.state.registerObjectCalls, 1)
  await rejectsStatus(409, context.lifecycle.create({ tenantId: 'tenant-a' }, {
    ...context.input, expiresAt: new Date(context.input.expiresAt.getTime() + 1),
  }))
})

test('tenant, expiry, and expected checksum authorization fail before archive access', async () => {
  const context = fixture(); const created = await context.lifecycle.create({ tenantId: 'tenant-a' }, context.input)
  const gets = context.objects.gets
  await rejectsStatus(404, context.lifecycle.resolve({ tenantId: 'tenant-b' }, created.sourceSnapshotId, created.checksum))
  await rejectsStatus(403, context.lifecycle.resolve({ tenantId: 'tenant-a' }, created.sourceSnapshotId, `sha256:${'f'.repeat(64)}`))
  assert.equal(context.objects.gets, gets)
  context.setTime(new Date(context.input.expiresAt.getTime() + 1))
  await rejectsStatus(404, context.lifecycle.resolve({ tenantId: 'tenant-a' }, created.sourceSnapshotId, created.checksum))
  assert.equal(context.objects.gets, gets)
})

test('checksum, expiry, canonical metadata, and archive layout validate before persistence', async () => {
  const cases = [
    (context: ReturnType<typeof fixture>) => ({ ...context.input, checksum: `sha256:${'0'.repeat(64)}` }),
    (context: ReturnType<typeof fixture>) => ({ ...context.input, expiresAt: new Date('2030-01-01T00:02:00Z') }),
    (context: ReturnType<typeof fixture>) => ({ ...context.input, cwdUri: 'file:///workspace/other' }),
    (context: ReturnType<typeof fixture>) => ({ ...context.input, workspaceRootUris: ['file:///workspace/roots/1/project'] }),
    (context: ReturnType<typeof fixture>) => { const archive = tar([{ path: 'roots/', type: 'Directory' }, { path: 'roots/1/', type: 'Directory' }]); return { ...context.input, archive, checksum: checksum(archive) } },
    (context: ReturnType<typeof fixture>) => { const archive = tar([
      { path: 'roots/', type: 'Directory' }, { path: 'roots/0/', type: 'Directory' },
      { path: 'roots/0/project/', type: 'Directory' }, { path: 'roots/0/project/src/', type: 'Directory' },
      { path: 'roots/0/undeclared', type: 'File', body: Buffer.from('no') },
    ]); return { ...context.input, archive, checksum: checksum(archive) } },
  ]
  for (const invalid of cases) {
    const context = fixture(); await rejectsStatus(400, context.lifecycle.create({ tenantId: 'tenant-a' }, invalid(context)))
    assert.equal(context.objects.puts, 0)
    assert.equal(context.state.registerObjectCalls, 0)
    assert.equal(context.state.registerSnapshotCalls, 0)
    assert.deepEqual(context.reclaimed, [])
  }
})

test('object and durable-state failures invoke ref-aware cleanup without leaking raw details', async () => {
  for (const point of ['put', 'object', 'snapshot', 'dishonest'] as const) {
    const context = fixture()
    if (point === 'put') context.objects.failPut = true
    if (point === 'object') context.state.failObject = true
    if (point === 'snapshot') context.state.failSnapshot = true
    if (point === 'dishonest') context.objects.dishonest = true
    await assert.rejects(context.lifecycle.create({ tenantId: 'tenant-a' }, context.input), error => {
      assert.ok(error instanceof ServiceError); assert.equal(error.status, 503)
      assert.equal(error.message.includes('outage'), false); assert.equal(error.message.includes('dishonest'), false); return true
    })
    assert.equal(context.reclaimed.length, 1)
    assert.match(context.reclaimed[0]!, /^source_object_[0-9a-f]{64}$/)
    assert.equal(context.objects.values.size, 0)
  }
})

test('cleanup failure is explicit and stored archive corruption fails closed', async () => {
  const failed = fixture(); failed.state.failSnapshot = true; failed.setCleanupFailure(true)
  await assert.rejects(failed.lifecycle.create({ tenantId: 'tenant-a' }, failed.input), /cleanup pending/)

  const corrupt = fixture(); const created = await corrupt.lifecycle.create({ tenantId: 'tenant-a' }, corrupt.input)
  corrupt.objects.values.set(created.checksum.slice('sha256:'.length), Uint8Array.from([1, 2, 3]))
  await rejectsStatus(503, corrupt.lifecycle.resolve({ tenantId: 'tenant-a' }, created.sourceSnapshotId, created.checksum))
})
