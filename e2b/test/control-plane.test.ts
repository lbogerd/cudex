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

async function fixture(provider = new FakeProvider()) {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-control-')); const root = join(directory, 'project')
  await mkdir(root); await writeFile(join(root, 'tracked.txt'), 'modified'); await writeFile(join(root, 'untracked.txt'), 'new'); await symlink('tracked.txt', join(root, 'link'))
  const state = join(directory, 'state.json'); const store = new JsonStore(state); await store.open()
  const tickets = new TicketIssuer(store, 'wss://gateway.example', 60_000)
  const blobs = new BlobStore(join(directory, 'blobs'))
  const service = new ControlPlane(store, provider, tickets, blobs, { templates: { 'general-v1': 'tpl-1' }, allowedRoots: [directory], ingress: { maxBytes: 10_000_000, maxRoots: 4 } })
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
  const restarted = new ControlPlane(restartedStore, context.provider, restartedTickets, context.blobs, { templates: { 'general-v1': 'tpl-1' }, allowedRoots: [context.directory], ingress: { maxBytes: 10_000_000, maxRoots: 4 } })
  const reconnected = await restarted.reconnect({ leaseId: provisioned.leaseId, idempotencyKey: 'reconnect-1' }); assert.equal(reconnected.environmentId, provisioned.environmentId)
  const restored = await restarted.provision({ ...context.request, agentId: 'agent-restored', source: { type: 'durableSnapshot', snapshotId: checkpoint.snapshotId }, idempotencyKey: 'restore-1' })
  assert.notEqual(restored.leaseId, provisioned.leaseId); assert.notEqual(restored.environmentId, provisioned.environmentId)
})

test('child gets an isolated spawn-time workspace capture', async () => {
  const context = await fixture(); const owner = await context.service.provision(context.request)
  const child = await context.service.provision({ ...context.request, agentId: 'child', ownerAgentId: 'agent-1', source: { type: 'agentEnvironment', ownerLeaseId: owner.leaseId }, idempotencyKey: 'child-1' })
  const leases = await context.store.read(database => database.leases); const ownerSandbox = context.provider.sandboxes.get(leases[owner.leaseId]!.sandboxId)!; const childSandbox = context.provider.sandboxes.get(leases[child.leaseId]!.sandboxId)!
  assert.deepEqual(childSandbox.bytes, ownerSandbox.bytes); childSandbox.bytes[0] = childSandbox.bytes[0]! ^ 1; assert.notDeepEqual(childSandbox.bytes, ownerSandbox.bytes)
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
