import { randomUUID } from 'node:crypto'
import type { ProviderAdapter } from './provider.js'
import type { PostgresDurableState } from './postgres-state.js'
import {
  canonicalRequestHash,
  OperationRequestMismatchError,
  type OperationAllocation,
  type OperationClaim,
  type OperationIdentity,
  type PostgresJournal,
} from './postgres-store.js'
import type { CheckpointRequest, ToolPolicy } from './types.js'
import { ServiceError } from './types.js'
import { validateCheckpointRequest, validateCheckpointResponse } from './validation.js'
import type {
  PreparedDurableBaseWorkspaceSnapshot,
  WorkspaceSnapshotPublisher,
} from './workspace-snapshots.js'
import { WorkspacePreparationAbortedError } from './workspace-snapshots.js'

export interface PostgresCheckpointOptions {
  tenantId: string
  workerId: string
  waitTimeoutMs?: number
}

const operation = 'checkpoint'

function bounded(label: string, value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

export class PostgresCheckpointCoordinator {
  private readonly tenantId: string
  private readonly workerId: string
  private readonly waitTimeoutMs: number

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly publisher: WorkspaceSnapshotPublisher,
    private readonly provider: ProviderAdapter,
    options: PostgresCheckpointOptions,
  ) {
    this.tenantId = bounded('tenant ID', options.tenantId)
    this.workerId = bounded('worker ID', options.workerId)
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs <= 0 || this.waitTimeoutMs > 5 * 60_000) {
      throw new Error('invalid operation wait timeout')
    }
  }

  async checkpoint(untrustedRequest: CheckpointRequest): Promise<{ snapshotId: string }> {
    const request = validateCheckpointRequest(untrustedRequest)
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
      throw new ServiceError(503, 'durable checkpoint service unavailable')
    }
    if (claim.kind === 'in_progress') {
      try {
        claim = await this.journal.waitForTerminal({ ...identity, requestHash }, { timeoutMs: this.waitTimeoutMs })
      } catch { throw new ServiceError(503, 'durable checkpoint is still in progress') }
    }
    if (claim.kind !== 'claimed') return this.replay(claim, request.leaseId)

    const fence = { ...identity, generation: claim.generation, workerId: this.workerId }
    let providerSnapshot: { resourceId: string; allocation: OperationAllocation | undefined } | undefined
    let prepared: PreparedDurableBaseWorkspaceSnapshot | undefined
    let preparationStarted = false
    let finalCommitStarted = false
    try {
      const response = await this.journal.withLeaseLocks(this.tenantId, [request.leaseId], async client => {
        const lease = await this.state.getLease(this.tenantId, request.leaseId, client)
        if (!lease || !['active', 'paused'].includes(lease.state) || !lease.providerSandboxId) {
          throw new ServiceError(409, 'lease cannot be checkpointed')
        }
        await this.heartbeat(fence)
        const archive = await this.provider.exportWorkspace(lease.providerSandboxId)
        const snapshotId = `snapshot_${randomUUID().replaceAll('-', '')}`
        const providerSnapshotId = await this.provider.snapshot(
          lease.providerSandboxId, { name: `checkpoint-${snapshotId}` })
        providerSnapshot = { resourceId: providerSnapshotId, allocation: undefined }
        providerSnapshot.allocation = await this.journal.withProviderResourceLock(
          'provider_snapshot', providerSnapshotId, allocationClient =>
            this.journal.recordAllocation(fence, fence.generation, fence.workerId, {
              kind: 'provider_snapshot', resourceId: providerSnapshotId,
              metadata: { checkpoint: snapshotId },
            }, allocationClient))
        await this.heartbeat(fence)
        preparationStarted = true
        prepared = await this.publisher.prepareDurableBase({
          fence,
          expectedSourceChecksum: null,
          expectedLatestSnapshotId: lease.latestSnapshotId,
          leaseId: lease.leaseId,
          environmentId: lease.environmentId,
          tenantId: lease.tenantId,
          agentId: lease.agentId,
          ownerAgentId: lease.ownerAgentId,
          ownerLeaseId: lease.ownerLeaseId,
          sourceSnapshotId: null,
          providerSandboxId: lease.providerSandboxId,
          sandboxTemplate: lease.sandboxTemplate,
          cwdUri: lease.cwdUri,
          workspaceRootUris: [...lease.workspaceRootUris],
          toolPolicy: structuredClone(lease.toolPolicy),
          policyVersion: lease.policyVersion,
          snapshot: { snapshotId, providerSnapshotId, archive, expiresAt: null },
        })
        finalCommitStarted = true
        await this.journal.lockProviderResources(
          [{ kind: 'provider_snapshot', resourceId: providerSnapshotId }], client)
        const durable = await this.publisher.commitDurableCheckpoint(fence, prepared, client)
        await this.journal.bindLeaseAndAdoptAllocations(identity, fence.generation, fence.workerId,
          lease.leaseId, [providerSnapshot.allocation.allocationId, ...durable.objectAllocationIds], client)
        const logical = validateCheckpointResponse({ snapshotId: durable.snapshot.snapshotId })
        await this.journal.completeOperation(identity, fence.generation, fence.workerId, logical, client)
        return logical
      })
      return response
    } catch (error) {
      if (finalCommitStarted) {
        const succeeded = await this.recoverCommitOutcome(identity, requestHash, fence)
        if (succeeded) return this.replay(succeeded, request.leaseId)
      }
      const cleaned = await this.cleanupFailedCheckpoint(fence, prepared, providerSnapshot)
      const preparationReclaimed = error instanceof WorkspacePreparationAbortedError
      if (cleaned && (!preparationStarted || prepared !== undefined || preparationReclaimed)) {
        const failure = error instanceof ServiceError && error.status < 500
          ? error
          : new ServiceError(503, 'durable checkpoint failed')
        await this.journal.failOperation(identity, fence.generation, fence.workerId,
          `service_${failure.status}`, failure.message).catch(() => undefined)
        throw failure
      }
      throw new ServiceError(503, 'durable checkpoint cleanup pending')
    }
  }

  private async replay(claim: Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }>,
    leaseId: string): Promise<{ snapshotId: string }> {
    if (claim.kind === 'failed_terminal') {
      const status = /^service_([0-9]{3})$/u.exec(claim.errorCode ?? '')
      const parsed = status ? Number(status[1]) : 503
      throw new ServiceError(parsed >= 400 && parsed <= 599 ? parsed : 503,
        claim.errorMessage || 'durable checkpoint failed')
    }
    const response = validateCheckpointResponse(claim.response)
    const snapshot = await this.state.getSnapshot(this.tenantId, response.snapshotId)
    if (!snapshot || snapshot.leaseId !== leaseId || snapshot.state !== 'available') {
      throw new ServiceError(503, 'durable checkpoint response is unavailable')
    }
    return response
  }

  private async heartbeat(fence: OperationIdentity & { generation: number; workerId: string }): Promise<void> {
    if (!await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)) {
      throw new ServiceError(503, 'durable checkpoint ownership changed')
    }
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
    throw new ServiceError(503, 'durable checkpoint cleanup pending')
  }

  private async cleanupFailedCheckpoint(
    fence: OperationIdentity & { generation: number; workerId: string },
    prepared: PreparedDurableBaseWorkspaceSnapshot | undefined,
    providerSnapshot: { resourceId: string; allocation: OperationAllocation | undefined } | undefined,
  ): Promise<boolean> {
    let failed = false
    if (prepared) {
      try { await this.publisher.abortDurableBase(fence, prepared) }
      catch { failed = true }
    }
    if (providerSnapshot) {
      try {
        await this.journal.withProviderResourceLock('provider_snapshot', providerSnapshot.resourceId, async client => {
          await this.provider.deleteSnapshot(providerSnapshot.resourceId)
          if (providerSnapshot.allocation) {
            await this.journal.updateAllocationState(fence, fence.generation, fence.workerId,
              providerSnapshot.allocation.allocationId, 'reclaimed', client)
          }
        })
      } catch { failed = true }
    }
    return !failed
  }
}
