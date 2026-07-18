import type { Pool, PoolClient } from 'pg'
import type { ObjectStore } from './blob-store.js'
import { OperationOwnershipError, type OperationIdentity } from './postgres-store.js'
import { WorkspacePreparationConflictError, type PreparationFence } from './postgres-workspace-preparations.js'

const checksumPattern = /^sha256:([0-9a-f]{64})$/u

interface CandidateRow {
  allocation_id: string
  resource_id: string
}

interface AllocationRow {
  state: 'allocated' | 'adopted' | 'reclaim_pending' | 'reclaimed'
}

interface ObjectRow {
  object_id: string
  tenant_id: string
  storage_bucket: string
  storage_key: string
  checksum: string
  state: 'pending' | 'available' | 'deleting' | 'deleted' | 'failed'
}

export interface ObjectReclaimBatchResult {
  claimed: number
  reclaimed: number
  retained: number
  shared: number
}

export interface ObjectDeleteRecoveryResult {
  found: number
  reclaimed: number
  failed: number
}

function validId(label: string, value: string, maximum = 512): void {
  if (!value.trim() || Buffer.byteLength(value) > maximum) throw new Error(`invalid ${label}`)
}

function validateOwnership(identity: OperationIdentity, generation: number, workerId: string, limit: number): void {
  validId('operation', identity.operation, 128)
  validId('idempotency key', identity.idempotencyKey)
  validId('tenant ID', identity.tenantId)
  validId('worker ID', workerId)
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid operation generation')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid object reclaim limit')
}

/** Reclaims registered object allocations through a resumable deleting state. */
export class PostgresObjectReclaimer {
  constructor(private readonly pool: Pool, private readonly objects: ObjectStore) {}

  async reclaimOperationObjects(identity: OperationIdentity, generation: number, workerId: string,
    limit = 100): Promise<ObjectReclaimBatchResult> {
    validateOwnership(identity, generation, workerId, limit)
    const candidates = await this.claimCandidates(identity, generation, workerId, limit)
    const result: ObjectReclaimBatchResult = {
      claimed: candidates.length, reclaimed: 0, retained: 0, shared: 0,
    }
    for (const candidate of candidates) {
      const outcome = await this.reclaimOne(identity, generation, workerId, candidate)
      if (outcome === 'reclaimed') result.reclaimed += 1
      else if (outcome === 'shared') { result.reclaimed += 1; result.shared += 1 }
      else result.retained += 1
    }
    return result
  }

  async reclaimPreparationObjects(fence: PreparationFence, preparationId: string,
    limit = 100): Promise<ObjectReclaimBatchResult> {
    validateOwnership(fence, fence.generation, fence.workerId, limit)
    validId('preparation ID', preparationId)
    const candidates = await this.claimPreparationCandidates(fence, preparationId, limit)
    const result: ObjectReclaimBatchResult = {
      claimed: candidates.length, reclaimed: 0, retained: 0, shared: 0,
    }
    for (const candidate of candidates) {
      const outcome = await this.reclaimOne(fence, fence.generation, fence.workerId, candidate)
      if (outcome === 'reclaimed') result.reclaimed += 1
      else if (outcome === 'shared') { result.reclaimed += 1; result.shared += 1 }
      else result.retained += 1
    }
    await this.finalizePreparationIfReclaimed(fence, preparationId)
    return result
  }

  async recoverDeletingObjects(tenantId: string, limit = 100): Promise<ObjectDeleteRecoveryResult> {
    validId('tenant ID', tenantId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid object reclaim limit')
    const candidates = await this.pool.query<ObjectRow>(`
      SELECT object_id, tenant_id, storage_bucket, storage_key, checksum, state
      FROM hosted_agent_objects
      WHERE tenant_id = $1 AND state = 'deleting'
      ORDER BY object_id
      LIMIT $2
    `, [tenantId, limit])
    let reclaimed = 0
    let failed = 0
    for (const candidate of candidates.rows) {
      try { if (await this.resumeDeletingObject(candidate)) reclaimed += 1 }
      catch { failed += 1 }
    }
    return { found: candidates.rows.length, reclaimed, failed }
  }

  private async claimCandidates(identity: OperationIdentity, generation: number, workerId: string,
    limit: number): Promise<CandidateRow[]> {
    return this.transaction(async client => {
      const result = await client.query<CandidateRow>(`
        WITH candidates AS (
          SELECT allocation.allocation_id
          FROM hosted_agent_operation_allocations AS allocation
          JOIN hosted_agent_operations AS owned_operation
            USING (operation, idempotency_key, tenant_id)
          JOIN hosted_agent_objects AS registered_object
            ON registered_object.object_id = allocation.resource_id
           AND registered_object.tenant_id = allocation.tenant_id
          WHERE allocation.operation = $1 AND allocation.idempotency_key = $2
            AND allocation.tenant_id = $3 AND allocation.allocation_kind = 'object'
            AND allocation.state IN ('allocated', 'reclaim_pending')
            AND owned_operation.generation = $4 AND owned_operation.worker_id = $5
            AND owned_operation.state = 'in_progress'
          ORDER BY allocation.allocation_id
          FOR UPDATE OF allocation SKIP LOCKED
          LIMIT $6
        )
        UPDATE hosted_agent_operation_allocations AS allocation
        SET state = 'reclaim_pending'
        FROM candidates
        WHERE allocation.allocation_id = candidates.allocation_id
        RETURNING allocation.allocation_id::text, allocation.resource_id
      `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId, limit])
      if (result.rows.length === 0) {
        const owned = await this.ownsOperation(client, identity, generation, workerId)
        if (!owned) throw new OperationOwnershipError()
      }
      return result.rows
    })
  }

  private async claimPreparationCandidates(fence: PreparationFence, preparationId: string,
    limit: number): Promise<CandidateRow[]> {
    return this.transaction(async client => {
      if (!await this.ownsOperation(client, fence, fence.generation, fence.workerId, true)) {
        throw new OperationOwnershipError()
      }
      const preparation = await client.query<{ state: string }>(`
        SELECT state FROM hosted_agent_workspace_preparations
        WHERE preparation_id = $1 AND operation = $2 AND idempotency_key = $3 AND tenant_id = $4
        FOR UPDATE
      `, [preparationId, fence.operation, fence.idempotencyKey, fence.tenantId])
      const state = preparation.rows[0]?.state
      if (state === 'reclaimed') return []
      if (state !== 'reclaim_pending') {
        throw new WorkspacePreparationConflictError('workspace preparation is not pending reclamation')
      }
      const result = await client.query<CandidateRow>(`
        WITH candidates AS (
          SELECT allocation.allocation_id
          FROM hosted_agent_workspace_preparation_objects AS prepared_object
          JOIN hosted_agent_operation_allocations AS allocation
            ON allocation.allocation_id = prepared_object.allocation_id
           AND allocation.operation = prepared_object.operation
           AND allocation.idempotency_key = prepared_object.idempotency_key
           AND allocation.tenant_id = prepared_object.tenant_id
          JOIN hosted_agent_objects AS registered_object
            ON registered_object.object_id = prepared_object.object_id
           AND registered_object.tenant_id = prepared_object.tenant_id
          WHERE prepared_object.preparation_id = $1
            AND prepared_object.operation = $2 AND prepared_object.idempotency_key = $3
            AND prepared_object.tenant_id = $4 AND allocation.allocation_kind = 'object'
            AND allocation.resource_id = prepared_object.object_id
            AND allocation.state IN ('allocated', 'reclaim_pending')
          ORDER BY allocation.allocation_id
          FOR UPDATE OF allocation SKIP LOCKED
          LIMIT $5
        )
        UPDATE hosted_agent_operation_allocations AS allocation
        SET state = 'reclaim_pending'
        FROM candidates
        WHERE allocation.allocation_id = candidates.allocation_id
        RETURNING allocation.allocation_id::text, allocation.resource_id
      `, [preparationId, fence.operation, fence.idempotencyKey, fence.tenantId, limit])
      return result.rows
    })
  }

  private async finalizePreparationIfReclaimed(fence: PreparationFence, preparationId: string): Promise<void> {
    await this.transaction(async client => {
      if (!await this.ownsOperation(client, fence, fence.generation, fence.workerId, true)) {
        throw new OperationOwnershipError()
      }
      const preparation = await client.query<{ state: string }>(`
        SELECT state FROM hosted_agent_workspace_preparations
        WHERE preparation_id = $1 AND operation = $2 AND idempotency_key = $3 AND tenant_id = $4
        FOR UPDATE
      `, [preparationId, fence.operation, fence.idempotencyKey, fence.tenantId])
      const state = preparation.rows[0]?.state
      if (state === 'reclaimed') return
      if (state !== 'reclaim_pending') {
        throw new WorkspacePreparationConflictError('workspace preparation left reclamation state')
      }
      const progress = await client.query<{ outstanding: string }>(`
        SELECT count(*) FILTER (WHERE allocation.state <> 'reclaimed')::text AS outstanding
        FROM hosted_agent_workspace_preparation_objects AS prepared_object
        JOIN hosted_agent_operation_allocations AS allocation
          ON allocation.allocation_id = prepared_object.allocation_id
         AND allocation.operation = prepared_object.operation
         AND allocation.idempotency_key = prepared_object.idempotency_key
         AND allocation.tenant_id = prepared_object.tenant_id
        WHERE prepared_object.preparation_id = $1
      `, [preparationId])
      if (progress.rows[0]!.outstanding !== '0') return
      const updated = await client.query(`
        UPDATE hosted_agent_workspace_preparations
        SET state = 'reclaimed', reclaimed_at = now(), committed_at = NULL
        WHERE preparation_id = $1 AND state = 'reclaim_pending'
      `, [preparationId])
      if (updated.rowCount !== 1) throw new WorkspacePreparationConflictError('workspace preparation reclaim lost')
    })
  }

  private async reclaimOne(identity: OperationIdentity, generation: number, workerId: string,
    candidate: CandidateRow): Promise<'reclaimed' | 'shared' | 'retained'> {
    const client = await this.pool.connect()
    let locationKey: string | undefined
    try {
      const locatorResult = await client.query<ObjectRow>(`
        SELECT object_id, tenant_id, storage_bucket, storage_key, checksum, state
        FROM hosted_agent_objects
        WHERE object_id = $1 AND tenant_id = $2
      `, [candidate.resource_id, identity.tenantId])
      const locator = locatorResult.rows[0]
      if (!locator) return 'retained'
      const storageId = this.storageIdFor(locator)
      locationKey = this.locationLockKey(locator)
      await this.lockLocation(client, locationKey)
      const prepared = await this.clientTransaction(client, async () => {
        await client.query("SET LOCAL lock_timeout = '30s'")
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`hosted-agent:object:${candidate.resource_id}`])
        const allocation = await client.query<AllocationRow>(`
          SELECT allocation.state
          FROM hosted_agent_operation_allocations AS allocation
          JOIN hosted_agent_operations AS owned_operation
            USING (operation, idempotency_key, tenant_id)
          WHERE allocation.allocation_id = $6::bigint
            AND allocation.operation = $1 AND allocation.idempotency_key = $2
            AND allocation.tenant_id = $3 AND allocation.allocation_kind = 'object'
            AND allocation.resource_id = $7
            AND owned_operation.generation = $4 AND owned_operation.worker_id = $5
            AND owned_operation.state = 'in_progress'
          FOR UPDATE OF allocation, owned_operation
        `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId,
          candidate.allocation_id, candidate.resource_id])
        if (allocation.rowCount !== 1) throw new OperationOwnershipError()
        if (allocation.rows[0]!.state === 'reclaimed') return 'complete' as const
        if (allocation.rows[0]!.state !== 'reclaim_pending') throw new OperationOwnershipError()

        const object = await this.lockObject(client, locator)
        if (object.state === 'deleted') {
          await this.markAllocationReclaimed(client, candidate.allocation_id)
          return 'complete' as const
        }
        if (object.state !== 'deleting' && await this.hasDurableReference(client, object.object_id)) {
          return 'retained' as const
        }
        if (object.state !== 'deleting') {
          const shared = await client.query(`
            SELECT 1 FROM hosted_agent_objects
            WHERE object_id <> $1 AND storage_bucket = $2 AND storage_key = $3
              AND state <> 'deleted'
            LIMIT 1
          `, [object.object_id, object.storage_bucket, object.storage_key])
          if (shared.rowCount === 1) {
            await this.markObjectAndAllocationDeleted(client, object.object_id, candidate.allocation_id)
            return 'shared' as const
          }
          await client.query(`UPDATE hosted_agent_objects SET state = 'deleting' WHERE object_id = $1`, [object.object_id])
        }
        return 'delete' as const
      })
      if (prepared === 'retained') return 'retained'
      if (prepared === 'shared') return 'shared'
      if (prepared === 'complete') return 'reclaimed'

      await this.objects.delete(storageId)
      await this.clientTransaction(client, async () => {
        const object = await this.lockObject(client, locator)
        if (object.state === 'deleting') {
          await client.query(`UPDATE hosted_agent_objects SET state = 'deleted' WHERE object_id = $1`, [object.object_id])
        } else if (object.state !== 'deleted') throw new Error('durable object left deleting state unexpectedly')
        const allocation = await client.query<AllocationRow>(`
          SELECT state FROM hosted_agent_operation_allocations WHERE allocation_id = $1::bigint FOR UPDATE
        `, [candidate.allocation_id])
        if (allocation.rows[0]?.state === 'reclaim_pending') {
          await this.markAllocationReclaimed(client, candidate.allocation_id)
        } else if (allocation.rows[0]?.state !== 'reclaimed') throw new OperationOwnershipError()
      })
      return 'reclaimed'
    } finally {
      if (locationKey) await this.releaseLocation(client, locationKey)
      else client.release()
    }
  }

  private async resumeDeletingObject(locator: ObjectRow): Promise<boolean> {
    const client = await this.pool.connect()
    const locationKey = this.locationLockKey(locator)
    try {
      const storageId = this.storageIdFor(locator)
      await this.lockLocation(client, locationKey)
      const action = await this.clientTransaction(client, async () => {
        const object = await this.lockObject(client, locator)
        if (object.state === 'deleted') return 'complete' as const
        if (object.state !== 'deleting') return 'skip' as const
        const shared = await client.query(`
          SELECT 1 FROM hosted_agent_objects
          WHERE object_id <> $1 AND storage_bucket = $2 AND storage_key = $3
            AND state <> 'deleted'
          LIMIT 1
        `, [object.object_id, object.storage_bucket, object.storage_key])
        if (shared.rowCount === 1) {
          await this.finalizeRecoveredObject(client, object)
          return 'shared' as const
        }
        return 'delete' as const
      })
      if (action === 'complete' || action === 'skip') return false
      if (action === 'shared') return true

      await this.objects.delete(storageId)
      await this.clientTransaction(client, async () => {
        const locked = await this.lockObject(client, locator)
        if (locked.state === 'deleting') await this.finalizeRecoveredObject(client, locked)
        else if (locked.state !== 'deleted') throw new Error('durable object left deleting state unexpectedly')
      })
      return true
    } finally {
      await this.releaseLocation(client, locationKey)
    }
  }

  private async finalizeRecoveredObject(client: PoolClient, object: ObjectRow): Promise<void> {
    await client.query(`UPDATE hosted_agent_objects SET state = 'deleted' WHERE object_id = $1`, [object.object_id])
    await client.query(`
      UPDATE hosted_agent_operation_allocations
      SET state = 'reclaimed', reclaimed_at = now()
      WHERE tenant_id = $1 AND allocation_kind = 'object' AND resource_id = $2
        AND state = 'reclaim_pending'
    `, [object.tenant_id, object.object_id])
  }

  private async lockLocation(client: PoolClient, key: string): Promise<void> {
    await client.query("SET statement_timeout = '30s'")
    try { await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]) }
    finally { await client.query('RESET statement_timeout') }
  }

  private async releaseLocation(client: PoolClient, key: string): Promise<void> {
    let destroy = false
    try {
      const result = await client.query<{ unlocked: boolean }>(`
        SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked
      `, [key])
      destroy = result.rows[0]?.unlocked !== true
    } catch { destroy = true }
    client.release(destroy)
  }

  private locationLockKey(object: ObjectRow): string {
    return `hosted-agent:object-location:${JSON.stringify([object.storage_bucket, object.storage_key])}`
  }

  private async lockObject(client: PoolClient, expected: ObjectRow): Promise<ObjectRow> {
    const result = await client.query<ObjectRow>(`
      SELECT object_id, tenant_id, storage_bucket, storage_key, checksum, state
      FROM hosted_agent_objects WHERE object_id = $1 AND tenant_id = $2 FOR UPDATE
    `, [expected.object_id, expected.tenant_id])
    const object = result.rows[0]
    if (!object) throw new Error('durable object disappeared during reclamation')
    this.assertSameLocator(object, expected)
    return object
  }

  private assertSameLocator(object: ObjectRow, expected: ObjectRow): void {
    if (object.storage_bucket !== expected.storage_bucket || object.storage_key !== expected.storage_key
      || object.checksum !== expected.checksum) throw new Error('durable object locator changed during reclamation')
  }

  private storageIdFor(object: ObjectRow): string {
    const checksum = checksumPattern.exec(object.checksum)
    if (!checksum) throw new Error('durable object has an invalid checksum')
    const storageId = checksum[1]!
    const expectedLocation = this.objects.location(storageId)
    if (expectedLocation.storageBucket !== object.storage_bucket || expectedLocation.storageKey !== object.storage_key) {
      throw new Error('durable object locator does not match the configured object store')
    }
    return storageId
  }

  private async hasDurableReference(client: PoolClient, objectId: string): Promise<boolean> {
    const result = await client.query(`
      SELECT 1 WHERE
        EXISTS (SELECT 1 FROM hosted_agent_object_references WHERE object_id = $1)
        OR EXISTS (SELECT 1 FROM hosted_agent_source_snapshots WHERE archive_object_id = $1)
        OR EXISTS (SELECT 1 FROM hosted_agent_snapshots
          WHERE workspace_archive_object_id = $1 OR manifest_object_id = $1)
        OR EXISTS (SELECT 1 FROM hosted_agent_artifacts
          WHERE base_manifest_object_id = $1 OR current_manifest_object_id = $1 OR artifact_object_id = $1)
    `, [objectId])
    return result.rowCount === 1
  }

  private async markObjectAndAllocationDeleted(client: PoolClient, objectId: string, allocationId: string): Promise<void> {
    await client.query(`UPDATE hosted_agent_objects SET state = 'deleted' WHERE object_id = $1`, [objectId])
    await this.markAllocationReclaimed(client, allocationId)
  }

  private async markAllocationReclaimed(client: PoolClient, allocationId: string): Promise<void> {
    const result = await client.query(`
      UPDATE hosted_agent_operation_allocations
      SET state = 'reclaimed', reclaimed_at = now()
      WHERE allocation_id = $1::bigint AND state = 'reclaim_pending'
    `, [allocationId])
    if (result.rowCount !== 1) throw new OperationOwnershipError()
  }

  private async ownsOperation(client: PoolClient, identity: OperationIdentity, generation: number,
    workerId: string, lock = false): Promise<boolean> {
    const result = await client.query(`
      SELECT 1 FROM hosted_agent_operations
      WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
        AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
      ${lock ? 'FOR UPDATE' : ''}
    `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId])
    return result.rowCount === 1
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      return await this.clientTransaction(client, () => fn(client))
    } finally { client.release() }
  }

  private async clientTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
    await client.query('BEGIN')
    try {
      const value = await fn()
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  }
}
