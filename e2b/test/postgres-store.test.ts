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

live('child operation subtype is immutable, replay-exact, and stale-claim filterable', async context => {
  await assert.rejects(context.first.claimOperation({
    operation: 'provision', idempotencyKey: 'invalid-child', tenantId: 'tenant-1',
    requestHash: canonicalRequestHash({}), workerId: 'child-worker', operationSubtype: 'child',
  }), /invalid child operation identity/)
  await context.firstPool.query(`
    INSERT INTO hosted_agent_leases
      (lease_id, environment_id, tenant_id, agent_id, sandbox_template, cwd_uri,
       workspace_root_uris, state, tool_policy, policy_version)
    VALUES ('child-owner', 'child-owner-environment', 'tenant-1', 'owner-agent', 'owner-v1',
      'file:///workspace/root', '["file:///workspace/root"]'::jsonb,
      'provisioning', '{}'::jsonb, 1)
  `)
  const child = {
    operation: 'provision', idempotencyKey: 'child-subtype', tenantId: 'tenant-1',
    requestHash: canonicalRequestHash({ source: 'owner' }), workerId: 'child-worker',
    operationSubtype: 'child' as const,
    primaryLeaseId: 'child-owner',
  }
  assert.equal((await context.first.claimOperation(child)).kind, 'claimed')
  const { operationSubtype: _subtype, ...withoutSubtype } = child
  await assert.rejects(context.second.claimOperation(withoutSubtype), OperationRequestMismatchError)
  await assert.rejects(context.firstPool.query(`
    UPDATE hosted_agent_operations SET operation_subtype = NULL
    WHERE operation = 'provision' AND idempotency_key = 'child-subtype'
  `), /operation subtype is immutable/)

  const ordinary = {
    operation: 'provision', idempotencyKey: 'ordinary-subtype', tenantId: 'tenant-1',
    requestHash: canonicalRequestHash({ source: 'immutable' }), workerId: 'ordinary-worker',
  }
  assert.equal((await context.first.claimOperation(ordinary)).kind, 'claimed')
  await context.firstPool.query(`
    UPDATE hosted_agent_operations SET heartbeat_at = now() - interval '1 hour'
  `)
  const childOnly = await context.second.claimStaleOperations(
    new Date(), 10, 'child-reconciler', 'tenant-1', 'provision', 'child')
  assert.equal(childOnly.length, 1)
  assert.equal(childOnly[0]!.idempotencyKey, child.idempotencyKey)
  assert.equal(childOnly[0]!.operationSubtype, 'child')
  const remaining = await context.first.claimStaleOperations(
    new Date(), 10, 'general-reconciler', 'tenant-1', 'provision', 'none')
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]!.idempotencyKey, ordinary.idempotencyKey)
  assert.equal(remaining[0]!.operationSubtype, null)
})

live('stale claims can exclude operations owned by a dedicated reconciler', async context => {
  for (const operation of ['provision', 'patch_apply']) {
    await context.first.claimOperation({
      operation, idempotencyKey: `exclude-${operation}`, tenantId: 'tenant-1',
      requestHash: canonicalRequestHash({ operation }), workerId: `worker-${operation}`,
    })
  }
  await context.firstPool.query(`
    UPDATE hosted_agent_operations SET heartbeat_at = now() - interval '1 hour'
  `)
  const general = await context.second.claimStaleOperations(
    new Date(), 10, 'general-reconciler', 'tenant-1', undefined, 'none', ['patch_apply'])
  assert.deepEqual(general.map(value => value.operation), ['provision'])
  const dedicated = await context.first.claimStaleOperations(
    new Date(), 10, 'patch-reconciler', 'tenant-1', 'patch_apply', 'none')
  assert.deepEqual(dedicated.map(value => value.operation), ['patch_apply'])
  await assert.rejects(context.first.claimStaleOperations(
    new Date(), 10, 'invalid-reconciler', 'tenant-1', undefined, 'none',
    ['patch_apply', 'patch_apply']), /invalid excluded operations/)
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

live('restore operations keep distinct source and result lease identities through stale takeover', async context => {
  for (const [leaseId, environmentId] of [['restore-source', 'restore-source-env'], ['restore-result', 'restore-result-env']]) {
    await context.firstPool.query(`
      INSERT INTO hosted_agent_leases
        (lease_id, environment_id, tenant_id, agent_id, sandbox_template, cwd_uri,
         workspace_root_uris, state, tool_policy, policy_version)
      VALUES ($1, $2, 'tenant-1', 'agent-1', 'general-v1', 'file:///workspace/root',
        '["file:///workspace/root"]'::jsonb, 'provisioning', '{}'::jsonb, 1)
    `, [leaseId, environmentId])
  }
  const identity = { operation: 'provision', idempotencyKey: 'restore-result-binding', tenantId: 'tenant-1' }
  const claim = await context.first.claimOperation({ ...identity, requestHash: canonicalRequestHash(identity),
    workerId: 'restore-worker', primaryLeaseId: 'restore-source' })
  assert.equal(claim.kind, 'claimed')
  if (claim.kind !== 'claimed') return
  await context.first.bindResultLeaseAndAdoptAllocations(
    identity, claim.generation, 'restore-worker', 'restore-result', [])
  await context.firstPool.query(`UPDATE hosted_agent_operations SET heartbeat_at = now() - interval '1 hour'
    WHERE operation = 'provision' AND idempotency_key = 'restore-result-binding'`)
  const stale = await context.second.claimStaleOperations(new Date(), 1, 'restore-reconciler', 'tenant-1')
  assert.equal(stale[0]?.primaryLeaseId, 'restore-source')
  assert.equal(stale[0]?.resultLeaseId, 'restore-result')
})

live('stale operation takeover is restricted to the configured tenant', async context => {
  for (const tenantId of ['tenant-1', 'tenant-2']) {
    const identity = { operation: 'provision', idempotencyKey: `stale-${tenantId}`, tenantId }
    assert.equal((await context.first.claimOperation({ ...identity, requestHash: canonicalRequestHash(identity),
      workerId: 'dead' })).kind, 'claimed')
  }
  await context.firstPool.query("UPDATE hosted_agent_operations SET heartbeat_at = now() - interval '1 hour'")
  const firstTenant = await context.second.claimStaleOperations(new Date(), 10, 'reconciler-1', 'tenant-1')
  assert.deepEqual(firstTenant.map(operation => operation.tenantId), ['tenant-1'])
  const remaining = await context.first.claimStaleOperations(new Date(), 10, 'reconciler-2', 'tenant-2')
  assert.deepEqual(remaining.map(operation => operation.tenantId), ['tenant-2'])
})

live('lease binding atomically adopts only selected allocations under generation ownership', async context => {
  const identity = { operation: 'provision', idempotencyKey: 'bind-1', tenantId: 'tenant-1' }
  const claim = await context.first.claimOperation({ ...identity, requestHash: canonicalRequestHash(identity), workerId: 'worker-1' })
  assert.equal(claim.kind, 'claimed')
  if (claim.kind !== 'claimed') return
  const sandbox = await context.first.recordAllocation(identity, claim.generation, 'worker-1', {
    kind: 'sandbox', resourceId: 'sandbox-1',
  })
  const temporary = await context.first.recordAllocation(identity, claim.generation, 'worker-1', {
    kind: 'capture_sandbox', resourceId: 'capture-1',
  })
  await context.firstPool.query(`
    INSERT INTO hosted_agent_leases
      (lease_id, environment_id, tenant_id, agent_id, provider_sandbox_id, sandbox_template,
       cwd_uri, workspace_root_uris, state, tool_policy, policy_version)
    VALUES ('lease-1', 'env-1', 'tenant-1', 'agent-1', 'sandbox-1', 'general-v1',
      'file:///workspace/root', '["file:///workspace/root"]'::jsonb,
      'provisioning', '{}'::jsonb, 1)
  `)
  await assert.rejects(
    context.second.bindLeaseAndAdoptAllocations(identity, claim.generation, 'worker-2', 'lease-1', [sandbox.allocationId]),
    OperationOwnershipError,
  )
  const before = await context.firstPool.query<{ primary_lease_id: string | null }>(`
    SELECT primary_lease_id FROM hosted_agent_operations WHERE operation = $1 AND idempotency_key = $2
  `, [identity.operation, identity.idempotencyKey])
  assert.equal(before.rows[0]!.primary_lease_id, null)
  const adopted = await context.first.bindLeaseAndAdoptAllocations(
    identity, claim.generation, 'worker-1', 'lease-1', [sandbox.allocationId],
  )
  assert.equal(adopted[0]!.leaseId, 'lease-1'); assert.equal(adopted[0]!.state, 'adopted')
  assert.equal((await context.second.listAllocations(identity)).find(item => item.allocationId === temporary.allocationId)!.state, 'allocated')
  await context.first.bindLeaseAndAdoptAllocations(identity, claim.generation, 'worker-1', 'lease-1', [sandbox.allocationId])
  await assert.rejects(
    context.first.bindLeaseAndAdoptAllocations(identity, claim.generation, 'worker-1', 'lease-1', [temporary.allocationId, '999999']),
    OperationOwnershipError,
  )
  const after = await context.firstPool.query<{ primary_lease_id: string }>(`
    SELECT primary_lease_id FROM hosted_agent_operations WHERE operation = $1 AND idempotency_key = $2
  `, [identity.operation, identity.idempotencyKey])
  assert.equal(after.rows[0]!.primary_lease_id, 'lease-1')
  assert.equal(await context.second.hasUnreclaimedAllocation('sandbox', 'sandbox-1'), true)
  await context.first.completeOperation(identity, claim.generation, 'worker-1', { leaseId: 'lease-1' })
  assert.equal(await context.second.hasUnreclaimedAllocation('sandbox', 'sandbox-1'), false)
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

live('session lease locks fence lifecycle transactions across durable phase commits', async context => {
  await context.firstPool.query(`
    INSERT INTO hosted_agent_leases
      (lease_id, environment_id, tenant_id, agent_id, sandbox_template, cwd_uri,
       workspace_root_uris, state, tool_policy, policy_version)
    VALUES ('lease-session', 'env-session', 'tenant-1', 'agent-session', 'general-v1',
      'file:///workspace/root', '["file:///workspace/root"]'::jsonb,
      'provisioning', '{}'::jsonb, 1)
  `)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let held!: () => void
  const holding = new Promise<void>(resolve => { held = resolve })
  let acquired = false
  const session = context.first.withSessionLeaseLocks(
    'tenant-1', ['lease-session'], async client => {
      await client.query('BEGIN')
      await client.query("UPDATE hosted_agent_leases SET sandbox_template = 'general-v1' WHERE lease_id = 'lease-session'")
      await client.query('COMMIT')
      held()
      await gate
    })
  await holding
  const transaction = context.second.withLeaseLocks('tenant-1', ['lease-session'], async () => {
    acquired = true
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(acquired, false)
  release()
  await Promise.all([session, transaction])
  assert.equal(acquired, true)
})

live('provider resource locks serialize the same durable provider identity across replicas', async context => {
  let active = 0; let maximum = 0
  const enter = async () => {
    active += 1; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 30))
    active -= 1
  }
  await Promise.all([
    context.first.withProviderResourceLock('sandbox', 'sandbox-shared', enter),
    context.second.withProviderResourceLock('sandbox', 'sandbox-shared', enter),
  ])
  assert.equal(maximum, 1)

  active = 0; maximum = 0
  await Promise.all([
    context.first.withProviderResourceLock('sandbox', 'sandbox-one', enter),
    context.second.withProviderResourceLock('sandbox', 'sandbox-two', enter),
  ])
  assert.equal(maximum, 2)

  await assert.rejects(context.first.withProviderResourceLock('provider_snapshot', 'snapshot-throw', async () => {
    throw new Error('injected provider failure')
  }), /injected provider failure/)
  await context.second.withProviderResourceLock('provider_snapshot', 'snapshot-throw', async () => undefined)

  const singlePool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${context.schema}`, max: 1 })
  try {
    const single = new PostgresJournal(singlePool)
    await single.withProviderResourceLock('sandbox', 'sandbox-single-pool', async client => {
      const result = await client.query<{ value: number }>('SELECT 1 AS value')
      assert.equal(result.rows[0]!.value, 1)
    })
  } finally {
    await singlePool.end()
  }
})

live('compound provider locks deduplicate and avoid reversed-order replica deadlocks', async context => {
  let active = 0
  let maximum = 0
  const completed: string[] = []
  const enter = async (label: string, client: import('pg').PoolClient) => {
    active += 1
    maximum = Math.max(maximum, active)
    await client.query('SELECT pg_sleep(0.05)')
    completed.push(label)
    active -= 1
  }
  await Promise.all([
    context.first.withProviderResourceLocks([
      { kind: 'sandbox', resourceId: 'compound-sandbox' },
      { kind: 'provider_snapshot', resourceId: 'compound-snapshot' },
      { kind: 'sandbox', resourceId: 'compound-sandbox' },
    ], client => enter('first', client)),
    context.second.withProviderResourceLocks([
      { kind: 'provider_snapshot', resourceId: 'compound-snapshot' },
      { kind: 'sandbox', resourceId: 'compound-sandbox' },
    ], client => enter('second', client)),
  ])
  assert.equal(maximum, 1)
  assert.deepEqual(new Set(completed), new Set(['first', 'second']))
})
