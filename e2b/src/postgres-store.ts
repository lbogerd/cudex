import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  completeOperation as completeOperationQuery, failOperation as failOperationQuery,
  getOperationClaim, heartbeatOperation as heartbeatOperationQuery, insertLeaseOperationClaim,
  insertOperationClaim, lockOperationClaim, recordAllocation as recordAllocationQuery,
  updateAllocationState as updateAllocationStateQuery, listAllocations as listAllocationsQuery,
  hasUnreclaimedAllocation as hasUnreclaimedAllocationQuery, bindPrimaryLease, bindResultLease,
  adoptAllocations, claimStaleOperations as claimStaleOperationsQuery, lockExistingLeases,
} from './db/queries/journal.queries.js'
import { begin, commit, lockLeaseSession, lockLeaseTransaction, rollbackQuietly,
  setLocalLockTimeout, unlockLeaseSessionQuietly } from './db/primitives.js'

const requestHashPattern = /^sha256:[0-9a-f]{64}$/
const allocationKinds = new Set(['sandbox', 'capture_sandbox', 'provider_snapshot', 'ticket', 'object'])
const providerResourceKinds = new Set(['sandbox', 'provider_snapshot'])
const forbiddenResponseKeys = new Set([
  'connection', 'execServerUrl', 'rawExecUrl', 'ticket', 'apiKey', 'accessToken',
  'trafficAccessToken', 'bearerToken',
])

export interface OperationIdentity {
  operation: string
  idempotencyKey: string
  tenantId: string
}

export interface OperationClaimInput extends OperationIdentity {
  requestHash: string
  workerId: string
  primaryLeaseId?: string
  operationSubtype?: 'child'
}

export type OperationClaim =
  | { kind: 'claimed'; generation: number }
  | { kind: 'in_progress'; generation: number; heartbeatAt: Date | null }
  | { kind: 'succeeded'; generation: number; response: unknown }
  | { kind: 'failed_terminal'; generation: number; errorCode: string | null; errorMessage: string | null }

export interface OperationAllocation {
  allocationId: string
  allocationKind: string
  resourceId: string
  leaseId: string | null
  state: 'allocated' | 'adopted' | 'reclaim_pending' | 'reclaimed'
  metadata: Record<string, unknown>
  allocatedAt: Date
  updatedAt: Date
  reclaimedAt: Date | null
}

export interface StaleOperation extends OperationIdentity {
  operationSubtype: 'child' | null
  requestHash: string
  generation: number
  previousWorkerId: string | null
  workerId: string
  primaryLeaseId: string | null
  resultLeaseId: string | null
}

export class OperationRequestMismatchError extends Error {
  constructor() { super('idempotency key reused with a different request') }
}

export class OperationOwnershipError extends Error {
  constructor() { super('operation generation is no longer owned by this worker') }
}

export class OperationWaitTimeoutError extends Error {
  constructor() { super('timed out waiting for the operation to finish') }
}

export class OperationTargetNotFoundError extends Error {
  constructor() { super('operation target was not found') }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

export function canonicalRequestHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`
}

function sanitizeLogicalResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeLogicalResponse)
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (!forbiddenResponseKeys.has(key)) sanitized[key] = sanitizeLogicalResponse(item)
    }
    return sanitized
  }
  return value
}

function validateIdentity(identity: OperationIdentity): void {
  for (const [name, value, limit] of [
    ['operation', identity.operation, 128],
    ['idempotency key', identity.idempotencyKey, 512],
    ['tenant ID', identity.tenantId, 512],
  ] as const) {
    if (!value.trim() || Buffer.byteLength(value) > limit) throw new Error(`invalid ${name}`)
  }
}

function validateClaim(input: OperationClaimInput): void {
  validateIdentity(input)
  if (!requestHashPattern.test(input.requestHash)) throw new Error('invalid canonical request hash')
  validateWorkerId(input.workerId)
  if (input.primaryLeaseId !== undefined
    && (!input.primaryLeaseId.trim() || Buffer.byteLength(input.primaryLeaseId) > 512)) {
    throw new Error('invalid primary lease ID')
  }
  if (input.operationSubtype === 'child'
    && (input.operation !== 'provision' || input.primaryLeaseId === undefined)) {
    throw new Error('invalid child operation identity')
  }
}

function validateWorkerId(workerId: string): void {
  if (!workerId.trim() || Buffer.byteLength(workerId) > 512) throw new Error('invalid worker ID')
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid operation generation')
}

interface OperationRow {
  tenant_id: string
  operation_subtype: 'child' | null
  request_hash: string
  state: 'in_progress' | 'succeeded' | 'failed_terminal'
  logical_response: unknown
  error_code: string | null
  error_message: string | null
  generation: string
  heartbeat_at: Date | null
  primary_lease_id: string | null
  result_lease_id: string | null
}

function rowToClaim(row: OperationRow, newlyClaimed: boolean): OperationClaim {
  const generation = Number(row.generation)
  if (newlyClaimed) return { kind: 'claimed', generation }
  if (row.state === 'succeeded') return { kind: 'succeeded', generation, response: sanitizeLogicalResponse(row.logical_response) }
  if (row.state === 'failed_terminal') {
    return { kind: 'failed_terminal', generation, errorCode: row.error_code, errorMessage: row.error_message }
  }
  return { kind: 'in_progress', generation, heartbeatAt: row.heartbeat_at }
}

export class PostgresJournal {
  constructor(private readonly pool: Pool) {}

  async claimOperation(input: OperationClaimInput): Promise<OperationClaim> {
    validateClaim(input)
    return this.transaction(async client => {
      const params = { operation: input.operation, idempotencyKey: input.idempotencyKey,
        tenantId: input.tenantId, requestHash: input.requestHash, workerId: input.workerId,
        operationSubtype: input.operationSubtype ?? null }
      const inserted = input.primaryLeaseId === undefined
        ? await insertOperationClaim.run(params, client)
        : await insertLeaseOperationClaim.run({ ...params, primaryLeaseId: input.primaryLeaseId }, client)
      const result = await lockOperationClaim.run({ operation: input.operation,
        idempotencyKey: input.idempotencyKey }, client)
      const row = result[0] as OperationRow | undefined
      if (!row && input.primaryLeaseId !== undefined) throw new OperationTargetNotFoundError()
      if (!row) throw new Error('operation claim disappeared')
      if (row.tenant_id !== input.tenantId || row.request_hash !== input.requestHash) {
        throw new OperationRequestMismatchError()
      }
      if (row.operation_subtype !== (input.operationSubtype ?? null)) {
        throw new OperationRequestMismatchError()
      }
      if (input.primaryLeaseId !== undefined && row.primary_lease_id !== input.primaryLeaseId) {
        throw new OperationRequestMismatchError()
      }
      return rowToClaim(row, inserted.length === 1)
    })
  }

  async waitForTerminal(
    input: Pick<OperationClaimInput, 'operation' | 'idempotencyKey' | 'tenantId' | 'requestHash'>,
    options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }>> {
    validateIdentity(input)
    if (!requestHashPattern.test(input.requestHash)) throw new Error('invalid canonical request hash')
    const timeoutMs = options.timeoutMs ?? 30_000
    const pollIntervalMs = options.pollIntervalMs ?? 25
    if (timeoutMs < 0 || pollIntervalMs <= 0) throw new Error('invalid wait duration')
    const deadline = Date.now() + timeoutMs
    for (;;) {
      options.signal?.throwIfAborted()
      const result = await getOperationClaim.run({ operation: input.operation,
        idempotencyKey: input.idempotencyKey }, this.pool)
      const row = result[0] as OperationRow | undefined
      if (!row || row.tenant_id !== input.tenantId || row.request_hash !== input.requestHash) {
        throw new OperationRequestMismatchError()
      }
      const claim = rowToClaim(row, false)
      if (claim.kind === 'succeeded' || claim.kind === 'failed_terminal') return claim
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new OperationWaitTimeoutError()
      await new Promise<void>((resolve, reject) => {
        const finish = () => { options.signal?.removeEventListener('abort', abort); resolve() }
        const timer = setTimeout(finish, Math.min(pollIntervalMs, remaining))
        const abort = () => { clearTimeout(timer); reject(options.signal?.reason ?? new Error('operation wait aborted')) }
        options.signal?.addEventListener('abort', abort, { once: true })
      })
    }
  }

  async heartbeatOperation(identity: OperationIdentity, generation: number, workerId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<boolean> {
    validateIdentity(identity)
    validateGeneration(generation); validateWorkerId(workerId)
    const result = await heartbeatOperationQuery.runWithCounts({ operation: identity.operation,
      idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, generation, workerId }, executor)
    return result.rowCount === 1
  }

  async completeOperation(identity: OperationIdentity, generation: number, workerId: string, response: unknown,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<void> {
    validateIdentity(identity); validateGeneration(generation); validateWorkerId(workerId)
    const logicalResponse = sanitizeLogicalResponse(response)
    const encodedResponse = JSON.stringify(logicalResponse)
    if (encodedResponse === undefined || Buffer.byteLength(encodedResponse) > 1024 * 1024) throw new Error('invalid logical response')
    const result = await completeOperationQuery.runWithCounts({ operation: identity.operation,
      idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, generation, workerId,
      logicalResponse: encodedResponse }, executor)
    if (result.rowCount !== 1) throw new OperationOwnershipError()
  }

  async failOperation(identity: OperationIdentity, generation: number, workerId: string, errorCode: string, errorMessage: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<void> {
    validateIdentity(identity); validateGeneration(generation); validateWorkerId(workerId)
    if (!errorCode.trim() || Buffer.byteLength(errorCode) > 512) throw new Error('invalid error code')
    if (Buffer.byteLength(errorMessage) > 4096) throw new Error('error message is too large')
    const result = await failOperationQuery.runWithCounts({ operation: identity.operation,
      idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, generation, workerId,
      errorCode, errorMessage }, executor)
    if (result.rowCount !== 1) throw new OperationOwnershipError()
  }

  async recordAllocation(
    identity: OperationIdentity,
    generation: number,
    workerId: string,
    allocation: { kind: string; resourceId: string; leaseId?: string; metadata?: Record<string, unknown> },
    executor: Pick<PoolClient, 'query'> = this.pool,
  ): Promise<OperationAllocation> {
    validateIdentity(identity); validateGeneration(generation); validateWorkerId(workerId)
    if (!allocationKinds.has(allocation.kind)) throw new Error('invalid allocation kind')
    if (!allocation.resourceId.trim() || Buffer.byteLength(allocation.resourceId) > 2048) throw new Error('invalid resource ID')
    const result = await recordAllocationQuery.run({ operation: identity.operation,
      idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, generation, workerId,
      allocationKind: allocation.kind, resourceId: allocation.resourceId,
      leaseId: allocation.leaseId ?? null, metadata: JSON.stringify(allocation.metadata ?? {}) }, executor)
    const row = result[0] as AllocationRow | undefined
    if (!row) throw new OperationOwnershipError()
    return allocationFromRow(row)
  }

  async updateAllocationState(
    identity: OperationIdentity,
    generation: number,
    workerId: string,
    allocationId: string,
    state: 'adopted' | 'reclaim_pending' | 'reclaimed',
    executor: Pick<PoolClient, 'query'> = this.pool,
  ): Promise<OperationAllocation> {
    validateIdentity(identity); validateGeneration(generation); validateWorkerId(workerId)
    const result = await updateAllocationStateQuery.run({ operation: identity.operation,
      idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, generation, workerId,
      allocationId, state }, executor)
    const row = result[0] as AllocationRow | undefined
    if (!row) throw new OperationOwnershipError()
    return allocationFromRow(row)
  }

  async listAllocations(identity: OperationIdentity, limit = 10_000,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<OperationAllocation[]> {
    validateIdentity(identity)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_001) throw new Error('invalid allocation limit')
    const result = await listAllocationsQuery.run({ operation: identity.operation,
      idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, limit }, executor)
    return result.map(row => allocationFromRow(row as AllocationRow))
  }

  /** Read-only reconciliation guard: provider inventory must not reclaim a resource owned by any unfinished operation. */
  async hasUnreclaimedAllocation(allocationKind: string, resourceId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<boolean> {
    if (!allocationKinds.has(allocationKind)) throw new Error('invalid allocation kind')
    if (!resourceId.trim() || Buffer.byteLength(resourceId) > 2048) throw new Error('invalid resource ID')
    return (await hasUnreclaimedAllocationQuery.run({ allocationKind, resourceId }, executor)).length === 1
  }

  async bindLeaseAndAdoptAllocations(
    identity: OperationIdentity,
    generation: number,
    workerId: string,
    leaseId: string,
    allocationIds: string[],
    executor?: PoolClient,
  ): Promise<OperationAllocation[]> {
    validateIdentity(identity); validateGeneration(generation); validateWorkerId(workerId)
    if (!leaseId.trim() || Buffer.byteLength(leaseId) > 512) throw new Error('invalid lease ID')
    const uniqueIds = [...new Set(allocationIds)]
    if (uniqueIds.length !== allocationIds.length || uniqueIds.length > 10_000
      || uniqueIds.some(allocationId => !/^[1-9][0-9]*$/.test(allocationId))) {
      throw new Error('invalid allocation IDs')
    }
    const bind = async (client: PoolClient) => {
      const operation = await bindPrimaryLease.runWithCounts({ operation: identity.operation,
        idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, generation, workerId, leaseId }, client)
      if (operation.rowCount !== 1) throw new OperationOwnershipError()
      if (uniqueIds.length === 0) return []
      const allocations = await adoptAllocations.run({ operation: identity.operation,
        idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, leaseId,
        allocationIds: uniqueIds }, client)
      if (allocations.length !== uniqueIds.length) throw new OperationOwnershipError()
      return allocations.map(row => allocationFromRow(row as AllocationRow))
    }
    return executor ? bind(executor) : this.transaction(bind)
  }

  async bindResultLeaseAndAdoptAllocations(identity: OperationIdentity, generation: number, workerId: string,
    resultLeaseId: string, allocationIds: string[], executor?: PoolClient): Promise<OperationAllocation[]> {
    validateIdentity(identity); validateGeneration(generation); validateWorkerId(workerId)
    if (!resultLeaseId.trim() || Buffer.byteLength(resultLeaseId) > 512) throw new Error('invalid result lease ID')
    const uniqueIds = [...new Set(allocationIds)]
    if (uniqueIds.length !== allocationIds.length || uniqueIds.length > 10_000
      || uniqueIds.some(allocationId => !/^[1-9][0-9]*$/.test(allocationId))) {
      throw new Error('invalid allocation IDs')
    }
    const bind = async (client: PoolClient) => {
      const result = await bindResultLease.runWithCounts({ operation: identity.operation,
        idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, generation, workerId,
        leaseId: resultLeaseId }, client)
      if (result.rowCount !== 1) throw new OperationOwnershipError()
      if (uniqueIds.length === 0) return []
      const allocations = await adoptAllocations.run({ operation: identity.operation,
        idempotencyKey: identity.idempotencyKey, tenantId: identity.tenantId, leaseId: resultLeaseId,
        allocationIds: uniqueIds }, client)
      if (allocations.length !== uniqueIds.length) throw new OperationOwnershipError()
      return allocations.map(row => allocationFromRow(row as AllocationRow))
    }
    return executor ? bind(executor) : this.transaction(bind)
  }

  async claimStaleOperations(staleBefore: Date, limit: number, workerId: string,
    tenantId?: string, operationFilter?: string,
    operationSubtypeFilter?: 'child' | 'none',
    excludedOperations?: string[]): Promise<StaleOperation[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid stale-operation limit')
    validateWorkerId(workerId)
    if (tenantId !== undefined) {
      if (!tenantId.trim() || Buffer.byteLength(tenantId) > 512) throw new Error('invalid tenant ID')
    }
    if (operationFilter !== undefined) {
      if (!operationFilter.trim() || Buffer.byteLength(operationFilter) > 128) {
        throw new Error('invalid operation filter')
      }
    }
    if (operationSubtypeFilter !== undefined
      && operationSubtypeFilter !== 'child' && operationSubtypeFilter !== 'none') {
      throw new Error('invalid operation subtype filter')
    }
    if (excludedOperations !== undefined && (excludedOperations.length > 32
      || new Set(excludedOperations).size !== excludedOperations.length
      || excludedOperations.some(operation => !operation.trim()
        || Buffer.byteLength(operation) > 128))) {
      throw new Error('invalid excluded operations')
    }
    return this.transaction(async client => {
      const result = await claimStaleOperationsQuery.run({ staleBefore, limit, workerId,
        tenantId: tenantId ?? null, operationFilter: operationFilter ?? null,
        subtypeFilter: operationSubtypeFilter ?? null,
        excludedOperations: excludedOperations ?? null }, client)
      return result.map(row => ({
        operation: row.operation,
        operationSubtype: row.operation_subtype as 'child' | null,
        idempotencyKey: row.idempotency_key,
        tenantId: row.tenant_id,
        requestHash: row.request_hash,
        generation: Number(row.generation),
        previousWorkerId: row.previous_worker_id,
        workerId: row.worker_id!,
        primaryLeaseId: row.primary_lease_id,
        resultLeaseId: row.result_lease_id,
      }))
    })
  }

  async withLeaseLocks<T>(tenantId: string, leaseIds: string[], fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!tenantId.trim() || Buffer.byteLength(tenantId) > 512) throw new Error('invalid tenant ID')
    const sorted = [...new Set(leaseIds)]
      .map(leaseId => {
        if (!leaseId.trim() || Buffer.byteLength(leaseId) > 512) throw new Error('invalid lease ID')
        return leaseId
      })
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    return this.transaction(async client => {
      for (const leaseId of sorted) {
        await lockLeaseTransaction(client, `hosted-agent:lease:${tenantId}:${leaseId}`)
      }
      if (sorted.length > 0) {
        const existing = await lockExistingLeases.run({ tenantId, leaseIds: sorted }, client)
        if (existing.length !== sorted.length) throw new Error('lease missing')
      }
      return fn(client)
    })
  }

  /**
   * Holds the lifecycle advisory lock across multiple caller-managed database
   * transactions and external provider calls. The callback must commit every
   * durable phase before its corresponding external side effect.
   */
  async withSessionLeaseLocks<T>(tenantId: string, leaseIds: string[],
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!tenantId.trim() || Buffer.byteLength(tenantId) > 512) throw new Error('invalid tenant ID')
    const sorted = [...new Set(leaseIds)].map(leaseId => {
      if (!leaseId.trim() || Buffer.byteLength(leaseId) > 512) throw new Error('invalid lease ID')
      return leaseId
    }).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    const keys = sorted.map(leaseId => `hosted-agent:lease:${tenantId}:${leaseId}`)
    const client = await this.pool.connect()
    const locked: string[] = []
    try {
      for (const key of keys) {
        await lockLeaseSession(client, key)
        locked.push(key)
      }
      return await fn(client)
    } finally {
      await rollbackQuietly(client)
      for (const key of locked.reverse()) {
        await unlockLeaseSessionQuietly(client, key)
      }
      client.release()
    }
  }

  /**
   * Holds a transaction-scoped advisory lock across an external provider
   * mutation. Every production lifecycle writer must take the same lock before
   * associating an already-created provider resource with durable state.
   */
  async withProviderResourceLock<T>(kind: 'sandbox' | 'provider_snapshot', resourceId: string,
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withProviderResourceLocks([{ kind, resourceId }], fn)
  }

  async withProviderResourceLocks<T>(resources: Array<{ kind: 'sandbox' | 'provider_snapshot'; resourceId: string }>,
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(async client => {
      await this.lockProviderResources(resources, client)
      return fn(client)
    })
  }

  /** Adds sorted provider-resource advisory locks to an existing caller-owned transaction. */
  async lockProviderResources(resources: Array<{ kind: 'sandbox' | 'provider_snapshot'; resourceId: string }>,
    executor: Pick<PoolClient, 'query'>): Promise<void> {
    if (resources.length < 1 || resources.length > 10_000) throw new Error('invalid provider resource count')
    const keys = new Set<string>()
    for (const resource of resources) {
      if (!providerResourceKinds.has(resource.kind)) throw new Error('invalid provider resource kind')
      if (!resource.resourceId.trim() || Buffer.byteLength(resource.resourceId) > 2048) throw new Error('invalid resource ID')
      keys.add(`hosted-agent:provider:${JSON.stringify([resource.kind, resource.resourceId])}`)
    }
    const sorted = [...keys].sort()
    await setLocalLockTimeout(executor)
    for (const key of sorted) {
      await lockLeaseTransaction(executor, key)
    }
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await begin(client)
      const result = await fn(client)
      await commit(client)
      return result
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    } finally {
      client.release()
    }
  }
}

interface AllocationRow {
  allocation_id: string
  allocation_kind: string
  resource_id: string
  lease_id: string | null
  state: OperationAllocation['state']
  metadata: Record<string, unknown>
  allocated_at: Date
  updated_at: Date
  reclaimed_at: Date | null
}

function allocationFromRow(row: AllocationRow): OperationAllocation {
  return {
    allocationId: row.allocation_id,
    allocationKind: row.allocation_kind,
    resourceId: row.resource_id,
    leaseId: row.lease_id,
    state: row.state,
    metadata: row.metadata,
    allocatedAt: row.allocated_at,
    updatedAt: row.updated_at,
    reclaimedAt: row.reclaimed_at,
  }
}

interface StaleRow {
  operation: string
  operation_subtype: 'child' | null
  idempotency_key: string
  tenant_id: string
  request_hash: string
  generation: string
  previous_worker_id: string | null
  worker_id: string
  primary_lease_id: string | null
  result_lease_id: string | null
}
