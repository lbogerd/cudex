import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { runMigrations } from '../src/migrate.js'
import { PostgresReconciler } from '../src/postgres-reconciler.js'
import { PostgresDurableState, type Lease, type Snapshot } from '../src/postgres-state.js'
import { canonicalRequestHash, PostgresJournal, type OperationAllocation, type StaleOperation } from '../src/postgres-store.js'
import { FakeProvider } from './fake-provider.js'

const operation: StaleOperation = {
  operation: 'provision', idempotencyKey: 'stale', tenantId: 'tenant-1',
  requestHash: canonicalRequestHash({ operation: 'provision' }), generation: 1,
  previousWorkerId: 'dead', workerId: 'reconciler', primaryLeaseId: null,
}

const withoutProviderContention = async <T>(_kind: 'sandbox' | 'provider_snapshot', _resourceId: string,
  fn: () => Promise<T>): Promise<T> => fn()

function allocation(id: string, kind: string, resourceId: string): OperationAllocation {
  return { allocationId: id, allocationKind: kind, resourceId, leaseId: null, state: 'allocated',
    metadata: {}, allocatedAt: new Date(), updatedAt: new Date(), reclaimedAt: null }
}

test('known cleanup is fenced, active durable sandboxes are adopted, and failures remain pending', async () => {
  const provider = new FakeProvider()
  const protectedSandbox = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-1' })
  const failedSandbox = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-1' })
  const allocations = [allocation('1', 'sandbox', protectedSandbox.sandboxId), allocation('2', 'sandbox', failedSandbox.sandboxId)]
  const lease = {
    leaseId: 'lease-active', environmentId: 'env-active', tenantId: 'tenant-1', agentId: 'agent',
    ownerAgentId: null, ownerLeaseId: null, sourceSnapshotId: null,
    providerSandboxId: protectedSandbox.sandboxId, sandboxTemplate: 'template',
    cwdUri: 'file:///workspace/root', workspaceRootUris: ['file:///workspace/root'],
    baseSnapshotId: 'snapshot-base', latestSnapshotId: 'snapshot-base', state: 'active',
    toolPolicy: {}, policyVersion: 1, connectionGeneration: 0, releasedAt: null,
  } satisfies Lease
  const journal = {
    claimStaleOperations: async () => [operation],
    heartbeatOperation: async () => true,
    listAllocations: async () => allocations,
    updateAllocationState: async (_identity: unknown, generation: number, worker: string, id: string, state: OperationAllocation['state']) => {
      assert.equal(generation, 1); assert.equal(worker, 'reconciler')
      const item = allocations.find(value => value.allocationId === id)!; item.state = state
      return item
    },
    bindLeaseAndAdoptAllocations: async (_identity: unknown, generation: number, worker: string, leaseId: string, ids: string[]) => {
      assert.equal(generation, 1); assert.equal(worker, 'reconciler'); assert.equal(leaseId, lease.leaseId)
      const selected = allocations.filter(value => ids.includes(value.allocationId)); for (const item of selected) item.state = 'adopted'; return selected
    },
    failOperation: async () => assert.fail('an operation with adopted or pending resources must not be terminally failed'),
    hasUnreclaimedAllocation: async (_kind: string, resourceId: string) => allocations.some(value => value.resourceId === resourceId && value.state !== 'reclaimed'),
    withProviderResourceLock: withoutProviderContention,
  } as unknown as PostgresJournal
  const state = {
    findLeaseByProviderSandboxForReconciliation: async (id: string) => id === protectedSandbox.sandboxId ? lease : null,
    findSnapshotByProviderIdForReconciliation: async () => null,
    getLease: async () => lease,
    cleanupTickets: async () => 0,
  } as unknown as PostgresDurableState
  provider.failAt = 'kill'
  const reconciler = new PostgresReconciler(journal, state, provider, {
    managedBy: 'cudex', tenantId: 'tenant-1', workerId: 'reconciler', staleAfterMs: 5_000,
  })
  const result = await reconciler.runOnce()
  assert.equal(result.protectedResources, 1); assert.equal(result.allocationsPending, 1)
  assert.equal(allocations[0]!.state, 'adopted'); assert.equal(allocations[1]!.state, 'reclaim_pending')
  assert.deepEqual(new Set(provider.live()), new Set([protectedSandbox.sandboxId, failedSandbox.sandboxId]))
})

test('inventory cleanup is tenant and managedBy scoped and deletes only discoverable orphan snapshots', async () => {
  const provider = new FakeProvider()
  const orphan = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-1' })
  const firstSnapshot = await provider.snapshot(orphan.sandboxId, { name: 'orphan-snapshot-1' })
  const secondSnapshot = await provider.snapshot(orphan.sandboxId, { name: 'orphan-snapshot-2' })
  provider.sandboxes.get(orphan.sandboxId)!.startedAt = new Date(Date.now() - 10_000)
  const fresh = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-1' })
  const otherTenant = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-2' })
  const otherManager = await provider.create('template', { managedBy: 'other', tenantId: 'tenant-1' })
  const journal = {
    claimStaleOperations: async () => [],
    hasUnreclaimedAllocation: async () => false,
    withProviderResourceLock: withoutProviderContention,
  } as unknown as PostgresJournal
  const state = {
    findLeaseByProviderSandboxForReconciliation: async () => null,
    findSnapshotByProviderIdForReconciliation: async () => null,
    cleanupTickets: async () => 0,
  } as unknown as PostgresDurableState
  const result = await new PostgresReconciler(journal, state, provider, {
    managedBy: 'cudex', tenantId: 'tenant-1', workerId: 'reconciler', staleAfterMs: 5_000,
    maxInventorySnapshotsPerSandbox: 1,
  }).runOnce()
  assert.equal(result.inventorySandboxesReclaimed, 0); assert.equal(provider.snapshots.has(firstSnapshot), false)
  assert.equal(provider.snapshots.has(secondSnapshot), true)
  assert.deepEqual(new Set(provider.live()), new Set([orphan.sandboxId, fresh.sandboxId, otherTenant.sandboxId, otherManager.sandboxId]))
  const drained = await new PostgresReconciler(journal, state, provider, {
    managedBy: 'cudex', tenantId: 'tenant-1', workerId: 'reconciler', staleAfterMs: 5_000,
    maxInventorySnapshotsPerSandbox: 1,
  }).runOnce()
  assert.equal(drained.inventorySandboxesReclaimed, 1); assert.equal(provider.snapshots.has(secondSnapshot), false)
  assert.deepEqual(new Set(provider.live()), new Set([fresh.sandboxId, otherTenant.sandboxId, otherManager.sandboxId]))
  provider.sandboxes.get(fresh.sandboxId)!.startedAt = new Date(Date.now() - 10_000)
  const next = await new PostgresReconciler(journal, state, provider, {
    managedBy: 'cudex', tenantId: 'tenant-1', workerId: 'reconciler', staleAfterMs: 5_000,
  }).runOnce()
  assert.equal(next.inventorySandboxesReclaimed, 1)
  assert.deepEqual(new Set(provider.live()), new Set([otherTenant.sandboxId, otherManager.sandboxId]))
})

test('a durable checkpoint snapshot is adopted and its logical response is recovered', async () => {
  const provider = new FakeProvider()
  const allocations = [allocation('1', 'provider_snapshot', 'provider-snapshot-durable')]
  let completed: unknown
  const journal = {
    claimStaleOperations: async () => [{ ...operation, operation: 'checkpoint' }],
    heartbeatOperation: async () => true,
    listAllocations: async () => allocations,
    updateAllocationState: async (_identity: unknown, _generation: number, _worker: string, _id: string,
      state: OperationAllocation['state']) => { allocations[0]!.state = state; return allocations[0] },
    completeOperation: async (_identity: unknown, _generation: number, _worker: string, response: unknown) => { completed = response },
    failOperation: async () => assert.fail('a durable checkpoint must not be failed'),
    hasUnreclaimedAllocation: async () => false,
    withProviderResourceLock: withoutProviderContention,
  } as unknown as PostgresJournal
  const snapshot = {
    snapshotId: 'snapshot-durable', tenantId: 'tenant-1', leaseId: 'released-lease',
    providerSnapshotId: 'provider-snapshot-durable', workspaceArchiveObjectId: 'archive',
    manifestObjectId: 'manifest', manifestChecksum: `sha256:${'a'.repeat(64)}`,
    state: 'available', expiresAt: null, createdAt: new Date(),
  } satisfies Snapshot
  const state = {
    findSnapshotByProviderIdForReconciliation: async () => snapshot,
    getLease: async () => null,
    cleanupTickets: async () => 0,
  } as unknown as PostgresDurableState
  const result = await new PostgresReconciler(journal, state, provider, {
    managedBy: 'cudex', tenantId: 'tenant-1', workerId: 'reconciler', staleAfterMs: 1,
  }).runOnce()
  assert.equal(result.protectedResources, 1)
  assert.equal(allocations[0]!.state, 'adopted')
  assert.deepEqual(completed, { snapshotId: 'snapshot-durable' })
})

test('runOnce coalesces concurrent calls and polling never overlaps', async () => {
  let active = 0; let maximum = 0; let runs = 0
  const journal = {
    claimStaleOperations: async () => {
      active += 1; maximum = Math.max(maximum, active); runs += 1
      await new Promise(resolve => setTimeout(resolve, 15)); active -= 1; return []
    },
    hasUnreclaimedAllocation: async () => false,
    withProviderResourceLock: withoutProviderContention,
  } as unknown as PostgresJournal
  const state = { cleanupTickets: async () => 0 } as unknown as PostgresDurableState
  const provider = { listManagedSandboxes: async () => [] } as unknown as FakeProvider
  const reconciler = new PostgresReconciler(journal, state, provider, {
    managedBy: 'cudex', tenantId: 'tenant-1', workerId: 'reconciler', staleAfterMs: 1, pollIntervalMs: 5,
  })
  const first = reconciler.runOnce(); const second = reconciler.runOnce()
  assert.equal(first, second); await Promise.all([first, second]); assert.equal(runs, 1)
  reconciler.start(); await new Promise(resolve => setTimeout(resolve, 48)); await reconciler.stop()
  assert.equal(maximum, 1); assert.ok(runs >= 2)
})

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
test('live PostgreSQL pass reclaims stale allocations, protects active leases, and cleans tickets', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const schema = `hosted_agent_reconciler_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await runMigrations(pool)
    const journal = new PostgresJournal(pool); const state = new PostgresDurableState(pool); const provider = new FakeProvider()
    const orphan = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-1' })
    const protectedSandbox = await provider.create('template', { managedBy: 'cudex', tenantId: 'tenant-1' })
    const baseProviderSnapshot = await provider.snapshot(protectedSandbox.sandboxId, { name: 'durable-base' })
    for (const object of [
      { objectId: 'archive-base', kind: 'workspace_archive' as const, checksum: `sha256:${'a'.repeat(64)}` },
      { objectId: 'manifest-base', kind: 'manifest' as const, checksum: `sha256:${'b'.repeat(64)}` },
    ]) {
      await state.registerObject({ ...object, tenantId: 'tenant-1', storageBucket: 'test',
        storageKey: `tenant-1/${object.objectId}`, sizeBytes: 10, state: 'available', expiresAt: null })
    }
    await state.createLeaseWithBaseSnapshot({
      leaseId: 'lease-active', environmentId: 'env-active', tenantId: 'tenant-1', agentId: 'agent',
      providerSandboxId: protectedSandbox.sandboxId, sandboxTemplate: 'template',
      cwdUri: 'file:///workspace/root', workspaceRootUris: ['file:///workspace/root'],
      toolPolicy: {}, policyVersion: 1,
      baseSnapshot: { snapshotId: 'snapshot-base', providerSnapshotId: baseProviderSnapshot,
        workspaceArchiveObjectId: 'archive-base', manifestObjectId: 'manifest-base',
        manifestChecksum: `sha256:${'b'.repeat(64)}` },
    })
    const staleInputs = [
      { operation: 'provision', idempotencyKey: 'orphan', resourceId: orphan.sandboxId },
      { operation: 'provision', idempotencyKey: 'protected', resourceId: protectedSandbox.sandboxId },
    ]
    for (const input of staleInputs) {
      const identity = { operation: input.operation, idempotencyKey: input.idempotencyKey, tenantId: 'tenant-1' }
      const claim = await journal.claimOperation({ ...identity, requestHash: canonicalRequestHash(identity), workerId: 'dead' })
      assert.equal(claim.kind, 'claimed'); if (claim.kind !== 'claimed') continue
      const recorded = await journal.recordAllocation(identity, claim.generation, 'dead', { kind: 'sandbox', resourceId: input.resourceId })
      if (input.idempotencyKey === 'protected') {
        await journal.updateAllocationState(identity, claim.generation, 'dead', recorded.allocationId, 'reclaim_pending')
      }
    }
    await pool.query("UPDATE hosted_agent_operations SET heartbeat_at = now() - interval '1 hour'")
    await pool.query(`
      INSERT INTO hosted_agent_tickets (ticket_hash, lease_id, purpose, issued_at, expires_at)
      VALUES ($1, 'lease-active', 'exec_gateway_connect', now() - interval '2 hours', now() - interval '1 hour')
    `, [randomBytes(32)])
    const result = await new PostgresReconciler(journal, state, provider, {
      managedBy: 'cudex', tenantId: 'tenant-1', workerId: 'reconciler', staleAfterMs: 5_000,
      ticketRetentionMs: 1,
    }).runOnce()
    assert.equal(result.operationsClaimed, 2); assert.equal(result.allocationsReclaimed, 1)
    assert.equal(result.protectedResources, 1); assert.equal(result.ticketsDeleted, 1)
    assert.deepEqual(provider.live(), [protectedSandbox.sandboxId])
    const protectedAllocations = await journal.listAllocations({ operation: 'provision', idempotencyKey: 'protected', tenantId: 'tenant-1' })
    assert.equal(protectedAllocations[0]!.state, 'adopted'); assert.equal(protectedAllocations[0]!.leaseId, 'lease-active')
    const replay = await journal.claimOperation({ operation: 'provision', idempotencyKey: 'protected', tenantId: 'tenant-1',
      requestHash: canonicalRequestHash({ operation: 'provision', idempotencyKey: 'protected', tenantId: 'tenant-1' }), workerId: 'observer' })
    assert.equal(replay.kind, 'succeeded')
    if (replay.kind === 'succeeded') assert.deepEqual(replay.response, {
      leaseId: 'lease-active', environmentId: 'env-active', cwd: 'file:///workspace/root',
      workspaceRoots: ['file:///workspace/root'], baseSnapshotId: 'snapshot-base', toolPolicy: {},
    })
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
