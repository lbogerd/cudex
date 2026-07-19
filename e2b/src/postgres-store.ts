import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

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
}

function validateWorkerId(workerId: string): void {
  if (!workerId.trim() || Buffer.byteLength(workerId) > 512) throw new Error('invalid worker ID')
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid operation generation')
}

interface OperationRow {
  tenant_id: string
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
      const inserted = input.primaryLeaseId === undefined
        ? await client.query<{ generation: string }>(`
            INSERT INTO hosted_agent_operations
              (operation, idempotency_key, tenant_id, request_hash, state, worker_id, heartbeat_at)
            VALUES ($1, $2, $3, $4, 'in_progress', $5, now())
            ON CONFLICT (operation, idempotency_key) DO NOTHING
            RETURNING generation
          `, [input.operation, input.idempotencyKey, input.tenantId, input.requestHash, input.workerId])
        : await client.query<{ generation: string }>(`
            INSERT INTO hosted_agent_operations
              (operation, idempotency_key, tenant_id, request_hash, state, worker_id,
               heartbeat_at, primary_lease_id)
            SELECT $1, $2, $3, $4, 'in_progress', $5, now(), lease_id
            FROM hosted_agent_leases WHERE tenant_id = $3 AND lease_id = $6
            ON CONFLICT (operation, idempotency_key) DO NOTHING
            RETURNING generation
          `, [input.operation, input.idempotencyKey, input.tenantId, input.requestHash,
            input.workerId, input.primaryLeaseId])
      const result = await client.query<OperationRow>(`
        SELECT tenant_id, request_hash, state, logical_response, error_code, error_message,
               generation::text, heartbeat_at, primary_lease_id, result_lease_id
        FROM hosted_agent_operations
        WHERE operation = $1 AND idempotency_key = $2
        FOR UPDATE
      `, [input.operation, input.idempotencyKey])
      const row = result.rows[0]
      if (!row && input.primaryLeaseId !== undefined) throw new OperationTargetNotFoundError()
      if (!row) throw new Error('operation claim disappeared')
      if (row.tenant_id !== input.tenantId || row.request_hash !== input.requestHash) {
        throw new OperationRequestMismatchError()
      }
      if (input.primaryLeaseId !== undefined && row.primary_lease_id !== input.primaryLeaseId) {
        throw new OperationRequestMismatchError()
      }
      return rowToClaim(row, inserted.rowCount === 1)
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
      const result = await this.pool.query<OperationRow>(`
        SELECT tenant_id, request_hash, state, logical_response, error_code, error_message,
               generation::text, heartbeat_at, primary_lease_id, result_lease_id
        FROM hosted_agent_operations
        WHERE operation = $1 AND idempotency_key = $2
      `, [input.operation, input.idempotencyKey])
      const row = result.rows[0]
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
    const result = await executor.query(`
      UPDATE hosted_agent_operations
      SET heartbeat_at = now()
      WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
        AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
    `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId])
    return result.rowCount === 1
  }

  async completeOperation(identity: OperationIdentity, generation: number, workerId: string, response: unknown,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<void> {
    validateIdentity(identity); validateGeneration(generation); validateWorkerId(workerId)
    const logicalResponse = sanitizeLogicalResponse(response)
    const encodedResponse = JSON.stringify(logicalResponse)
    if (encodedResponse === undefined || Buffer.byteLength(encodedResponse) > 1024 * 1024) throw new Error('invalid logical response')
    const result = await executor.query(`
      UPDATE hosted_agent_operations
      SET state = 'succeeded', logical_response = $6::jsonb, error_code = NULL,
          error_message = NULL, completed_at = now(), heartbeat_at = now()
      WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
        AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
    `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId, encodedResponse])
    if (result.rowCount !== 1) throw new OperationOwnershipError()
  }

  async failOperation(identity: OperationIdentity, generation: number, workerId: string, errorCode: string, errorMessage: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<void> {
    validateIdentity(identity); validateGeneration(generation); validateWorkerId(workerId)
    if (!errorCode.trim() || Buffer.byteLength(errorCode) > 512) throw new Error('invalid error code')
    if (Buffer.byteLength(errorMessage) > 4096) throw new Error('error message is too large')
    const result = await executor.query(`
      UPDATE hosted_agent_operations
      SET state = 'failed_terminal', logical_response = NULL, error_code = $6,
          error_message = $7, completed_at = now(), heartbeat_at = now()
      WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
        AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
    `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId, errorCode, errorMessage])
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
    const result = await executor.query<AllocationRow>(`
      INSERT INTO hosted_agent_operation_allocations
        (operation, idempotency_key, tenant_id, allocation_kind, resource_id, lease_id, state, metadata)
      SELECT operation, idempotency_key, tenant_id, $6, $7, $8, 'allocated', $9::jsonb
      FROM hosted_agent_operations
      WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
        AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
      ON CONFLICT (operation, idempotency_key, allocation_kind, resource_id)
      DO UPDATE SET updated_at = hosted_agent_operation_allocations.updated_at
      RETURNING allocation_id::text, allocation_kind, resource_id, lease_id, state, metadata,
                allocated_at, updated_at, reclaimed_at
    `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId, allocation.kind,
      allocation.resourceId, allocation.leaseId ?? null, JSON.stringify(allocation.metadata ?? {})])
    const row = result.rows[0]
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
    const result = await executor.query<AllocationRow>(`
      UPDATE hosted_agent_operation_allocations AS allocation
      SET state = $7,
          reclaimed_at = CASE WHEN $7 = 'reclaimed' THEN now() ELSE NULL END
      FROM hosted_agent_operations AS operation
      WHERE allocation.allocation_id = $6::bigint
        AND allocation.operation = operation.operation
        AND allocation.idempotency_key = operation.idempotency_key
        AND allocation.tenant_id = operation.tenant_id
        AND operation.operation = $1 AND operation.idempotency_key = $2
        AND operation.tenant_id = $3 AND operation.generation = $4
        AND operation.worker_id = $5
        AND operation.state = 'in_progress'
      RETURNING allocation.allocation_id::text, allocation.allocation_kind,
                allocation.resource_id, allocation.lease_id, allocation.state,
                allocation.metadata, allocation.allocated_at, allocation.updated_at,
                allocation.reclaimed_at
    `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId, allocationId, state])
    const row = result.rows[0]
    if (!row) throw new OperationOwnershipError()
    return allocationFromRow(row)
  }

  async listAllocations(identity: OperationIdentity, limit = 10_000,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<OperationAllocation[]> {
    validateIdentity(identity)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_001) throw new Error('invalid allocation limit')
    const result = await executor.query<AllocationRow>(`
      SELECT allocation_id::text, allocation_kind, resource_id, lease_id, state,
             metadata, allocated_at, updated_at, reclaimed_at
      FROM hosted_agent_operation_allocations
      WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
      ORDER BY allocation_id
      LIMIT $4
    `, [identity.operation, identity.idempotencyKey, identity.tenantId, limit])
    return result.rows.map(allocationFromRow)
  }

  /** Read-only reconciliation guard: provider inventory must not reclaim a resource owned by any unfinished operation. */
  async hasUnreclaimedAllocation(allocationKind: string, resourceId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<boolean> {
    if (!allocationKinds.has(allocationKind)) throw new Error('invalid allocation kind')
    if (!resourceId.trim() || Buffer.byteLength(resourceId) > 2048) throw new Error('invalid resource ID')
    const result = await executor.query(`
      SELECT 1
      FROM hosted_agent_operation_allocations AS allocation
      JOIN hosted_agent_operations AS operation
        USING (operation, idempotency_key, tenant_id)
      WHERE allocation.allocation_kind = $1 AND allocation.resource_id = $2
        AND allocation.state <> 'reclaimed'
        AND operation.state = 'in_progress'
      LIMIT 1
    `, [allocationKind, resourceId])
    return result.rowCount === 1
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
      const operation = await client.query(`
        UPDATE hosted_agent_operations
        SET primary_lease_id = $6
        WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
          AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
          AND (primary_lease_id IS NULL OR primary_lease_id = $6)
      `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId, leaseId])
      if (operation.rowCount !== 1) throw new OperationOwnershipError()
      if (uniqueIds.length === 0) return []
      const allocations = await client.query<AllocationRow>(`
        UPDATE hosted_agent_operation_allocations
        SET lease_id = $4, state = 'adopted'
        WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
          AND allocation_id = ANY($5::bigint[])
          AND (state IN ('allocated', 'reclaim_pending') OR (state = 'adopted' AND lease_id = $4))
        RETURNING allocation_id::text, allocation_kind, resource_id, lease_id, state,
                  metadata, allocated_at, updated_at, reclaimed_at
      `, [identity.operation, identity.idempotencyKey, identity.tenantId, leaseId, uniqueIds])
      if (allocations.rowCount !== uniqueIds.length) throw new OperationOwnershipError()
      return allocations.rows.map(allocationFromRow)
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
      const result = await client.query(`
        UPDATE hosted_agent_operations
        SET result_lease_id = $6
        WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
          AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
          AND (result_lease_id IS NULL OR result_lease_id = $6)
      `, [identity.operation, identity.idempotencyKey, identity.tenantId, generation, workerId, resultLeaseId])
      if (result.rowCount !== 1) throw new OperationOwnershipError()
      if (uniqueIds.length === 0) return []
      const allocations = await client.query<AllocationRow>(`
        UPDATE hosted_agent_operation_allocations
        SET lease_id = $4, state = 'adopted'
        WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
          AND allocation_id = ANY($5::bigint[])
          AND (state IN ('allocated', 'reclaim_pending') OR (state = 'adopted' AND lease_id = $4))
        RETURNING allocation_id::text, allocation_kind, resource_id, lease_id, state,
                  metadata, allocated_at, updated_at, reclaimed_at
      `, [identity.operation, identity.idempotencyKey, identity.tenantId, resultLeaseId, uniqueIds])
      if (allocations.rowCount !== uniqueIds.length) throw new OperationOwnershipError()
      return allocations.rows.map(allocationFromRow)
    }
    return executor ? bind(executor) : this.transaction(bind)
  }

  async claimStaleOperations(staleBefore: Date, limit: number, workerId: string, tenantId?: string): Promise<StaleOperation[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid stale-operation limit')
    validateWorkerId(workerId)
    if (tenantId !== undefined) {
      if (!tenantId.trim() || Buffer.byteLength(tenantId) > 512) throw new Error('invalid tenant ID')
    }
    return this.transaction(async client => {
      const result = await client.query<StaleRow>(`
        WITH candidates AS (
          SELECT operation, idempotency_key, worker_id
          FROM hosted_agent_operations
          WHERE state = 'in_progress'
            AND COALESCE(heartbeat_at, started_at) < $1
            AND ($4::text IS NULL OR tenant_id = $4)
          ORDER BY COALESCE(heartbeat_at, started_at), operation, idempotency_key
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE hosted_agent_operations AS operation
        SET generation = operation.generation + 1, worker_id = $3,
            heartbeat_at = now()
        FROM candidates
        WHERE operation.operation = candidates.operation
          AND operation.idempotency_key = candidates.idempotency_key
        RETURNING operation.operation, operation.idempotency_key, operation.tenant_id,
                  operation.request_hash, operation.generation::text,
                  candidates.worker_id AS previous_worker_id, operation.worker_id,
                  operation.primary_lease_id, operation.result_lease_id
      `, [staleBefore, limit, workerId, tenantId ?? null])
      return result.rows.map(row => ({
        operation: row.operation,
        idempotencyKey: row.idempotency_key,
        tenantId: row.tenant_id,
        requestHash: row.request_hash,
        generation: Number(row.generation),
        previousWorkerId: row.previous_worker_id,
        workerId: row.worker_id,
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
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`hosted-agent:lease:${tenantId}:${leaseId}`])
      }
      if (sorted.length > 0) {
        const existing = await client.query<{ lease_id: string }>(`
          SELECT lease_id FROM hosted_agent_leases
          WHERE tenant_id = $1 AND lease_id = ANY($2::text[])
          ORDER BY lease_id
          FOR UPDATE
        `, [tenantId, sorted])
        if (existing.rowCount !== sorted.length) throw new Error('lease missing')
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
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key])
        locked.push(key)
      }
      return await fn(client)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      for (const key of locked.reverse()) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
          .catch(() => undefined)
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
    await executor.query("SET LOCAL lock_timeout = '30s'")
    for (const key of sorted) {
      await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
    }
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
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
  idempotency_key: string
  tenant_id: string
  request_hash: string
  generation: string
  previous_worker_id: string | null
  worker_id: string
  primary_lease_id: string | null
  result_lease_id: string | null
}
