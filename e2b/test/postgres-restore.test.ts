import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { Header } from 'tar'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import { PostgresObjectReclaimer } from '../src/postgres-object-reclaimer.js'
import { PostgresReconciler } from '../src/postgres-reconciler.js'
import {
  deterministicRestoreId,
  PostgresRestoreCoordinator,
  restoreProviderSnapshotName,
} from '../src/postgres-restore.js'
import { PostgresRestoreSourceResolver } from '../src/postgres-restore-source.js'
import { PostgresDurableState } from '../src/postgres-state.js'
import {
  canonicalRequestHash,
  PostgresJournal,
} from '../src/postgres-store.js'
import { PostgresTicketIssuer } from '../src/postgres-tickets.js'
import { PostgresWorkspacePreparations } from '../src/postgres-workspace-preparations.js'
import type { ProvisionRequest } from '../src/types.js'
import { ServiceError } from '../src/types.js'
import { WorkspaceSnapshotPublisher } from '../src/workspace-snapshots.js'
import { FakeProvider } from './fake-provider.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const tenantId = 'tenant-restore'
const role = {
  sandboxTemplate: 'general-v1',
  providerTemplateId: 'clean-provider-template-v1',
  toolPolicy: {
    allowedDomains: ['agentEnvironment'],
    allowedTools: [{ name: 'read', namespace: 'workspace' }],
  },
  policyVersion: 7,
}

function archive(marker = 'source'): Buffer {
  const entries = [
    { path: 'roots/', type: 'Directory' as const, body: Buffer.alloc(0) },
    { path: 'roots/0/', type: 'Directory' as const, body: Buffer.alloc(0) },
    { path: 'roots/0/project/', type: 'Directory' as const, body: Buffer.alloc(0) },
    { path: 'roots/0/project/file.txt', type: 'File' as const, body: Buffer.from(marker) },
  ]
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    new Header({
      path: entry.path,
      type: entry.type,
      mode: entry.type === 'Directory' ? 0o755 : 0o644,
      size: entry.body.byteLength,
    }).encode(header)
    chunks.push(header, entry.body, Buffer.alloc((512 - entry.body.byteLength % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

class TrackingObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  puts = 0
  deletes = 0
  failAt = Number.POSITIVE_INFINITY

  async put(bytes: Uint8Array): Promise<string> {
    this.puts++
    if (this.puts === this.failAt) throw new Error('injected object storage failure')
    const id = digest(bytes)
    this.values.set(id, Uint8Array.from(bytes))
    return id
  }

  async get(id: string): Promise<Uint8Array> {
    const value = this.values.get(id)
    if (!value) throw new Error('missing object')
    return Uint8Array.from(value)
  }

  async delete(id: string): Promise<void> {
    this.deletes++
    this.values.delete(id)
  }

  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'restore-test', storageKey: `v1/sha256/${id.slice(0, 2)}/${id}` }
  }
}

class AmbiguousJournal extends PostgresJournal {
  throwAfterLeaseCommit = false

  override async withLeaseLocks<T>(tenant: string, leaseIds: string[],
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const result = await super.withLeaseLocks(tenant, leaseIds, fn)
    if (this.throwAfterLeaseCommit) {
      this.throwAfterLeaseCommit = false
      throw new Error('injected ambiguous commit acknowledgement')
    }
    return result
  }
}

interface Fixture {
  admin: Pool
  pools: [Pool, Pool]
  journals: [AmbiguousJournal, AmbiguousJournal]
  states: [PostgresDurableState, PostgresDurableState]
  provider: FakeProvider
  objects: TrackingObjects
  publishers: [WorkspaceSnapshotPublisher, WorkspaceSnapshotPublisher]
  coordinators: [PostgresRestoreCoordinator, PostgresRestoreCoordinator]
  request: ProvisionRequest
  sourceArchive: Buffer
  sourceLeaseId: string
  sourceSnapshotId: string
  staleSnapshotId: string | null
  schema: string
}

async function fixture(options: { terminal?: boolean; checkpoint?: boolean } = {}): Promise<Fixture> {
  const schema = `hosted_agent_restore_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pools = [0, 1].map(() => new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 6,
  })) as [Pool, Pool]
  await runMigrations(pools[0])
  const states = pools.map(pool => new PostgresDurableState(pool)) as
    [PostgresDurableState, PostgresDurableState]
  const journals = pools.map(pool => new AmbiguousJournal(pool)) as
    [AmbiguousJournal, AmbiguousJournal]
  const objects = new TrackingObjects()
  const provider = new FakeProvider()
  const publishers = pools.map((pool, index) => {
    const reclaimer = new PostgresObjectReclaimer(pool, objects)
    return new WorkspaceSnapshotPublisher(states[index]!, objects, {
      reclaimer: {
        async reclaimUnreferencedWorkspaceObject() {
          assert.fail('successful source publication must not require legacy cleanup')
        },
      },
      durablePreparation: {
        journal: journals[index]!,
        preparations: new PostgresWorkspacePreparations(pool),
        reclaimer,
      },
    })
  }) as [WorkspaceSnapshotPublisher, WorkspaceSnapshotPublisher]
  const sourceArchive = archive()
  const sourceLeaseId = 'restore-source-lease'
  const baseSnapshotId = 'restore-source-base'
  provider.snapshots.set('dead-source-provider-snapshot', {
    bytes: Uint8Array.from(sourceArchive),
    runtimeIdentity: 'source-runtime-identity-must-not-survive',
    sandboxId: 'dead-source-sandbox',
    names: [],
  })
  const source = await publishers[0].createBase({
    leaseId: sourceLeaseId,
    environmentId: 'restore-source-environment',
    tenantId,
    agentId: 'agent-root',
    ownerAgentId: null,
    ownerLeaseId: null,
    sourceSnapshotId: null,
    providerSandboxId: 'dead-source-sandbox',
    sandboxTemplate: role.sandboxTemplate,
    cwdUri: 'file:///workspace/roots/0/project',
    workspaceRootUris: ['file:///workspace/roots/0/project'],
    toolPolicy: { allowedDomains: ['legacy.invalid'], allowedTools: ['legacy'] },
    policyVersion: 1,
    snapshot: {
      snapshotId: baseSnapshotId,
      providerSnapshotId: 'dead-source-provider-snapshot',
      archive: sourceArchive,
    },
  })
  let sourceSnapshotId = source.snapshot.snapshotId
  let staleSnapshotId: string | null = null
  if (options.checkpoint) {
    staleSnapshotId = sourceSnapshotId
    const checkpointArchive = archive('latest-checkpoint')
    const checkpoint = await publishers[0].appendCheckpoint({
      tenantId,
      leaseId: sourceLeaseId,
      snapshot: {
        snapshotId: 'restore-source-checkpoint',
        providerSnapshotId: 'dead-checkpoint-provider-snapshot',
        archive: checkpointArchive,
      },
    })
    sourceSnapshotId = checkpoint.snapshot.snapshotId
  }
  if (options.terminal !== false) {
    const client = await pools[0].connect()
    try {
      await client.query('BEGIN')
      await states[0].markLeaseLost(tenantId, sourceLeaseId, 'dead-source-sandbox', client)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  const coordinators = journals.map((journal, index) => new PostgresRestoreCoordinator(
    journal,
    states[index]!,
    publishers[index]!,
    provider,
    new PostgresTicketIssuer(states[index]!, tenantId, 'wss://gateway.example'),
    new PostgresRestoreSourceResolver(states[index]!, objects),
    {
      principal: { tenantId },
      managedBy: 'cudex',
      workerId: `restore-worker-${index}`,
      roles: { default: role },
    },
  )) as [PostgresRestoreCoordinator, PostgresRestoreCoordinator]
  const request: ProvisionRequest = {
    agentId: 'agent-root',
    ownerAgentId: null,
    agentType: 'default',
    sandboxTemplate: role.sandboxTemplate,
    source: { type: 'durableSnapshot', snapshotId: sourceSnapshotId },
    idempotencyKey: 'durable-restore',
  }
  return { admin, pools, journals, states, provider, objects, publishers, coordinators,
    request, sourceArchive, sourceLeaseId, sourceSnapshotId, staleSnapshotId, schema }
}

async function close(context: Fixture): Promise<void> {
  await Promise.all(context.pools.map(pool => pool.end()))
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

test('durable restore uses one clean template, exact archive, and replay allocates nothing', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const restored = await context.coordinators[0].restore(context.request)
    assert.equal(context.provider.creates, 1)
    assert.equal(context.provider.restores, 0)
    assert.equal(context.provider.live().length, 1)
    assert.equal(context.provider.snapshots.size, 2)
    const sandbox = context.provider.sandboxes.get(context.provider.live()[0]!)!
    assert.equal(sandbox.templateId, role.providerTemplateId)
    assert.equal(sandbox.runtimeIdentity, undefined)
    assert.deepEqual(Buffer.from(sandbox.bytes), context.sourceArchive)
    assert.deepEqual(restored.toolPolicy, role.toolPolicy)
    assert.match(restored.connection.execServerUrl, /^wss:\/\/gateway\.example\/leases\//u)

    const beforeReplay = {
      creates: context.provider.creates,
      restores: context.provider.restores,
      snapshots: context.provider.snapshots.size,
      puts: context.objects.puts,
    }
    const replay = await context.coordinators[1].restore(context.request)
    assert.equal(replay.leaseId, restored.leaseId)
    assert.deepEqual({
      creates: context.provider.creates,
      restores: context.provider.restores,
      snapshots: context.provider.snapshots.size,
      puts: context.objects.puts,
    }, beforeReplay)

    const durable = await context.pools[0].query<{
      state: string
      primary_lease_id: string | null
      result_lease_id: string | null
      request_hash: string
      source_state: string
      restore_source_lease_id: string
      restore_source_snapshot_id: string
      allocated: string
      adopted: string
    }>(`
      SELECT operation.state, operation.primary_lease_id, operation.result_lease_id,
        operation.request_hash, source.state AS source_state,
        replacement.restore_source_lease_id, replacement.restore_source_snapshot_id,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'provision' AND idempotency_key = operation.idempotency_key) AS allocated,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'provision' AND idempotency_key = operation.idempotency_key
            AND state = 'adopted' AND lease_id = operation.result_lease_id) AS adopted
      FROM hosted_agent_operations AS operation
      JOIN hosted_agent_leases AS source ON source.lease_id = operation.primary_lease_id
      JOIN hosted_agent_leases AS replacement ON replacement.lease_id = operation.result_lease_id
      WHERE operation.operation = 'provision' AND operation.idempotency_key = $1
    `, [context.request.idempotencyKey])
    assert.deepEqual(durable.rows[0], {
      state: 'succeeded',
      primary_lease_id: context.sourceLeaseId,
      result_lease_id: restored.leaseId,
      request_hash: canonicalRequestHash(context.request),
      source_state: 'released',
      restore_source_lease_id: context.sourceLeaseId,
      restore_source_snapshot_id: context.sourceSnapshotId,
      allocated: '5',
      adopted: '5',
    })
  } finally {
    await close(context)
  }
})

test('restore authorization failures allocate no provider resources', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture({ checkpoint: true })
  try {
    const otherTenant = new PostgresRestoreCoordinator(
      context.journals[0],
      context.states[0],
      context.publishers[0],
      context.provider,
      new PostgresTicketIssuer(context.states[0], 'tenant-other', 'wss://gateway.example'),
      new PostgresRestoreSourceResolver(context.states[0], context.objects),
      {
        principal: { tenantId: 'tenant-other' }, managedBy: 'cudex', workerId: 'other-tenant-worker',
        roles: { default: role },
      },
    )
    await assert.rejects(otherTenant.restore({ ...context.request, idempotencyKey: 'cross-tenant' }),
      (error: unknown) => error instanceof ServiceError && error.status === 404)
    await assert.rejects(context.coordinators[0].restore({
      ...context.request,
      idempotencyKey: 'stale-snapshot',
      source: { type: 'durableSnapshot', snapshotId: context.staleSnapshotId! },
    }), (error: unknown) => error instanceof ServiceError && error.status === 404)
    await assert.rejects(context.coordinators[0].restore({
      ...context.request,
      agentId: 'different-agent',
      idempotencyKey: 'wrong-agent',
    }), (error: unknown) => error instanceof ServiceError && error.status === 404)
    assert.equal(context.provider.creates, 0)
    assert.equal(context.provider.restores, 0)
    assert.equal(context.provider.snapshots.size, 1)
    assert.deepEqual(context.provider.live(), [])
  } finally {
    await close(context)
  }
})

test('non-terminal restore source fails before provider allocation', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture({ terminal: false })
  try {
    await assert.rejects(context.coordinators[0].restore(context.request),
      (error: unknown) => error instanceof ServiceError && error.status === 409
        && error.message === 'restore source lease is not terminal')
    assert.equal(context.provider.creates, 0)
    assert.equal(context.provider.restores, 0)
    const operation = await context.pools[0].query<{ state: string; error_code: string }>(`
      SELECT state, error_code FROM hosted_agent_operations
      WHERE operation = 'provision' AND idempotency_key = $1
    `, [context.request.idempotencyKey])
    assert.deepEqual(operation.rows[0], { state: 'failed_terminal', error_code: 'service_409' })
  } finally {
    await close(context)
  }
})

test('partial durable restore publication reclaims provider and object allocations', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const baseline = { puts: context.objects.puts, values: context.objects.values.size }
    context.objects.failAt = baseline.puts + 2
    await assert.rejects(context.coordinators[0].restore(context.request),
      (error: unknown) => error instanceof ServiceError && error.status === 503
        && error.message === 'durable restore failed')
    assert.deepEqual(context.provider.live(), [])
    assert.equal(context.provider.kills, 1)
    assert.equal(context.provider.snapshots.size, 1)
    assert.equal(context.provider.snapshotDeletes, 1)
    assert.equal(context.objects.values.size, baseline.values)
    assert.equal((await context.states[0].getLease(tenantId, context.sourceLeaseId))?.state, 'lost')

    const mutationCounts = {
      creates: context.provider.creates,
      kills: context.provider.kills,
      snapshotDeletes: context.provider.snapshotDeletes,
      puts: context.objects.puts,
    }
    await assert.rejects(context.coordinators[1].restore(context.request),
      (error: unknown) => error instanceof ServiceError && error.status === 503
        && error.message === 'durable restore failed')
    assert.deepEqual({
      creates: context.provider.creates,
      kills: context.provider.kills,
      snapshotDeletes: context.provider.snapshotDeletes,
      puts: context.objects.puts,
    }, mutationCounts)
  } finally {
    await close(context)
  }
})

test('ambiguous final restore commit recovers the replacement without cleanup', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    context.journals[0].throwAfterLeaseCommit = true
    const restored = await context.coordinators[0].restore(context.request)
    assert.equal(context.provider.creates, 1)
    assert.equal(context.provider.kills, 0)
    assert.equal(context.provider.snapshotDeletes, 0)
    assert.equal(context.provider.live().length, 1)
    assert.equal(context.provider.snapshots.size, 2)
    const replacement = await context.states[1].getLease(tenantId, restored.leaseId)
    assert.equal(replacement?.state, 'active')
    assert.equal(replacement?.restoreSourceLeaseId, context.sourceLeaseId)
    const replay = await context.coordinators[1].restore(context.request)
    assert.equal(replay.leaseId, restored.leaseId)
    assert.equal(context.provider.creates, 1)
  } finally {
    await close(context)
  }
})

async function leavePreparedRestore(context: Fixture, idempotencyKey: string,
  options: { ledgerSnapshot?: boolean } = {}): Promise<{
    identity: { operation: string; idempotencyKey: string; tenantId: string }
    sandboxId: string
    providerSnapshotId: string
    preparationId: string
  }> {
  const identity = { operation: 'provision', idempotencyKey, tenantId }
  const claim = await context.journals[0].claimOperation({
    ...identity,
    requestHash: canonicalRequestHash({ ...context.request, idempotencyKey }),
    workerId: 'dead-restore-worker',
    primaryLeaseId: context.sourceLeaseId,
  })
  assert.equal(claim.kind, 'claimed')
  if (claim.kind !== 'claimed') throw new Error('restore operation was not claimed')
  const fence = { ...identity, generation: claim.generation, workerId: 'dead-restore-worker' }
  const leaseId = deterministicRestoreId('lease', identity)
  const created = await context.provider.create(role.providerTemplateId, {
    managedBy: 'cudex', tenantId, leaseId, agentId: context.request.agentId,
    sandboxTemplate: role.sandboxTemplate, restoreSourceLeaseId: context.sourceLeaseId,
  })
  await context.journals[0].recordAllocation(fence, fence.generation, fence.workerId, {
    kind: 'sandbox', resourceId: created.sandboxId,
    metadata: { managedBy: 'cudex', action: 'restore' },
  })
  const restoredArchive = archive(`stale-${idempotencyKey}`)
  await context.provider.uploadArchive(created.sandboxId, restoredArchive)
  const providerSnapshotId = await context.provider.snapshot(created.sandboxId, {
    name: restoreProviderSnapshotName(identity),
  })
  if (options.ledgerSnapshot !== false) {
    await context.journals[0].recordAllocation(fence, fence.generation, fence.workerId, {
      kind: 'provider_snapshot', resourceId: providerSnapshotId,
      metadata: { managedBy: 'cudex', action: 'restore' },
    })
  }
  const prepared = await context.publishers[0].prepareDurableBase({
    fence,
    expectedSourceChecksum: null,
    leaseId,
    environmentId: deterministicRestoreId('env', identity),
    tenantId,
    agentId: context.request.agentId,
    ownerAgentId: null,
    ownerLeaseId: null,
    sourceSnapshotId: null,
    restoreSourceLeaseId: context.sourceLeaseId,
    restoreSourceSnapshotId: context.sourceSnapshotId,
    providerSandboxId: created.sandboxId,
    sandboxTemplate: role.sandboxTemplate,
    cwdUri: 'file:///workspace/roots/0/project',
    workspaceRootUris: ['file:///workspace/roots/0/project'],
    toolPolicy: structuredClone(role.toolPolicy),
    policyVersion: role.policyVersion,
    snapshot: {
      snapshotId: deterministicRestoreId('snapshot', identity),
      providerSnapshotId,
      archive: restoredArchive,
      expiresAt: null,
    },
  })
  assert.equal(prepared.kind, 'prepared')
  await context.pools[0].query(`
    UPDATE hosted_agent_operations
    SET heartbeat_at = now() - interval '1 hour'
    WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
  `, [identity.operation, identity.idempotencyKey, identity.tenantId])
  return {
    identity, sandboxId: created.sandboxId, providerSnapshotId,
    preparationId: prepared.preparation.preparationId,
  }
}

test('stale prepared restore reclaims its sandbox, snapshot, and workspace objects', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const baselineObjects = new Set(context.objects.values.keys())
    const stale = await leavePreparedRestore(context, 'stale-prepared-restore')
    assert.ok(context.provider.live().includes(stale.sandboxId))
    assert.equal(context.provider.snapshots.has(stale.providerSnapshotId), true)
    assert.ok(context.objects.values.size > baselineObjects.size)

    const preparations = new PostgresWorkspacePreparations(context.pools[1])
    const result = await new PostgresReconciler(
      context.journals[1], context.states[1], context.provider,
      {
        managedBy: 'cudex', tenantId, workerId: 'restore-reconciler', staleAfterMs: 1,
        workspaceRecovery: {
          preparations,
          reclaimer: new PostgresObjectReclaimer(context.pools[1], context.objects),
        },
      },
    ).runOnce()

    assert.equal(result.operationsClaimed, 1)
    assert.equal(context.provider.live().includes(stale.sandboxId), false)
    assert.equal(context.provider.snapshots.has(stale.providerSnapshotId), false)
    assert.deepEqual(new Set(context.objects.values.keys()), baselineObjects)
    assert.equal((await preparations.getForOperation(stale.identity))?.state, 'reclaimed')
    const operation = await context.pools[0].query<{ state: string; error_code: string }>(`
      SELECT state, error_code FROM hosted_agent_operations
      WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
    `, [stale.identity.operation, stale.identity.idempotencyKey, stale.identity.tenantId])
    assert.deepEqual(operation.rows[0], {
      state: 'failed_terminal', error_code: 'reconciled_abandoned',
    })
    const allocations = await context.journals[0].listAllocations(stale.identity)
    assert.ok(allocations.length >= 4)
    assert.ok(allocations.every(allocation => allocation.state === 'reclaimed'))
  } finally {
    await close(context)
  }
})

test('stale restore discovers an unledgered deterministic snapshot before sandbox cleanup', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const stale = await leavePreparedRestore(context, 'stale-unledgered-snapshot', {
      ledgerSnapshot: false,
    })
    const cleanupOrder: string[] = []
    const deleteSnapshot = context.provider.deleteSnapshot.bind(context.provider)
    const kill = context.provider.kill.bind(context.provider)
    context.provider.deleteSnapshot = async snapshotId => {
      cleanupOrder.push(`snapshot:${snapshotId}`)
      return deleteSnapshot(snapshotId)
    }
    context.provider.kill = async sandboxId => {
      cleanupOrder.push(`sandbox:${sandboxId}`)
      return kill(sandboxId)
    }
    await new PostgresReconciler(
      context.journals[1], context.states[1], context.provider,
      {
        managedBy: 'cudex', tenantId, workerId: 'restore-reconciler', staleAfterMs: 1,
        workspaceRecovery: {
          preparations: new PostgresWorkspacePreparations(context.pools[1]),
          reclaimer: new PostgresObjectReclaimer(context.pools[1], context.objects),
        },
      },
    ).runOnce()

    assert.deepEqual(cleanupOrder, [
      `snapshot:${stale.providerSnapshotId}`,
      `sandbox:${stale.sandboxId}`,
    ])
    assert.equal(context.provider.snapshots.has(stale.providerSnapshotId), false)
    assert.equal(context.provider.live().includes(stale.sandboxId), false)
    const operation = await context.pools[0].query<{ state: string }>(`
      SELECT state FROM hosted_agent_operations
      WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
    `, [stale.identity.operation, stale.identity.idempotencyKey, stale.identity.tenantId])
    assert.equal(operation.rows[0]?.state, 'failed_terminal')
  } finally {
    await close(context)
  }
})
