import { randomUUID } from 'node:crypto'
import type { ProviderAdapter } from './provider.js'
import type { Lease, PostgresDurableState } from './postgres-state.js'
import {
  canonicalRequestHash,
  OperationRequestMismatchError,
  type OperationAllocation,
  type OperationClaim,
  type OperationIdentity,
  type PostgresJournal,
} from './postgres-store.js'
import type { AuthenticatedTenant, ResolvedSourceSnapshot } from './source-snapshots.js'
import type { TicketAuthority } from './tickets.js'
import type { ProvisionRequest, ProvisionedAgent, ToolPolicy } from './types.js'
import { ServiceError } from './types.js'
import { validateProvisionedAgent, validateProvisionRequest } from './validation.js'
import type {
  PreparedDurableBaseWorkspaceSnapshot,
  WorkspaceSnapshotPublisher,
} from './workspace-snapshots.js'
import { WorkspacePreparationAbortedError } from './workspace-snapshots.js'

export interface TrustedProvisionRole {
  sandboxTemplate: string
  providerTemplateId: string
  toolPolicy: ToolPolicy
  policyVersion: number
}

export interface PostgresProvisionOptions {
  principal: AuthenticatedTenant
  managedBy: string
  workerId: string
  roles: Record<string, TrustedProvisionRole>
  sourceResolver: {
    resolve(principal: AuthenticatedTenant, sourceSnapshotId: string,
      expectedChecksum: string): Promise<ResolvedSourceSnapshot>
  }
  waitTimeoutMs?: number
  heartbeatIntervalMs?: number
}

interface LogicalProvisionResponse {
  leaseId: string
  environmentId: string
  cwd: string
  workspaceRoots: string[]
  baseSnapshotId: string
  toolPolicy: ToolPolicy
}

const operation = 'provision'

function generatedId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function bounded(label: string, value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

function policy(value: unknown): ToolPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid durable tool policy')
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.allowedDomains) || !Array.isArray(record.allowedTools)) throw new Error('invalid durable tool policy')
  return structuredClone(value) as ToolPolicy
}

function logicalFromLease(lease: Lease): LogicalProvisionResponse {
  if (lease.state !== 'active' || !lease.baseSnapshotId) throw new ServiceError(503, 'durable provision response is unavailable')
  return {
    leaseId: lease.leaseId,
    environmentId: lease.environmentId,
    cwd: lease.cwdUri,
    workspaceRoots: [...lease.workspaceRootUris],
    baseSnapshotId: lease.baseSnapshotId,
    toolPolicy: policy(lease.toolPolicy),
  }
}

function replayLeaseId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError(503, 'durable provision response is unavailable')
  }
  const leaseId = (value as Record<string, unknown>).leaseId
  if (typeof leaseId !== 'string') throw new ServiceError(503, 'durable provision response is unavailable')
  return bounded('replay lease ID', leaseId)
}

export class PostgresProvisionCoordinator {
  private readonly tenantId: string
  private readonly managedBy: string
  private readonly workerId: string
  private readonly waitTimeoutMs: number
  private readonly heartbeatIntervalMs: number

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly publisher: WorkspaceSnapshotPublisher,
    private readonly provider: ProviderAdapter,
    private readonly tickets: TicketAuthority,
    private readonly options: PostgresProvisionOptions,
  ) {
    this.tenantId = bounded('tenant ID', options.principal.tenantId)
    this.managedBy = bounded('managed-by marker', options.managedBy)
    this.workerId = bounded('worker ID', options.workerId)
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs <= 0 || this.waitTimeoutMs > 5 * 60_000) {
      throw new Error('invalid operation wait timeout')
    }
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0
      || this.heartbeatIntervalMs > 60_000) throw new Error('invalid operation heartbeat interval')
  }

  async provision(untrustedRequest: ProvisionRequest): Promise<ProvisionedAgent> {
    const request = validateProvisionRequest(untrustedRequest)
    if (request.source.type !== 'sourceSnapshot') throw new ServiceError(400, 'durable provision requires an immutable source snapshot')
    const sourceRequest = request.source
    const role = this.options.roles[request.agentType]
    if (!role || role.sandboxTemplate !== request.sandboxTemplate) throw new ServiceError(422, 'invalid trusted agent role')
    bounded('provider template ID', role.providerTemplateId)
    if (!Number.isSafeInteger(role.policyVersion) || role.policyVersion <= 0) throw new Error('invalid policy version')
    const identity: OperationIdentity = {
      operation,
      idempotencyKey: request.idempotencyKey,
      tenantId: this.tenantId,
    }
    const requestHash = canonicalRequestHash(request)
    let claim: OperationClaim
    try { claim = await this.journal.claimOperation({ ...identity, requestHash, workerId: this.workerId }) }
    catch (error) {
      if (error instanceof OperationRequestMismatchError) throw new ServiceError(409, error.message)
      throw new ServiceError(503, 'durable provision service unavailable')
    }
    if (claim.kind === 'in_progress') {
      try {
        claim = await this.journal.waitForTerminal({ ...identity, requestHash }, { timeoutMs: this.waitTimeoutMs })
      } catch { throw new ServiceError(503, 'durable provision is still in progress') }
    }
    if (claim.kind !== 'claimed') return this.replay(identity, claim)

    const fence = { ...identity, generation: claim.generation, workerId: this.workerId }
    const providerAllocations: Array<{
      kind: 'sandbox' | 'provider_snapshot'
      resourceId: string
      allocation: OperationAllocation | undefined
    }> = []
    let prepared: PreparedDurableBaseWorkspaceSnapshot | undefined
    let committed: LogicalProvisionResponse
    let preparationStarted = false
    let finalCommitStarted = false
    try {
      const source = await this.withHeartbeat(fence, () => this.options.sourceResolver.resolve(
        this.options.principal, sourceRequest.sourceSnapshotId, sourceRequest.checksum))
      if (source.sourceSnapshotId !== sourceRequest.sourceSnapshotId
        || source.checksum !== sourceRequest.checksum || !(source.archive instanceof Uint8Array)) {
        throw new ServiceError(503, 'immutable source snapshot resolution mismatch')
      }
      const leaseId = generatedId('lease')
      const environmentId = generatedId('env')
      const snapshotId = generatedId('snapshot')
      const created = await this.withHeartbeat(fence, () => this.provider.create(role.providerTemplateId, {
        managedBy: this.managedBy,
        tenantId: this.tenantId,
        leaseId,
        agentId: request.agentId,
        sandboxTemplate: request.sandboxTemplate,
      }))
      const sandboxResource = { kind: 'sandbox' as const, resourceId: created.sandboxId,
        allocation: undefined as OperationAllocation | undefined }
      providerAllocations.push(sandboxResource)
      const sandboxAllocation = await this.recordProviderAllocation(
        fence, 'sandbox', created.sandboxId)
      sandboxResource.allocation = sandboxAllocation
      await this.heartbeat(fence)
      await this.withHeartbeat(fence, () =>
        this.provider.uploadArchive(created.sandboxId, source.archive))
      await this.withHeartbeat(fence, () => this.provider.startExecServer(created.sandboxId))
      await this.withHeartbeat(fence, () => this.provider.probeExecServer(created.sandboxId))
      const archive = await this.withHeartbeat(
        fence, () => this.provider.exportWorkspace(created.sandboxId))
      const providerSnapshotId = await this.withHeartbeat(
        fence, () => this.provider.snapshot(created.sandboxId))
      const snapshotResource = { kind: 'provider_snapshot' as const, resourceId: providerSnapshotId,
        allocation: undefined as OperationAllocation | undefined }
      providerAllocations.push(snapshotResource)
      const snapshotAllocation = await this.recordProviderAllocation(
        fence, 'provider_snapshot', providerSnapshotId)
      snapshotResource.allocation = snapshotAllocation
      await this.heartbeat(fence)
      preparationStarted = true
      prepared = await this.withHeartbeat(fence, () => this.publisher.prepareDurableBase({
        fence,
        expectedSourceChecksum: sourceRequest.checksum,
        leaseId,
        environmentId,
        tenantId: this.tenantId,
        agentId: request.agentId,
        ownerAgentId: request.ownerAgentId,
        ownerLeaseId: null,
        sourceSnapshotId: sourceRequest.sourceSnapshotId,
        providerSandboxId: created.sandboxId,
        sandboxTemplate: request.sandboxTemplate,
        cwdUri: source.cwdUri,
        workspaceRootUris: [...source.workspaceRootUris],
        toolPolicy: structuredClone(role.toolPolicy) as unknown as Record<string, unknown>,
        policyVersion: role.policyVersion,
        snapshot: { snapshotId, providerSnapshotId, archive, expiresAt: null },
      }))
      finalCommitStarted = true
      committed = await this.journal.withProviderResourceLocks([
        { kind: 'sandbox', resourceId: created.sandboxId },
        { kind: 'provider_snapshot', resourceId: providerSnapshotId },
      ], async client => {
        const durable = await this.publisher.commitDurableBase(fence, prepared!, client)
        await this.journal.bindLeaseAndAdoptAllocations(identity, fence.generation, fence.workerId,
          leaseId, [sandboxAllocation.allocationId, snapshotAllocation.allocationId,
            ...durable.objectAllocationIds], client)
        const logical = logicalFromLease(durable.lease)
        await this.journal.completeOperation(identity, fence.generation, fence.workerId, logical, client)
        return logical
      })
    } catch (error) {
      if (finalCommitStarted) {
        const succeeded = await this.recoverCommitOutcome(identity, requestHash, fence)
        if (succeeded) return this.replay(identity, succeeded)
      }
      const cleaned = await this.cleanupFailedProvision(fence, prepared, providerAllocations)
      const preparationReclaimed = error instanceof WorkspacePreparationAbortedError
      if (cleaned && (!preparationStarted || prepared !== undefined || preparationReclaimed)) {
        const failure = error instanceof ServiceError && error.status < 500
          ? error
          : new ServiceError(503, 'durable provision failed')
        await this.journal.failOperation(identity, fence.generation, fence.workerId,
          `service_${failure.status}`, failure.message).catch(() => undefined)
        throw failure
      }
      throw new ServiceError(503, 'durable provision cleanup pending')
    }
    return this.withConnection(committed)
  }

  private async replay(identity: OperationIdentity,
    claim: Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }>): Promise<ProvisionedAgent> {
    if (claim.kind === 'failed_terminal') {
      const status = /^service_([0-9]{3})$/u.exec(claim.errorCode ?? '')
      const parsed = status ? Number(status[1]) : 503
      throw new ServiceError(parsed >= 400 && parsed <= 599 ? parsed : 503,
        claim.errorMessage || 'durable provision failed')
    }
    const lease = await this.state.getLease(identity.tenantId, replayLeaseId(claim.response))
    if (!lease) throw new ServiceError(503, 'durable provision response is unavailable')
    return this.withConnection(logicalFromLease(lease))
  }

  private async withConnection(logical: LogicalProvisionResponse): Promise<ProvisionedAgent> {
    return validateProvisionedAgent({
      ...logical,
      connection: { execServerUrl: await this.tickets.issue(logical.leaseId) },
    })
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
    throw new ServiceError(503, 'durable provision cleanup pending')
  }

  private async recordProviderAllocation(
    fence: OperationIdentity & { generation: number; workerId: string },
    kind: 'sandbox' | 'provider_snapshot',
    resourceId: string,
  ): Promise<OperationAllocation> {
    return this.journal.withProviderResourceLock(kind, resourceId, client =>
      this.journal.recordAllocation(fence, fence.generation, fence.workerId,
        { kind, resourceId, metadata: { managedBy: this.managedBy } }, client))
  }

  private async heartbeat(fence: OperationIdentity & { generation: number; workerId: string }): Promise<void> {
    if (!await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)) {
      throw new ServiceError(503, 'durable provision ownership changed')
    }
  }

  private async withHeartbeat<T>(
    fence: OperationIdentity & { generation: number; workerId: string },
    call: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      void this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)
        .catch(() => undefined)
    }, this.heartbeatIntervalMs)
    timer.unref()
    try {
      const result = await call()
      await this.heartbeat(fence)
      return result
    } finally { clearInterval(timer) }
  }

  private async cleanupFailedProvision(
    fence: OperationIdentity & { generation: number; workerId: string },
    prepared: PreparedDurableBaseWorkspaceSnapshot | undefined,
    allocations: Array<{ kind: 'sandbox' | 'provider_snapshot'; resourceId: string;
      allocation: OperationAllocation | undefined }>,
  ): Promise<boolean> {
    let failed = false
    if (prepared) {
      try { await this.withHeartbeat(fence, () => this.publisher.abortDurableBase(fence, prepared)) }
      catch { failed = true }
    }
    for (const item of [...allocations].reverse()) {
      try {
        await this.journal.withProviderResourceLock(item.kind, item.resourceId, async client => {
          if (item.kind === 'provider_snapshot') {
            await this.withHeartbeat(fence, () => this.provider.deleteSnapshot(item.resourceId))
          } else await this.withHeartbeat(fence, () => this.provider.kill(item.resourceId))
          if (item.allocation) {
            await this.journal.updateAllocationState(fence, fence.generation, fence.workerId,
              item.allocation.allocationId, 'reclaimed', client)
          }
        })
      } catch { failed = true }
    }
    return !failed
  }
}
