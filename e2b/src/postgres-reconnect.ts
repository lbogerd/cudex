import type { ProviderAdapter } from './provider.js'
import { ProviderSandboxMissingError } from './provider.js'
import type { Lease, PostgresDurableState } from './postgres-state.js'
import {
  canonicalRequestHash,
  OperationRequestMismatchError,
  OperationTargetNotFoundError,
  type OperationClaim,
  type OperationIdentity,
  type PostgresJournal,
} from './postgres-store.js'
import type { TicketAuthority } from './tickets.js'
import type { ProvisionedAgent, ReconnectRequest } from './types.js'
import { ServiceError } from './types.js'
import { validateProvisionedAgent, validateReconnectRequest } from './validation.js'
import { canonicalJson } from './workspace-manifest.js'
import type { ReleaseConnectionRevoker } from './postgres-release.js'

export interface PostgresReconnectOptions {
  tenantId: string
  workerId: string
  waitTimeoutMs?: number
  connections?: ReleaseConnectionRevoker
}

export interface LogicalReconnectResponse extends Omit<ProvisionedAgent, 'connection'> {}

const operation = 'reconnect'

function bounded(label: string, value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

export function logicalReconnectFromLease(lease: Lease): LogicalReconnectResponse {
  if (lease.state !== 'active' || !lease.baseSnapshotId) {
    throw new ServiceError(503, 'durable reconnect response is unavailable')
  }
  const validated = validateProvisionedAgent({
    leaseId: lease.leaseId,
    environmentId: lease.environmentId,
    connection: {
      execServerUrl: `wss://logical.invalid/leases/${encodeURIComponent(lease.leaseId)}?ticket=logical`,
    },
    cwd: lease.cwdUri,
    workspaceRoots: [...lease.workspaceRootUris],
    baseSnapshotId: lease.baseSnapshotId,
    toolPolicy: structuredClone(lease.toolPolicy),
  })
  const { connection: _connection, ...logical } = validated
  return logical
}

function unavailableLease(lease: Lease): { status: 404 | 409; message: string } {
  const missing = ['release_pending', 'released', 'lost'].includes(lease.state)
  return { status: missing ? 404 : 409,
    message: missing ? 'lease missing' : 'lease cannot be reconnected' }
}

export class PostgresReconnectCoordinator {
  private readonly tenantId: string
  private readonly workerId: string
  private readonly waitTimeoutMs: number

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly provider: ProviderAdapter,
    private readonly tickets: TicketAuthority,
    private readonly options: PostgresReconnectOptions,
  ) {
    this.tenantId = bounded('tenant ID', options.tenantId)
    this.workerId = bounded('worker ID', options.workerId)
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs <= 0 || this.waitTimeoutMs > 5 * 60_000) {
      throw new Error('invalid operation wait timeout')
    }
  }

  async reconnect(untrustedRequest: ReconnectRequest): Promise<ProvisionedAgent> {
    const request = validateReconnectRequest(untrustedRequest)
    const identity: OperationIdentity = {
      operation, idempotencyKey: request.idempotencyKey, tenantId: this.tenantId,
    }
    const requestHash = canonicalRequestHash(request)
    let claim: OperationClaim
    try {
      claim = await this.journal.claimOperation({
        ...identity, requestHash, workerId: this.workerId, primaryLeaseId: request.leaseId,
      })
    } catch (error) {
      if (error instanceof OperationRequestMismatchError) throw new ServiceError(409, error.message)
      if (error instanceof OperationTargetNotFoundError) throw new ServiceError(404, 'lease missing')
      throw new ServiceError(503, 'durable reconnect service unavailable')
    }
    if (claim.kind === 'in_progress') {
      try {
        claim = await this.journal.waitForTerminal({ ...identity, requestHash }, { timeoutMs: this.waitTimeoutMs })
      } catch { throw new ServiceError(503, 'durable reconnect is still in progress') }
    }
    if (claim.kind !== 'claimed') return this.replay(identity, claim, request.leaseId)

    const fence = { ...identity, generation: claim.generation, workerId: this.workerId }
    let committed: { logical: LogicalReconnectResponse; connectionGeneration: number }
      | { status: 404 | 409; message: string }
    try {
      committed = await this.journal.withLeaseLocks(this.tenantId, [request.leaseId], async client => {
        const lease = await this.state.getLease(this.tenantId, request.leaseId, client)
        if (!lease) throw new Error('reconnect lease disappeared')
        if (!await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId, client)) {
          throw new Error('reconnect operation ownership changed')
        }
        await this.journal.bindLeaseAndAdoptAllocations(
          identity, fence.generation, fence.workerId, lease.leaseId, [], client)
        if (['active', 'paused'].includes(lease.state) && !lease.providerSandboxId) {
          throw new Error('active reconnect lease has no provider sandbox')
        }
        if (!['active', 'paused'].includes(lease.state) || !lease.providerSandboxId) {
          const failure = unavailableLease(lease)
          await this.journal.failOperation(identity, fence.generation, fence.workerId,
            `service_${failure.status}`, failure.message, client)
          return failure
        }
        await this.journal.lockProviderResources(
          [{ kind: 'sandbox', resourceId: lease.providerSandboxId }], client)
        try {
          const connected = await this.provider.connect(lease.providerSandboxId)
          if (connected.sandboxId !== lease.providerSandboxId) {
            throw new Error('provider returned a different reconnect sandbox')
          }
          await this.provider.startExecServer(lease.providerSandboxId)
          await this.provider.probeExecServer(lease.providerSandboxId)
        } catch (error) {
          if (!(error instanceof ProviderSandboxMissingError)) throw error
          await this.state.markLeaseLost(
            this.tenantId, lease.leaseId, lease.providerSandboxId, client)
          await this.journal.failOperation(identity, fence.generation, fence.workerId,
            'service_404', 'lease missing', client)
          return { status: 404, message: 'lease missing' }
        }
        const active = await this.state.completeReconnect(
          this.tenantId, lease.leaseId, lease.providerSandboxId, client)
        const logical = logicalReconnectFromLease(active)
        await this.journal.completeOperation(
          identity, fence.generation, fence.workerId, logical, client)
        return { logical, connectionGeneration: active.connectionGeneration }
      })
    } catch (error) {
      const recovered = await this.recoverCommitOutcome(identity, requestHash, fence, request.leaseId)
      if (recovered) return this.replay(identity, recovered, request.leaseId)
      // Provider and database outages preserve the active lease, its current generation,
      // and operation ownership for retry or stale-operation takeover.
      throw new ServiceError(503, 'provider temporarily unavailable')
    }
    if ('status' in committed) {
      if (committed.status === 404) this.revokeConnections(request.leaseId)
      throw new ServiceError(committed.status, committed.message)
    }
    this.revokeConnections(request.leaseId)
    return this.withConnection(committed.logical, committed.connectionGeneration)
  }

  private async replay(identity: OperationIdentity,
    claim: Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }>,
    leaseId: string): Promise<ProvisionedAgent> {
    if (claim.kind === 'failed_terminal') {
      const status = /^service_([0-9]{3})$/u.exec(claim.errorCode ?? '')
      const parsed = status ? Number(status[1]) : 503
      if (parsed === 404) this.revokeConnections(leaseId)
      throw new ServiceError(parsed >= 400 && parsed <= 599 ? parsed : 503,
        claim.errorMessage || 'durable reconnect failed')
    }
    let replay: { logical: LogicalReconnectResponse; connectionGeneration: number }
    try {
      replay = await this.journal.withLeaseLocks(this.tenantId, [leaseId], async client => {
        const lease = await this.state.getLease(this.tenantId, leaseId, client)
        if (lease && ['release_pending', 'released', 'lost'].includes(lease.state)) {
          throw new ServiceError(404, 'lease missing')
        }
        if (!lease || lease.state !== 'active' || !lease.providerSandboxId) {
          throw new Error('reconnect replay lease is unavailable')
        }
        const response = logicalReconnectFromLease(lease)
        if (canonicalJson(response) !== canonicalJson(claim.response)) {
          throw new Error('reconnect replay response changed')
        }
        const rotated = await this.state.rotateReconnectReplayAccess(
          this.tenantId, leaseId, lease.providerSandboxId, client)
        return { logical: response, connectionGeneration: rotated.connectionGeneration }
      })
    } catch (error) {
      if (error instanceof ServiceError && error.status === 404) {
        this.revokeConnections(leaseId)
        throw error
      }
      throw new ServiceError(503, 'durable reconnect response is unavailable')
    }
    this.revokeConnections(leaseId)
    return this.withConnection(replay.logical, replay.connectionGeneration)
  }

  private async withConnection(logical: LogicalReconnectResponse,
    expectedConnectionGeneration: number): Promise<ProvisionedAgent> {
    try {
      return validateProvisionedAgent({
        ...logical, connection: { execServerUrl: await this.tickets.issue(
          logical.leaseId, undefined, expectedConnectionGeneration) },
      })
    } catch { throw new ServiceError(503, 'gateway ticket service unavailable') }
  }

  private async recoverCommitOutcome(identity: OperationIdentity, requestHash: string,
    fence: OperationIdentity & { generation: number; workerId: string }, leaseId: string): Promise<
      Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }> | null
    > {
    try {
      const claim = await this.journal.claimOperation({
        ...identity, requestHash, workerId: this.workerId, primaryLeaseId: leaseId,
      })
      if (claim.kind === 'succeeded' || claim.kind === 'failed_terminal') return claim
      if (claim.kind === 'in_progress' && claim.generation === fence.generation
        && await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)) return null
    } catch { /* An unreadable outcome must not alter lease access. */ }
    throw new ServiceError(503, 'durable reconnect outcome pending')
  }

  private revokeConnections(leaseId: string): void {
    try { this.options.connections?.revoke(leaseId) }
    catch { /* Durable ticket rotation remains authoritative. */ }
  }
}
