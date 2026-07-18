import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderCapabilityError } from '../src/provider.js'
import { FakeProvider } from './fake-provider.js'

test('exec health probe fails closed until the server is started', async () => {
  const provider = new FakeProvider(); const sandbox = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-one', operation: 'one' })
  await assert.rejects(provider.probeExecServer(sandbox.sandboxId), /health probe/)
  await provider.startExecServer(sandbox.sandboxId)
  await provider.probeExecServer(sandbox.sandboxId)
  provider.failAt = 'probe'
  await assert.rejects(provider.probeExecServer(sandbox.sandboxId), /injected probe/)
})

test('managed sandbox inventory requires ownership scope and returns no connection material', async () => {
  const provider = new FakeProvider()
  const owned = await provider.create('template-a', { managedBy: 'cudex', tenantId: 'one', operation: 'op-1' })
  await provider.create('template-b', { managedBy: 'other', tenantId: 'one', operation: 'op-2' })
  await assert.rejects(provider.listManagedSandboxes({ metadata: { managedBy: '', tenantId: 'one' } }), ProviderCapabilityError)
  await assert.rejects(provider.listManagedSandboxes({ metadata: { managedBy: 'cudex', tenantId: '' } }), ProviderCapabilityError)
  const inventory = await provider.listManagedSandboxes({ metadata: { managedBy: 'cudex', tenantId: 'one' } })
  assert.deepEqual(inventory.map(item => item.sandboxId), [owned.sandboxId])
  assert.equal(JSON.stringify(inventory).includes('rawExecUrl'), false)
  assert.equal(JSON.stringify(inventory).includes('ticket='), false)
})

test('snapshot inventory is explicitly scoped and deletion is idempotent', async () => {
  const provider = new FakeProvider(); const sandbox = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-one' })
  const first = await provider.snapshot(sandbox.sandboxId, { name: 'cudex-op-one' })
  const second = await provider.snapshot(sandbox.sandboxId, { name: 'cudex-op-two' })
  await assert.rejects(provider.listSnapshots({}), ProviderCapabilityError)
  assert.deepEqual((await provider.listSnapshots({ sandboxId: sandbox.sandboxId })).map(item => item.snapshotId), [first, second])
  assert.deepEqual((await provider.listSnapshots({ name: 'cudex-op-two' })).map(item => item.snapshotId), [second])
  assert.equal(await provider.deleteSnapshot(first), true)
  assert.equal(await provider.deleteSnapshot(first), false)
})

test('failed provider cleanup remains observable for reconciliation retry', async () => {
  const provider = new FakeProvider(); const sandbox = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-one' })
  const snapshot = await provider.snapshot(sandbox.sandboxId)
  provider.failAt = 'kill'; await assert.rejects(provider.kill(sandbox.sandboxId), /injected kill/)
  assert.deepEqual(provider.live(), [sandbox.sandboxId])
  provider.failAt = 'deleteSnapshot'; await assert.rejects(provider.deleteSnapshot(snapshot), /injected deleteSnapshot/)
  assert.equal(provider.snapshots.has(snapshot), true)
})
