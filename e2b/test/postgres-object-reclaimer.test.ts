import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import { PostgresObjectReclaimer } from '../src/postgres-object-reclaimer.js'
import { PostgresDurableState, type StoredObject } from '../src/postgres-state.js'
import { canonicalRequestHash, OperationOwnershipError, PostgresJournal, type OperationIdentity } from '../src/postgres-store.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL

class MemoryObjectStore implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  readonly deletes: string[] = []
  failDelete = false
  failAfterDelete = false

  async put(bytes: Uint8Array): Promise<string> {
    const id = createHash('sha256').update(bytes).digest('hex')
    this.values.set(id, Uint8Array.from(bytes))
    return id
  }

  async get(id: string): Promise<Uint8Array> {
    const value = this.values.get(id)
    if (!value) throw new Error('missing object')
    return Uint8Array.from(value)
  }

  async delete(id: string): Promise<void> {
    this.deletes.push(id)
    if (this.failDelete) throw new Error('object-store delete failed')
    this.values.delete(id)
    if (this.failAfterDelete) throw new Error('process lost after object-store delete')
  }

  location(id: string): { storageBucket: string; storageKey: string } {
    if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error('invalid object identifier')
    return { storageBucket: 'reclaimer-test', storageKey: `objects/sha256/${id.slice(0, 2)}/${id}` }
  }
}

interface Fixture {
  admin: Pool
  pool: Pool
  schema: string
  journal: PostgresJournal
  state: PostgresDurableState
  objects: MemoryObjectStore
  reclaimer: PostgresObjectReclaimer
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_object_reclaimer_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  await runMigrations(pool)
  const objects = new MemoryObjectStore()
  return {
    admin, pool, schema, objects,
    journal: new PostgresJournal(pool),
    state: new PostgresDurableState(pool),
    reclaimer: new PostgresObjectReclaimer(pool, objects),
  }
}

async function cleanup(context: Fixture): Promise<void> {
  await context.pool.end()
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

const live = (name: string, fn: (context: Fixture) => Promise<void>) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try { await fn(context) } finally { await cleanup(context) }
})

async function operation(context: Fixture, tenantId = 'tenant-1') {
  const identity: OperationIdentity = {
    operation: 'provision', idempotencyKey: randomUUID(), tenantId,
  }
  const workerId = 'reclaimer-worker'
  const claim = await context.journal.claimOperation({
    ...identity, workerId, requestHash: canonicalRequestHash(identity),
  })
  assert.equal(claim.kind, 'claimed')
  if (claim.kind !== 'claimed') throw new Error('operation was not claimed')
  return { identity, workerId, generation: claim.generation }
}

async function allocatedObject(context: Fixture, owner: Awaited<ReturnType<typeof operation>>,
  objectId: string, body: string, tenantId = owner.identity.tenantId): Promise<{ object: StoredObject; storageId: string }> {
  const bytes = Buffer.from(body)
  const storageId = await context.objects.put(bytes)
  const location = context.objects.location(storageId)
  const object: StoredObject = {
    objectId, tenantId, kind: 'content_blob', ...location,
    checksum: `sha256:${storageId}`, sizeBytes: bytes.byteLength, state: 'available', expiresAt: null,
  }
  await context.state.registerObject(object)
  await context.journal.recordAllocation(owner.identity, owner.generation, owner.workerId, {
    kind: 'object', resourceId: objectId,
  })
  return { object, storageId }
}

live('reclaims unreferenced objects in bounded batches and preserves deleted audit rows', async context => {
  const owner = await operation(context)
  const first = await allocatedObject(context, owner, 'object-1', 'first')
  const second = await allocatedObject(context, owner, 'object-2', 'second')

  assert.deepEqual(await context.reclaimer.reclaimOperationObjects(
    owner.identity, owner.generation, owner.workerId, 1,
  ), { claimed: 1, reclaimed: 1, retained: 0, shared: 0 })
  assert.equal(context.objects.deletes.length, 1)
  assert.equal(context.objects.values.size, 1)

  assert.deepEqual(await context.reclaimer.reclaimOperationObjects(
    owner.identity, owner.generation, owner.workerId, 1,
  ), { claimed: 1, reclaimed: 1, retained: 0, shared: 0 })
  assert.deepEqual(new Set(context.objects.deletes), new Set([first.storageId, second.storageId]))

  const rows = await context.pool.query<{ object_id: string; object_state: string; allocation_state: string; reclaimed_at: Date | null }>(`
    SELECT object_row.object_id, object_row.state AS object_state,
           allocation.state AS allocation_state, allocation.reclaimed_at
    FROM hosted_agent_objects AS object_row
    JOIN hosted_agent_operation_allocations AS allocation ON allocation.resource_id = object_row.object_id
    ORDER BY object_row.object_id
  `)
  assert.deepEqual(rows.rows.map(row => [row.object_id, row.object_state, row.allocation_state]), [
    ['object-1', 'deleted', 'reclaimed'], ['object-2', 'deleted', 'reclaimed'],
  ])
  assert.ok(rows.rows.every(row => row.reclaimed_at instanceof Date))
})

live('retains referenced objects and never deletes a locator shared by another tenant', async context => {
  const owner = await operation(context)
  const referenced = await allocatedObject(context, owner, 'referenced-object', 'referenced')
  await context.state.addObjectReference({
    tenantId: owner.identity.tenantId, objectId: referenced.object.objectId,
    referenceKind: 'operation', referenceId: 'durable-owner', purpose: 'result',
  })

  const shared = await allocatedObject(context, owner, 'shared-object', 'shared-content')
  await context.state.registerObject({ ...shared.object, objectId: 'other-tenant-object', tenantId: 'tenant-2' })

  assert.deepEqual(await context.reclaimer.reclaimOperationObjects(
    owner.identity, owner.generation, owner.workerId, 10,
  ), { claimed: 2, reclaimed: 1, retained: 1, shared: 1 })
  assert.equal(context.objects.values.has(referenced.storageId), true)
  assert.equal(context.objects.values.has(shared.storageId), true)
  assert.deepEqual(context.objects.deletes, [])

  const rows = await context.pool.query<{ object_id: string; state: string }>(`
    SELECT object_id, state FROM hosted_agent_objects ORDER BY object_id
  `)
  assert.deepEqual(rows.rows.map(row => [row.object_id, row.state]), [
    ['other-tenant-object', 'available'], ['referenced-object', 'available'], ['shared-object', 'deleted'],
  ])
})

live('delete failures remain resumable and operation fencing prevents deletion', async context => {
  const owner = await operation(context)
  const allocated = await allocatedObject(context, owner, 'retry-object', 'retry')

  await assert.rejects(
    context.reclaimer.reclaimOperationObjects(owner.identity, owner.generation, 'wrong-worker'),
    OperationOwnershipError,
  )
  assert.deepEqual(context.objects.deletes, [])

  context.objects.failDelete = true
  await assert.rejects(
    context.reclaimer.reclaimOperationObjects(owner.identity, owner.generation, owner.workerId),
    /object-store delete failed/,
  )
  const failed = await context.pool.query<{ object_state: string; allocation_state: string }>(`
    SELECT object_row.state AS object_state, allocation.state AS allocation_state
    FROM hosted_agent_objects AS object_row
    JOIN hosted_agent_operation_allocations AS allocation ON allocation.resource_id = object_row.object_id
    WHERE object_row.object_id = 'retry-object'
  `)
  assert.deepEqual(failed.rows[0], { object_state: 'deleting', allocation_state: 'reclaim_pending' })
  assert.equal(context.objects.values.has(allocated.storageId), true)

  context.objects.failDelete = false
  assert.deepEqual(await context.reclaimer.reclaimOperationObjects(
    owner.identity, owner.generation, owner.workerId,
  ), { claimed: 1, reclaimed: 1, retained: 0, shared: 0 })
  assert.equal(context.objects.values.has(allocated.storageId), false)

  const unregistered = await context.journal.recordAllocation(owner.identity, owner.generation, owner.workerId, {
    kind: 'object', resourceId: 'put-succeeded-but-registration-missing',
  })
  assert.deepEqual(await context.reclaimer.reclaimOperationObjects(
    owner.identity, owner.generation, owner.workerId,
  ), { claimed: 0, reclaimed: 0, retained: 0, shared: 0 })
  const allocation = await context.pool.query<{ state: string }>(`
    SELECT state FROM hosted_agent_operation_allocations WHERE allocation_id = $1::bigint
  `, [unregistered.allocationId])
  assert.equal(allocation.rows[0]?.state, 'allocated')

  const interrupted = await allocatedObject(context, owner, 'interrupted-object', 'interrupted')
  context.objects.failAfterDelete = true
  await assert.rejects(
    context.reclaimer.reclaimOperationObjects(owner.identity, owner.generation, owner.workerId),
    /process lost after object-store delete/,
  )
  assert.equal(context.objects.values.has(interrupted.storageId), false)
  const pending = await context.pool.query<{ object_state: string; allocation_state: string }>(`
    SELECT object_row.state AS object_state, allocation.state AS allocation_state
    FROM hosted_agent_objects AS object_row
    JOIN hosted_agent_operation_allocations AS allocation ON allocation.resource_id = object_row.object_id
    WHERE object_row.object_id = 'interrupted-object'
  `)
  assert.deepEqual(pending.rows[0], { object_state: 'deleting', allocation_state: 'reclaim_pending' })

  await context.journal.failOperation(owner.identity, owner.generation, owner.workerId, 'interrupted', 'worker exited')
  context.objects.failAfterDelete = false
  assert.equal(await context.objects.put(Buffer.from('interrupted')), interrupted.storageId)
  await context.state.registerObject({
    ...interrupted.object, objectId: 'replacement-object', state: 'available',
  })
  assert.deepEqual(await context.reclaimer.recoverDeletingObjects(owner.identity.tenantId), {
    found: 1, reclaimed: 1, failed: 0,
  })
  assert.equal(context.objects.values.has(interrupted.storageId), true)
  assert.equal(context.objects.deletes.filter(id => id === interrupted.storageId).length, 1)
  const recovered = await context.pool.query<{ object_state: string; allocation_state: string }>(`
    SELECT object_row.state AS object_state, allocation.state AS allocation_state
    FROM hosted_agent_objects AS object_row
    JOIN hosted_agent_operation_allocations AS allocation ON allocation.resource_id = object_row.object_id
    WHERE object_row.object_id = 'interrupted-object'
  `)
  assert.deepEqual(recovered.rows[0], { object_state: 'deleted', allocation_state: 'reclaimed' })
  const replacement = await context.pool.query<{ state: string }>(`
    SELECT state FROM hosted_agent_objects WHERE object_id = 'replacement-object'
  `)
  assert.deepEqual(replacement.rows[0], { state: 'available' })

  const recoveryOwner = await operation(context)
  const recoverable = await allocatedObject(context, recoveryOwner, 'recoverable-object', 'recoverable')
  context.objects.failAfterDelete = true
  await assert.rejects(context.reclaimer.reclaimOperationObjects(
    recoveryOwner.identity, recoveryOwner.generation, recoveryOwner.workerId,
  ), /process lost after object-store delete/)
  await context.journal.failOperation(recoveryOwner.identity, recoveryOwner.generation,
    recoveryOwner.workerId, 'interrupted', 'worker exited')
  context.objects.failAfterDelete = false
  assert.deepEqual(await context.reclaimer.recoverDeletingObjects(recoveryOwner.identity.tenantId), {
    found: 1, reclaimed: 1, failed: 0,
  })
  assert.equal(context.objects.values.has(recoverable.storageId), false)
  assert.equal(context.objects.deletes.filter(id => id === recoverable.storageId).length, 2)
})

live('replicas that claim the same pending object serialize and physically delete it once', async context => {
  const owner = await operation(context)
  const allocated = await allocatedObject(context, owner, 'contended-object', 'contended')
  const singlePool = new Pool({
    connectionString: databaseUrl, options: `-c search_path=${context.schema}`, max: 1,
  })
  try {
    const replicas = [
      new PostgresObjectReclaimer(singlePool, context.objects),
      new PostgresObjectReclaimer(singlePool, context.objects),
    ]
    const results = await Promise.all(replicas.map(replica => replica.reclaimOperationObjects(
      owner.identity, owner.generation, owner.workerId,
    )))
    assert.equal(results.some(result => result.reclaimed === 1), true)
    assert.deepEqual(context.objects.deletes, [allocated.storageId])
    const row = await context.pool.query<{ object_state: string; allocation_state: string }>(`
      SELECT object_row.state AS object_state, allocation.state AS allocation_state
      FROM hosted_agent_objects AS object_row
      JOIN hosted_agent_operation_allocations AS allocation ON allocation.resource_id = object_row.object_id
      WHERE object_row.object_id = 'contended-object'
    `)
    assert.deepEqual(row.rows[0], { object_state: 'deleted', allocation_state: 'reclaimed' })
  } finally { await singlePool.end() }
})
