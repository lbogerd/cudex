import type { Pool, PoolClient } from 'pg'
import type { ObjectStore } from './blob-store.js'
import { OperationOwnershipError, type OperationIdentity } from './postgres-store.js'
import { WorkspacePreparationConflictError, type PreparationFence } from './postgres-workspace-preparations.js'
import { begin, commit, lockLeaseSession, lockLeaseTransaction, resetStatementTimeout,
  rollbackQuietly, setLocalLockTimeout, setStatementTimeout, unlockLeaseSession } from './db/primitives.js'
import { reclaimerClaimOperationObjects, reclaimerClaimPreparationObjects,
  reclaimerFinalizePreparation, reclaimerGetObject, reclaimerHasDurableReference,
  reclaimerHasSharedLocator, reclaimerListDeletingObjects, reclaimerLockAllocation,
  reclaimerLockObject, reclaimerLockObjectWithKind, reclaimerLockOwnedAllocation,
  reclaimerLockPreparation, reclaimerMarkAllocationReclaimed, reclaimerMarkObjectAllocationsReclaimed,
  reclaimerMarkObjectDeleted, reclaimerMarkObjectDeleting, reclaimerOwnsOperation,
  reclaimerOwnsOperationForUpdate, reclaimerPreparationOutstanding } from './db/queries/objects.queries.js'

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

  /** Safely removes a source archive whose durable publication never acquired a reference. */
  async reclaimUnreferencedSourceArchive(tenantId: string, objectId: string, storageId: string): Promise<void> {
    validId('tenant ID', tenantId); validId('object ID', objectId)
    if (!/^[0-9a-f]{64}$/u.test(storageId)) throw new Error('invalid source archive storage ID')
    const location = this.objects.location(storageId)
    validId('storage bucket', location.storageBucket); validId('storage key', location.storageKey, 2048)
    const client = await this.pool.connect()
    const locationKey = this.locationKey(location.storageBucket, location.storageKey)
    try {
      await this.lockLocation(client, locationKey)
      const action = await this.clientTransaction(client, async () => {
        await setLocalLockTimeout(client)
        const exact = await reclaimerLockObjectWithKind.run({ objectId, tenantId }, client)
        const object = exact[0] as ObjectRow & { kind: string } | undefined
        if (object) {
          if (object.kind !== 'source_archive' || object.checksum !== `sha256:${storageId}`
            || object.storage_bucket !== location.storageBucket || object.storage_key !== location.storageKey) {
            throw new Error('source archive registration does not match its physical object')
          }
          if (object.state === 'deleted') return 'complete' as const
          if (object.state !== 'deleting' && await this.hasDurableReference(client, object.object_id)) {
            return 'retained' as const
          }
        }
        const shared = await reclaimerHasSharedLocator.run({ objectId,
          storageBucket: location.storageBucket, storageKey: location.storageKey }, client)
        if (shared.length === 1) {
          if (object && object.state !== 'deleted') {
            await reclaimerMarkObjectDeleted.run({ objectId }, client)
          }
          return 'shared' as const
        }
        if (object?.state !== 'deleting') {
          if (object) await reclaimerMarkObjectDeleting.run({ objectId }, client)
        }
        return 'delete' as const
      })
      if (action !== 'delete') return
      await this.objects.delete(storageId)
      await this.clientTransaction(client, async () => {
        const result = await reclaimerLockObject.run({ objectId, tenantId }, client)
        const object = result[0] as ObjectRow | undefined
        if (!object) return
        if (object.storage_bucket !== location.storageBucket || object.storage_key !== location.storageKey
          || object.checksum !== `sha256:${storageId}`) {
          throw new Error('source archive registration changed during reclamation')
        }
        if (object.state === 'deleting') {
          await reclaimerMarkObjectDeleted.run({ objectId }, client)
        } else if (object.state !== 'deleted') throw new Error('source archive left deleting state unexpectedly')
      })
    } finally { await this.releaseLocation(client, locationKey) }
  }

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
    const candidates = await reclaimerListDeletingObjects.run({ tenantId, limit }, this.pool)
    let reclaimed = 0
    let failed = 0
    for (const candidate of candidates) {
      try { if (await this.resumeDeletingObject(candidate as ObjectRow)) reclaimed += 1 }
      catch { failed += 1 }
    }
    return { found: candidates.length, reclaimed, failed }
  }

  private async claimCandidates(identity: OperationIdentity, generation: number, workerId: string,
    limit: number): Promise<CandidateRow[]> {
    return this.transaction(async client => {
      const result = await reclaimerClaimOperationObjects.run({ operation: identity.operation,
        idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId,
        generation, workerId, limit }, client)
      if (result.length === 0) {
        const owned = await this.ownsOperation(client, identity, generation, workerId)
        if (!owned) throw new OperationOwnershipError()
      }
      return result as CandidateRow[]
    })
  }

  private async claimPreparationCandidates(fence: PreparationFence, preparationId: string,
    limit: number): Promise<CandidateRow[]> {
    return this.transaction(async client => {
      if (!await this.ownsOperation(client, fence, fence.generation, fence.workerId, true)) {
        throw new OperationOwnershipError()
      }
      const preparation = await reclaimerLockPreparation.run({ preparationId, operation: fence.operation,
        idempotencyKey: fence.idempotencyKey, tenantId: fence.tenantId }, client)
      const state = preparation[0]?.state
      if (state === 'reclaimed') return []
      if (state !== 'reclaim_pending') {
        throw new WorkspacePreparationConflictError('workspace preparation is not pending reclamation')
      }
      const result = await reclaimerClaimPreparationObjects.run({ preparationId, operation: fence.operation,
        idempotencyKey: fence.idempotencyKey, tenantId: fence.tenantId, limit }, client)
      return result as CandidateRow[]
    })
  }

  private async finalizePreparationIfReclaimed(fence: PreparationFence, preparationId: string): Promise<void> {
    await this.transaction(async client => {
      if (!await this.ownsOperation(client, fence, fence.generation, fence.workerId, true)) {
        throw new OperationOwnershipError()
      }
      const preparation = await reclaimerLockPreparation.run({ preparationId, operation: fence.operation,
        idempotencyKey: fence.idempotencyKey, tenantId: fence.tenantId }, client)
      const state = preparation[0]?.state
      if (state === 'reclaimed') return
      if (state !== 'reclaim_pending') {
        throw new WorkspacePreparationConflictError('workspace preparation left reclamation state')
      }
      const progress = await reclaimerPreparationOutstanding.run({ preparationId }, client)
      if (progress[0]!.outstanding !== '0') return
      const updated = await reclaimerFinalizePreparation.runWithCounts({ preparationId }, client)
      if (updated.rowCount !== 1) throw new WorkspacePreparationConflictError('workspace preparation reclaim lost')
    })
  }

  private async reclaimOne(identity: OperationIdentity, generation: number, workerId: string,
    candidate: CandidateRow): Promise<'reclaimed' | 'shared' | 'retained'> {
    const client = await this.pool.connect()
    let locationKey: string | undefined
    try {
      const locatorResult = await reclaimerGetObject.run({ objectId: candidate.resource_id,
        tenantId: identity.tenantId }, client)
      const locator = locatorResult[0] as ObjectRow | undefined
      if (!locator) return 'retained'
      const storageId = this.storageIdFor(locator)
      locationKey = this.locationLockKey(locator)
      await this.lockLocation(client, locationKey)
      const prepared = await this.clientTransaction(client, async () => {
        await setLocalLockTimeout(client)
        await lockLeaseTransaction(client, `hosted-agent:object:${candidate.resource_id}`)
        const allocation = await reclaimerLockOwnedAllocation.run({ operation: identity.operation,
          idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, generation, workerId,
          allocationId: candidate.allocation_id, resourceId: candidate.resource_id }, client)
        if (allocation.length !== 1) throw new OperationOwnershipError()
        if (allocation[0]!.state === 'reclaimed') return 'complete' as const
        if (allocation[0]!.state !== 'reclaim_pending') throw new OperationOwnershipError()

        const object = await this.lockObject(client, locator)
        if (object.state === 'deleted') {
          await this.markAllocationReclaimed(client, candidate.allocation_id)
          return 'complete' as const
        }
        if (object.state !== 'deleting' && await this.hasDurableReference(client, object.object_id)) {
          return 'retained' as const
        }
        if (object.state !== 'deleting') {
          const shared = await reclaimerHasSharedLocator.run({ objectId: object.object_id,
            storageBucket: object.storage_bucket, storageKey: object.storage_key }, client)
          if (shared.length === 1) {
            await this.markObjectAndAllocationDeleted(client, object.object_id, candidate.allocation_id)
            return 'shared' as const
          }
          await reclaimerMarkObjectDeleting.run({ objectId: object.object_id }, client)
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
          await reclaimerMarkObjectDeleted.run({ objectId: object.object_id }, client)
        } else if (object.state !== 'deleted') throw new Error('durable object left deleting state unexpectedly')
        const allocation = await reclaimerLockAllocation.run({ allocationId: candidate.allocation_id }, client)
        if (allocation[0]?.state === 'reclaim_pending') {
          await this.markAllocationReclaimed(client, candidate.allocation_id)
        } else if (allocation[0]?.state !== 'reclaimed') throw new OperationOwnershipError()
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
        const shared = await reclaimerHasSharedLocator.run({ objectId: object.object_id,
          storageBucket: object.storage_bucket, storageKey: object.storage_key }, client)
        if (shared.length === 1) {
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
    await reclaimerMarkObjectDeleted.run({ objectId: object.object_id }, client)
    await reclaimerMarkObjectAllocationsReclaimed.run({ tenantId: object.tenant_id,
      objectId: object.object_id }, client)
  }

  private async lockLocation(client: PoolClient, key: string): Promise<void> {
    await setStatementTimeout(client)
    try { await lockLeaseSession(client, key) }
    finally { await resetStatementTimeout(client) }
  }

  private async releaseLocation(client: PoolClient, key: string): Promise<void> {
    let destroy = false
    try {
      destroy = !await unlockLeaseSession(client, key)
    } catch { destroy = true }
    client.release(destroy)
  }

  private locationLockKey(object: ObjectRow): string {
    return this.locationKey(object.storage_bucket, object.storage_key)
  }

  private locationKey(storageBucket: string, storageKey: string): string {
    return `hosted-agent:object-location:${JSON.stringify([storageBucket, storageKey])}`
  }

  private async lockObject(client: PoolClient, expected: ObjectRow): Promise<ObjectRow> {
    const result = await reclaimerLockObject.run({ objectId: expected.object_id,
      tenantId: expected.tenant_id }, client)
    const object = result[0] as ObjectRow | undefined
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
    return (await reclaimerHasDurableReference.run({ objectId }, client)).length === 1
  }

  private async markObjectAndAllocationDeleted(client: PoolClient, objectId: string, allocationId: string): Promise<void> {
    await reclaimerMarkObjectDeleted.run({ objectId }, client)
    await this.markAllocationReclaimed(client, allocationId)
  }

  private async markAllocationReclaimed(client: PoolClient, allocationId: string): Promise<void> {
    const result = await reclaimerMarkAllocationReclaimed.runWithCounts({ allocationId }, client)
    if (result.rowCount !== 1) throw new OperationOwnershipError()
  }

  private async ownsOperation(client: PoolClient, identity: OperationIdentity, generation: number,
    workerId: string, lock = false): Promise<boolean> {
    const query = lock ? reclaimerOwnsOperationForUpdate : reclaimerOwnsOperation
    return (await query.run({ operation: identity.operation, idempotencyKey: identity.idempotencyKey,
      tenantId: identity.tenantId, generation, workerId }, client)).length === 1
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      return await this.clientTransaction(client, () => fn(client))
    } finally { client.release() }
  }

  private async clientTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
    await begin(client)
    try {
      const value = await fn()
      await commit(client)
      return value
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    }
  }
}
