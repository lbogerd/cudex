import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { runMigrations } from '../src/migrate.js'
import { ProviderSandboxMissingError } from '../src/provider.js'
import { PostgresReconnectCoordinator } from '../src/postgres-reconnect.js'
import { PostgresReconciler } from '../src/postgres-reconciler.js'
import { PostgresDurableState } from '../src/postgres-state.js'
import {
  PostgresJournal,
  type OperationClaim,
  type OperationClaimInput,
} from '../src/postgres-store.js'
import { PostgresTicketIssuer } from '../src/postgres-tickets.js'
import type { TicketAuthority } from '../src/tickets.js'
import { ServiceError, type ReconnectRequest, type TicketPurpose } from '../src/types.js'
import { FakeProvider } from './fake-provider.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const tenantId = 'tenant-reconnect'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return { promise: new Promise(done => { resolve = done }), resolve }
}

interface Gate {
  entered: ReturnType<typeof deferred>
  released: ReturnType<typeof deferred>
}

class ReconnectProvider extends FakeProvider {
  private readonly connectGates: Gate[] = []
  connectAttempts = 0
  starts = 0
  probes = 0
  missingNextConnect = false

  gateNextConnect(): { entered: Promise<void>; release(): void } {
    const gate = { entered: deferred(), released: deferred() }
    this.connectGates.push(gate)
    return { entered: gate.entered.promise, release: () => { gate.released.resolve() } }
  }

  override async connect(sandboxId: string) {
    this.connectAttempts++
    const gate = this.connectGates.shift()
    if (gate) { gate.entered.resolve(); await gate.released.promise }
    if (this.missingNextConnect) {
      this.missingNextConnect = false
      throw new ProviderSandboxMissingError()
    }
    return super.connect(sandboxId)
  }

  override async startExecServer(sandboxId: string): Promise<void> {
    this.starts++
    return super.startExecServer(sandboxId)
  }

  override async probeExecServer(sandboxId: string): Promise<void> {
    this.probes++
    return super.probeExecServer(sandboxId)
  }
}

class ConnectionRevoker {
  readonly leases: string[] = []
  revoke(leaseId: string): void { this.leases.push(leaseId) }
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

class ObservedJournal extends PostgresJournal {
  private readonly inProgress = deferred()
  private readonly leaseLock = deferred()
  private failRecoveryClaim = false
  readonly inProgressObserved = this.inProgress.promise
  readonly leaseLockObserved = this.leaseLock.promise
  throwAfterLeaseCommit = false
  failClaimAfterAmbiguousCommit = false

  override async claimOperation(input: OperationClaimInput): Promise<OperationClaim> {
    if (this.failRecoveryClaim) {
      this.failRecoveryClaim = false
      throw new Error('injected recovery read outage')
    }
    const claim = await super.claimOperation(input)
    if (claim.kind === 'in_progress') this.inProgress.resolve()
    return claim
  }

  override async withLeaseLocks<T>(tenant: string, leaseIds: string[],
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    this.leaseLock.resolve()
    const result = await super.withLeaseLocks(tenant, leaseIds, fn)
    if (this.throwAfterLeaseCommit) {
      this.throwAfterLeaseCommit = false
      this.failRecoveryClaim = this.failClaimAfterAmbiguousCommit
      throw new Error('injected ambiguous commit acknowledgement')
    }
    return result
  }
}

interface Fixture {
  admin: Pool
  pools: [Pool, Pool]
  journals: [ObservedJournal, ObservedJournal]
  states: [PostgresDurableState, PostgresDurableState]
  tickets: [PostgresTicketIssuer, PostgresTicketIssuer]
  coordinators: [PostgresReconnectCoordinator, PostgresReconnectCoordinator]
  revokers: [ConnectionRevoker, ConnectionRevoker]
  provider: ReconnectProvider
  leaseId: string
  sandboxId: string
  initialTicketUrl: string
  schema: string
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_reconnect_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pools = [0, 1].map(() => new Pool({ connectionString: databaseUrl,
    options: `-c search_path=${schema}`, max: 6 })) as [Pool, Pool]
  await runMigrations(pools[0])

  const provider = new ReconnectProvider()
  const sandboxId = (await provider.create()).sandboxId
  const leaseId = 'lease-reconnect'
  const checksum = `sha256:${'0'.repeat(64)}`
  await pools[0].query(`
    INSERT INTO hosted_agent_objects
      (object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes, state)
    VALUES
      ('workspace-object', $1, 'workspace_archive', 'test', 'workspace', $2, 0, 'available'),
      ('manifest-object', $1, 'manifest', 'test', 'manifest', $2, 0, 'available')
  `, [tenantId, checksum])
  await pools[0].query(`
    INSERT INTO hosted_agent_leases
      (lease_id, environment_id, tenant_id, agent_id, provider_sandbox_id, sandbox_template,
       cwd_uri, workspace_root_uris, state, tool_policy, policy_version)
    VALUES ($1, 'environment-reconnect', $2, 'agent-root', $3, 'general-v1',
      'file:///workspace/project', '["file:///workspace/project"]'::jsonb, 'active',
      '{"allowedDomains":["agentEnvironment"],"allowedTools":[]}'::jsonb, 1)
  `, [leaseId, tenantId, sandboxId])
  await pools[0].query(`
    INSERT INTO hosted_agent_snapshots
      (snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
       manifest_object_id, manifest_checksum, state)
    VALUES ('snapshot-base', $1, $2, NULL, 'workspace-object', 'manifest-object', $3, 'available')
  `, [tenantId, leaseId, checksum])
  await pools[0].query(`
    UPDATE hosted_agent_leases
      SET base_snapshot_id = 'snapshot-base', latest_snapshot_id = 'snapshot-base'
      WHERE lease_id = $1
  `, [leaseId])
  await pools[0].query(`
    INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
      VALUES ('snapshot-base', 'lease_base', $1), ('snapshot-base', 'lease_latest', $1)
  `, [leaseId])

  const states = pools.map(pool => new PostgresDurableState(pool)) as
    [PostgresDurableState, PostgresDurableState]
  const journals = pools.map(pool => new ObservedJournal(pool)) as [ObservedJournal, ObservedJournal]
  const tickets = states.map(state => new PostgresTicketIssuer(
    state, tenantId, 'wss://gateway.example')) as [PostgresTicketIssuer, PostgresTicketIssuer]
  const initialTicketUrl = await tickets[0].issue(leaseId)
  const revokers: [ConnectionRevoker, ConnectionRevoker] = [new ConnectionRevoker(), new ConnectionRevoker()]
  const coordinators = journals.map((journal, index) => new PostgresReconnectCoordinator(
    journal, states[index]!, provider, tickets[index]!, {
      tenantId, workerId: `reconnect-worker-${index}`, waitTimeoutMs: 2_000,
      connections: revokers[index]!,
    })) as [PostgresReconnectCoordinator, PostgresReconnectCoordinator]
  return { admin, pools, journals, states, tickets, coordinators, revokers, provider,
    leaseId, sandboxId, initialTicketUrl, schema }
}

async function close(context: Fixture): Promise<void> {
  await Promise.all(context.pools.map(pool => pool.end()))
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

async function restartFirstReplica(context: Fixture): Promise<void> {
  await context.pools[0].end()
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${context.schema}`,
    max: 6,
  })
  const state = new PostgresDurableState(pool)
  const journal = new ObservedJournal(pool)
  const tickets = new PostgresTicketIssuer(state, tenantId, 'wss://gateway.example')
  const revoker = new ConnectionRevoker()
  context.pools[0] = pool
  context.states[0] = state
  context.journals[0] = journal
  context.tickets[0] = tickets
  context.revokers[0] = revoker
  context.coordinators[0] = new PostgresReconnectCoordinator(
    journal, state, context.provider, tickets, {
      tenantId, workerId: 'reconnect-worker-restarted', waitTimeoutMs: 2_000,
      connections: revoker,
    })
}

function ticketFrom(url: string): string {
  const ticket = new URL(url).searchParams.get('ticket')
  assert.ok(ticket)
  return ticket
}

function withoutConnection<T extends { connection: unknown }>(value: T): Omit<T, 'connection'> {
  const { connection: _connection, ...logical } = value
  return logical
}

function withoutAccess<T extends { connection: unknown; connectionGeneration: number }>(
  value: T,
): Omit<T, 'connection' | 'connectionGeneration'> {
  const { connection: _connection, connectionGeneration: _connectionGeneration, ...logical } = value
  return logical
}

test('durable reconnect serializes duplicate keys across replicas and returns fresh tickets', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const gate = context.provider.gateNextConnect()
    const request: ReconnectRequest = { leaseId: context.leaseId, idempotencyKey: 'reconnect-same' }
    const first = context.coordinators[0].reconnect(request)
    await gate.entered
    const duplicate = context.coordinators[1].reconnect(request)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(context.provider.connectAttempts, 1)
    gate.release()
    const [left, right] = await Promise.all([first, duplicate])

    assert.deepEqual(withoutAccess(left), withoutAccess(right))
    assert.deepEqual([left.connectionGeneration, right.connectionGeneration].sort(), [1, 2])
    assert.notEqual(left.connection.execServerUrl, right.connection.execServerUrl)
    assert.deepEqual({ connects: context.provider.connectAttempts, starts: context.provider.starts,
      probes: context.provider.probes }, { connects: 1, starts: 1, probes: 1 })
    assert.equal((await context.states[0].getLease(tenantId, context.leaseId))?.connectionGeneration, 2)
    assert.ok(context.revokers[0].leases.includes(context.leaseId))
    assert.ok(context.revokers[1].leases.includes(context.leaseId))

    const durable = await context.pools[0].query<{
      state: string; logical_response: Record<string, unknown>; live_tickets: string
    }>(`
      SELECT operation.state, operation.logical_response,
        (SELECT count(*)::text FROM hosted_agent_tickets
          WHERE lease_id = $1 AND revoked_at IS NULL) AS live_tickets
      FROM hosted_agent_operations AS operation
      WHERE operation.operation = 'reconnect' AND operation.idempotency_key = $2
    `, [context.leaseId, request.idempotencyKey])
    assert.equal(durable.rows[0]?.state, 'succeeded')
    assert.equal(durable.rows[0]?.live_tickets, '1')
    const encoded = JSON.stringify(durable.rows[0]?.logical_response)
    assert.equal(Object.hasOwn(durable.rows[0]?.logical_response ?? {}, 'connection'), false)
    assert.equal(/ticket|token|credential|api.?key/iu.test(encoded), false)
    assert.equal(await context.tickets[0].validate(context.leaseId,
      ticketFrom(context.initialTicketUrl)), null)
    const fresh = await Promise.all([left, right].map(result => context.tickets[0].validate(
      context.leaseId, ticketFrom(result.connection.execServerUrl))))
    assert.equal(fresh.filter(Boolean).length, 1)
    assert.equal(fresh.find(Boolean)?.connectionGeneration, 2)
  } finally { await close(context) }
})

test('distinct reconnect keys serialize on the lease and each rotate its generation', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const firstGate = context.provider.gateNextConnect()
    const secondGate = context.provider.gateNextConnect()
    const first = context.coordinators[0].reconnect({
      leaseId: context.leaseId, idempotencyKey: 'reconnect-first',
    })
    await firstGate.entered
    const second = context.coordinators[1].reconnect({
      leaseId: context.leaseId, idempotencyKey: 'reconnect-second',
    })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(context.provider.connectAttempts, 1)
    firstGate.release()
    await secondGate.entered
    assert.equal((await context.states[0].getLease(tenantId, context.leaseId))?.connectionGeneration, 1)
    secondGate.release()
    const [left, right] = await Promise.all([first, second])

    assert.equal(left.leaseId, context.leaseId)
    assert.equal(right.leaseId, context.leaseId)
    assert.deepEqual([left.connectionGeneration, right.connectionGeneration].sort(), [1, 2])
    assert.deepEqual({ connects: context.provider.connectAttempts, starts: context.provider.starts,
      probes: context.provider.probes }, { connects: 2, starts: 2, probes: 2 })
    assert.equal((await context.states[0].getLease(tenantId, context.leaseId))?.connectionGeneration, 2)
    const operations = await context.pools[0].query<{ state: string }>(`
      SELECT state FROM hosted_agent_operations WHERE operation = 'reconnect' ORDER BY idempotency_key
    `)
    assert.deepEqual(operations.rows, [{ state: 'succeeded' }, { state: 'succeeded' }])
  } finally { await close(context) }
})

test('transient reconnect failure preserves lease access for stale reconciliation', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const request: ReconnectRequest = { leaseId: context.leaseId, idempotencyKey: 'reconnect-transient' }
    context.provider.failAt = 'connect'
    await assert.rejects(context.coordinators[0].reconnect(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503)
    const pending = await context.pools[0].query<{
      operation_state: string; lease_state: string; connection_generation: string; live_tickets: string
    }>(`
      SELECT operation.state AS operation_state, lease.state AS lease_state,
        lease.connection_generation::text,
        (SELECT count(*)::text FROM hosted_agent_tickets
          WHERE lease_id = lease.lease_id AND revoked_at IS NULL) AS live_tickets
      FROM hosted_agent_operations AS operation
      JOIN hosted_agent_leases AS lease ON lease.lease_id = operation.primary_lease_id
      WHERE operation.operation = 'reconnect' AND operation.idempotency_key = $1
    `, [request.idempotencyKey])
    assert.deepEqual(pending.rows[0], {
      operation_state: 'in_progress', lease_state: 'active', connection_generation: '0', live_tickets: '1',
    })

    context.provider.failAt = undefined
    await context.pools[0].query(`UPDATE hosted_agent_operations
      SET heartbeat_at = now() - interval '1 hour'
      WHERE operation = 'reconnect' AND idempotency_key = $1`, [request.idempotencyKey])
    await restartFirstReplica(context)
    const reconciler = new PostgresReconciler(
      context.journals[0], context.states[0], context.provider, {
        managedBy: 'cudex', tenantId, workerId: 'reconnect-reconciler', staleAfterMs: 1,
        connections: context.revokers[0],
      })
    const result = await reconciler.runOnce()
    assert.equal(result.operationsClaimed, 1)
    assert.equal((await context.states[0].getLease(tenantId, context.leaseId))?.connectionGeneration, 1)
    assert.deepEqual(context.revokers[0].leases, [context.leaseId])
    assert.deepEqual(withoutConnection(await context.coordinators[0].reconnect(request)), {
      leaseId: context.leaseId,
      environmentId: 'environment-reconnect',
      cwd: 'file:///workspace/project',
      workspaceRoots: ['file:///workspace/project'],
      baseSnapshotId: 'snapshot-base',
      connectionGeneration: 2,
      toolPolicy: { allowedDomains: ['agentEnvironment'], allowedTools: [] },
    })
    assert.equal((await context.states[0].getLease(tenantId, context.leaseId))?.connectionGeneration, 2)
  } finally { await close(context) }
})

test('confirmed missing sandbox durably marks the lease lost and terminally replays 404', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const request: ReconnectRequest = { leaseId: context.leaseId, idempotencyKey: 'reconnect-missing' }
    context.provider.missingNextConnect = true
    await assert.rejects(context.coordinators[0].reconnect(request),
      (error: unknown) => error instanceof ServiceError && error.status === 404
        && error.message === 'lease missing')
    const lease = await context.states[0].getLease(tenantId, context.leaseId)
    assert.equal(lease?.state, 'lost')
    assert.equal(lease?.connectionGeneration, 1)
    assert.equal(await context.tickets[0].validate(context.leaseId,
      ticketFrom(context.initialTicketUrl)), null)
    const durable = await context.pools[0].query<{
      state: string; error_code: string; error_message: string; live_tickets: string
    }>(`
      SELECT operation.state, operation.error_code, operation.error_message,
        (SELECT count(*)::text FROM hosted_agent_tickets
          WHERE lease_id = $1 AND revoked_at IS NULL) AS live_tickets
      FROM hosted_agent_operations AS operation
      WHERE operation.operation = 'reconnect' AND operation.idempotency_key = $2
    `, [context.leaseId, request.idempotencyKey])
    assert.deepEqual(durable.rows[0], {
      state: 'failed_terminal', error_code: 'service_404', error_message: 'lease missing', live_tickets: '0',
    })
    await assert.rejects(context.coordinators[1].reconnect(request),
      (error: unknown) => error instanceof ServiceError && error.status === 404)
    assert.equal(context.provider.connectAttempts, 1)
    assert.ok(context.revokers[0].leases.includes(context.leaseId))
    assert.ok(context.revokers[1].leases.includes(context.leaseId))
  } finally { await close(context) }
})

test('ambiguous reconnect commit replays durable success without a second provider mutation', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const request: ReconnectRequest = { leaseId: context.leaseId, idempotencyKey: 'reconnect-ambiguous' }
    context.journals[0].throwAfterLeaseCommit = true
    context.journals[0].failClaimAfterAmbiguousCommit = true
    await assert.rejects(context.coordinators[0].reconnect(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503
        && error.message === 'durable reconnect outcome pending')
    assert.equal((await context.states[0].getLease(tenantId, context.leaseId))?.connectionGeneration, 1)
    assert.equal(context.provider.connectAttempts, 1)

    const replay = await context.coordinators[1].reconnect(request)
    assert.equal(replay.leaseId, context.leaseId)
    assert.equal(context.provider.connectAttempts, 1)
    assert.equal((await context.states[0].getLease(tenantId, context.leaseId))?.connectionGeneration, 2)
    const durable = await context.pools[0].query<{ state: string; logical_response: Record<string, unknown> }>(`
      SELECT state, logical_response FROM hosted_agent_operations
      WHERE operation = 'reconnect' AND idempotency_key = $1
    `, [request.idempotencyKey])
    assert.equal(durable.rows[0]?.state, 'succeeded')
    assert.equal(Object.hasOwn(durable.rows[0]?.logical_response ?? {}, 'connection'), false)
  } finally { await close(context) }
})

test('ticket issuance failure preserves durable success and replay repairs access', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const request: ReconnectRequest = { leaseId: context.leaseId, idempotencyKey: 'reconnect-ticket-outage' }
    const coordinator = new PostgresReconnectCoordinator(
      context.journals[0], context.states[0], context.provider,
      new FailOnceTickets(context.tickets[0]), {
        tenantId, workerId: 'reconnect-ticket-worker', waitTimeoutMs: 2_000,
        connections: context.revokers[0],
      })
    await assert.rejects(coordinator.reconnect(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503
        && error.message === 'gateway ticket service unavailable')
    assert.equal(context.provider.connectAttempts, 1)
    assert.equal((await context.states[0].getLease(tenantId, context.leaseId))?.connectionGeneration, 1)
    const durable = await context.pools[0].query<{ state: string; logical_response: Record<string, unknown> }>(`
      SELECT state, logical_response FROM hosted_agent_operations
      WHERE operation = 'reconnect' AND idempotency_key = $1
    `, [request.idempotencyKey])
    assert.equal(durable.rows[0]?.state, 'succeeded')
    assert.equal(Object.hasOwn(durable.rows[0]?.logical_response ?? {}, 'connection'), false)

    const replay = await context.coordinators[1].reconnect(request)
    assert.equal(replay.leaseId, context.leaseId)
    assert.equal(context.provider.connectAttempts, 1)
    assert.equal((await context.states[0].getLease(tenantId, context.leaseId))?.connectionGeneration, 2)
    assert.deepEqual(await context.tickets[0].validate(
      context.leaseId, ticketFrom(replay.connection.execServerUrl)), { connectionGeneration: 2 })
  } finally { await close(context) }
})

test('successful reconnect replay returns 404 after the lease is later lost', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const request: ReconnectRequest = { leaseId: context.leaseId, idempotencyKey: 'reconnect-then-lost' }
    await context.coordinators[0].reconnect(request)
    const client = await context.pools[1].connect()
    try {
      await client.query('BEGIN')
      await context.states[1].markLeaseLost(tenantId, context.leaseId, context.sandboxId, client)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
    await assert.rejects(context.coordinators[1].reconnect(request),
      (error: unknown) => error instanceof ServiceError && error.status === 404
        && error.message === 'lease missing')
    assert.equal(context.provider.connectAttempts, 1)
    assert.deepEqual(context.revokers[1].leases, [context.leaseId])
  } finally { await close(context) }
})
