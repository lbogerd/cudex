import { createHash } from 'node:crypto'
import type { ProviderAdapter } from './provider.js'
import type { PostgresRestoreSourceResolver } from './postgres-restore-source.js'
import type { Lease, PostgresDurableState, Snapshot } from './postgres-state.js'
import {
  canonicalRequestHash,
  OperationRequestMismatchError,
  OperationTargetNotFoundError,
  type OperationAllocation,
  type OperationClaim,
  type OperationIdentity,
  type PostgresJournal,
} from './postgres-store.js'
import type { AuthenticatedTenant } from './source-snapshots.js'
import { gatewayConnectTicketPurpose, type TicketAuthority } from './tickets.js'
import type { ProvisionRequest, ProvisionedAgent, ToolPolicy } from './types.js'
import { ServiceError } from './types.js'
import { validateProvisionedAgent, validateProvisionRequest } from './validation.js'
import type {
  PreparedDurableBaseWorkspaceSnapshot,
  WorkspaceSnapshotPublisher,
} from './workspace-snapshots.js'
import { WorkspacePreparationAbortedError } from './workspace-snapshots.js'

export interface TrustedRestoreRole {
  sandboxTemplate: string
  providerTemplateId: string
  toolPolicy: ToolPolicy
  policyVersion: number
}

export interface PostgresRestoreOptions {
  principal: AuthenticatedTenant
  managedBy: string
  workerId: string
  roles: Record<string, TrustedRestoreRole>
  waitTimeoutMs?: number
  heartbeatIntervalMs?: number
}

interface LogicalRestoreResponse {
  leaseId: string
  environmentId: string
  cwd: string
  workspaceRoots: string[]
  baseSnapshotId: string
  toolPolicy: ToolPolicy
}

const operation = 'provision'

function bounded(label: string, value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

export function deterministicRestoreId(
  prefix: 'lease' | 'env' | 'snapshot', identity: OperationIdentity,
): string {
  return `${prefix}_${createHash('sha256')
    .update('hosted-agent-restore\0').update(prefix).update('\0')
    .update(identity.tenantId).update('\0').update(identity.idempotencyKey)
    .digest('hex').slice(0, 32)}`
}

export function restoreProviderSnapshotName(identity: OperationIdentity): string {
  return `restore-${deterministicRestoreId('snapshot', identity)}`
}

function policy(value: unknown): ToolPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid durable tool policy')
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.allowedDomains) || !Array.isArray(record.allowedTools)) {
    throw new Error('invalid durable tool policy')
  }
  return structuredClone(value) as ToolPolicy
}

function logicalFromLease(lease: Lease): LogicalRestoreResponse {
  if (lease.state !== 'active' || !lease.baseSnapshotId || !lease.restoreSourceLeaseId
    || !lease.restoreSourceSnapshotId) {
    throw new ServiceError(503, 'durable restore response is unavailable')
  }
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
    throw new ServiceError(503, 'durable restore response is unavailable')
  }
  const leaseId = (value as Record<string, unknown>).leaseId
  if (typeof leaseId !== 'string') throw new ServiceError(503, 'durable restore response is unavailable')
  return bounded('replay lease ID', leaseId)
}

export class PostgresRestoreCoordinator {
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
    private readonly sourceResolver: PostgresRestoreSourceResolver,
    private readonly options: PostgresRestoreOptions,
  ) {
    this.tenantId = bounded('tenant ID', options.principal.tenantId)
    this.managedBy = bounded('managed-by marker', options.managedBy)
    this.workerId = bounded('worker ID', options.workerId)
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs <= 0
      || this.waitTimeoutMs > 5 * 60_000) throw new Error('invalid operation wait timeout')
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0
      || this.heartbeatIntervalMs > 60_000) throw new Error('invalid operation heartbeat interval')
    const templates = new Set<string>()
    for (const role of Object.values(options.roles)) {
      bounded('sandbox template', role.sandboxTemplate)
      if (templates.has(role.sandboxTemplate)) {
        throw new Error('restore roles require unique sandbox templates')
      }
      templates.add(role.sandboxTemplate)
    }
  }

  async provision(untrustedRequest: ProvisionRequest): Promise<ProvisionedAgent> {
    const request = validateProvisionRequest(untrustedRequest)
    if (request.source.type !== 'durableSnapshot') {
      throw new ServiceError(400, 'durable restore requires a durable snapshot')
    }
    const sourceSnapshotId = request.source.snapshotId
    const role = this.options.roles[request.agentType]
    if (!role || role.sandboxTemplate !== request.sandboxTemplate) {
      throw new ServiceError(422, 'invalid trusted agent role')
    }
    bounded('provider template ID', role.providerTemplateId)
    if (!Number.isSafeInteger(role.policyVersion) || role.policyVersion <= 0) {
      throw new Error('invalid policy version')
    }

    let snapshot: Snapshot
    let sourceLease: Lease
    try {
      const foundSnapshot = await this.state.getSnapshot(this.tenantId, sourceSnapshotId)
      if (!foundSnapshot) throw new ServiceError(404, 'snapshot missing')
      const foundLease = await this.state.getLease(this.tenantId, foundSnapshot.leaseId)
      if (!foundLease || foundSnapshot.snapshotId !== foundLease.latestSnapshotId) {
        throw new ServiceError(404, 'snapshot missing')
      }
      snapshot = foundSnapshot
      sourceLease = foundLease
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(503, 'durable restore service unavailable')
    }
    const identity: OperationIdentity = {
      operation,
      idempotencyKey: request.idempotencyKey,
      tenantId: this.tenantId,
    }
    const requestHash = canonicalRequestHash(request)
    let claim: OperationClaim
    try {
      claim = await this.journal.claimOperation({
        ...identity,
        requestHash,
        workerId: this.workerId,
        primaryLeaseId: sourceLease.leaseId,
      })
    } catch (error) {
      if (error instanceof OperationRequestMismatchError) throw new ServiceError(409, error.message)
      if (error instanceof OperationTargetNotFoundError) throw new ServiceError(404, 'snapshot missing')
      throw new ServiceError(503, 'durable restore service unavailable')
    }
    if (claim.kind === 'in_progress') {
      try {
        claim = await this.journal.waitForTerminal(
          { ...identity, requestHash }, { timeoutMs: this.waitTimeoutMs })
      } catch { throw new ServiceError(503, 'durable restore is still in progress') }
    }
    const replayExpected = {
      sourceSnapshotId,
      agentId: request.agentId,
      ownerAgentId: request.ownerAgentId,
      sandboxTemplate: request.sandboxTemplate,
    }
    if (claim.kind !== 'claimed') return this.replay(identity, claim, sourceLease, replayExpected)

    const fence = { ...identity, generation: claim.generation, workerId: this.workerId }
    const providerAllocations: Array<{
      kind: 'sandbox' | 'provider_snapshot'
      resourceId: string
      allocation: OperationAllocation | undefined
    }> = []
    let prepared: PreparedDurableBaseWorkspaceSnapshot | undefined
    let preparationStarted = false
    let finalCommitStarted = false
    let committed: Lease
    try {
      const source = await this.withHeartbeat(fence, () => this.sourceResolver.resolve({
        tenantId: this.tenantId,
        sourceLeaseId: sourceLease.leaseId,
        sourceSnapshotId,
        agentId: request.agentId,
        ownerAgentId: request.ownerAgentId,
        ownerLeaseId: sourceLease.ownerLeaseId,
        sandboxTemplate: request.sandboxTemplate,
      }))
      if (source.lease.leaseId !== sourceLease.leaseId
        || source.snapshot.snapshotId !== sourceSnapshotId
        || source.snapshot.leaseId !== source.lease.leaseId
        || !(source.archive instanceof Uint8Array)) {
        throw new ServiceError(503, 'durable restore source resolution mismatch')
      }

      const leaseId = deterministicRestoreId('lease', identity)
      const environmentId = deterministicRestoreId('env', identity)
      const snapshotId = deterministicRestoreId('snapshot', identity)
      const created = await this.withHeartbeat(fence, () => this.provider.create(role.providerTemplateId, {
        managedBy: this.managedBy,
        tenantId: this.tenantId,
        leaseId,
        agentId: request.agentId,
        sandboxTemplate: request.sandboxTemplate,
        restoreSourceLeaseId: source.lease.leaseId,
      }))
      const sandboxResource = {
        kind: 'sandbox' as const,
        resourceId: created.sandboxId,
        allocation: undefined as OperationAllocation | undefined,
      }
      providerAllocations.push(sandboxResource)
      const sandboxAllocation = await this.recordProviderAllocation(
        fence, 'sandbox', created.sandboxId)
      sandboxResource.allocation = sandboxAllocation
      await this.withHeartbeat(fence, () => this.provider.uploadArchive(created.sandboxId, source.archive))
      await this.withHeartbeat(fence, () => this.provider.startExecServer(created.sandboxId))
      await this.withHeartbeat(fence, () => this.provider.probeExecServer(created.sandboxId))
      const archive = await this.withHeartbeat(
        fence, () => this.provider.exportWorkspace(created.sandboxId))
      const providerSnapshotId = await this.withHeartbeat(fence, () => this.provider.snapshot(
        created.sandboxId, { name: restoreProviderSnapshotName(identity) }))
      const snapshotResource = {
        kind: 'provider_snapshot' as const,
        resourceId: providerSnapshotId,
        allocation: undefined as OperationAllocation | undefined,
      }
      providerAllocations.push(snapshotResource)
      const snapshotAllocation = await this.recordProviderAllocation(
        fence, 'provider_snapshot', providerSnapshotId)
      snapshotResource.allocation = snapshotAllocation
      await this.heartbeat(fence)
      preparationStarted = true
      prepared = await this.publisher.prepareDurableBase({
        fence,
        expectedSourceChecksum: null,
        leaseId,
        environmentId,
        tenantId: this.tenantId,
        agentId: request.agentId,
        ownerAgentId: source.lease.ownerAgentId,
        ownerLeaseId: source.lease.ownerLeaseId,
        sourceSnapshotId: null,
        restoreSourceLeaseId: source.lease.leaseId,
        restoreSourceSnapshotId: source.snapshot.snapshotId,
        providerSandboxId: created.sandboxId,
        sandboxTemplate: request.sandboxTemplate,
        cwdUri: source.lease.cwdUri,
        workspaceRootUris: [...source.lease.workspaceRootUris],
        toolPolicy: structuredClone(role.toolPolicy) as unknown as Record<string, unknown>,
        policyVersion: role.policyVersion,
        snapshot: { snapshotId, providerSnapshotId, archive, expiresAt: null },
      })
      finalCommitStarted = true
      committed = await this.journal.withLeaseLocks(
        this.tenantId, [source.lease.leaseId], async client => {
          if (!await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId, client)) {
            throw new Error('durable restore ownership changed')
          }
          await this.journal.lockProviderResources([
            { kind: 'sandbox', resourceId: created.sandboxId },
            { kind: 'provider_snapshot', resourceId: providerSnapshotId },
          ], client)
          const durable = await this.publisher.commitDurableRestore(fence, prepared!, client)
          await this.journal.bindResultLeaseAndAdoptAllocations(
            identity, fence.generation, fence.workerId, durable.lease.leaseId,
            [sandboxAllocation.allocationId, snapshotAllocation.allocationId,
              ...durable.objectAllocationIds], client)
          const logical = logicalFromLease(durable.lease)
          await this.journal.completeOperation(
            identity, fence.generation, fence.workerId, logical, client)
          return durable.lease
        })
    } catch (error) {
      if (finalCommitStarted) {
        const succeeded = await this.recoverCommitOutcome(
          identity, requestHash, sourceLease.leaseId, fence)
        if (succeeded) return this.replay(identity, succeeded, sourceLease, replayExpected)
      }
      const cleaned = await this.cleanupFailedRestore(fence, prepared, providerAllocations)
      const preparationReclaimed = error instanceof WorkspacePreparationAbortedError
      if (cleaned && (!preparationStarted || prepared !== undefined || preparationReclaimed)) {
        const failure = error instanceof ServiceError && error.status < 500
          ? error
          : new ServiceError(503, 'durable restore failed')
        await this.journal.failOperation(identity, fence.generation, fence.workerId,
          `service_${failure.status}`, failure.message).catch(() => undefined)
        throw failure
      }
      throw new ServiceError(503, 'durable restore cleanup pending')
    }
    return this.withConnection(logicalFromLease(committed), committed.connectionGeneration)
  }

  async restore(untrustedRequest: ProvisionRequest): Promise<ProvisionedAgent> {
    return this.provision(untrustedRequest)
  }

  private async replay(identity: OperationIdentity,
    claim: Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }>,
    sourceLease: Lease, expected: { sourceSnapshotId: string; agentId: string;
      ownerAgentId: string | null; sandboxTemplate: string },
  ): Promise<ProvisionedAgent> {
    if (claim.kind === 'failed_terminal') {
      const status = /^service_([0-9]{3})$/u.exec(claim.errorCode ?? '')
      const parsed = status ? Number(status[1]) : 503
      throw new ServiceError(parsed >= 400 && parsed <= 599 ? parsed : 503,
        claim.errorMessage || 'durable restore failed')
    }
    const resultLeaseId = replayLeaseId(claim.response)
    const lease = await this.state.getLease(identity.tenantId, resultLeaseId)
    if (!lease || lease.restoreSourceLeaseId !== sourceLease.leaseId
      || lease.restoreSourceSnapshotId !== expected.sourceSnapshotId
      || lease.agentId !== expected.agentId || lease.ownerAgentId !== expected.ownerAgentId
      || lease.ownerLeaseId !== sourceLease.ownerLeaseId
      || lease.sandboxTemplate !== expected.sandboxTemplate) {
      throw new ServiceError(503, 'durable restore response is unavailable')
    }
    return this.withConnection(logicalFromLease(lease), lease.connectionGeneration)
  }

  private async withConnection(logical: LogicalRestoreResponse,
    connectionGeneration: number): Promise<ProvisionedAgent> {
    return validateProvisionedAgent({
      ...logical,
      connection: {
        execServerUrl: await this.tickets.issue(
          logical.leaseId, gatewayConnectTicketPurpose, connectionGeneration),
      },
    })
  }

  private async recoverCommitOutcome(identity: OperationIdentity, requestHash: string,
    sourceLeaseId: string,
    fence: OperationIdentity & { generation: number; workerId: string }): Promise<
      Extract<OperationClaim, { kind: 'succeeded' }> | null
    > {
    try {
      const claim = await this.journal.claimOperation({
        ...identity, requestHash, workerId: this.workerId, primaryLeaseId: sourceLeaseId,
      })
      if (claim.kind === 'succeeded') return claim
      if (claim.kind === 'in_progress' && claim.generation === fence.generation
        && await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)) return null
    } catch { /* An unreadable outcome must remain for reconciliation. */ }
    throw new ServiceError(503, 'durable restore cleanup pending')
  }

  private async recordProviderAllocation(
    fence: OperationIdentity & { generation: number; workerId: string },
    kind: 'sandbox' | 'provider_snapshot',
    resourceId: string,
  ): Promise<OperationAllocation> {
    return this.journal.withProviderResourceLock(kind, resourceId, client =>
      this.journal.recordAllocation(fence, fence.generation, fence.workerId, {
        kind,
        resourceId,
        metadata: { managedBy: this.managedBy, action: 'restore' },
      }, client))
  }

  private async heartbeat(
    fence: OperationIdentity & { generation: number; workerId: string }): Promise<void> {
    if (!await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)) {
      throw new ServiceError(503, 'durable restore ownership changed')
    }
  }

  private async withHeartbeat<T>(
    fence: OperationIdentity & { generation: number; workerId: string },
    action: () => Promise<T>,
  ): Promise<T> {
    await this.heartbeat(fence)
    let heartbeatFailure: unknown
    const timer = setInterval(() => {
      void this.heartbeat(fence).catch(error => { heartbeatFailure ??= error })
    }, this.heartbeatIntervalMs)
    timer.unref?.()
    try {
      const result = await action()
      if (heartbeatFailure) throw heartbeatFailure
      await this.heartbeat(fence)
      return result
    } finally {
      clearInterval(timer)
    }
  }

  private async cleanupFailedRestore(
    fence: OperationIdentity & { generation: number; workerId: string },
    prepared: PreparedDurableBaseWorkspaceSnapshot | undefined,
    allocations: Array<{
      kind: 'sandbox' | 'provider_snapshot'
      resourceId: string
      allocation: OperationAllocation | undefined
    }>,
  ): Promise<boolean> {
    let failed = false
    if (prepared) {
      try {
        await this.heartbeat(fence)
        await this.publisher.abortDurableBase(fence, prepared)
      }
      catch { failed = true }
    }
    for (const item of [...allocations].reverse()) {
      try {
        await this.journal.withProviderResourceLock(item.kind, item.resourceId, async client => {
          if (!await this.journal.heartbeatOperation(
            fence, fence.generation, fence.workerId, client)) {
            throw new Error('durable restore ownership changed')
          }
          if (item.kind === 'provider_snapshot') await this.provider.deleteSnapshot(item.resourceId)
          else await this.provider.kill(item.resourceId)
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
