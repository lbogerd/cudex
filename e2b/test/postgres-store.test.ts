import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { runMigrations } from '../src/migrate.js'
import {
  canonicalRequestHash,
  OperationOwnershipError,
  OperationRequestMismatchError,
  PostgresJournal,
} from '../src/postgres-store.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL

interface Fixture {
  admin: Pool
  firstPool: Pool
  secondPool: Pool
  first: PostgresJournal
  second: PostgresJournal
  schema: string
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_journal_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const config = { connectionString: databaseUrl, options: `-c search_path=${schema}` }
  const firstPool = new Pool(config); const secondPool = new Pool(config)
  await runMigrations(firstPool)
  return { admin, firstPool, secondPool, first: new PostgresJournal(firstPool), second: new PostgresJournal(secondPool), schema }
}

async function cleanup(context: Fixture): Promise<void> {
  await context.firstPool.end(); await context.secondPool.end()
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

const live = (name: string, fn: (context: Fixture) => Promise<void>) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try { await fn(context) } finally { await cleanup(context) }
})

live('two replicas atomically claim one operation and replay a sanitized response', async context => {
  const requestHash = canonicalRequestHash({ source: 'root', agentId: 'agent' })
  const input = { operation: 'provision', idempotencyKey: 'provision-1', tenantId: 'tenant-1', requestHash }
  const claims = await Promise.all([
    context.first.claimOperation({ ...input, workerId: 'worker-1' }),
    context.second.claimOperation({ ...input, workerId: 'worker-2' }),
  ])
  assert.equal(claims.filter(claim => claim.kind === 'claimed').length, 1)
  assert.equal(claims.filter(claim => claim.kind === 'in_progress').length, 1)
  const winner = claims.find(claim => claim.kind === 'claimed')!
  const winnerWorker = claims[0] === winner ? 'worker-1' : 'worker-2'
  await context.first.completeOperation(input, winner.generation, winnerWorker, {
    leaseId: 'lease-1', environmentId: 'env-1',
    connection: { execServerUrl: 'wss://gateway.invalid/leases/lease-1?ticket=secret' },
  })
  const replay = await context.second.claimOperation({ ...input, workerId: 'worker-2' })
  assert.deepEqual(replay, { kind: 'succeeded', generation: 0, response: { leaseId: 'lease-1', environmentId: 'env-1' } })
  const persisted = await context.firstPool.query<{ logical_response: Record<string, unknown> }>(
    'SELECT logical_response FROM hosted_agent_operations WHERE operation = $1 AND idempotency_key = $2',
    [input.operation, input.idempotencyKey],
  )
  assert.equal('connection' in persisted.rows[0]!.logical_response, false)
  assert.equal(JSON.stringify(persisted.rows[0]!.logical_response).includes('ticket='), false)
})

live('changed request hash or tenant is rejected before a second claim', async context => {
  const original = { operation: 'checkpoint', idempotencyKey: 'same-key', tenantId: 'tenant-1', requestHash: canonicalRequestHash({ leaseId: 'one' }), workerId: 'worker' }
  assert.equal((await context.first.claimOperation(original)).kind, 'claimed')
  await assert.rejects(
    context.second.claimOperation({ ...original, requestHash: canonicalRequestHash({ leaseId: 'two' }) }),
    OperationRequestMismatchError,
  )
  await assert.rejects(
    context.second.claimOperation({ ...original, tenantId: 'tenant-2' }),
    OperationRequestMismatchError,
  )
  const count = await context.firstPool.query<{ count: string }>('SELECT count(*) FROM hosted_agent_operations')
  assert.equal(count.rows[0]!.count, '1')
})

live('journal validation, heartbeat, terminal failure, and database identities are enforced', async context => {
  await assert.rejects(context.first.claimOperation({
    operation: 'release', idempotencyKey: 'bad-hash', tenantId: 'tenant-1',
    requestHash: 'not-a-hash', workerId: 'worker',
  }), /invalid canonical request hash/)
  const identity = { operation: 'release', idempotencyKey: 'release-1', tenantId: 'tenant-1' }
  const requestHash = canonicalRequestHash(identity)
  const claim = await context.first.claimOperation({ ...identity, requestHash, workerId: 'worker-1' })
  assert.equal(claim.kind, 'claimed')
  if (claim.kind !== 'claimed') return
  assert.equal(await context.first.heartbeatOperation(identity, claim.generation, 'worker-1'), true)
  await context.first.failOperation(identity, claim.generation, 'worker-1', 'provider_denied', 'provider denied release')
  const terminal = await context.second.waitForTerminal({ ...identity, requestHash }, { timeoutMs: 1_000 })
  assert.deepEqual(terminal, {
    kind: 'failed_terminal', generation: 0,
    errorCode: 'provider_denied', errorMessage: 'provider denied release',
  })

  const leaseValues = `
    (lease_id, environment_id, tenant_id, agent_id, sandbox_template, cwd_uri,
     workspace_root_uris, state, tool_policy, policy_version)
  `
  await context.firstPool.query(`
    INSERT INTO hosted_agent_leases ${leaseValues}
    VALUES ('unique-lease-1', 'same-environment', 'tenant-1', 'agent-1', 'general-v1',
      'file:///workspace/one', '["file:///workspace/one"]'::jsonb, 'provisioning', '{}'::jsonb, 1)
  `)
  await assert.rejects(context.secondPool.query(`
    INSERT INTO hosted_agent_leases ${leaseValues}
    VALUES ('unique-lease-2', 'same-environment', 'tenant-1', 'agent-2', 'general-v1',
      'file:///workspace/two', '["file:///workspace/two"]'::jsonb, 'provisioning', '{}'::jsonb, 1)
  `), error => (error as { code?: string }).code === '23505')
})

live('allocation ledger and stale claiming use generation fencing across replicas', async context => {
  const identity = { operation: 'provision', idempotencyKey: 'stale-1', tenantId: 'tenant-1' }
  const claim = await context.first.claimOperation({ ...identity, requestHash: canonicalRequestHash(identity), workerId: 'dead-worker' })
  assert.equal(claim.kind, 'claimed')
  if (claim.kind !== 'claimed') return
  const allocation = await context.first.recordAllocation(identity, claim.generation, 'dead-worker', {
    kind: 'capture_sandbox', resourceId: 'sandbox-capture-1', metadata: { role: 'capture' },
  })
  const duplicate = await context.first.recordAllocation(identity, claim.generation, 'dead-worker', {
    kind: 'capture_sandbox', resourceId: 'sandbox-capture-1', metadata: { ignored: true },
  })
  assert.equal(duplicate.allocationId, allocation.allocationId)
  await context.firstPool.query(`
    UPDATE hosted_agent_operations SET heartbeat_at = now() - interval '10 minutes'
    WHERE operation = $1 AND idempotency_key = $2
  `, [identity.operation, identity.idempotencyKey])
  const stale = (await Promise.all([
    context.first.claimStaleOperations(new Date(), 10, 'reconciler-1'),
    context.second.claimStaleOperations(new Date(), 10, 'reconciler-2'),
  ])).flat()
  assert.equal(stale.length, 1)
  assert.equal(stale[0]!.generation, 1)
  assert.equal(await context.first.heartbeatOperation(identity, 0, 'dead-worker'), false)
  await assert.rejects(
    context.first.updateAllocationState(identity, 0, 'dead-worker', allocation.allocationId, 'reclaim_pending'),
    OperationOwnershipError,
  )
  const reconciler = stale[0]!.workerId
  const pending = await context.second.updateAllocationState(identity, 1, reconciler, allocation.allocationId, 'reclaim_pending')
  assert.equal(pending.state, 'reclaim_pending')
  const reclaimed = await context.second.updateAllocationState(identity, 1, reconciler, allocation.allocationId, 'reclaimed')
  assert.equal(reclaimed.state, 'reclaimed'); assert.ok(reclaimed.reclaimedAt)
})

live('sorted multi-lease advisory locks avoid reversed-order deadlock', async context => {
  await context.firstPool.query(`
    INSERT INTO hosted_agent_leases
      (lease_id, environment_id, tenant_id, agent_id, sandbox_template, cwd_uri,
       workspace_root_uris, state, tool_policy, policy_version)
    VALUES
      ('lease-a', 'env-a', 'tenant-1', 'agent-a', 'general-v1', 'file:///workspace/a',
       '["file:///workspace/a"]'::jsonb, 'provisioning', '{}'::jsonb, 1),
      ('lease-b', 'env-b', 'tenant-1', 'agent-b', 'general-v1', 'file:///workspace/b',
       '["file:///workspace/b"]'::jsonb, 'provisioning', '{}'::jsonb, 1)
  `)
  const completed: string[] = []
  await Promise.all([
    context.first.withLeaseLocks('tenant-1', ['lease-a', 'lease-b'], async client => {
      await client.query("SELECT pg_sleep(0.05)"); completed.push('first')
    }),
    context.second.withLeaseLocks('tenant-1', ['lease-b', 'lease-a'], async client => {
      await client.query("SELECT pg_sleep(0.05)"); completed.push('second')
    }),
  ])
  assert.deepEqual(new Set(completed), new Set(['first', 'second']))
})
