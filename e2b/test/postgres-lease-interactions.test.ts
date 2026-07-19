import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { runMigrations } from '../src/migrate.js'
import {
  LeaseInteractionConflictError,
  LeaseNotQuiescentError,
  PostgresLeaseInteractionGate,
  hostedCodeModeProcessId,
  type LeaseInteractionIdentity,
} from '../src/postgres-lease-interactions.js'
import { PostgresDurableState } from '../src/postgres-state.js'
import { PostgresJournal } from '../src/postgres-store.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const tenantId = 'tenant-interactions'

interface Fixture {
  admin: Pool
  pools: [Pool, Pool]
  journals: [PostgresJournal, PostgresJournal]
  gates: [PostgresLeaseInteractionGate, PostgresLeaseInteractionGate]
  schema: string
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_interactions_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pools = [0, 1].map(() => new Pool({
    connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4,
  })) as [Pool, Pool]
  await runMigrations(pools[0])
  await pools[0].query(`
    INSERT INTO hosted_agent_leases
      (lease_id, environment_id, tenant_id, agent_id, provider_sandbox_id,
       sandbox_template, cwd_uri, workspace_root_uris, state, tool_policy, policy_version)
    VALUES ('lease-active', 'environment-active', $1, 'agent', 'sandbox-active',
      'general-v1', 'file:///workspace/root', '["file:///workspace/root"]'::jsonb,
      'active', '{"allowedDomains":[],"allowedTools":[]}'::jsonb, 1)
  `, [tenantId])
  const journals = pools.map(pool => new PostgresJournal(pool)) as
    [PostgresJournal, PostgresJournal]
  const states = pools.map(pool => new PostgresDurableState(pool))
  const gates = journals.map((journal, index) =>
    new PostgresLeaseInteractionGate(journal, states[index]!)) as
    [PostgresLeaseInteractionGate, PostgresLeaseInteractionGate]
  return { admin, pools, journals, gates, schema }
}

async function close(context: Fixture): Promise<void> {
  await Promise.all(context.pools.map(pool => pool.end()))
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

const processInteraction = (interactionId = 'interaction-process'): LeaseInteractionIdentity => ({
  tenantId, leaseId: 'lease-active', interactionId, connectionGeneration: 0,
  sessionId: 'session-1', kind: 'process', processId: 'process-1',
})

test('lease interaction transitions are exact, idempotent, and terminal', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const identity = processInteraction()
    assert.equal((await context.gates[0].begin(identity)).state, 'active')
    assert.equal((await context.gates[1].begin(identity)).state, 'active')
    await assert.rejects(context.gates[1].begin({
      ...identity, interactionId: 'other-process-interaction',
    }), LeaseInteractionConflictError)
    assert.equal((await context.gates[0].detach(identity)).state, 'detached')
    await context.journals[1].withLeaseLocks(tenantId, [identity.leaseId], client =>
      assert.rejects(context.gates[1].assertQuiescent(
        tenantId, identity.leaseId, 0, client), LeaseNotQuiescentError))
    assert.equal((await context.gates[1].resume(identity)).state, 'active')
    assert.equal((await context.gates[0].finish(identity)).state, 'finished')
    assert.equal((await context.gates[1].finish(identity)).state, 'finished')
    const reused = { ...identity, interactionId: 'reused-process-interaction' }
    assert.equal((await context.gates[0].begin(reused)).state, 'active')
    assert.equal((await context.gates[1].finish(reused)).state, 'finished')
    await context.journals[0].withLeaseLocks(tenantId, [identity.leaseId], client =>
      context.gates[0].assertQuiescent(tenantId, identity.leaseId, 0, client))
    await assert.rejects(context.gates[0].resume(identity), LeaseInteractionConflictError)
    await assert.rejects(context.pools[0].query(`
      UPDATE hosted_agent_lease_interactions SET session_id = 'tampered'
      WHERE interaction_id = $1
    `, [identity.interactionId]), /lease interaction identity is immutable/)
  } finally { await close(context) }
})

test('the exact lease-bound code-mode host does not permanently block workspace lifecycle', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const runtime: LeaseInteractionIdentity = {
      ...processInteraction('hosted-code-mode-runtime'),
      processId: hostedCodeModeProcessId('lease-active', 'environment-active', 0),
    }
    await context.gates[0].begin(runtime)
    await context.journals[0].withLeaseLocks(tenantId, [runtime.leaseId], client =>
      context.gates[0].assertQuiescent(tenantId, runtime.leaseId, 0, client))

    const ordinary = processInteraction('ordinary-command')
    await context.gates[0].begin(ordinary)
    await assert.rejects(context.journals[0].withLeaseLocks(
      tenantId, [ordinary.leaseId], client =>
        context.gates[0].assertQuiescent(tenantId, ordinary.leaseId, 0, client)),
    LeaseNotQuiescentError)
    await context.gates[0].finish(ordinary)
    await context.gates[0].finish(runtime)
  } finally { await close(context) }
})

test('command admission and lifecycle quiescence share one cross-replica lease gate', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const identity = processInteraction('interaction-serialized')
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const lifecycleEntered = new Promise<void>(resolve => { entered = resolve })
    let admissionCompleted = false
    const lifecycle = context.journals[0].withSessionLeaseLocks(
      tenantId, [identity.leaseId], async client => {
        await client.query('BEGIN')
        try {
          await context.gates[0].assertQuiescent(tenantId, identity.leaseId, 0, client)
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
        entered()
        await held
      })
    await lifecycleEntered
    const admission = context.gates[1].begin(identity).then(value => {
      admissionCompleted = true
      return value
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(admissionCompleted, false)
    release()
    await lifecycle
    assert.equal((await admission).state, 'active')

    await assert.rejects(context.journals[0].withLeaseLocks(
      tenantId, [identity.leaseId], client =>
        context.gates[0].assertQuiescent(tenantId, identity.leaseId, 0, client)),
    LeaseNotQuiescentError)
    await context.gates[1].finish(identity)
  } finally { await close(context) }
})

test('interaction admission and quiescence are generation fenced', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try {
    const detached = processInteraction('interaction-before-rotation')
    await context.gates[0].begin(detached)
    await context.gates[0].detach(detached)
    await context.pools[0].query(`
      UPDATE hosted_agent_leases SET connection_generation = 1 WHERE lease_id = 'lease-active'
    `)
    await assert.rejects(context.gates[0].begin(processInteraction()),
      LeaseInteractionConflictError)
    await assert.rejects(context.journals[0].withLeaseLocks(
      tenantId, ['lease-active'], client =>
        context.gates[0].assertQuiescent(tenantId, 'lease-active', 0, client)),
    LeaseInteractionConflictError)
    assert.deepEqual(await context.gates[1].listUnfinishedProcesses(
      tenantId, 'lease-active', 1, detached.sessionId), [detached])
    assert.equal((await context.gates[1].reattach(detached, 1)).state, 'active')
    await context.gates[0].finish(detached)
    const filesystem: LeaseInteractionIdentity = {
      tenantId, leaseId: 'lease-active', interactionId: 'filesystem-request',
      connectionGeneration: 1, sessionId: 'session-2', kind: 'filesystem', processId: null,
    }
    assert.equal((await context.gates[1].begin(filesystem)).state, 'active')
    assert.deepEqual(await context.gates[0].listUnfinishedFilesystem(
      tenantId, 'lease-active', 1, filesystem.sessionId), [filesystem])
    assert.equal((await context.gates[0].finish(filesystem)).state, 'finished')
  } finally { await close(context) }
})
