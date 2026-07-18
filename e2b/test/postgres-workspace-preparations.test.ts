import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { runMigrations } from '../src/migrate.js'
import { PostgresDurableState, type StoredObject } from '../src/postgres-state.js'
import { canonicalRequestHash, OperationOwnershipError, PostgresJournal } from '../src/postgres-store.js'
import {
  canonicalWorkspacePreparationIntent,
  PostgresWorkspacePreparations,
  WorkspacePreparationConflictError,
  type PreparationFence,
  type WorkspacePreparationIntent,
} from '../src/postgres-workspace-preparations.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL

function intent(overrides: Partial<WorkspacePreparationIntent> = {}): WorkspacePreparationIntent {
  return {
    tenantId: 'tenant-1', leaseId: 'lease-1', environmentId: 'environment-1', agentId: 'agent-1',
    ownerAgentId: null, ownerLeaseId: null, sourceSnapshotId: null, expectedSourceChecksum: null,
    providerSandboxId: 'sandbox-1', sandboxTemplate: 'general-v1', cwdUri: 'file:///workspace/root',
    workspaceRootUris: ['file:///workspace/root'], toolPolicy: {
      allowedDomains: ['controlPlane'], allowedTools: [{ namespace: 'workspace', name: 'read' }],
    },
    policyVersion: 1, snapshotId: 'snapshot-1', providerSnapshotId: 'provider-snapshot-1',
    snapshotExpiresAt: null, archiveChecksum: `sha256:${'a'.repeat(64)}`,
    manifestChecksum: `sha256:${'b'.repeat(64)}`,
    ...overrides,
  }
}

test('workspace preparation intents are canonical and require complete source identity', () => {
  const first = canonicalWorkspacePreparationIntent(intent())
  const second = canonicalWorkspacePreparationIntent(intent({ toolPolicy: {
    allowedTools: [{ name: 'read', namespace: 'workspace' }], allowedDomains: ['controlPlane'],
  } }))
  assert.equal(first.hash, second.hash)
  assert.equal(first.canonicalJson, second.canonicalJson)
  assert.throws(() => canonicalWorkspacePreparationIntent(intent({ sourceSnapshotId: 'source-1' })), /paired/)
  assert.throws(() => canonicalWorkspacePreparationIntent(intent({
    sourceSnapshotId: 'source-1', expectedSourceChecksum: 'not-a-checksum',
  })), /source checksum/)
  assert.throws(() => canonicalWorkspacePreparationIntent({ ...intent(), accessToken: 'secret' } as WorkspacePreparationIntent),
    /invalid workspace preparation intent/)
  assert.throws(() => canonicalWorkspacePreparationIntent(intent({ toolPolicy: {
    allowedDomains: [], allowedTools: [], accessToken: 'secret',
  } })), /invalid tool policy/)
  assert.throws(() => canonicalWorkspacePreparationIntent(intent({ toolPolicy: {
    allowedDomains: [], allowedTools: Array.from({ length: 200 }, (_, index) => ({
      name: `${index}-${'x'.repeat(400)}`, namespace: null,
    })),
  } })), /too large/)
})

interface Fixture {
  admin: Pool
  firstPool: Pool
  secondPool: Pool
  schema: string
  journal: PostgresJournal
  state: PostgresDurableState
  preparations: PostgresWorkspacePreparations
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_workspace_preparations_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const config = { connectionString: databaseUrl, options: `-c search_path=${schema}` }
  const firstPool = new Pool(config); const secondPool = new Pool(config)
  await runMigrations(firstPool)
  return { admin, firstPool, secondPool, schema, journal: new PostgresJournal(firstPool),
    state: new PostgresDurableState(firstPool), preparations: new PostgresWorkspacePreparations(firstPool) }
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

async function claim(context: Fixture, idempotencyKey: string): Promise<PreparationFence> {
  const identity = { operation: 'provision', idempotencyKey, tenantId: 'tenant-1' }
  const workerId = `worker-${idempotencyKey}`
  const claimed = await context.journal.claimOperation({
    ...identity, workerId, requestHash: canonicalRequestHash(identity),
  })
  assert.equal(claimed.kind, 'claimed')
  if (claimed.kind !== 'claimed') throw new Error('operation was not claimed')
  return { ...identity, workerId, generation: claimed.generation }
}

function object(objectId: string, kind: StoredObject['kind'], character: string): StoredObject {
  return {
    objectId, tenantId: 'tenant-1', kind, storageBucket: 'workspace-preparation-test',
    storageKey: `sha256/${character.repeat(64)}`, checksum: `sha256:${character.repeat(64)}`,
    sizeBytes: 10, state: 'available', expiresAt: null,
  }
}

async function prepared(context: Fixture, fence: PreparationFence, preparationId: string,
  preparationIntent = intent()): Promise<{ allocationIds: string[] }> {
  await context.preparations.createOrReplay({ ...fence, preparationId, intent: preparationIntent, expectedObjectCount: 2 })
  const objects = [object(`${preparationId}-archive`, 'workspace_archive', 'a'),
    object(`${preparationId}-manifest`, 'manifest', 'b')]
  const allocationIds: string[] = []
  for (const [index, stored] of objects.entries()) {
    await context.state.registerObject(stored)
    const allocation = await context.journal.recordAllocation(fence, fence.generation, fence.workerId,
      { kind: 'object', resourceId: stored.objectId })
    allocationIds.push(allocation.allocationId)
    await context.preparations.associateObject({ ...fence, preparationId,
      allocationId: allocation.allocationId, objectId: stored.objectId,
      purpose: index === 0 ? 'workspace_archive' : 'manifest' })
  }
  await context.preparations.markPrepared(fence, preparationId)
  return { allocationIds }
}

live('create/replay is exact and generation-worker fenced', async context => {
  const fence = await claim(context, 'create-replay')
  const created = await context.preparations.createOrReplay({
    ...fence, preparationId: 'preparation-1', intent: intent(), expectedObjectCount: 2,
  })
  const replay = await context.preparations.createOrReplay({
    ...fence, preparationId: 'preparation-1', intent: intent({ toolPolicy: {
      allowedTools: [{ name: 'read', namespace: 'workspace' }], allowedDomains: ['controlPlane'],
    } }),
    expectedObjectCount: 2,
  })
  assert.equal(replay.preparationId, created.preparationId)
  assert.equal(replay.intentHash, created.intentHash)
  await assert.rejects(context.preparations.createOrReplay({
    ...fence, preparationId: 'preparation-1', intent: intent({ leaseId: 'different-lease' }), expectedObjectCount: 2,
  }), WorkspacePreparationConflictError)
  await assert.rejects(context.preparations.createOrReplay({
    ...fence, preparationId: 'different-preparation', intent: intent(), expectedObjectCount: 2,
  }), WorkspacePreparationConflictError)
  await assert.rejects(context.preparations.createOrReplay({
    ...fence, workerId: 'wrong-worker', preparationId: 'preparation-1', intent: intent(), expectedObjectCount: 2,
  }), OperationOwnershipError)
})

live('object associations are tenant-safe, exact, idempotent, and counted before prepared', async context => {
  const fence = await claim(context, 'associate')
  const preparationId = 'preparation-associate'
  await context.preparations.createOrReplay({ ...fence, preparationId, intent: intent(), expectedObjectCount: 2 })
  const archive = object('associate-archive', 'workspace_archive', 'a')
  const manifest = object('associate-manifest', 'manifest', 'b')
  await context.state.registerObject(archive); await context.state.registerObject(manifest)
  const archiveAllocation = await context.journal.recordAllocation(fence, fence.generation, fence.workerId,
    { kind: 'object', resourceId: archive.objectId })
  const manifestAllocation = await context.journal.recordAllocation(fence, fence.generation, fence.workerId,
    { kind: 'object', resourceId: manifest.objectId })
  const association = { ...fence, preparationId, allocationId: archiveAllocation.allocationId,
    objectId: archive.objectId, purpose: 'workspace_archive' as const }
  assert.deepEqual(await context.preparations.associateObject(association),
    await context.preparations.associateObject(association))
  await assert.rejects(context.preparations.associateObject({ ...association, purpose: 'manifest' }),
    WorkspacePreparationConflictError)
  await assert.rejects(context.preparations.markPrepared(fence, preparationId), /incomplete/)
  await assert.rejects(context.preparations.associateObject({ ...fence, preparationId,
    allocationId: manifestAllocation.allocationId, objectId: manifest.objectId, purpose: 'content_blob' }),
  WorkspacePreparationConflictError)

  const otherFence = await claim(context, 'other-operation-allocation')
  const foreign = await context.journal.recordAllocation(otherFence, otherFence.generation, otherFence.workerId,
    { kind: 'object', resourceId: manifest.objectId })
  await assert.rejects(context.preparations.associateObject({ ...fence, preparationId,
    allocationId: foreign.allocationId, objectId: manifest.objectId, purpose: 'manifest' }),
  WorkspacePreparationConflictError)

  await context.preparations.associateObject({ ...fence, preparationId,
    allocationId: manifestAllocation.allocationId, objectId: manifest.objectId, purpose: 'manifest' })
  await context.firstPool.query(`UPDATE hosted_agent_operation_allocations SET state = 'reclaim_pending'
    WHERE allocation_id = $1::bigint`, [archiveAllocation.allocationId])
  await assert.rejects(context.preparations.markPrepared(fence, preparationId), /incomplete/)
  await context.firstPool.query(`UPDATE hosted_agent_operation_allocations SET state = 'allocated'
    WHERE allocation_id = $1::bigint`, [archiveAllocation.allocationId])
  const marked = await context.preparations.markPrepared(fence, preparationId)
  assert.equal(marked.state, 'prepared'); assert.equal(marked.associatedObjectCount, 2)
})

live('commit and abort linearize on the preparation row and rollback hands ownership to abort', async context => {
  const committedFence = await claim(context, 'commit-wins')
  await prepared(context, committedFence, 'preparation-commit')
  const commitClient = await context.firstPool.connect()
  const abortClient = await context.secondPool.connect()
  try {
    await commitClient.query('BEGIN'); await abortClient.query('BEGIN')
    await context.preparations.lockForCommit(committedFence, 'preparation-commit', intent(), commitClient)
    const abort = context.preparations.beginAbort(committedFence, 'preparation-commit', abortClient)
    const committed = await context.preparations.markCommitted(
      committedFence, 'preparation-commit', intent(), commitClient)
    assert.equal((await context.preparations.markCommitted(
      committedFence, 'preparation-commit', intent(), commitClient)).committedAt?.getTime(),
    committed.committedAt?.getTime())
    await commitClient.query('COMMIT')
    const afterCommit = await abort
    assert.equal(afterCommit.state, 'committed')
    await abortClient.query('COMMIT')
  } finally {
    await commitClient.query('ROLLBACK').catch(() => undefined); commitClient.release()
    await abortClient.query('ROLLBACK').catch(() => undefined); abortClient.release()
  }

  const rollbackFence = await claim(context, 'rollback-to-abort')
  const rollbackIntent = intent({ leaseId: 'lease-rollback', environmentId: 'environment-rollback',
    snapshotId: 'snapshot-rollback', providerSnapshotId: 'provider-snapshot-rollback' })
  const rollbackObjects = await prepared(context, rollbackFence, 'preparation-rollback', rollbackIntent)
  const rollbackClient = await context.firstPool.connect()
  try {
    await rollbackClient.query('BEGIN')
    await context.preparations.markCommitted(rollbackFence, 'preparation-rollback', rollbackIntent, rollbackClient)
    await rollbackClient.query('ROLLBACK')
  } finally { rollbackClient.release() }
  const abortAfterRollback = await context.secondPool.connect()
  try {
    await abortAfterRollback.query('BEGIN')
    const pending = await context.preparations.beginAbort(rollbackFence, 'preparation-rollback', abortAfterRollback)
    assert.equal(pending.state, 'reclaim_pending')
    await abortAfterRollback.query('COMMIT')
  } finally { abortAfterRollback.release() }
  const rejectedClient = await context.firstPool.connect()
  try {
    await rejectedClient.query('BEGIN')
    await assert.rejects(context.preparations.lockForCommit(
      rollbackFence, 'preparation-rollback', rollbackIntent, rejectedClient), WorkspacePreparationConflictError)
    await rejectedClient.query('ROLLBACK')
  } finally { rejectedClient.release() }

  await context.firstPool.query(`UPDATE hosted_agent_operation_allocations
    SET state = 'reclaimed', reclaimed_at = now()
    WHERE allocation_id = ANY($1::bigint[])`, [rollbackObjects.allocationIds])
  const reclaimedClient = await context.firstPool.connect()
  try {
    await reclaimedClient.query('BEGIN')
    const reclaimed = await context.preparations.markReclaimed(
      rollbackFence, 'preparation-rollback', reclaimedClient)
    assert.equal(reclaimed.state, 'reclaimed')
    assert.equal((await context.preparations.markReclaimed(
      rollbackFence, 'preparation-rollback', reclaimedClient)).reclaimedAt?.getTime(),
    reclaimed.reclaimedAt?.getTime())
    await reclaimedClient.query('COMMIT')
  } finally { reclaimedClient.release() }
  await context.firstPool.query(`DELETE FROM hosted_agent_objects
    WHERE object_id IN ('preparation-rollback-archive', 'preparation-rollback-manifest')`)
  assert.equal((await context.firstPool.query(`SELECT 1 FROM hosted_agent_workspace_preparation_objects
    WHERE preparation_id = 'preparation-rollback'`)).rowCount, 0)
})

live('stale takeover resumes exact preparation and rejects the old operation fence', async context => {
  const oldFence = await claim(context, 'stale-takeover')
  await context.preparations.createOrReplay({
    ...oldFence, preparationId: 'preparation-takeover', intent: intent(), expectedObjectCount: 2,
  })
  await context.firstPool.query(`UPDATE hosted_agent_operations
    SET heartbeat_at = now() - interval '10 minutes'
    WHERE operation = $1 AND idempotency_key = $2`, [oldFence.operation, oldFence.idempotencyKey])
  const taken = await context.journal.claimStaleOperations(new Date(), 1, 'takeover-worker', 'tenant-1')
  assert.equal(taken.length, 1)
  const newFence: PreparationFence = { operation: taken[0]!.operation,
    idempotencyKey: taken[0]!.idempotencyKey, tenantId: taken[0]!.tenantId,
    generation: taken[0]!.generation, workerId: taken[0]!.workerId }
  await assert.rejects(context.preparations.createOrReplay({
    ...oldFence, preparationId: 'preparation-takeover', intent: intent(), expectedObjectCount: 2,
  }), OperationOwnershipError)
  assert.equal((await context.preparations.createOrReplay({
    ...newFence, preparationId: 'preparation-takeover', intent: intent(), expectedObjectCount: 2,
  })).createdGeneration, oldFence.generation)
})

live('database guards reject illegal preparation mutation and final locks reject unavailable objects', async context => {
  const fence = await claim(context, 'database-guards')
  await prepared(context, fence, 'preparation-guards')
  await assert.rejects(context.firstPool.query(`UPDATE hosted_agent_workspace_preparations
    SET lease_id = 'changed' WHERE preparation_id = 'preparation-guards'`), /identity is immutable/)
  await assert.rejects(context.firstPool.query(`UPDATE hosted_agent_workspace_preparations
    SET state = 'reclaimed', reclaimed_at = now() WHERE preparation_id = 'preparation-guards'`), /illegal.*transition/)
  await assert.rejects(context.firstPool.query(`UPDATE hosted_agent_objects SET checksum = $1
    WHERE object_id = 'preparation-guards-archive'`, [`sha256:${'f'.repeat(64)}`]), /object identity is immutable/)
  await context.firstPool.query(`UPDATE hosted_agent_objects SET state = 'deleting'
    WHERE object_id = 'preparation-guards-archive'`)
  const client = await context.firstPool.connect()
  try {
    await client.query('BEGIN')
    await assert.rejects(context.preparations.lockForCommit(
      fence, 'preparation-guards', intent(), client), WorkspacePreparationConflictError)
    await client.query('ROLLBACK')
  } finally { client.release() }
  await assert.rejects(context.preparations.associateObject({ ...fence,
    preparationId: 'preparation-guards', allocationId: '999999999999999999999',
    objectId: 'preparation-guards-archive', purpose: 'workspace_archive' }), /invalid allocation ID/)
})
