import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { Header } from 'tar'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import { PostgresObjectReclaimer } from '../src/postgres-object-reclaimer.js'
import { PostgresCheckpointCoordinator } from '../src/postgres-checkpoint.js'
import { PostgresProvisionCoordinator } from '../src/postgres-provision.js'
import { PostgresReconciler } from '../src/postgres-reconciler.js'
import { PostgresReleaseCoordinator } from '../src/postgres-release.js'
import { PostgresDurableState } from '../src/postgres-state.js'
import {
  canonicalRequestHash,
  PostgresJournal,
  type OperationClaim,
  type OperationClaimInput,
} from '../src/postgres-store.js'
import { PostgresTicketIssuer } from '../src/postgres-tickets.js'
import { PostgresWorkspacePreparations } from '../src/postgres-workspace-preparations.js'
import { SourceSnapshotLifecycle } from '../src/source-snapshots.js'
import type { TicketAuthority } from '../src/tickets.js'
import type { ProvisionRequest } from '../src/types.js'
import type { TicketPurpose } from '../src/types.js'
import { ServiceError } from '../src/types.js'
import { WorkspaceSnapshotPublisher } from '../src/workspace-snapshots.js'
import { FakeProvider } from './fake-provider.js'
import { ProviderSandboxMissingError } from '../src/provider.js'
import {
  PostgresLeaseInteractionGate,
  type LeaseInteractionIdentity,
} from '../src/postgres-lease-interactions.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const tenantId = 'tenant-provision'
const principal = { tenantId }

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return { promise: new Promise(done => { resolve = done }), resolve }
}

function archive(): Buffer {
  const entries = [
    { path: 'roots/', type: 'Directory' as const, body: Buffer.alloc(0) },
    { path: 'roots/0/', type: 'Directory' as const, body: Buffer.alloc(0) },
    { path: 'roots/0/project/', type: 'Directory' as const, body: Buffer.alloc(0) },
    { path: 'roots/0/project/file.bin', type: 'File' as const, body: Buffer.from([0, 255, 1, 2]) },
  ]
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    new Header({ path: entry.path, type: entry.type, mode: entry.type === 'Directory' ? 0o755 : 0o644,
      size: entry.body.byteLength }).encode(header)
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
    const id = digest(bytes); this.values.set(id, Uint8Array.from(bytes)); return id
  }
  async get(id: string): Promise<Uint8Array> {
    const value = this.values.get(id); if (!value) throw new Error('missing object')
    return Uint8Array.from(value)
  }
  async delete(id: string): Promise<void> { this.deletes++; this.values.delete(id) }
  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'provision-test', storageKey: `v1/sha256/${id.slice(0, 2)}/${id}` }
  }
}

class GatedProvider extends FakeProvider {
  private readonly entered = deferred()
  private readonly released = deferred()
  readonly uploadEntered = this.entered.promise
  releaseUpload(): void { this.released.resolve() }
  override async uploadArchive(sandboxId: string, bytes: Uint8Array): Promise<void> {
    this.entered.resolve(); await this.released.promise; return super.uploadArchive(sandboxId, bytes)
  }
}

class CheckpointGatedProvider extends FakeProvider {
  private readonly gates: Array<{ entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }> = []
  gateNextExport(): { entered: Promise<void>; release(): void } {
    const gate = { entered: deferred(), released: deferred() }; this.gates.push(gate)
    return { entered: gate.entered.promise, release: () => { gate.released.resolve() } }
  }
  override async exportWorkspace(sandboxId: string): Promise<Uint8Array> {
    const gate = this.gates.shift()
    if (gate) { gate.entered.resolve(); await gate.released.promise }
    return super.exportWorkspace(sandboxId)
  }
}

class ReleaseProvider extends CheckpointGatedProvider {
  private readonly killGates: Array<{ entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }> = []
  gateNextKill(): { entered: Promise<void>; release(): void } {
    const gate = { entered: deferred(), released: deferred() }; this.killGates.push(gate)
    return { entered: gate.entered.promise, release: () => { gate.released.resolve() } }
  }
  override async kill(sandboxId: string): Promise<void> {
    const gate = this.killGates.shift()
    if (gate) { gate.entered.resolve(); await gate.released.promise }
    if (!this.sandboxes.get(sandboxId)?.alive) throw new ProviderSandboxMissingError()
    return super.kill(sandboxId)
  }
}

class ReleaseRevoker {
  readonly leases: string[] = []
  revoke(leaseId: string): void { this.leases.push(leaseId) }
}

class ObservedJournal extends PostgresJournal {
  private readonly observed = deferred()
  private readonly lockObserved = deferred()
  private failRecoveryClaim = false
  readonly inProgressObserved = this.observed.promise
  readonly leaseLockObserved = this.lockObserved.promise
  throwAfterLeaseCommit = false
  throwAfterLeaseCommitAt: number | undefined
  throwAfterCompoundProviderCommit = false
  failClaimAfterAmbiguousCommit = false
  override async claimOperation(input: OperationClaimInput): Promise<OperationClaim> {
    if (this.failRecoveryClaim) { this.failRecoveryClaim = false; throw new Error('injected recovery read outage') }
    const claim = await super.claimOperation(input)
    if (claim.kind === 'in_progress') this.observed.resolve()
    return claim
  }
  override async withLeaseLocks<T>(tenant: string, leaseIds: string[],
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    this.lockObserved.resolve()
    const result = await super.withLeaseLocks(tenant, leaseIds, fn)
    if (this.throwAfterLeaseCommitAt !== undefined) {
      this.throwAfterLeaseCommitAt--
      if (this.throwAfterLeaseCommitAt === 0) {
        this.throwAfterLeaseCommitAt = undefined
        this.failRecoveryClaim = this.failClaimAfterAmbiguousCommit
        throw new Error('injected ambiguous commit acknowledgement')
      }
    }
    if (this.throwAfterLeaseCommit) {
      this.throwAfterLeaseCommit = false
      this.failRecoveryClaim = this.failClaimAfterAmbiguousCommit
      throw new Error('injected ambiguous commit acknowledgement')
    }
    return result
  }
  override async withProviderResourceLocks<T>(
    resources: Array<{ kind: 'sandbox' | 'provider_snapshot'; resourceId: string }>,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const result = await super.withProviderResourceLocks(resources, fn)
    if (this.throwAfterCompoundProviderCommit && resources.length > 1) {
      this.throwAfterCompoundProviderCommit = false
      throw new Error('injected ambiguous commit acknowledgement')
    }
    return result
  }
}

class FailOnceTickets implements TicketAuthority {
  private failed = false
  constructor(private readonly delegate: TicketAuthority) {}
  async issue(leaseId: string, purpose?: TicketPurpose): Promise<string> {
    if (!this.failed) { this.failed = true; throw new Error('injected ticket outage') }
    return this.delegate.issue(leaseId, purpose)
  }
  async validate(leaseId: string, ticket: string, purpose?: TicketPurpose) {
    return this.delegate.validate(leaseId, ticket, purpose)
  }
  async revokeLease(leaseId: string): Promise<void> { return this.delegate.revokeLease(leaseId) }
}

interface Fixture {
  admin: Pool
  pools: [Pool, Pool]
  journals: [ObservedJournal, ObservedJournal]
  states: [PostgresDurableState, PostgresDurableState]
  provider: FakeProvider
  objects: TrackingObjects
  lifecycle: SourceSnapshotLifecycle
  coordinators: [PostgresProvisionCoordinator, PostgresProvisionCoordinator]
  checkpointCoordinators: [PostgresCheckpointCoordinator, PostgresCheckpointCoordinator]
  releaseCoordinators: [PostgresReleaseCoordinator, PostgresReleaseCoordinator]
  releaseRevokers: [ReleaseRevoker, ReleaseRevoker]
  interactionGates: [PostgresLeaseInteractionGate, PostgresLeaseInteractionGate]
  request: ProvisionRequest
  schema: string
}

async function fixture(provider: FakeProvider = new FakeProvider(), failFirstTicket = false,
  cleanupBatchSize?: number): Promise<Fixture> {
  const schema = `hosted_agent_provision_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`)
  const pools = [0, 1].map(() => new Pool({ connectionString: databaseUrl,
    options: `-c search_path=${schema}`, max: 6 })) as [Pool, Pool]
  await runMigrations(pools[0])
  const states = pools.map(pool => new PostgresDurableState(pool)) as [PostgresDurableState, PostgresDurableState]
  const journals: [ObservedJournal, ObservedJournal] = [new ObservedJournal(pools[0]), new ObservedJournal(pools[1])]
  const interactionGates = journals.map((journal, index) =>
    new PostgresLeaseInteractionGate(journal, states[index]!)) as
    [PostgresLeaseInteractionGate, PostgresLeaseInteractionGate]
  const objects = new TrackingObjects()
  const sourceReclaimer = new PostgresObjectReclaimer(pools[0], objects)
  const lifecycle = new SourceSnapshotLifecycle(states[0], objects, { reclaimer: sourceReclaimer })
  const sourceArchive = archive(); const checksum = `sha256:${digest(sourceArchive)}`
  const source = await lifecycle.create(principal, {
    archive: sourceArchive, checksum,
    cwdUri: 'file:///workspace/roots/0/project',
    workspaceRootUris: ['file:///workspace/roots/0/project'],
    expiresAt: new Date(Date.now() + 60 * 60_000),
  })
  const role = {
    sandboxTemplate: 'general-v1', providerTemplateId: 'provider-template-v1',
    toolPolicy: { allowedDomains: ['agentEnvironment'], allowedTools: [] }, policyVersion: 1,
  }
  const publishers = journals.map((journal, index) => {
    const reclaimer = new PostgresObjectReclaimer(pools[index]!, objects)
    return new WorkspaceSnapshotPublisher(states[index]!, objects, {
      reclaimer: { async reclaimUnreferencedWorkspaceObject() { assert.fail('durable publication must not use legacy cleanup') } },
      durablePreparation: {
        journal,
        preparations: new PostgresWorkspacePreparations(pools[index]!),
        reclaimer,
        ...(cleanupBatchSize === undefined ? {} : { cleanupBatchSize }),
      },
    })
  }) as [WorkspaceSnapshotPublisher, WorkspaceSnapshotPublisher]
  const coordinators = journals.map((journal, index) => {
    const issuer = new PostgresTicketIssuer(states[index]!, tenantId, 'wss://gateway.example')
    const tickets = index === 0 && failFirstTicket ? new FailOnceTickets(issuer) : issuer
    return new PostgresProvisionCoordinator(journal, states[index]!, publishers[index]!, provider, tickets, {
        principal, managedBy: 'cudex', workerId: `provision-worker-${index}`,
        roles: { default: role }, sourceResolver: lifecycle, heartbeatIntervalMs: 10,
      })
  }) as [PostgresProvisionCoordinator, PostgresProvisionCoordinator]
  const checkpointCoordinators = journals.map((journal, index) =>
    new PostgresCheckpointCoordinator(journal, states[index]!, publishers[index]!, provider, {
      tenantId, workerId: `checkpoint-worker-${index}`,
      interactionGate: interactionGates[index]!,
    })) as [PostgresCheckpointCoordinator, PostgresCheckpointCoordinator]
  const releaseRevokers: [ReleaseRevoker, ReleaseRevoker] = [new ReleaseRevoker(), new ReleaseRevoker()]
  const releaseCoordinators = journals.map((journal, index) =>
    new PostgresReleaseCoordinator(journal, states[index]!, provider, {
      tenantId, workerId: `release-worker-${index}`, connections: releaseRevokers[index]!,
    })) as [PostgresReleaseCoordinator, PostgresReleaseCoordinator]
  const request: ProvisionRequest = {
    agentId: 'agent-root', ownerAgentId: null, agentType: 'default', sandboxTemplate: 'general-v1',
    source: { type: 'sourceSnapshot', sourceSnapshotId: source.sourceSnapshotId, checksum: source.checksum },
    idempotencyKey: 'durable-provision',
  }
  return { admin, pools, journals, states, provider, objects, lifecycle, coordinators,
    checkpointCoordinators, releaseCoordinators, releaseRevokers, interactionGates,
    request, schema }
}

async function close(context: Fixture): Promise<void> {
  await Promise.all(context.pools.map(pool => pool.end()))
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

test('durable provision serializes two replicas and replays one adopted allocation graph', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const provider = new GatedProvider(); const context = await fixture(provider)
  try {
    const first = context.coordinators[0].provision(context.request)
    await provider.uploadEntered
    const second = context.coordinators[1].provision(context.request)
    await context.journals[1].inProgressObserved
    assert.equal(provider.creates, 1)
    const blocked = await context.pools[0].query<{ operations: string; sandboxes: string }>(`
      SELECT
        (SELECT count(*)::text FROM hosted_agent_operations WHERE state = 'in_progress') AS operations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE allocation_kind = 'sandbox' AND state = 'allocated') AS sandboxes
    `)
    assert.deepEqual(blocked.rows[0], { operations: '1', sandboxes: '1' })
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.deepEqual(await context.journals[1].claimStaleOperations(
      new Date(Date.now() - 20), 10, 'premature-provision-reconciler',
      tenantId, 'provision', 'none'), [])
    provider.releaseUpload()
    const [left, right] = await Promise.all([first, second])
    assert.deepEqual({ ...left, connection: undefined }, { ...right, connection: undefined })
    assert.notEqual(left.connection.execServerUrl, right.connection.execServerUrl)
    const puts = context.objects.puts
    const replay = await context.coordinators[1].provision(context.request)
    assert.equal(replay.leaseId, left.leaseId)
    assert.equal(context.objects.puts, puts)
    assert.equal(provider.creates, 1)
    assert.equal(provider.snapshots.size, 1)
    assert.equal(provider.live().length, 1)

    const durable = await context.pools[0].query<{
      operation_state: string; request_hash: string; logical_response: Record<string, unknown>
      leases: string; snapshots: string; preparations: string; allocations: string; adopted: string
    }>(`
      SELECT operation.state AS operation_state, operation.request_hash, operation.logical_response,
        (SELECT count(*)::text FROM hosted_agent_leases WHERE state = 'active') AS leases,
        (SELECT count(*)::text FROM hosted_agent_snapshots WHERE state = 'available') AS snapshots,
        (SELECT count(*)::text FROM hosted_agent_workspace_preparations WHERE state = 'committed') AS preparations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations) AS allocations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE state = 'adopted' AND lease_id = operation.primary_lease_id) AS adopted
      FROM hosted_agent_operations AS operation
      WHERE operation.operation = 'provision' AND operation.idempotency_key = $1
    `, [context.request.idempotencyKey])
    const row = durable.rows[0]!
    assert.equal(row.operation_state, 'succeeded')
    assert.equal(row.request_hash, canonicalRequestHash(context.request))
    assert.deepEqual({ leases: row.leases, snapshots: row.snapshots, preparations: row.preparations,
      allocations: row.allocations, adopted: row.adopted }, {
      leases: '1', snapshots: '1', preparations: '1', allocations: '5', adopted: '5',
    })
    const encoded = JSON.stringify(row.logical_response)
    assert.equal(Object.hasOwn(durable.rows[0]?.logical_response ?? {}, 'connection'), false)
    assert.equal(/ticket|token|credential|api.?key/iu.test(encoded), false)
  } finally { await close(context) }
})

test('partial durable publication reclaims provider and object allocations before terminal replay', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const baselinePuts = context.objects.puts; const baselineObjects = context.objects.values.size
    context.objects.failAt = baselinePuts + 2
    await assert.rejects(context.coordinators[0].provision(context.request),
      (error: unknown) => error instanceof ServiceError && error.status === 503 && error.message === 'durable provision failed')
    assert.deepEqual(context.provider.live(), [])
    assert.equal(context.provider.snapshots.size, 0)
    assert.equal(context.provider.kills, 1)
    assert.equal(context.provider.snapshotDeletes, 1)
    assert.equal(context.objects.values.size, baselineObjects)
    const mutations = { creates: context.provider.creates, puts: context.objects.puts,
      kills: context.provider.kills, snapshotDeletes: context.provider.snapshotDeletes }

    const durable = await context.pools[0].query<{
      operation_state: string; primary_lease_id: string | null; leases: string; snapshots: string
      preparation_state: string; associations: string; allocations: string; reclaimed: string
    }>(`
      SELECT operation.state AS operation_state, operation.primary_lease_id,
        (SELECT count(*)::text FROM hosted_agent_leases) AS leases,
        (SELECT count(*)::text FROM hosted_agent_snapshots) AS snapshots,
        (SELECT state FROM hosted_agent_workspace_preparations
          WHERE operation = 'provision' AND idempotency_key = operation.idempotency_key) AS preparation_state,
        (SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects
          WHERE operation = 'provision' AND idempotency_key = operation.idempotency_key) AS associations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'provision' AND idempotency_key = operation.idempotency_key) AS allocations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'provision' AND idempotency_key = operation.idempotency_key AND state = 'reclaimed') AS reclaimed
      FROM hosted_agent_operations AS operation
      WHERE operation.operation = 'provision' AND operation.idempotency_key = $1
    `, [context.request.idempotencyKey])
    assert.deepEqual(durable.rows[0], {
      operation_state: 'failed_terminal', primary_lease_id: null, leases: '0', snapshots: '0',
      preparation_state: 'reclaimed', associations: '1', allocations: '3', reclaimed: '3',
    })
    await assert.rejects(context.coordinators[1].provision(context.request),
      (error: unknown) => error instanceof ServiceError && error.status === 503 && error.message === 'durable provision failed')
    assert.deepEqual({ creates: context.provider.creates, puts: context.objects.puts,
      kills: context.provider.kills, snapshotDeletes: context.provider.snapshotDeletes }, mutations)
  } finally { await close(context) }
})

test('ticket failure after durable completion preserves the adopted lease for fresh replay', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture(new FakeProvider(), true)
  try {
    context.journals[0].throwAfterCompoundProviderCommit = true
    await assert.rejects(context.coordinators[0].provision(context.request), /injected ticket outage/)
    assert.equal(context.provider.creates, 1)
    assert.equal(context.provider.live().length, 1)
    assert.equal(context.provider.snapshots.size, 1)
    const durable = await context.pools[0].query<{ state: string; lease_state: string; allocated: string; adopted: string }>(`
      SELECT operation.state,
        (SELECT state FROM hosted_agent_leases WHERE lease_id = operation.primary_lease_id) AS lease_state,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'provision' AND idempotency_key = operation.idempotency_key) AS allocated,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'provision' AND idempotency_key = operation.idempotency_key AND state = 'adopted') AS adopted
      FROM hosted_agent_operations AS operation
      WHERE operation.operation = 'provision' AND operation.idempotency_key = $1
    `, [context.request.idempotencyKey])
    assert.deepEqual(durable.rows[0], { state: 'succeeded', lease_state: 'active', allocated: '5', adopted: '5' })
    const replay = await context.coordinators[1].provision(context.request)
    assert.match(replay.connection.execServerUrl, /^wss:\/\/gateway\.example\/leases\//u)
    assert.equal(context.provider.creates, 1)
    assert.equal(context.provider.kills, 0)
    assert.equal(context.provider.snapshotDeletes, 0)
  } finally { await close(context) }
})

test('durable checkpoints serialize per lease across replicas and replay without mutation', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const provider = new CheckpointGatedProvider(); const context = await fixture(provider)
  try {
    const lease = await context.coordinators[0].provision(context.request)
    const baselineExports = provider.exports
    const firstGate = provider.gateNextExport(); const secondGate = provider.gateNextExport()
    const firstRequest = { leaseId: lease.leaseId, idempotencyKey: 'checkpoint-a' }
    const secondRequest = { leaseId: lease.leaseId, idempotencyKey: 'checkpoint-b' }
    const first = context.checkpointCoordinators[0].checkpoint(firstRequest)
    await firstGate.entered
    const duplicate = context.checkpointCoordinators[1].checkpoint(firstRequest)
    await context.journals[1].inProgressObserved
    const second = context.checkpointCoordinators[1].checkpoint(secondRequest)
    await context.journals[1].leaseLockObserved
    assert.equal(provider.exports, baselineExports)
    firstGate.release()
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
    assert.deepEqual(duplicateResult, firstResult)
    await secondGate.entered
    assert.equal(provider.exports, baselineExports + 1)
    secondGate.release()
    const secondResult = await second
    assert.notEqual(secondResult.snapshotId, firstResult.snapshotId)
    const mutations = { exports: provider.exports, snapshots: provider.snapshots.size, puts: context.objects.puts }
    assert.deepEqual(await context.checkpointCoordinators[1].checkpoint(firstRequest), firstResult)
    assert.deepEqual({ exports: provider.exports, snapshots: provider.snapshots.size, puts: context.objects.puts }, mutations)

    const durableLease = await context.states[0].getLease(tenantId, lease.leaseId)
    assert.equal(durableLease?.baseSnapshotId, lease.baseSnapshotId)
    assert.equal(durableLease?.latestSnapshotId, secondResult.snapshotId)
    const graph = await context.pools[0].query<{
      operations: string; snapshots: string; preparations: string; allocations: string; adopted: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM hosted_agent_operations
          WHERE operation = 'checkpoint' AND state = 'succeeded') AS operations,
        (SELECT count(*)::text FROM hosted_agent_snapshots WHERE lease_id = $1 AND state = 'available') AS snapshots,
        (SELECT count(*)::text FROM hosted_agent_workspace_preparations
          WHERE operation = 'checkpoint' AND state = 'committed') AS preparations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'checkpoint') AS allocations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'checkpoint' AND state = 'adopted' AND lease_id = $1) AS adopted
    `, [lease.leaseId])
    assert.deepEqual(graph.rows[0], {
      operations: '2', snapshots: '3', preparations: '2', allocations: '8', adopted: '8',
    })
    const operations = await context.pools[0].query<{
      idempotency_key: string; request_hash: string; logical_response: { snapshotId: string }
    }>(`SELECT idempotency_key, request_hash, logical_response FROM hosted_agent_operations
      WHERE operation = 'checkpoint' ORDER BY idempotency_key`)
    assert.deepEqual(operations.rows, [
      { idempotency_key: firstRequest.idempotencyKey, request_hash: canonicalRequestHash(firstRequest),
        logical_response: firstResult },
      { idempotency_key: secondRequest.idempotencyKey, request_hash: canonicalRequestHash(secondRequest),
        logical_response: secondResult },
    ])
  } finally { await close(context) }
})

test('durable checkpoint refuses to capture an unfinished command interaction', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const lease = await context.coordinators[0].provision(context.request)
    const interaction: LeaseInteractionIdentity = {
      tenantId, leaseId: lease.leaseId, interactionId: 'checkpoint-command',
      connectionGeneration: 0, sessionId: 'session-command',
      kind: 'process', processId: 'process-command',
    }
    await context.interactionGates[0].begin(interaction)
    const before = {
      exports: context.provider.exports,
      snapshots: context.provider.snapshots.size,
      puts: context.objects.puts,
    }
    await assert.rejects(context.checkpointCoordinators[1].checkpoint({
      leaseId: lease.leaseId, idempotencyKey: 'checkpoint-active-command',
    }), (error: unknown) => error instanceof ServiceError && error.status === 503)
    assert.deepEqual({
      exports: context.provider.exports,
      snapshots: context.provider.snapshots.size,
      puts: context.objects.puts,
    }, before)
    await context.interactionGates[1].finish(interaction)
    const completed = await context.checkpointCoordinators[1].checkpoint({
      leaseId: lease.leaseId, idempotencyKey: 'checkpoint-after-command',
    })
    assert.notEqual(completed.snapshotId, lease.baseSnapshotId)
  } finally { await close(context) }
})

test('partial checkpoint publication preserves the lease while reclaiming snapshot and objects', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture(new FakeProvider(), false, 1)
  try {
    const lease = await context.coordinators[0].provision(context.request)
    const before = await context.states[0].getLease(tenantId, lease.leaseId)
    const baseline = { puts: context.objects.puts, values: context.objects.values.size,
      providerSnapshots: context.provider.snapshots.size, exports: context.provider.exports }
    context.objects.failAt = baseline.puts + 3
    const request = { leaseId: lease.leaseId, idempotencyKey: 'checkpoint-partial' }
    await assert.rejects(context.checkpointCoordinators[0].checkpoint(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503 && error.message === 'durable checkpoint failed')
    assert.equal(context.provider.live().length, 1)
    assert.equal(context.provider.kills, 0)
    assert.equal(context.provider.snapshots.size, baseline.providerSnapshots)
    assert.equal(context.provider.snapshotDeletes, 1)
    assert.equal(context.objects.values.size, baseline.values)
    const after = await context.states[0].getLease(tenantId, lease.leaseId)
    assert.equal(after?.state, 'active')
    assert.equal(after?.baseSnapshotId, before?.baseSnapshotId)
    assert.equal(after?.latestSnapshotId, before?.latestSnapshotId)

    const graph = await context.pools[0].query<{
      operation_state: string; primary_lease_id: string | null; snapshots: string
      preparation_state: string; associations: string; allocations: string; reclaimed: string
    }>(`
      SELECT operation.state AS operation_state, operation.primary_lease_id,
        (SELECT count(*)::text FROM hosted_agent_snapshots WHERE lease_id = $1) AS snapshots,
        (SELECT state FROM hosted_agent_workspace_preparations
          WHERE operation = 'checkpoint' AND idempotency_key = operation.idempotency_key) AS preparation_state,
        (SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects
          WHERE operation = 'checkpoint' AND idempotency_key = operation.idempotency_key) AS associations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'checkpoint' AND idempotency_key = operation.idempotency_key) AS allocations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'checkpoint' AND idempotency_key = operation.idempotency_key AND state = 'reclaimed') AS reclaimed
      FROM hosted_agent_operations AS operation
      WHERE operation.operation = 'checkpoint' AND operation.idempotency_key = $2
    `, [lease.leaseId, request.idempotencyKey])
    assert.deepEqual(graph.rows[0], {
      operation_state: 'failed_terminal', primary_lease_id: null, snapshots: '1',
      preparation_state: 'reclaimed', associations: '2', allocations: '3', reclaimed: '3',
    })
    const mutations = { creates: context.provider.creates, exports: context.provider.exports,
      snapshots: context.provider.snapshots.size, puts: context.objects.puts, deletes: context.provider.snapshotDeletes }
    await assert.rejects(context.checkpointCoordinators[1].checkpoint(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503 && error.message === 'durable checkpoint failed')
    assert.deepEqual({ creates: context.provider.creates, exports: context.provider.exports,
      snapshots: context.provider.snapshots.size, puts: context.objects.puts, deletes: context.provider.snapshotDeletes }, mutations)
  } finally { await close(context) }
})

test('ambiguous checkpoint commit never deletes adopted resources when recovery reads fail', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const lease = await context.coordinators[0].provision(context.request)
    const request = { leaseId: lease.leaseId, idempotencyKey: 'checkpoint-ambiguous' }
    context.journals[0].throwAfterLeaseCommit = true
    context.journals[0].failClaimAfterAmbiguousCommit = true
    await assert.rejects(context.checkpointCoordinators[0].checkpoint(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503
        && error.message === 'durable checkpoint cleanup pending')

    const durableLease = await context.states[0].getLease(tenantId, lease.leaseId)
    assert.notEqual(durableLease?.latestSnapshotId, lease.baseSnapshotId)
    assert.equal(context.provider.snapshotDeletes, 0)
    assert.equal(context.provider.live().length, 1)
    const mutations = { snapshots: context.provider.snapshots.size, puts: context.objects.puts,
      deletes: context.provider.snapshotDeletes }
    assert.deepEqual(await context.checkpointCoordinators[1].checkpoint(request),
      { snapshotId: durableLease?.latestSnapshotId })
    assert.deepEqual({ snapshots: context.provider.snapshots.size, puts: context.objects.puts,
      deletes: context.provider.snapshotDeletes }, mutations)
  } finally { await close(context) }
})

test('durable release serializes after checkpoint, revokes access, and retains durable data', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const provider = new ReleaseProvider(); const context = await fixture(provider)
  try {
    const lease = await context.coordinators[0].provision(context.request)
    const checkpointGate = provider.gateNextExport(); const killGate = provider.gateNextKill()
    const checkpoint = context.checkpointCoordinators[0].checkpoint({
      leaseId: lease.leaseId, idempotencyKey: 'checkpoint-before-release',
    })
    await checkpointGate.entered
    const releaseRequest = { leaseId: lease.leaseId, idempotencyKey: 'release-a' }
    const release = context.releaseCoordinators[1].release(releaseRequest)
    assert.equal(provider.kills, 0)
    checkpointGate.release()
    const checkpointResult = await checkpoint
    await killGate.entered
    const duplicate = context.releaseCoordinators[0].release(releaseRequest)
    const other = context.releaseCoordinators[0].release({
      leaseId: lease.leaseId, idempotencyKey: 'release-b',
    })
    assert.equal(provider.kills, 0)
    killGate.release()
    await Promise.all([release, duplicate, other])

    const durableLease = await context.states[0].getLease(tenantId, lease.leaseId)
    assert.equal(durableLease?.state, 'released')
    assert.equal(durableLease?.baseSnapshotId, lease.baseSnapshotId)
    assert.equal(durableLease?.latestSnapshotId, checkpointResult.snapshotId)
    assert.equal(provider.kills, 1)
    assert.equal(provider.snapshotDeletes, 0)
    assert.equal(provider.snapshots.size, 2)
    const graph = await context.pools[0].query<{
      snapshots: string; snapshot_refs: string; object_refs: string; live_tickets: string
      operations: string; allocations: string; reclaimed: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM hosted_agent_snapshots WHERE lease_id = $1) AS snapshots,
        (SELECT count(*)::text FROM hosted_agent_snapshot_references WHERE reference_id = $1) AS snapshot_refs,
        (SELECT count(*)::text FROM hosted_agent_object_references
          WHERE reference_kind = 'snapshot' AND reference_id IN
            (SELECT snapshot_id FROM hosted_agent_snapshots WHERE lease_id = $1)) AS object_refs,
        (SELECT count(*)::text FROM hosted_agent_tickets
          WHERE lease_id = $1 AND revoked_at IS NULL) AS live_tickets,
        (SELECT count(*)::text FROM hosted_agent_operations
          WHERE operation = 'release' AND state = 'succeeded' AND logical_response = '{"released":true}'::jsonb) AS operations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'release') AS allocations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'release' AND state = 'reclaimed') AS reclaimed
    `, [lease.leaseId])
    assert.deepEqual(graph.rows[0], {
      snapshots: '2', snapshot_refs: '2', object_refs: '6', live_tickets: '0',
      operations: '2', allocations: '1', reclaimed: '1',
    })
    assert.ok(context.releaseRevokers[0].leases.includes(lease.leaseId))
    assert.ok(context.releaseRevokers[1].leases.includes(lease.leaseId))
    const mutations = { kills: provider.kills, snapshots: provider.snapshots.size,
      objects: context.objects.values.size }
    await context.releaseCoordinators[1].release(releaseRequest)
    assert.deepEqual({ kills: provider.kills, snapshots: provider.snapshots.size,
      objects: context.objects.values.size }, mutations)
    await assert.rejects(context.checkpointCoordinators[1].checkpoint({
      leaseId: lease.leaseId, idempotencyKey: 'checkpoint-after-release',
    }), (error: unknown) => error instanceof ServiceError && error.status === 409)
  } finally { await close(context) }
})

test('transient release kill failure remains pending until fenced reconciliation completes it', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const provider = new ReleaseProvider(); const context = await fixture(provider)
  try {
    const lease = await context.coordinators[0].provision(context.request)
    const request = { leaseId: lease.leaseId, idempotencyKey: 'release-transient' }
    provider.failAt = 'kill'
    await assert.rejects(context.releaseCoordinators[0].release(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503
        && error.message === 'durable release cleanup pending')
    assert.equal((await context.states[0].getLease(tenantId, lease.leaseId))?.state, 'release_pending')
    assert.equal(provider.live().length, 1)
    const pending = await context.pools[0].query<{
      operation_state: string; allocation_state: string; live_tickets: string
    }>(`
      SELECT operation.state AS operation_state, allocation.state AS allocation_state,
        (SELECT count(*)::text FROM hosted_agent_tickets
          WHERE lease_id = $1 AND revoked_at IS NULL) AS live_tickets
      FROM hosted_agent_operations AS operation
      JOIN hosted_agent_operation_allocations AS allocation
        USING (operation, idempotency_key, tenant_id)
      WHERE operation.operation = 'release' AND operation.idempotency_key = $2
    `, [lease.leaseId, request.idempotencyKey])
    assert.deepEqual(pending.rows[0], {
      operation_state: 'in_progress', allocation_state: 'allocated', live_tickets: '0',
    })

    provider.failAt = undefined
    await context.pools[0].query(`UPDATE hosted_agent_operations
      SET heartbeat_at = now() - interval '1 hour'
      WHERE operation = 'release' AND idempotency_key = $1`, [request.idempotencyKey])
    const reconciler = new PostgresReconciler(context.journals[1], context.states[1], provider, {
      managedBy: 'cudex', tenantId, workerId: 'release-reconciler', staleAfterMs: 1,
    })
    const result = await reconciler.runOnce()
    assert.equal(result.operationsClaimed, 1)
    assert.equal((await context.states[0].getLease(tenantId, lease.leaseId))?.state, 'released')
    assert.equal(provider.kills, 1)
    const completed = await context.pools[0].query<{ operation_state: string; allocation_state: string }>(`
      SELECT operation.state AS operation_state, allocation.state AS allocation_state
      FROM hosted_agent_operations AS operation
      JOIN hosted_agent_operation_allocations AS allocation
        USING (operation, idempotency_key, tenant_id)
      WHERE operation.operation = 'release' AND operation.idempotency_key = $1
    `, [request.idempotencyKey])
    assert.deepEqual(completed.rows[0], { operation_state: 'succeeded', allocation_state: 'reclaimed' })
    await context.releaseCoordinators[1].release(request)
    assert.equal(provider.kills, 1)
  } finally { await close(context) }
})

test('reconciler reconstructs release after a crash immediately following target-bound claim', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const provider = new ReleaseProvider(); const context = await fixture(provider)
  try {
    const lease = await context.coordinators[0].provision(context.request)
    const request = { leaseId: lease.leaseId, idempotencyKey: 'release-claim-crash' }
    assert.deepEqual(await context.journals[0].claimOperation({
      operation: 'release', idempotencyKey: request.idempotencyKey, tenantId,
      requestHash: canonicalRequestHash(request), workerId: 'dead-release-worker',
      primaryLeaseId: lease.leaseId,
    }), { kind: 'claimed', generation: 0 })
    await context.pools[0].query(`UPDATE hosted_agent_operations
      SET heartbeat_at = now() - interval '1 hour'
      WHERE operation = 'release' AND idempotency_key = $1`, [request.idempotencyKey])
    const reconciler = new PostgresReconciler(context.journals[1], context.states[1], provider, {
      managedBy: 'cudex', tenantId, workerId: 'claim-crash-reconciler', staleAfterMs: 1,
    })
    assert.equal((await reconciler.runOnce()).operationsClaimed, 1)
    assert.equal((await context.states[0].getLease(tenantId, lease.leaseId))?.state, 'released')
    assert.equal(provider.kills, 1)
    await context.releaseCoordinators[1].release(request)
    assert.equal(provider.kills, 1)
  } finally { await close(context) }
})

test('release treats a confirmed missing sandbox as success', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const provider = new ReleaseProvider(); const context = await fixture(provider)
  try {
    const lease = await context.coordinators[0].provision(context.request)
    const durable = await context.states[0].getLease(tenantId, lease.leaseId)
    await provider.kill(durable!.providerSandboxId!)
    await context.releaseCoordinators[0].release({
      leaseId: lease.leaseId, idempotencyKey: 'release-missing',
    })
    assert.equal((await context.states[0].getLease(tenantId, lease.leaseId))?.state, 'released')
    assert.equal(provider.kills, 1)
    assert.equal(provider.snapshotDeletes, 0)
  } finally { await close(context) }
})

test('ambiguous release commit with failed outcome read never repeats provider cleanup', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const provider = new ReleaseProvider(); const context = await fixture(provider)
  try {
    const lease = await context.coordinators[0].provision(context.request)
    const request = { leaseId: lease.leaseId, idempotencyKey: 'release-ambiguous' }
    context.journals[0].throwAfterLeaseCommitAt = 2
    context.journals[0].failClaimAfterAmbiguousCommit = true
    await assert.rejects(context.releaseCoordinators[0].release(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503
        && error.message === 'durable release cleanup pending')
    assert.equal((await context.states[0].getLease(tenantId, lease.leaseId))?.state, 'released')
    assert.equal(provider.kills, 1)
    await context.releaseCoordinators[1].release(request)
    assert.equal(provider.kills, 1)
  } finally { await close(context) }
})
