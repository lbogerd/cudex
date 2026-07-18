import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { JsonStore } from '../src/store.js'
import { TicketIssuer } from '../src/tickets.js'
import { ControlPlane } from '../src/service.js'
import { FakeProvider } from './fake-provider.js'
import { BlobStore } from '../src/blob-store.js'
import { ServiceError } from '../src/types.js'

async function fixture(provider = new FakeProvider()) {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-control-')); const root = join(directory, 'project')
  await mkdir(root); await writeFile(join(root, 'tracked.txt'), 'modified'); await writeFile(join(root, 'untracked.txt'), 'new'); await symlink('tracked.txt', join(root, 'link'))
  const state = join(directory, 'state.json'); const store = new JsonStore(state); await store.open()
  const tickets = new TicketIssuer(store, 'wss://gateway.example', 60_000)
  const blobs = new BlobStore(join(directory, 'blobs'))
  const service = new ControlPlane(store, provider, tickets, blobs, { templates: { 'general-v1': 'tpl-1', 'review-v1': 'tpl-2' }, allowedRoots: [directory], ingress: { maxBytes: 10_000_000, maxRoots: 4 } })
  const request = { agentId: 'agent-1', ownerAgentId: null, agentType: 'default', sandboxTemplate: 'general-v1',
    source: { type: 'rootWorkspace' as const, cwd: pathToFileURL(root).href, workspaceRoots: [pathToFileURL(root).href] }, idempotencyKey: 'provision-1' }
  return { directory, root, state, store, tickets, blobs, service, provider, request }
}

test('provision captures dirty workspace and idempotent replay does not allocate', async () => {
  const context = await fixture(); const first = await context.service.provision(context.request); const second = await context.service.provision(context.request)
  assert.equal(context.provider.creates, 1); assert.equal(first.leaseId, second.leaseId); assert.equal(first.environmentId, second.environmentId)
  assert.notEqual(first.connection.execServerUrl, second.connection.execServerUrl)
  const durable = await readFile(context.state, 'utf8'); assert.equal(durable.includes('ticket='), false); assert.equal(durable.includes('wss://'), false)
  const archive = context.provider.sandboxes.get((await context.store.read(database => database.leases[first.leaseId]!.sandboxId)))!.bytes
  assert.ok(archive.byteLength > 0)
})

test('changed request with reused key is rejected without mutation', async () => {
  const context = await fixture(); await context.service.provision(context.request)
  await assert.rejects(context.service.provision({ ...context.request, agentType: 'reviewer' }), /idempotency key reused/)
  assert.equal(context.provider.creates, 1)
})

test('checkpoint survives restart, reconnect uses persisted provider id, and durable restore creates a distinct lease', async () => {
  const context = await fixture(); const provisioned = await context.service.provision(context.request)
  const checkpoint = await context.service.checkpoint({ leaseId: provisioned.leaseId, idempotencyKey: 'checkpoint-1' })
  const restartedStore = new JsonStore(context.state); await restartedStore.open(); const restartedTickets = new TicketIssuer(restartedStore, 'wss://gateway.example')
  const restarted = new ControlPlane(restartedStore, context.provider, restartedTickets, context.blobs, { templates: { 'general-v1': 'tpl-1', 'review-v1': 'tpl-2' }, allowedRoots: [context.directory], ingress: { maxBytes: 10_000_000, maxRoots: 4 } })
  const reconnected = await restarted.reconnect({ leaseId: provisioned.leaseId, idempotencyKey: 'reconnect-1' }); assert.equal(reconnected.environmentId, provisioned.environmentId)
  await restarted.release({ leaseId: provisioned.leaseId, idempotencyKey: 'release-before-restore' })
  const restored = await restarted.provision({ ...context.request, source: { type: 'durableSnapshot', snapshotId: checkpoint.snapshotId }, idempotencyKey: 'restore-1' })
  assert.notEqual(restored.leaseId, provisioned.leaseId); assert.notEqual(restored.environmentId, provisioned.environmentId)
  assert.equal(context.provider.restores, 0)
})

test('durable recovery uses a clean template, overlays only the latest workspace, and replays without allocation', async () => {
  const context = await fixture(); const agent = await context.service.provision(context.request)
  const sourceLease = await context.store.read(database => database.leases[agent.leaseId]!)
  const sourceSandbox = context.provider.sandboxes.get(sourceLease.sandboxId)!
  sourceSandbox.runtimeIdentity = 'inherited-session-secret'
  sourceSandbox.bytes = Uint8Array.from([0, 255, 17, 33])
  const checkpoint = await context.service.checkpoint({ leaseId: agent.leaseId, idempotencyKey: 'clean-restore-checkpoint' })
  const oldTicket = new URL(agent.connection.execServerUrl).searchParams.get('ticket')!
  await context.provider.kill(sourceLease.sandboxId)
  await assert.rejects(context.service.reconnect({ leaseId: agent.leaseId, idempotencyKey: 'clean-restore-missing' }),
    (error: unknown) => error instanceof ServiceError && error.status === 404)
  assert.equal((await context.store.read(database => database.leases[agent.leaseId]!.state)), 'lost')
  assert.equal(await context.tickets.validate(agent.leaseId, oldTicket), false)

  const request = { ...context.request, source: { type: 'durableSnapshot' as const, snapshotId: checkpoint.snapshotId }, idempotencyKey: 'clean-restore' }
  const restored = await context.service.provision(request)
  const replay = await context.service.provision(request)
  const restoredLease = await context.store.read(database => database.leases[restored.leaseId]!)
  const restoredSandbox = context.provider.sandboxes.get(restoredLease.sandboxId)!
  assert.deepEqual(restoredSandbox.bytes, sourceSandbox.bytes)
  assert.equal(restoredSandbox.runtimeIdentity, undefined)
  assert.equal(context.provider.restores, 0)
  assert.equal(context.provider.creates, 2)
  assert.equal(replay.leaseId, restored.leaseId)
  assert.equal((await context.store.read(database => database.leases[agent.leaseId]!.state)), 'released')
})

test('durable restore rejects active, cross-lineage, cross-template, and stale snapshot sources before allocation', async () => {
  const context = await fixture(); const agent = await context.service.provision(context.request)
  await assert.rejects(context.service.provision({ ...context.request, source: { type: 'durableSnapshot', snapshotId: agent.baseSnapshotId },
    idempotencyKey: 'restore-active' }), (error: unknown) => error instanceof ServiceError && error.status === 409)
  assert.equal(context.provider.creates, 1)
  const checkpoint = await context.service.checkpoint({ leaseId: agent.leaseId, idempotencyKey: 'restore-lineage-checkpoint' })
  await context.service.release({ leaseId: agent.leaseId, idempotencyKey: 'restore-lineage-release' })
  const attempts = [
    { ...context.request, agentId: 'other-agent', source: { type: 'durableSnapshot' as const, snapshotId: checkpoint.snapshotId }, idempotencyKey: 'restore-other-agent' },
    { ...context.request, ownerAgentId: 'other-owner', source: { type: 'durableSnapshot' as const, snapshotId: checkpoint.snapshotId }, idempotencyKey: 'restore-other-owner' },
    { ...context.request, sandboxTemplate: 'review-v1', source: { type: 'durableSnapshot' as const, snapshotId: checkpoint.snapshotId }, idempotencyKey: 'restore-other-template' },
    { ...context.request, source: { type: 'durableSnapshot' as const, snapshotId: agent.baseSnapshotId }, idempotencyKey: 'restore-stale-snapshot' },
  ]
  for (const attempt of attempts) {
    await assert.rejects(context.service.provision(attempt), (error: unknown) => error instanceof ServiceError && error.status === 404)
  }
  assert.equal(context.provider.creates, 1)
})

for (const point of ['upload', 'start', 'probe', 'snapshot']) test(`durable restore failure at ${point} cleans its fresh allocation`, async () => {
  const context = await fixture(); const agent = await context.service.provision(context.request)
  const checkpoint = await context.service.checkpoint({ leaseId: agent.leaseId, idempotencyKey: `restore-${point}-checkpoint` })
  await context.service.release({ leaseId: agent.leaseId, idempotencyKey: `restore-${point}-release` })
  context.provider.failAt = point
  await assert.rejects(context.service.provision({ ...context.request, source: { type: 'durableSnapshot', snapshotId: checkpoint.snapshotId },
    idempotencyKey: `restore-${point}-failure` }), new RegExp(`injected ${point}`))
  assert.deepEqual(context.provider.live(), [])
  assert.equal(context.provider.restores, 0)
})

test('child gets an isolated spawn-time workspace capture', async () => {
  const context = await fixture(); const owner = await context.service.provision(context.request)
  const child = await context.service.provision({ ...context.request, agentId: 'child', ownerAgentId: 'agent-1', source: { type: 'agentEnvironment', ownerLeaseId: owner.leaseId }, idempotencyKey: 'child-1' })
  const leases = await context.store.read(database => database.leases); const ownerSandbox = context.provider.sandboxes.get(leases[owner.leaseId]!.sandboxId)!; const childSandbox = context.provider.sandboxes.get(leases[child.leaseId]!.sandboxId)!
  assert.deepEqual(childSandbox.bytes, ownerSandbox.bytes); childSandbox.bytes[0] = childSandbox.bytes[0]! ^ 1; assert.notDeepEqual(childSandbox.bytes, ownerSandbox.bytes)
  assert.equal(context.provider.snapshots.size, 2)
  assert.equal(context.provider.live().length, 2)
  assert.equal(context.provider.kills, 1)
})

for (const point of ['restore', 'export']) test(`child failure at ${point} reclaims its clean sandbox, capture, and temporary snapshot`, async () => {
  const context = await fixture(); const owner = await context.service.provision(context.request)
  context.provider.failAt = point
  await assert.rejects(context.service.provision({ ...context.request, agentId: 'child', ownerAgentId: 'agent-1',
    source: { type: 'agentEnvironment', ownerLeaseId: owner.leaseId }, idempotencyKey: `child-${point}` }), new RegExp(`injected ${point}`))
  const leases = await context.store.read(database => database.leases)
  assert.deepEqual(context.provider.live(), [leases[owner.leaseId]!.sandboxId])
  assert.equal(context.provider.snapshots.size, 1)
})

for (const point of ['upload', 'start', 'probe', 'snapshot']) test(`failure at ${point} cleans provider allocation`, async () => {
  const context = await fixture(); context.provider.failAt = point; await assert.rejects(context.service.provision(context.request), new RegExp(`injected ${point}`)); assert.deepEqual(context.provider.live(), [])
})

test('release is idempotent and revokes active tickets', async () => {
  const context = await fixture(); const agent = await context.service.provision(context.request); const url = new URL(agent.connection.execServerUrl); const ticket = url.searchParams.get('ticket')!
  assert.equal(await context.tickets.validate(agent.leaseId, ticket), true)
  await context.service.release({ leaseId: agent.leaseId, idempotencyKey: 'release-1' }); await context.service.release({ leaseId: agent.leaseId, idempotencyKey: 'release-1' })
  assert.equal(await context.tickets.validate(agent.leaseId, ticket), false); assert.deepEqual(context.provider.live(), [])
})

test('production mode rejects local ingress before provider allocation', async () => {
  const context = await fixture()
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [], ingress: { maxBytes: 10_000_000, maxRoots: 4 }, allowLocalIngress: false,
  })
  await assert.rejects(service.provision(context.request), /local workspace ingress is disabled/)
  assert.equal(context.provider.creates, 0)
})

test('immutable source snapshot provision fails closed before provider allocation until one backend owns it', async () => {
  const context = await fixture()
  const request = {
    ...context.request,
    source: { type: 'sourceSnapshot' as const, sourceSnapshotId: `source_${'a'.repeat(32)}`, checksum: `sha256:${'b'.repeat(64)}` },
  }
  await assert.rejects(context.service.provision(request), /immutable source snapshot provisioning is not configured/)
  assert.equal(context.provider.creates, 0)
  assert.deepEqual(context.provider.live(), [])
})

function immutableRequest(context: Awaited<ReturnType<typeof fixture>>, idempotencyKey: string) {
  return {
    ...context.request,
    source: { type: 'sourceSnapshot' as const, sourceSnapshotId: `source_${'a'.repeat(32)}`,
      checksum: `sha256:${'b'.repeat(64)}` },
    idempotencyKey,
  }
}

function immutableResolution(request: ReturnType<typeof immutableRequest>) {
  const archive = Uint8Array.from([0, 255, 1, 2, 3])
  return {
    sourceSnapshotId: request.source.sourceSnapshotId, checksum: request.source.checksum,
    expiresAt: new Date(Date.now() + 60_000), manifestChecksum: `sha256:${'c'.repeat(64)}`,
    sizeBytes: archive.byteLength, archive,
    cwdUri: 'file:///workspace/roots/1/second/nested',
    workspaceRootUris: ['file:///workspace/roots/0/first', 'file:///workspace/roots/1/second'],
    manifest: { version: 1 as const, identity: request.source.sourceSnapshotId, entries: [] },
  }
}

test('immutable source snapshot resolves with trusted identity before allocation and materializes exact state', async () => {
  const context = await fixture(); const request = immutableRequest(context, 'immutable-success')
  const resolution = immutableResolution(request); const principal = { tenantId: 'tenant-trusted' }; const calls: unknown[] = []
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [], ingress: { maxBytes: 10_000_000, maxRoots: 4 },
    allowLocalIngress: false,
    sourceSnapshots: { principal, resolver: { async resolve(...args) {
      assert.equal(context.provider.creates, 0); calls.push(args); return resolution
    } } },
  })

  const provisioned = await service.provision(request)
  assert.deepEqual(calls, [[principal, request.source.sourceSnapshotId, request.source.checksum]])
  assert.equal(Object.hasOwn(request, 'tenantId'), false)
  assert.equal(provisioned.cwd, resolution.cwdUri)
  assert.deepEqual(provisioned.workspaceRoots, resolution.workspaceRootUris)
  const lease = await context.store.read(database => database.leases[provisioned.leaseId]!)
  assert.deepEqual(context.provider.sandboxes.get(lease.sandboxId)!.bytes, resolution.archive)
})

test('immutable source authorization failure happens before provider allocation', async () => {
  const context = await fixture(); const request = immutableRequest(context, 'immutable-denied')
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [], ingress: { maxBytes: 10_000_000, maxRoots: 4 },
    sourceSnapshots: { principal: { tenantId: 'tenant-trusted' }, resolver: {
      async resolve() { throw new ServiceError(404, 'source snapshot unavailable') },
    } },
  })

  await assert.rejects(service.provision(request), /source snapshot unavailable/)
  assert.equal(context.provider.creates, 0)
  assert.deepEqual(context.provider.live(), [])
})

test('immutable source resolution mismatch fails before provider allocation', async () => {
  const context = await fixture(); const request = immutableRequest(context, 'immutable-mismatch')
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [], ingress: { maxBytes: 10_000_000, maxRoots: 4 },
    sourceSnapshots: { principal: { tenantId: 'tenant-trusted' }, resolver: {
      async resolve() { return { ...immutableResolution(request), checksum: `sha256:${'d'.repeat(64)}` } },
    } },
  })

  await assert.rejects(service.provision(request), /immutable source snapshot resolution mismatch/)
  assert.equal(context.provider.creates, 0)
  assert.deepEqual(context.provider.live(), [])
})

test('immutable source provisioning cleans its allocation after a later failure', async () => {
  const context = await fixture(); const request = immutableRequest(context, 'immutable-cleanup')
  context.provider.failAt = 'start'
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [], ingress: { maxBytes: 10_000_000, maxRoots: 4 },
    sourceSnapshots: { principal: { tenantId: 'tenant-trusted' }, resolver: {
      async resolve() { return immutableResolution(request) },
    } },
  })

  await assert.rejects(service.provision(request), /injected start/)
  assert.equal(context.provider.creates, 1)
  assert.deepEqual(context.provider.live(), [])
})

test('immutable source idempotent replay neither resolves nor allocates again', async () => {
  const context = await fixture(); const request = immutableRequest(context, 'immutable-replay'); let resolutions = 0
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [], ingress: { maxBytes: 10_000_000, maxRoots: 4 },
    sourceSnapshots: { principal: { tenantId: 'tenant-trusted' }, resolver: {
      async resolve() { resolutions += 1; return immutableResolution(request) },
    } },
  })

  const first = await service.provision(request); const replay = await service.provision(request)
  assert.equal(resolutions, 1)
  assert.equal(context.provider.creates, 1)
  assert.equal(replay.leaseId, first.leaseId)
  assert.notEqual(replay.connection.execServerUrl, first.connection.execServerUrl)
})

test('release closes active gateway connections through the revoker', async () => {
  const context = await fixture()
  const revoked: string[] = []
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [context.directory], ingress: { maxBytes: 10_000_000, maxRoots: 4 },
  }, { revoke: leaseId => { revoked.push(leaseId) } })
  const agent = await service.provision(context.request)
  await service.release({ leaseId: agent.leaseId, idempotencyKey: 'release-close' })
  assert.deepEqual(revoked, [agent.leaseId])
})

test('reconnect rotates tickets and closes stale gateway connections, including on replay', async () => {
  const context = await fixture(); const revoked: string[] = []
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [context.directory], ingress: { maxBytes: 10_000_000, maxRoots: 4 },
  }, { revoke: leaseId => { revoked.push(leaseId) } })
  const agent = await service.provision(context.request)
  const originalTicket = new URL(agent.connection.execServerUrl).searchParams.get('ticket')!
  const first = await service.reconnect({ leaseId: agent.leaseId, idempotencyKey: 'reconnect-close' })
  const firstTicket = new URL(first.connection.execServerUrl).searchParams.get('ticket')!
  assert.equal(await context.tickets.validate(agent.leaseId, originalTicket), false)
  const replay = await service.reconnect({ leaseId: agent.leaseId, idempotencyKey: 'reconnect-close' })
  const replayTicket = new URL(replay.connection.execServerUrl).searchParams.get('ticket')!
  assert.equal(await context.tickets.validate(agent.leaseId, firstTicket), false)
  assert.equal(await context.tickets.validate(agent.leaseId, replayTicket), true)
  assert.deepEqual(revoked, [agent.leaseId, agent.leaseId])
})

test('transient reconnect failure is a retryable provider error and preserves existing access', async () => {
  const context = await fixture(); const revoked: string[] = []
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [context.directory], ingress: { maxBytes: 10_000_000, maxRoots: 4 },
  }, { revoke: leaseId => { revoked.push(leaseId) } })
  const agent = await service.provision(context.request)
  const ticket = new URL(agent.connection.execServerUrl).searchParams.get('ticket')!
  context.provider.failAt = 'connect'
  await assert.rejects(service.reconnect({ leaseId: agent.leaseId, idempotencyKey: 'reconnect-outage' }),
    (error: unknown) => error instanceof ServiceError && error.status === 503 && error.message === 'provider temporarily unavailable')
  assert.equal(await context.tickets.validate(agent.leaseId, ticket), true)
  assert.deepEqual(revoked, [])
})

test('missing sandbox reconnect returns lease-missing and revokes stale access', async () => {
  const context = await fixture(); const revoked: string[] = []
  const service = new ControlPlane(context.store, context.provider, context.tickets, context.blobs, {
    templates: { 'general-v1': 'tpl-1' }, allowedRoots: [context.directory], ingress: { maxBytes: 10_000_000, maxRoots: 4 },
  }, { revoke: leaseId => { revoked.push(leaseId) } })
  const agent = await service.provision(context.request)
  const ticket = new URL(agent.connection.execServerUrl).searchParams.get('ticket')!
  const lease = await context.store.read(database => database.leases[agent.leaseId]!)
  await context.provider.kill(lease.sandboxId)
  await assert.rejects(service.reconnect({ leaseId: agent.leaseId, idempotencyKey: 'reconnect-missing' }),
    (error: unknown) => error instanceof ServiceError && error.status === 404 && error.message === 'lease missing')
  assert.equal(await context.tickets.validate(agent.leaseId, ticket), false)
  assert.deepEqual(revoked, [agent.leaseId])
})
