import type { PoolClient } from 'pg'
import type { ProviderAdapter } from './provider.js'
import type { PostgresDurableState } from './postgres-state.js'
import type { PostgresObjectReclaimer } from './postgres-object-reclaimer.js'
import type {
  PatchApplication,
  PatchApplicationFence,
  PostgresPatchApplicationRepository,
} from './postgres-patch-applications.js'
import type { PostgresPatchApplySourceResolver } from './postgres-patch-apply-source.js'
import {
  deterministicPatchApplyId,
  patchApplyProviderSnapshotName,
} from './postgres-patch-apply.js'
import {
  canonicalRequestHash,
  OperationOwnershipError,
  type OperationAllocation,
  type PostgresJournal,
  type StaleOperation,
} from './postgres-store.js'
import type { PostgresWorkspacePreparations } from './postgres-workspace-preparations.js'
import { validatePatchApplyResponse } from './validation.js'

const operationName = 'patch_apply'

export interface PostgresPatchApplyReconcilerOptions {
  tenantId: string
  workerId: string
  staleAfterMs?: number
  pollIntervalMs?: number
  maxOperationsPerRun?: number
  maxAllocationsPerOperation?: number
  heartbeatIntervalMs?: number
  onError?: (error: unknown) => void
}

export interface PatchApplyReconcileResult {
  operationsClaimed: number
  operationsCompleted: number
  operationsFailed: number
  allocationsReclaimed: number
  allocationsPending: number
  protectedResources: number
}

interface RecoveryDependencies {
  preparations: Pick<PostgresWorkspacePreparations,
    'getForOperation' | 'listObjectAllocationIdsForReconciliation' | 'beginAbort'>
  reclaimer: Pick<PostgresObjectReclaimer,
    'reclaimPreparationObjects' | 'reclaimOperationObjects'>
}

interface CleanupCounts {
  allocationsReclaimed: number
  protectedResources: number
}

const defaults = {
  staleAfterMs: 5 * 60_000,
  pollIntervalMs: 30_000,
  maxOperationsPerRun: 100,
  maxAllocationsPerOperation: 100,
  heartbeatIntervalMs: 15_000,
}

function bounded(label: string, value: string, maximum = 512): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

function positive(label: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`invalid ${label}`)
  }
  return value
}

function exactMetadata(allocation: OperationAllocation, expected: Record<string, string>): boolean {
  const keys = Object.keys(allocation.metadata).sort()
  const expectedKeys = Object.keys(expected).sort()
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]
      && allocation.metadata[key] === expected[key])
}

function sortAllocationIds(values: string[]): string[] {
  return [...values].sort((left, right) => {
    const a = BigInt(left); const b = BigInt(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

export class PostgresPatchApplyReconciler {
  private readonly options: Required<Omit<PostgresPatchApplyReconcilerOptions, 'onError'>>
    & Pick<PostgresPatchApplyReconcilerOptions, 'onError'>
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<PatchApplyReconcileResult> | undefined
  private stopped = true

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly sources: PostgresPatchApplySourceResolver,
    private readonly applications: PostgresPatchApplicationRepository,
    private readonly provider: ProviderAdapter,
    private readonly recovery: RecoveryDependencies,
    options: PostgresPatchApplyReconcilerOptions,
  ) {
    this.options = { ...defaults, ...options }
    bounded('tenant ID', this.options.tenantId)
    bounded('worker ID', this.options.workerId)
    positive('stale timeout', this.options.staleAfterMs, 24 * 60 * 60_000)
    positive('poll interval', this.options.pollIntervalMs, 24 * 60 * 60_000)
    positive('operation batch size', this.options.maxOperationsPerRun, 1000)
    positive('allocation batch size', this.options.maxAllocationsPerOperation, 10_000)
    positive('heartbeat interval', this.options.heartbeatIntervalMs, 60_000)
    if (this.options.heartbeatIntervalMs >= this.options.staleAfterMs) {
      throw new Error('patch apply recovery heartbeat must be shorter than stale timeout')
    }
  }

  runOnce(): Promise<PatchApplyReconcileResult> {
    if (this.running) return this.running
    const run = this.runBounded().finally(() => { if (this.running === run) this.running = undefined })
    this.running = run
    return run
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.running?.catch(() => undefined)
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.runOnce().catch(error => this.options.onError?.(error)).finally(() => {
        this.schedule(this.options.pollIntervalMs)
      })
    }, delayMs)
    this.timer.unref()
  }

  private async runBounded(): Promise<PatchApplyReconcileResult> {
    const result: PatchApplyReconcileResult = {
      operationsClaimed: 0, operationsCompleted: 0, operationsFailed: 0,
      allocationsReclaimed: 0, allocationsPending: 0, protectedResources: 0,
    }
    const stale = await this.journal.claimStaleOperations(
      new Date(Date.now() - this.options.staleAfterMs),
      this.options.maxOperationsPerRun, this.options.workerId,
      this.options.tenantId, operationName)
    result.operationsClaimed = stale.length
    for (const claimed of stale) {
      try {
        const outcome = await this.reconcileClaimed(claimed)
        result.operationsCompleted += outcome.completed ? 1 : 0
        result.operationsFailed += outcome.failed ? 1 : 0
        result.allocationsReclaimed += outcome.counts.allocationsReclaimed
        result.protectedResources += outcome.counts.protectedResources
        result.allocationsPending += outcome.pending ? 1 : 0
      } catch (error) {
        result.allocationsPending += 1
        this.options.onError?.(error)
      }
    }
    return result
  }

  private async reconcileClaimed(operation: StaleOperation): Promise<{
    completed: boolean
    failed: boolean
    pending: boolean
    counts: CleanupCounts
  }> {
    if (operation.operation !== operationName || operation.tenantId !== this.options.tenantId
      || operation.primaryLeaseId === null || operation.resultLeaseId !== null) {
      throw new OperationOwnershipError()
    }
    return this.journal.withSessionLeaseLocks(
      operation.tenantId, [operation.primaryLeaseId], client =>
        this.reconcileOwned(operation, client))
  }

  private async reconcileOwned(operation: StaleOperation, client: PoolClient): Promise<{
    completed: boolean
    failed: boolean
    pending: boolean
    counts: CleanupCounts
  }> {
    const fence: PatchApplicationFence = {
      operation: operation.operation, idempotencyKey: operation.idempotencyKey,
      tenantId: operation.tenantId, generation: operation.generation,
      workerId: operation.workerId,
    }
    await this.heartbeat(fence)
    let application = await this.applications.getForOperation(fence)
    if (!application) {
      if ((await this.allocations(fence)).length !== 0) throw new OperationOwnershipError()
      await this.cleanupNamedSnapshot(fence, 'rollback')
      await this.cleanupNamedSnapshot(fence, 'result')
      await this.failOperation(fence)
      return { completed: false, failed: true, pending: false,
        counts: { allocationsReclaimed: 0, protectedResources: 0 } }
    }
    this.validateApplication(operation, application)

    if (application.phase === 'checkpointed') {
      return this.recoverCheckpointed(fence, application, client)
    }
    if (application.phase === 'planned') {
      application = await this.transaction(client, () => this.applications.markFailed(
        fence, application!.applicationId, 'abandoned before provider mutation', client))
    } else if (!['rolled_back', 'failed'].includes(application.phase)) {
      const source = await this.withHeartbeat(fence, () =>
        this.transaction(client, () => this.sources.resolveRecoveryTarget({
          tenantId: application!.tenantId,
          targetLeaseId: application!.targetLeaseId,
          sourceTargetSnapshotId: application!.sourceTargetSnapshotId,
          targetProviderSandboxId: application!.targetProviderSandboxId,
        }, client)))
      application = await this.transaction(client, () => this.applications.beginRollback(
        fence, application!.applicationId, 'reconciled after interrupted patch application', client))
      await this.withHeartbeat(fence, () => this.provider.uploadArchive(
        application!.targetProviderSandboxId, source.archive))
      application = await this.transaction(client, () => this.applications.markRolledBack(
        fence, application!.applicationId, client))
    }
    if (!['rolled_back', 'failed'].includes(application.phase)) throw new OperationOwnershipError()
    const cleanup = await this.cleanupFailed(fence, application)
    if (cleanup.pending) return { completed: false, failed: false, pending: true, counts: cleanup.counts }
    await this.failOperation(fence)
    return { completed: false, failed: true, pending: false, counts: cleanup.counts }
  }

  private validateApplication(operation: StaleOperation, application: PatchApplication): void {
    if (application.operation !== operation.operation
      || application.idempotencyKey !== operation.idempotencyKey
      || application.tenantId !== operation.tenantId
      || application.applicationId !== deterministicPatchApplyId('application', operation)
      || application.resultSnapshotId !== deterministicPatchApplyId('snapshot', operation)
      || application.targetLeaseId !== operation.primaryLeaseId
      || canonicalRequestHash({
        targetLeaseId: application.targetLeaseId, artifactId: application.artifactId,
        idempotencyKey: application.idempotencyKey,
      }) !== operation.requestHash
      || application.createdGeneration >= operation.generation) {
      throw new OperationOwnershipError()
    }
  }

  private async recoverCheckpointed(fence: PatchApplicationFence,
    application: PatchApplication, client: PoolClient): Promise<{
      completed: boolean
      failed: boolean
      pending: boolean
      counts: CleanupCounts
    }> {
    await this.transaction(client, () => this.applications.verifyCheckpointed(
      fence, application.applicationId, client))
    const preparation = await this.recovery.preparations.getForOperation(fence)
    if (!preparation || preparation.state !== 'committed'
      || preparation.leaseId !== application.targetLeaseId
      || preparation.snapshotId !== application.resultSnapshotId
      || preparation.intent.expectedLatestSnapshotId !== application.sourceTargetSnapshotId
      || preparation.intent.providerSandboxId !== application.targetProviderSandboxId
      || preparation.intent.providerSnapshotId === null
      || preparation.intent.archiveChecksum !== application.resultArchiveChecksum
      || preparation.intent.manifestChecksum !== application.resultManifestChecksum
      || preparation.expectedObjectCount !== preparation.associatedObjectCount) {
      throw new OperationOwnershipError()
    }
    const allocations = await this.allocations(fence)
    this.validateAllocations(application, allocations)
    const preparedAllocationIds = sortAllocationIds(await this.recovery.preparations
      .listObjectAllocationIdsForReconciliation(fence))
    const objectAllocationIds = sortAllocationIds(allocations
      .filter(value => value.allocationKind === 'object').map(value => value.allocationId))
    if (preparedAllocationIds.length !== preparation.expectedObjectCount
      || preparedAllocationIds.length !== objectAllocationIds.length
      || preparedAllocationIds.some((value, index) => value !== objectAllocationIds[index])) {
      throw new OperationOwnershipError()
    }
    const resultAllocation = allocations.find(value => value.allocationKind === 'provider_snapshot'
      && value.allocationId !== application.rollbackAllocationId)
    const snapshot = await this.state.getSnapshot(application.tenantId, application.resultSnapshotId)
    if (!resultAllocation || !snapshot
      || resultAllocation.resourceId !== preparation.intent.providerSnapshotId
      || snapshot.providerSnapshotId !== resultAllocation.resourceId) {
      throw new OperationOwnershipError()
    }
    const rollback = allocations.find(value => value.allocationId === application.rollbackAllocationId)
    if (!rollback) throw new OperationOwnershipError()
    const counts: CleanupCounts = { allocationsReclaimed: 0, protectedResources: 0 }
    if (rollback.state !== 'reclaimed') await this.cleanupProviderAllocation(fence, rollback, counts)
    await this.cleanupNamedSnapshot(fence, 'rollback')
    const final = await this.allocations(fence)
    this.validateAllocations(application, final)
    if (final.some(value => value.allocationId === application.rollbackAllocationId
      ? value.state !== 'reclaimed' : value.state !== 'adopted')) {
      return { completed: false, failed: false, pending: true, counts }
    }
    const logical = validatePatchApplyResponse({
      type: 'applied', checkpoint: { snapshotId: application.resultSnapshotId },
    })
    await this.transaction(client, () => this.journal.completeOperation(
      fence, fence.generation, fence.workerId, logical, client))
    return { completed: true, failed: false, pending: false, counts }
  }

  private async cleanupFailed(fence: PatchApplicationFence,
    application: PatchApplication): Promise<{ pending: boolean; counts: CleanupCounts }> {
    const counts: CleanupCounts = { allocationsReclaimed: 0, protectedResources: 0 }
    const preparation = await this.recovery.preparations.getForOperation(fence)
    const objectAllocations = sortAllocationIds((await this.allocations(fence))
      .filter(value => value.allocationKind === 'object').map(value => value.allocationId))
    if (preparation) {
      if (preparation.state === 'committed'
        || preparation.leaseId !== application.targetLeaseId
        || preparation.snapshotId !== application.resultSnapshotId
        || preparation.intent.expectedLatestSnapshotId !== application.sourceTargetSnapshotId
        || preparation.intent.providerSandboxId !== application.targetProviderSandboxId) {
        throw new OperationOwnershipError()
      }
      const preparedAllocationIds = sortAllocationIds(await this.recovery.preparations
        .listObjectAllocationIdsForReconciliation(fence))
      if (preparedAllocationIds.length !== objectAllocations.length
        || preparedAllocationIds.some((value, index) => value !== objectAllocations[index])) {
        throw new OperationOwnershipError()
      }
      const aborting = await this.recovery.preparations.beginAbort(fence, preparation.preparationId)
      if (aborting.state !== 'reclaimed') {
        const reclaimed = await this.recovery.reclaimer.reclaimPreparationObjects(
          fence, preparation.preparationId, this.options.maxAllocationsPerOperation)
        counts.allocationsReclaimed += reclaimed.reclaimed
        counts.protectedResources += reclaimed.retained
        const current = await this.recovery.preparations.getForOperation(fence)
        if (current?.state !== 'reclaimed') return { pending: true, counts }
      }
    } else if (objectAllocations.length !== 0) throw new OperationOwnershipError()

    let allocations = await this.allocations(fence)
    this.validateAllocations(application, allocations)
    for (const allocation of allocations.filter(value => value.allocationKind === 'provider_snapshot'
      && value.state !== 'reclaimed')) {
      if (allocation.state === 'adopted') throw new OperationOwnershipError()
      await this.cleanupProviderAllocation(fence, allocation, counts)
    }
    allocations = await this.allocations(fence)
    const objects = allocations.filter(value => value.allocationKind === 'object'
      && value.state !== 'reclaimed')
    if (objects.length > 0) {
      const reclaimed = await this.recovery.reclaimer.reclaimOperationObjects(
        fence, fence.generation, fence.workerId, this.options.maxAllocationsPerOperation)
      counts.allocationsReclaimed += reclaimed.reclaimed
      counts.protectedResources += reclaimed.retained
    }
    await this.cleanupNamedSnapshot(fence, 'rollback')
    await this.cleanupNamedSnapshot(fence, 'result')
    const final = await this.allocations(fence)
    this.validateAllocations(application, final)
    return { pending: final.some(value => value.state !== 'reclaimed'), counts }
  }

  private validateAllocations(application: PatchApplication,
    allocations: OperationAllocation[]): void {
    let rollbackCount = 0
    let resultCount = 0
    for (const allocation of allocations) {
      if (allocation.allocationKind === 'object') continue
      if (allocation.allocationKind !== 'provider_snapshot'
        || allocation.leaseId !== application.targetLeaseId) throw new OperationOwnershipError()
      if (allocation.allocationId === application.rollbackAllocationId) {
        rollbackCount += 1
        if (allocation.resourceId !== application.rollbackProviderSnapshotId
          || !exactMetadata(allocation, {
            purpose: 'patch_apply_rollback', applicationId: application.applicationId,
            name: patchApplyProviderSnapshotName('rollback', application),
          })) throw new OperationOwnershipError()
      } else {
        resultCount += 1
        if (!exactMetadata(allocation, {
          purpose: 'patch_apply_checkpoint', applicationId: application.applicationId,
          name: patchApplyProviderSnapshotName('result', application),
        })) throw new OperationOwnershipError()
      }
    }
    if (application.rollbackAllocationId === null
      || application.rollbackProviderSnapshotId === null) {
      if (application.rollbackAllocationId !== null || application.rollbackProviderSnapshotId !== null
        || rollbackCount !== 0 || !['planned', 'failed'].includes(application.phase)) {
        throw new OperationOwnershipError()
      }
    } else if (rollbackCount !== 1) throw new OperationOwnershipError()
    if (resultCount > 1) throw new OperationOwnershipError()
    if (application.phase === 'checkpointed' && resultCount !== 1) throw new OperationOwnershipError()
  }

  private async cleanupProviderAllocation(fence: PatchApplicationFence,
    allocation: OperationAllocation, counts: CleanupCounts): Promise<void> {
    await this.journal.withProviderResourceLock('provider_snapshot', allocation.resourceId,
      async client => {
        await this.heartbeat(fence, client)
        if (await this.state.findSnapshotByProviderIdForReconciliation(
          allocation.resourceId, client)) {
          counts.protectedResources += 1
          throw new OperationOwnershipError()
        }
        const current = (await this.journal.listAllocations(fence,
          this.options.maxAllocationsPerOperation + 1, client))
          .find(value => value.allocationId === allocation.allocationId)
        if (!current || current.state === 'adopted') throw new OperationOwnershipError()
        if (current.state !== 'reclaimed') {
          await this.journal.updateAllocationState(fence, fence.generation, fence.workerId,
            current.allocationId, 'reclaim_pending', client)
          await this.provider.deleteSnapshot(current.resourceId)
          await this.journal.updateAllocationState(fence, fence.generation, fence.workerId,
            current.allocationId, 'reclaimed', client)
          counts.allocationsReclaimed += 1
        }
      })
  }

  private async cleanupNamedSnapshot(fence: PatchApplicationFence,
    kind: 'rollback' | 'result'): Promise<void> {
    const name = patchApplyProviderSnapshotName(kind, fence)
    const snapshots = await this.provider.listSnapshots({ name })
    if (snapshots.length > 1 || snapshots.some(value => !value.names.includes(name))) {
      throw new Error(`ambiguous deterministic patch apply ${kind} snapshot inventory`)
    }
    const snapshot = snapshots[0]
    if (!snapshot) return
    if (await this.state.findSnapshotByProviderIdForReconciliation(snapshot.snapshotId)
      || await this.journal.hasUnreclaimedAllocation('provider_snapshot', snapshot.snapshotId)) return
    await this.journal.withProviderResourceLock('provider_snapshot', snapshot.snapshotId,
      async client => {
        await this.heartbeat(fence, client)
        if (await this.state.findSnapshotByProviderIdForReconciliation(snapshot.snapshotId, client)
          || await this.journal.hasUnreclaimedAllocation(
            'provider_snapshot', snapshot.snapshotId, client)) return
        await this.provider.deleteSnapshot(snapshot.snapshotId)
      })
  }

  private async allocations(fence: PatchApplicationFence): Promise<OperationAllocation[]> {
    const values = await this.journal.listAllocations(
      fence, this.options.maxAllocationsPerOperation + 1)
    if (values.length > this.options.maxAllocationsPerOperation) throw new OperationOwnershipError()
    return values
  }

  private async failOperation(fence: PatchApplicationFence): Promise<void> {
    await this.journal.failOperation(fence, fence.generation, fence.workerId,
      'service_503', 'patch application was safely reconciled after interruption')
  }

  private async heartbeat(fence: PatchApplicationFence,
    executor?: Pick<PoolClient, 'query'>): Promise<void> {
    if (!await this.journal.heartbeatOperation(
      fence, fence.generation, fence.workerId, executor)) throw new OperationOwnershipError()
  }

  private async withHeartbeat<T>(fence: PatchApplicationFence,
    call: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      void this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)
        .catch(() => undefined)
    }, this.options.heartbeatIntervalMs)
    timer.unref()
    try {
      const result = await call()
      await this.heartbeat(fence)
      return result
    } finally { clearInterval(timer) }
  }

  private async transaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
    await client.query('BEGIN')
    try {
      const result = await fn()
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  }
}
