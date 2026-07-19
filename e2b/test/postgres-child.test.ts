import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { Header } from 'tar'
import type { ObjectStore } from '../src/blob-store.js'
import {
  childProviderSnapshotName,
  deterministicChildId,
  PostgresChildCoordinator,
} from '../src/postgres-child.js'
import { runMigrations } from '../src/migrate.js'
import { PostgresObjectReclaimer } from '../src/postgres-object-reclaimer.js'
import { PostgresDurableState } from '../src/postgres-state.js'
import { PostgresJournal } from '../src/postgres-store.js'
import { PostgresTicketIssuer } from '../src/postgres-tickets.js'
import { PostgresWorkspacePreparations } from '../src/postgres-workspace-preparations.js'
import type { ProvisionRequest } from '../src/types.js'
import { ServiceError } from '../src/types.js'
import { WorkspaceSnapshotPublisher } from '../src/workspace-snapshots.js'
import { FakeProvider } from './fake-provider.js'
import type { ProviderSnapshotOptions } from '../src/provider.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const tenantId = 'tenant-child'
const role = {
  sandboxTemplate: 'child-v1',
  providerTemplateId: 'clean-child-template-v1',
  toolPolicy: {
    allowedDomains: ['agentEnvironment'],
    allowedTools: [{ name: 'read', namespace: 'workspace' }],
  },
  policyVersion: 11,
}

function archive(marker = 'owner-spawn-state'): Buffer {
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

  async put(bytes: Uint8Array): Promise<string> {
    const id = digest(bytes)
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
    return { storageBucket: 'child-test', storageKey: `v1/${id}` }
  }
}

class GatedCaptureProvider extends FakeProvider {
  private releaseCapture!: () => void
  private captureEntered!: () => void
  readonly captureGate = new Promise<void>(resolve => { this.releaseCapture = resolve })
  readonly entered = new Promise<void>(resolve => { this.captureEntered = resolve })

  release(): void { this.releaseCapture() }

  override async snapshot(sandboxId: string, options: ProviderSnapshotOptions = {}): Promise<string> {
    if (options.name?.startsWith('child-capture-')) {
      this.captureEntered()
      await this.captureGate
    }
    return super.snapshot(sandboxId, options)
  }
}

interface Fixture {
  admin: Pool
  pools: [Pool, Pool]
  journals: [PostgresJournal, PostgresJournal]
  states: [PostgresDurableState, PostgresDurableState]
  provider: FakeProvider
  objects: TrackingObjects
  coordinators: [PostgresChildCoordinator, PostgresChildCoordinator]
  request: ProvisionRequest
  ownerLeaseId: string
  ownerSandboxId: string
  ownerSnapshotId: string
  ownerArchive: Buffer
  schema: string
}

async function fixture(provider: FakeProvider = new FakeProvider()): Promise<Fixture> {
  const schema = `hosted_agent_child_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pools = [0, 1].map(() => new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 8,
  })) as [Pool, Pool]
  await runMigrations(pools[0])
  const states = pools.map(pool => new PostgresDurableState(pool)) as
    [PostgresDurableState, PostgresDurableState]
  const journals = pools.map(pool => new PostgresJournal(pool)) as
    [PostgresJournal, PostgresJournal]
  const objects = new TrackingObjects()
  const publishers = pools.map((pool, index) => new WorkspaceSnapshotPublisher(
    states[index]!, objects, {
      reclaimer: { async reclaimUnreferencedWorkspaceObject() {
        assert.fail('durable child publication must use preparation cleanup')
      } },
      durablePreparation: {
        journal: journals[index]!,
        preparations: new PostgresWorkspacePreparations(pool),
        reclaimer: new PostgresObjectReclaimer(pool, objects),
      },
    })) as [WorkspaceSnapshotPublisher, WorkspaceSnapshotPublisher]

  const ownerArchive = archive()
  const ownerSandbox = await provider.create('owner-template', {
    managedBy: 'cudex', tenantId, leaseId: 'owner-lease', agentId: 'owner-agent',
  })
  await provider.uploadArchive(ownerSandbox.sandboxId, ownerArchive)
  provider.sandboxes.get(ownerSandbox.sandboxId)!.runtimeIdentity = 'owner-session-secret'
  const ownerProviderSnapshot = await provider.snapshot(ownerSandbox.sandboxId)
  const ownerSnapshotId = 'owner-latest-snapshot'
  await publishers[0].createBase({
    leaseId: 'owner-lease', environmentId: 'owner-environment', tenantId,
    agentId: 'owner-agent', ownerAgentId: null, ownerLeaseId: null,
    sourceSnapshotId: null, providerSandboxId: ownerSandbox.sandboxId,
    sandboxTemplate: 'owner-v1', cwdUri: 'file:///workspace/roots/0/project',
    workspaceRootUris: ['file:///workspace/roots/0/project'],
    toolPolicy: { allowedDomains: ['owner'], allowedTools: [] }, policyVersion: 3,
    snapshot: {
      snapshotId: ownerSnapshotId,
      providerSnapshotId: ownerProviderSnapshot,
      archive: ownerArchive,
    },
  })
  const coordinators = journals.map((journal, index) => new PostgresChildCoordinator(
    journal, states[index]!, publishers[index]!, provider,
    new PostgresTicketIssuer(states[index]!, tenantId, 'wss://gateway.example'),
    {
      principal: { tenantId }, managedBy: 'cudex', workerId: `child-worker-${index}`,
      roles: { child: role }, waitTimeoutMs: 5_000, heartbeatIntervalMs: 20,
    },
  )) as [PostgresChildCoordinator, PostgresChildCoordinator]
  const request: ProvisionRequest = {
    agentId: 'child-agent', ownerAgentId: 'owner-agent', agentType: 'child',
    sandboxTemplate: role.sandboxTemplate,
    source: { type: 'agentEnvironment', ownerLeaseId: 'owner-lease' },
    idempotencyKey: 'durable-child',
  }
  return {
    admin, pools, journals, states, provider, objects, coordinators, request,
    ownerLeaseId: 'owner-lease', ownerSandboxId: ownerSandbox.sandboxId,
    ownerSnapshotId, ownerArchive, schema,
  }
}

async function close(context: Fixture): Promise<void> {
  await Promise.all(context.pools.map(pool => pool.end()))
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

test('durable child captures once, uses a clean template, and replays across replicas', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const [first, replay] = await Promise.all([
      context.coordinators[0].provision(context.request),
      context.coordinators[1].provision(context.request),
    ])
    assert.equal(first.leaseId, replay.leaseId)
    assert.equal(first.environmentId, replay.environmentId)
    assert.equal(first.baseSnapshotId, replay.baseSnapshotId)
    assert.deepEqual(first.toolPolicy, role.toolPolicy)
    assert.notEqual(first.connection.execServerUrl, replay.connection.execServerUrl)
    assert.equal(context.provider.restores, 1)
    assert.equal(context.provider.creates, 2)
    assert.equal(context.provider.live().length, 2)
    assert.equal(context.provider.snapshots.size, 2)

    const identity = { operation: 'provision', idempotencyKey: context.request.idempotencyKey, tenantId }
    const leaseId = deterministicChildId('lease', identity)
    const lease = await context.states[0].getLease(tenantId, leaseId)
    assert.ok(lease)
    assert.equal(lease.agentId, context.request.agentId)
    assert.equal(lease.ownerAgentId, context.request.ownerAgentId)
    assert.equal(lease.ownerLeaseId, context.ownerLeaseId)
    assert.equal(lease.sandboxTemplate, role.sandboxTemplate)
    const childSandbox = context.provider.sandboxes.get(lease.providerSandboxId!)!
    assert.equal(childSandbox.templateId, role.providerTemplateId)
    assert.equal(childSandbox.runtimeIdentity, undefined)
    assert.deepEqual(Buffer.from(childSandbox.bytes), context.ownerArchive)
    assert.deepEqual(await context.provider.listSnapshots({
      name: childProviderSnapshotName('capture', identity),
    }), [])
    assert.equal((await context.provider.listSnapshots({
      name: childProviderSnapshotName('result', identity),
    })).length, 1)

    const graph = await context.pools[0].query(`
      SELECT operation.primary_lease_id, operation.result_lease_id, operation.state,
             preparation.state AS preparation_state,
             preparation.intent ->> 'expectedLatestSnapshotId' AS expected_owner_snapshot,
             count(*) FILTER (WHERE allocation.state = 'reclaimed'
               AND allocation.allocation_kind IN ('capture_sandbox', 'provider_snapshot'))::text AS reclaimed_temporary,
             count(*) FILTER (WHERE allocation.state = 'adopted')::text AS adopted
      FROM hosted_agent_operations AS operation
      JOIN hosted_agent_workspace_preparations AS preparation
        USING (operation, idempotency_key, tenant_id)
      JOIN hosted_agent_operation_allocations AS allocation
        USING (operation, idempotency_key, tenant_id)
      WHERE operation.operation = 'provision' AND operation.idempotency_key = $1
      GROUP BY operation.primary_lease_id, operation.result_lease_id, operation.state,
               preparation.state, preparation.intent
    `, [context.request.idempotencyKey])
    assert.deepEqual(graph.rows[0], {
      primary_lease_id: context.ownerLeaseId,
      result_lease_id: leaseId,
      state: 'succeeded',
      preparation_state: 'committed',
      expected_owner_snapshot: context.ownerSnapshotId,
      reclaimed_temporary: '2',
      adopted: '5',
    })
  } finally { await close(context) }
})

test('durable child rejects a mismatched owner before capture or clean allocation', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const beforeCreates = context.provider.creates
    const beforeSnapshots = context.provider.snapshots.size
    await assert.rejects(context.coordinators[0].provision({
      ...context.request, ownerAgentId: 'wrong-owner', idempotencyKey: 'wrong-owner-child',
    }), (error: unknown) => error instanceof ServiceError && error.status === 404)
    assert.equal(context.provider.creates, beforeCreates)
    assert.equal(context.provider.restores, 0)
    assert.equal(context.provider.snapshots.size, beforeSnapshots)
    assert.deepEqual(context.provider.live(), [context.ownerSandboxId])
    await assert.rejects(context.states[0].createChildLeaseWithBaseSnapshot({
      leaseId: 'invalid-mixed-child', environmentId: 'invalid-mixed-environment', tenantId,
      agentId: 'child-agent', ownerAgentId: 'owner-agent', ownerLeaseId: context.ownerLeaseId,
      expectedOwnerLatestSnapshotId: context.ownerSnapshotId,
      expectedOwnerProviderSandboxId: context.ownerSandboxId,
      expectedOwnerConnectionGeneration: 0, sourceSnapshotId: 'mixed-source',
      providerSandboxId: 'invalid-child-sandbox', sandboxTemplate: role.sandboxTemplate,
      cwdUri: 'file:///workspace/roots/0/project',
      workspaceRootUris: ['file:///workspace/roots/0/project'],
      toolPolicy: role.toolPolicy, policyVersion: role.policyVersion,
      baseSnapshot: {
        snapshotId: 'invalid-child-snapshot', providerSnapshotId: null,
        workspaceArchiveObjectId: 'invalid-child-archive',
        manifestObjectId: 'invalid-child-manifest',
        manifestChecksum: `sha256:${'a'.repeat(64)}`,
      },
    }), /child lease cannot have another source lineage/)
  } finally { await close(context) }
})

test('durable child failure after clean allocation reclaims every temporary and result resource', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    context.provider.failAt = 'start'
    await assert.rejects(context.coordinators[0].provision(context.request),
      (error: unknown) => error instanceof ServiceError && error.status === 503)
    assert.deepEqual(context.provider.live(), [context.ownerSandboxId])
    assert.equal(context.provider.snapshots.size, 1)
    const graph = await context.pools[0].query(`
      SELECT operation.state,
             count(*) FILTER (WHERE allocation.state = 'reclaimed')::text AS reclaimed,
             count(*)::text AS allocations
      FROM hosted_agent_operations AS operation
      JOIN hosted_agent_operation_allocations AS allocation
        USING (operation, idempotency_key, tenant_id)
      WHERE operation.operation = 'provision' AND operation.idempotency_key = $1
      GROUP BY operation.state
    `, [context.request.idempotencyKey])
    assert.deepEqual(graph.rows[0], {
      state: 'failed_terminal', reclaimed: '3', allocations: '3',
    })
  } finally { await close(context) }
})

test('temporary cleanup outage remains durably in progress for reconciliation', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    context.provider.failAt = 'deleteSnapshot'
    await assert.rejects(context.coordinators[0].provision(context.request),
      (error: unknown) => error instanceof ServiceError
        && error.message === 'durable child cleanup pending')
    assert.deepEqual(context.provider.live(), [context.ownerSandboxId])
    assert.equal(context.provider.snapshots.size, 2)
    const graph = await context.pools[0].query(`
      SELECT operation.state,
             count(*) FILTER (WHERE allocation.state = 'allocated')::text AS allocated,
             count(*) FILTER (WHERE allocation.state = 'reclaimed')::text AS reclaimed
      FROM hosted_agent_operations AS operation
      JOIN hosted_agent_operation_allocations AS allocation
        USING (operation, idempotency_key, tenant_id)
      WHERE operation.operation = 'provision' AND operation.idempotency_key = $1
      GROUP BY operation.state
    `, [context.request.idempotencyKey])
    assert.deepEqual(graph.rows[0], {
      state: 'in_progress', allocated: '1', reclaimed: '1',
    })
  } finally { await close(context) }
})

test('owner session lock excludes another lifecycle mutation throughout capture', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const provider = new GatedCaptureProvider()
  const context = await fixture(provider)
  try {
    const child = context.coordinators[0].provision(context.request)
    await provider.entered
    let competingEntered = false
    const competing = context.journals[1].withLeaseLocks(
      tenantId, [context.ownerLeaseId], async () => { competingEntered = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(competingEntered, false)
    provider.release()
    await child
    await competing
    assert.equal(competingEntered, true)
  } finally { await close(context) }
})
