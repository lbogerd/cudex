import type { ProviderAdapter } from './provider.js'
import type { PoolClient } from 'pg'
import { ProviderSandboxMissingError } from './provider.js'
import type { PostgresDurableState } from './postgres-state.js'
import {
  canonicalRequestHash,
  OperationRequestMismatchError,
  OperationTargetNotFoundError,
  type OperationAllocation,
  type OperationClaim,
  type OperationIdentity,
  type PostgresJournal,
} from './postgres-store.js'
import type { ReleaseRequest } from './types.js'
import { ServiceError } from './types.js'
import { validateReleaseRequest } from './validation.js'

export interface ReleaseConnectionRevoker { revoke(leaseId: string): void }

export interface PostgresReleaseOptions {
  tenantId: string
  workerId: string
  waitTimeoutMs?: number
  connections?: ReleaseConnectionRevoker
  referenceRetention?: { assertSynchronized(client: PoolClient, leaseId: string): Promise<void> }
}

const operation = 'release'
const logicalResponse = Object.freeze({ released: true })

function bounded(label: string, value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

function validateLogicalResponse(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 1 || (value as { released?: unknown }).released !== true) {
    throw new ServiceError(503, 'durable release response is unavailable')
  }
}

export class PostgresReleaseCoordinator {
  private readonly tenantId: string
  private readonly workerId: string
  private readonly waitTimeoutMs: number

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly provider: ProviderAdapter,
    private readonly options: PostgresReleaseOptions,
  ) {
    this.tenantId = bounded('tenant ID', options.tenantId)
    this.workerId = bounded('worker ID', options.workerId)
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs <= 0 || this.waitTimeoutMs > 5 * 60_000) {
      throw new Error('invalid operation wait timeout')
    }
  }

  async release(untrustedRequest: ReleaseRequest): Promise<void> {
    const request = validateReleaseRequest(untrustedRequest)
    const identity: OperationIdentity = {
      operation, idempotencyKey: request.idempotencyKey, tenantId: this.tenantId,
    }
    const requestHash = canonicalRequestHash(request)
    let claim: OperationClaim
    try {
      claim = await this.journal.claimOperation({
        ...identity, requestHash, workerId: this.workerId, primaryLeaseId: request.leaseId,
      })
    }
    catch (error) {
      if (error instanceof OperationRequestMismatchError) throw new ServiceError(409, error.message)
      if (error instanceof OperationTargetNotFoundError) throw new ServiceError(404, 'lease missing')
      throw new ServiceError(503, 'durable release service unavailable')
    }
    if (claim.kind === 'in_progress') {
      try {
        claim = await this.journal.waitForTerminal({ ...identity, requestHash }, { timeoutMs: this.waitTimeoutMs })
      } catch { throw new ServiceError(503, 'durable release is still in progress') }
    }
    if (claim.kind !== 'claimed') return this.replay(claim, request.leaseId)

    const fence = { ...identity, generation: claim.generation, workerId: this.workerId }
    let releaseAllocation: OperationAllocation | undefined
    let alreadyReleased = false
    try {
      await this.journal.withLeaseLocks(this.tenantId, [request.leaseId], async client => {
        const lease = await this.state.getLease(this.tenantId, request.leaseId, client)
        if (!lease) throw new Error('release lease disappeared')
        if (!await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId, client)) {
          throw new Error('release operation ownership changed')
        }
        if (lease.state !== 'released') await this.options.referenceRetention?.assertSynchronized(client, lease.leaseId)
        await this.journal.bindLeaseAndAdoptAllocations(
          identity, fence.generation, fence.workerId, lease.leaseId, [], client)
        const pending = await this.state.beginRelease(this.tenantId, lease.leaseId, client)
        if (pending.state === 'released' || !pending.providerSandboxId) {
          if (pending.state !== 'released') await this.state.releaseLease(this.tenantId, lease.leaseId, client)
          await this.journal.completeOperation(
            identity, fence.generation, fence.workerId, logicalResponse, client)
          alreadyReleased = true
          return
        }
        await this.journal.lockProviderResources(
          [{ kind: 'sandbox', resourceId: pending.providerSandboxId }], client)
        releaseAllocation = await this.journal.recordAllocation(
          fence, fence.generation, fence.workerId, {
            kind: 'sandbox', resourceId: pending.providerSandboxId, leaseId: pending.leaseId,
            metadata: { action: 'release' },
          }, client)
      })
    } catch {
      this.revokeConnections(request.leaseId)
      const succeeded = await this.recoverCommitOutcome(identity, requestHash, fence)
      if (succeeded) return this.replay(succeeded, request.leaseId)
      throw new ServiceError(503, 'durable release preparation pending')
    }

    this.revokeConnections(request.leaseId)
    if (alreadyReleased) return
    if (!releaseAllocation) throw new ServiceError(503, 'durable release cleanup pending')

    try {
      await this.journal.withLeaseLocks(this.tenantId, [request.leaseId], async client => {
        const lease = await this.state.getLease(this.tenantId, request.leaseId, client)
        if (!lease) throw new Error('release lease disappeared')
        if (!await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId, client)) {
          throw new Error('release operation ownership changed')
        }
        if (lease.state !== 'released') {
          if (lease.state !== 'release_pending' || !lease.providerSandboxId
            || lease.providerSandboxId !== releaseAllocation!.resourceId) {
            throw new Error('release lease identity changed')
          }
          await this.journal.lockProviderResources(
            [{ kind: 'sandbox', resourceId: releaseAllocation!.resourceId }], client)
          try { await this.provider.kill(releaseAllocation!.resourceId) }
          catch (error) { if (!(error instanceof ProviderSandboxMissingError)) throw error }
          await this.state.releaseLease(this.tenantId, request.leaseId, client)
        }
        await this.journal.updateAllocationState(
          fence, fence.generation, fence.workerId, releaseAllocation!.allocationId, 'reclaimed', client)
        await this.journal.completeOperation(
          identity, fence.generation, fence.workerId, logicalResponse, client)
      })
    } catch {
      const succeeded = await this.recoverCommitOutcome(identity, requestHash, fence)
      if (succeeded) return this.replay(succeeded, request.leaseId)
      throw new ServiceError(503, 'durable release cleanup pending')
    }
  }

  private async replay(
    claim: Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }>, leaseId: string,
  ): Promise<void> {
    if (claim.kind === 'failed_terminal') {
      const status = /^service_([0-9]{3})$/u.exec(claim.errorCode ?? '')
      const parsed = status ? Number(status[1]) : 503
      throw new ServiceError(parsed >= 400 && parsed <= 599 ? parsed : 503,
        claim.errorMessage || 'durable release failed')
    }
    validateLogicalResponse(claim.response)
    const lease = await this.state.getLease(this.tenantId, leaseId)
    if (!lease || lease.state !== 'released') throw new ServiceError(503, 'durable release response is unavailable')
    this.revokeConnections(leaseId)
  }

  private async recoverCommitOutcome(identity: OperationIdentity, requestHash: string,
    fence: OperationIdentity & { generation: number; workerId: string }): Promise<
      Extract<OperationClaim, { kind: 'succeeded' }> | null
    > {
    try {
      const claim = await this.journal.claimOperation({ ...identity, requestHash, workerId: this.workerId })
      if (claim.kind === 'succeeded') return claim
      if (claim.kind === 'in_progress' && claim.generation === fence.generation
        && await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)) return null
    } catch { /* An unreadable outcome must remain for reconciliation. */ }
    throw new ServiceError(503, 'durable release cleanup pending')
  }

  private revokeConnections(leaseId: string): void {
    try { this.options.connections?.revoke(leaseId) }
    catch { /* Durable state and ticket revocation remain authoritative. */ }
  }
}
