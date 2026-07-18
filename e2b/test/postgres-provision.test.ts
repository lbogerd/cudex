import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { Header } from 'tar'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import { PostgresObjectReclaimer } from '../src/postgres-object-reclaimer.js'
import { PostgresProvisionCoordinator } from '../src/postgres-provision.js'
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

class ObservedJournal extends PostgresJournal {
  private readonly observed = deferred()
  readonly inProgressObserved = this.observed.promise
  override async claimOperation(input: OperationClaimInput): Promise<OperationClaim> {
    const claim = await super.claimOperation(input)
    if (claim.kind === 'in_progress') this.observed.resolve()
    return claim
  }
}

class FailOnceTickets implements TicketAuthority {
  private failed = false
  constructor(private readonly delegate: TicketAuthority) {}
  async issue(leaseId: string, purpose?: TicketPurpose): Promise<string> {
    if (!this.failed) { this.failed = true; throw new Error('injected ticket outage') }
    return this.delegate.issue(leaseId, purpose)
  }
  async validate(leaseId: string, ticket: string, purpose?: TicketPurpose): Promise<boolean> {
    return this.delegate.validate(leaseId, ticket, purpose)
  }
  async revokeLease(leaseId: string): Promise<void> { return this.delegate.revokeLease(leaseId) }
}

interface Fixture {
  admin: Pool
  pools: [Pool, Pool]
  journals: [PostgresJournal, ObservedJournal]
  states: [PostgresDurableState, PostgresDurableState]
  provider: FakeProvider
  objects: TrackingObjects
  lifecycle: SourceSnapshotLifecycle
  coordinators: [PostgresProvisionCoordinator, PostgresProvisionCoordinator]
  request: ProvisionRequest
  schema: string
}

async function fixture(provider: FakeProvider = new FakeProvider(), failFirstTicket = false): Promise<Fixture> {
  const schema = `hosted_agent_provision_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`)
  const pools = [0, 1].map(() => new Pool({ connectionString: databaseUrl,
    options: `-c search_path=${schema}`, max: 6 })) as [Pool, Pool]
  await runMigrations(pools[0])
  const states = pools.map(pool => new PostgresDurableState(pool)) as [PostgresDurableState, PostgresDurableState]
  const journals: [PostgresJournal, ObservedJournal] = [new PostgresJournal(pools[0]), new ObservedJournal(pools[1])]
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
  const coordinators = journals.map((journal, index) => {
    const reclaimer = new PostgresObjectReclaimer(pools[index]!, objects)
    const publisher = new WorkspaceSnapshotPublisher(states[index]!, objects, {
      reclaimer: { async reclaimUnreferencedWorkspaceObject() { assert.fail('durable publication must not use legacy cleanup') } },
      durablePreparation: {
        journal,
        preparations: new PostgresWorkspacePreparations(pools[index]!),
        reclaimer,
      },
    })
    const issuer = new PostgresTicketIssuer(states[index]!, tenantId, 'wss://gateway.example')
    const tickets = index === 0 && failFirstTicket ? new FailOnceTickets(issuer) : issuer
    return new PostgresProvisionCoordinator(journal, states[index]!, publisher, provider, tickets, {
        principal, managedBy: 'cudex', workerId: `provision-worker-${index}`,
        roles: { default: role }, sourceResolver: lifecycle,
      })
  }) as [PostgresProvisionCoordinator, PostgresProvisionCoordinator]
  const request: ProvisionRequest = {
    agentId: 'agent-root', ownerAgentId: null, agentType: 'default', sandboxTemplate: 'general-v1',
    source: { type: 'sourceSnapshot', sourceSnapshotId: source.sourceSnapshotId, checksum: source.checksum },
    idempotencyKey: 'durable-provision',
  }
  return { admin, pools, journals, states, provider, objects, lifecycle, coordinators, request, schema }
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
    assert.equal(encoded.includes('connection'), false)
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
