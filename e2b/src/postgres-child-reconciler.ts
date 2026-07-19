import type { PoolClient } from 'pg'
import { childProviderSnapshotName, deterministicChildId, logicalChildFromLease } from './postgres-child.js'
import type { ProviderAdapter } from './provider.js'
import { ProviderSandboxMissingError } from './provider.js'
import type { PostgresObjectReclaimer } from './postgres-object-reclaimer.js'
import type { PostgresDurableState } from './postgres-state.js'
import {
  canonicalRequestHash,
  OperationOwnershipError,
  type OperationAllocation,
  type OperationIdentity,
  type PostgresJournal,
  type StaleOperation,
} from './postgres-store.js'
import type { PostgresWorkspacePreparations } from './postgres-workspace-preparations.js'
import { canonicalJson } from './workspace-manifest.js'

export interface PostgresChildReconcilerOptions {
  tenantId: string
  managedBy: string
  workerId: string
  staleAfterMs?: number
  pollIntervalMs?: number
  maxOperationsPerRun?: number
  maxAllocationsPerOperation?: number
  maxInventorySandboxesPerOperation?: number
  heartbeatIntervalMs?: number
  onError?: (error: unknown) => void
}

export interface ChildReconcileResult {
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

interface Counts {
  reclaimed: number
  protected: number
}

const defaults = {
  staleAfterMs: 5 * 60_000,
  pollIntervalMs: 30_000,
  maxOperationsPerRun: 100,
  maxAllocationsPerOperation: 100,
  maxInventorySandboxesPerOperation: 16,
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

function sortIds(values: string[]): string[] {
  return [...values].sort((left, right) => {
    const a = BigInt(left)
    const b = BigInt(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

function exactMetadata(allocation: OperationAllocation, expected: Record<string, unknown>): boolean {
  return canonicalJson(allocation.metadata) === canonicalJson(expected)
}

interface ChildRequestMetadata {
  childLeaseId: string
  childEnvironmentId: string
  childSnapshotId: string
  childAgentId: string
  ownerAgentId: string
  ownerLeaseId: string
  agentType: string
  sandboxTemplate: string
}

function requestMetadata(value: Record<string, unknown>, identity: OperationIdentity,
  ownerLeaseId: string): ChildRequestMetadata {
  const expected = {
    childLeaseId: deterministicChildId('lease', identity),
    childEnvironmentId: deterministicChildId('env', identity),
    childSnapshotId: deterministicChildId('snapshot', identity),
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new OperationOwnershipError()
  }
  const strings = ['childAgentId', 'ownerAgentId', 'ownerLeaseId', 'agentType', 'sandboxTemplate'] as const
  for (const key of strings) {
    if (typeof value[key] !== 'string' || !value[key]) throw new OperationOwnershipError()
  }
  if (value.ownerLeaseId !== ownerLeaseId) throw new OperationOwnershipError()
  return {
    ...expected,
    childAgentId: value.childAgentId as string,
    ownerAgentId: value.ownerAgentId as string,
    ownerLeaseId: value.ownerLeaseId as string,
    agentType: value.agentType as string,
    sandboxTemplate: value.sandboxTemplate as string,
  }
}

function baseMetadata(metadata: ChildRequestMetadata): ChildRequestMetadata {
  return { ...metadata }
}

export class PostgresChildReconciler {
  private readonly options: Required<Omit<PostgresChildReconcilerOptions, 'onError'>>
    & Pick<PostgresChildReconcilerOptions, 'onError'>
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<ChildReconcileResult> | undefined
  private stopped = true

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly provider: ProviderAdapter,
    private readonly recovery: RecoveryDependencies,
    options: PostgresChildReconcilerOptions,
  ) {
    this.options = { ...defaults, ...options }
    bounded('tenant ID', this.options.tenantId)
    bounded('managed-by marker', this.options.managedBy)
    bounded('worker ID', this.options.workerId)
    positive('stale timeout', this.options.staleAfterMs, 24 * 60 * 60_000)
    positive('poll interval', this.options.pollIntervalMs, 24 * 60 * 60_000)
    positive('operation batch size', this.options.maxOperationsPerRun, 1000)
    positive('allocation batch size', this.options.maxAllocationsPerOperation, 10_000)
    positive('sandbox inventory size', this.options.maxInventorySandboxesPerOperation, 1000)
    positive('heartbeat interval', this.options.heartbeatIntervalMs, 60_000)
    if (this.options.heartbeatIntervalMs >= this.options.staleAfterMs) {
      throw new Error('child recovery heartbeat must be shorter than stale timeout')
    }
  }

  runOnce(): Promise<ChildReconcileResult> {
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

  private async runBounded(): Promise<ChildReconcileResult> {
    const result: ChildReconcileResult = {
      operationsClaimed: 0, operationsCompleted: 0, operationsFailed: 0,
      allocationsReclaimed: 0, allocationsPending: 0, protectedResources: 0,
    }
    const stale = await this.journal.claimStaleOperations(
      new Date(Date.now() - this.options.staleAfterMs),
      this.options.maxOperationsPerRun, this.options.workerId,
      this.options.tenantId, 'provision', 'child')
    result.operationsClaimed = stale.length
    for (const operation of stale) {
      this.counts = { reclaimed: 0, protected: 0 }
      try {
        const outcome = await this.reconcileClaimed(operation)
        result.operationsCompleted += outcome === 'completed' ? 1 : 0
        result.operationsFailed += outcome === 'failed' ? 1 : 0
        result.allocationsPending += outcome === 'pending' ? 1 : 0
      } catch (error) {
        result.allocationsPending += 1
        this.options.onError?.(error)
      } finally {
        result.allocationsReclaimed += this.counts.reclaimed
        result.protectedResources += this.counts.protected
        this.counts = { reclaimed: 0, protected: 0 }
      }
    }
    return result
  }

  private counts: Counts = { reclaimed: 0, protected: 0 }

  private async reconcileClaimed(operation: StaleOperation): Promise<'completed' | 'failed' | 'pending'> {
    if (operation.operation !== 'provision' || operation.operationSubtype !== 'child'
      || operation.tenantId !== this.options.tenantId || operation.primaryLeaseId === null) {
      throw new OperationOwnershipError()
    }
    const ownerLeaseId = operation.primaryLeaseId
    return this.journal.withSessionLeaseLocks(
      operation.tenantId, [ownerLeaseId], client =>
        this.reconcileOwned(operation, ownerLeaseId, client))
  }

  private async reconcileOwned(operation: StaleOperation, ownerLeaseId: string,
    client: PoolClient): Promise<'completed' | 'failed' | 'pending'> {
    const fence = {
      operation: operation.operation, idempotencyKey: operation.idempotencyKey,
      tenantId: operation.tenantId, generation: operation.generation,
      workerId: operation.workerId,
    }
    await this.heartbeat(fence)
    const allocations = await this.allocations(fence)
    const childLeaseId = deterministicChildId('lease', fence)
    const childLease = await this.state.getLease(fence.tenantId, childLeaseId)
    if (childLease) {
      await this.recoverCommitted(operation, ownerLeaseId, fence, childLeaseId, allocations, client)
      return 'completed'
    }
    if (operation.resultLeaseId !== null) throw new OperationOwnershipError()
    const metadata = await this.validateAbandonedGraph(
      operation, ownerLeaseId, fence, allocations)
    await this.abortObjects(fence, ownerLeaseId, allocations, metadata)
    await this.cleanupLedgeredProviderResources(fence)
    await this.cleanupInventory(fence, ownerLeaseId)
    const final = await this.allocations(fence)
    if (final.some(item => item.state !== 'reclaimed')) return 'pending'
    await this.transaction(client, async () => {
      await this.heartbeat(fence, client)
      if (await this.state.getLease(fence.tenantId, childLeaseId, client)) {
        throw new OperationOwnershipError()
      }
      await this.journal.failOperation(
        fence, fence.generation, fence.workerId,
        'reconciled_abandoned', 'abandoned child allocations were reclaimed', client)
    })
    return 'failed'
  }

  private async recoverCommitted(operation: StaleOperation,
    ownerLeaseId: string,
    fence: OperationIdentity & { generation: number; workerId: string },
    childLeaseId: string, allocations: OperationAllocation[], client: PoolClient): Promise<void> {
    if (operation.resultLeaseId !== childLeaseId) throw new OperationOwnershipError()
    const preparation = await this.recovery.preparations.getForOperation(fence)
    if (!preparation || preparation.state !== 'committed'
      || preparation.leaseId !== childLeaseId
      || preparation.intent.leaseId !== childLeaseId
      || preparation.intent.environmentId !== deterministicChildId('env', fence)
      || preparation.intent.snapshotId !== deterministicChildId('snapshot', fence)
      || preparation.intent.ownerLeaseId !== ownerLeaseId
      || preparation.intent.expectedLatestSnapshotId === null
      || preparation.intent.sourceSnapshotId !== null
      || preparation.intent.expectedSourceChecksum !== null
      || preparation.intent.restoreSourceLeaseId !== null
      || preparation.intent.restoreSourceSnapshotId !== null) throw new OperationOwnershipError()

    const captureSnapshot = allocations.filter(item =>
      item.allocationKind === 'provider_snapshot' && item.metadata.purpose === 'owner_snapshot')
    const captureSandbox = allocations.filter(item =>
      item.allocationKind === 'capture_sandbox' && item.metadata.purpose === 'capture_sandbox')
    const resultSandbox = allocations.filter(item =>
      item.allocationKind === 'sandbox' && item.metadata.purpose === 'result_sandbox')
    const resultSnapshot = allocations.filter(item =>
      item.allocationKind === 'provider_snapshot' && item.metadata.purpose === 'result_snapshot')
    const providerAllocations = allocations.filter(item => item.allocationKind !== 'object')
    if (providerAllocations.length !== 4
      || [captureSnapshot, captureSandbox, resultSandbox, resultSnapshot]
        .some(items => items.length !== 1)) {
      throw new OperationOwnershipError()
    }
    const metadata = requestMetadata(captureSnapshot[0]!.metadata, fence, ownerLeaseId)
    const common = baseMetadata(metadata)
    if (!exactMetadata(captureSnapshot[0]!, {
      managedBy: this.options.managedBy, action: 'child_capture', purpose: 'owner_snapshot',
      name: childProviderSnapshotName('capture', fence),
      ownerSnapshotId: preparation.intent.expectedLatestSnapshotId,
      ownerProviderSandboxId: captureSnapshot[0]!.metadata.ownerProviderSandboxId,
      ownerConnectionGeneration: captureSnapshot[0]!.metadata.ownerConnectionGeneration,
      ...common,
    }) || typeof captureSnapshot[0]!.metadata.ownerProviderSandboxId !== 'string'
      || !Number.isSafeInteger(captureSnapshot[0]!.metadata.ownerConnectionGeneration)
      || !exactMetadata(captureSandbox[0]!, {
        managedBy: this.options.managedBy, action: 'child_capture', purpose: 'capture_sandbox', ...common,
      }) || !exactMetadata(resultSandbox[0]!, {
        managedBy: this.options.managedBy, action: 'child_result', purpose: 'result_sandbox', ...common,
      }) || !exactMetadata(resultSnapshot[0]!, {
        managedBy: this.options.managedBy, action: 'child_result', purpose: 'result_snapshot',
        name: childProviderSnapshotName('result', fence), ...common,
      })) throw new OperationOwnershipError()

    const request = {
      agentId: metadata.childAgentId, ownerAgentId: metadata.ownerAgentId,
      agentType: metadata.agentType, sandboxTemplate: metadata.sandboxTemplate,
      source: { type: 'agentEnvironment', ownerLeaseId: metadata.ownerLeaseId },
      idempotencyKey: fence.idempotencyKey,
    }
    if (canonicalRequestHash(request) !== operation.requestHash) throw new OperationOwnershipError()
    const lease = await this.state.getLease(fence.tenantId, childLeaseId)
    if (!lease || lease.environmentId !== metadata.childEnvironmentId
      || lease.baseSnapshotId !== metadata.childSnapshotId
      || lease.agentId !== metadata.childAgentId || lease.ownerAgentId !== metadata.ownerAgentId
      || lease.ownerLeaseId !== metadata.ownerLeaseId
      || lease.sandboxTemplate !== metadata.sandboxTemplate
      || lease.providerSandboxId !== resultSandbox[0]!.resourceId
      || preparation.intent.providerSandboxId !== resultSandbox[0]!.resourceId
      || preparation.intent.providerSnapshotId !== resultSnapshot[0]!.resourceId
      || preparation.intent.agentId !== metadata.childAgentId
      || preparation.intent.ownerAgentId !== metadata.ownerAgentId
      || preparation.intent.sandboxTemplate !== metadata.sandboxTemplate) {
      throw new OperationOwnershipError()
    }
    const snapshot = await this.state.getSnapshot(fence.tenantId, metadata.childSnapshotId)
    if (!snapshot || snapshot.leaseId !== childLeaseId || snapshot.state !== 'available'
      || snapshot.providerSnapshotId !== resultSnapshot[0]!.resourceId) {
      throw new OperationOwnershipError()
    }
    const preparedObjectIds = sortIds(
      await this.recovery.preparations.listObjectAllocationIdsForReconciliation(
        fence))
    const objectAllocations = allocations.filter(item => item.allocationKind === 'object')
    if (preparedObjectIds.length !== preparation.expectedObjectCount
      || preparation.expectedObjectCount !== preparation.associatedObjectCount
      || canonicalJson(sortIds(objectAllocations.map(item => item.allocationId)))
      !== canonicalJson(preparedObjectIds)
      || captureSnapshot[0]!.state !== 'reclaimed' || captureSnapshot[0]!.leaseId !== null
      || captureSandbox[0]!.state !== 'reclaimed' || captureSandbox[0]!.leaseId !== null
      || [resultSandbox[0]!, resultSnapshot[0]!, ...objectAllocations].some(item =>
        item.state !== 'adopted' || item.leaseId !== childLeaseId)) {
      throw new OperationOwnershipError()
    }
    await this.transaction(client, async () => {
      await this.heartbeat(fence, client)
      const exactLease = await this.state.getLease(fence.tenantId, childLeaseId, client)
      if (!exactLease || canonicalJson(logicalChildFromLease(exactLease))
        !== canonicalJson(logicalChildFromLease(lease))) throw new OperationOwnershipError()
      await this.journal.completeOperation(
        fence, fence.generation, fence.workerId, logicalChildFromLease(exactLease), client)
    })
  }

  private async abortObjects(
    fence: OperationIdentity & { generation: number; workerId: string },
    ownerLeaseId: string, allocations: OperationAllocation[], metadata: ChildRequestMetadata | null,
  ): Promise<void> {
    const preparation = await this.recovery.preparations.getForOperation(fence)
    if (preparation) {
      const captureSnapshot = allocations.find(item => item.allocationKind === 'provider_snapshot'
        && item.metadata.purpose === 'owner_snapshot')
      if (preparation.state === 'committed') throw new OperationOwnershipError()
      if (preparation.intent.leaseId !== deterministicChildId('lease', fence)
        || preparation.intent.environmentId !== deterministicChildId('env', fence)
        || preparation.intent.snapshotId !== deterministicChildId('snapshot', fence)
        || preparation.intent.ownerLeaseId !== ownerLeaseId
        || preparation.intent.sourceSnapshotId !== null
        || preparation.intent.expectedSourceChecksum !== null
        || preparation.intent.restoreSourceLeaseId !== null
        || preparation.intent.restoreSourceSnapshotId !== null
        || preparation.intent.expectedLatestSnapshotId === null
        || preparation.intent.expectedLatestSnapshotId
          !== captureSnapshot?.metadata.ownerSnapshotId) {
        throw new OperationOwnershipError()
      }
      const resultSandbox = allocations.find(item => item.allocationKind === 'sandbox')
      const resultSnapshot = allocations.find(item => item.allocationKind === 'provider_snapshot'
        && item.metadata.purpose === 'result_snapshot')
      if (!metadata || !resultSandbox || !resultSnapshot
        || preparation.intent.providerSandboxId !== resultSandbox.resourceId
        || preparation.intent.providerSnapshotId !== resultSnapshot.resourceId
        || preparation.intent.agentId !== metadata.childAgentId
        || preparation.intent.ownerAgentId !== metadata.ownerAgentId
        || preparation.intent.sandboxTemplate !== metadata.sandboxTemplate) {
        throw new OperationOwnershipError()
      }
      const abort = await this.recovery.preparations.beginAbort(fence, preparation.preparationId)
      if (abort.state !== 'reclaimed') {
        for (;;) {
          const reclaimed = await this.withHeartbeat(fence, () =>
            this.recovery.reclaimer.reclaimPreparationObjects(
              fence, preparation.preparationId, this.options.maxAllocationsPerOperation))
          this.counts.reclaimed += reclaimed.reclaimed
          this.counts.protected += reclaimed.retained
          if (reclaimed.claimed < this.options.maxAllocationsPerOperation) break
        }
      }
    }
    const stray = await this.withHeartbeat(fence, () =>
      this.recovery.reclaimer.reclaimOperationObjects(
        fence, fence.generation, fence.workerId, this.options.maxAllocationsPerOperation))
    this.counts.reclaimed += stray.reclaimed
    this.counts.protected += stray.retained
  }

  private async validateAbandonedGraph(operation: StaleOperation, ownerLeaseId: string,
    fence: OperationIdentity & { generation: number; workerId: string },
    allocations: OperationAllocation[]): Promise<ChildRequestMetadata | null> {
    if (allocations.some(item => item.state === 'adopted' || item.leaseId !== null)) {
      throw new OperationOwnershipError()
    }
    const provider = allocations.filter(item => item.allocationKind !== 'object')
    const objects = allocations.filter(item => item.allocationKind === 'object')
    if (provider.length === 0) {
      if (objects.length !== 0 || await this.recovery.preparations.getForOperation(fence)) {
        throw new OperationOwnershipError()
      }
      return null
    }
    const expected = [
      ['provider_snapshot', 'owner_snapshot'],
      ['capture_sandbox', 'capture_sandbox'],
      ['sandbox', 'result_sandbox'],
      ['provider_snapshot', 'result_snapshot'],
    ] as const
    if (provider.length > expected.length || objects.length > 0 && provider.length !== expected.length
      || provider.some((item, index) => item.allocationKind !== expected[index]![0]
        || item.metadata.purpose !== expected[index]![1])
      || new Set(provider.map(item => `${item.allocationKind}\0${item.resourceId}`)).size
        !== provider.length) throw new OperationOwnershipError()

    const captureSnapshot = provider[0]!
    const metadata = requestMetadata(captureSnapshot.metadata, fence, ownerLeaseId)
    if (canonicalRequestHash({
      agentId: metadata.childAgentId, ownerAgentId: metadata.ownerAgentId,
      agentType: metadata.agentType, sandboxTemplate: metadata.sandboxTemplate,
      source: { type: 'agentEnvironment', ownerLeaseId: metadata.ownerLeaseId },
      idempotencyKey: fence.idempotencyKey,
    }) !== operation.requestHash
      || typeof captureSnapshot.metadata.ownerProviderSandboxId !== 'string'
      || !Number.isSafeInteger(captureSnapshot.metadata.ownerConnectionGeneration)
      || !exactMetadata(captureSnapshot, {
        managedBy: this.options.managedBy, action: 'child_capture', purpose: 'owner_snapshot',
        name: childProviderSnapshotName('capture', fence),
        ownerSnapshotId: captureSnapshot.metadata.ownerSnapshotId,
        ownerProviderSandboxId: captureSnapshot.metadata.ownerProviderSandboxId,
        ownerConnectionGeneration: captureSnapshot.metadata.ownerConnectionGeneration,
        ...baseMetadata(metadata),
      }) || typeof captureSnapshot.metadata.ownerSnapshotId !== 'string') {
      throw new OperationOwnershipError()
    }
    const exact = [
      { action: 'child_capture', purpose: 'capture_sandbox' },
      { action: 'child_result', purpose: 'result_sandbox' },
      { action: 'child_result', purpose: 'result_snapshot',
        name: childProviderSnapshotName('result', fence) },
    ]
    for (let index = 1; index < provider.length; index += 1) {
      if (!exactMetadata(provider[index]!, {
        managedBy: this.options.managedBy, ...exact[index - 1], ...baseMetadata(metadata),
      })) throw new OperationOwnershipError()
    }
    return metadata
  }

  private async cleanupLedgeredProviderResources(
    fence: OperationIdentity & { generation: number; workerId: string }): Promise<void> {
    const allocations = await this.allocations(fence)
    for (const allocation of allocations) {
      if (allocation.state === 'reclaimed' || allocation.allocationKind === 'object') continue
      if (allocation.state === 'adopted' || allocation.leaseId !== null) throw new OperationOwnershipError()
      const action = allocation.metadata.action
      if ((allocation.allocationKind === 'capture_sandbox' && action !== 'child_capture')
        || (allocation.allocationKind === 'sandbox' && action !== 'child_result')
        || (allocation.allocationKind === 'provider_snapshot'
          && !['child_capture', 'child_result'].includes(String(action)))) {
        throw new OperationOwnershipError()
      }
      if (allocation.allocationKind === 'provider_snapshot') {
        await this.reclaimSnapshot(fence, allocation)
      } else if (allocation.allocationKind === 'sandbox'
        || allocation.allocationKind === 'capture_sandbox') {
        await this.reclaimSandbox(fence, allocation)
      } else throw new OperationOwnershipError()
    }
  }

  private async reclaimSandbox(fence: OperationIdentity & { generation: number; workerId: string },
    allocation: OperationAllocation): Promise<void> {
    await this.journal.withProviderResourceLock('sandbox', allocation.resourceId, async client => {
      await this.heartbeat(fence, client)
      if (await this.state.findLeaseByProviderSandboxForReconciliation(allocation.resourceId, client)) {
        this.counts.protected += 1
        throw new OperationOwnershipError()
      }
      try { await this.provider.kill(allocation.resourceId) }
      catch (error) { if (!(error instanceof ProviderSandboxMissingError)) throw error }
      await this.heartbeat(fence, client)
      await this.journal.updateAllocationState(
        fence, fence.generation, fence.workerId, allocation.allocationId, 'reclaimed', client)
      this.counts.reclaimed += 1
    })
  }

  private async reclaimSnapshot(fence: OperationIdentity & { generation: number; workerId: string },
    allocation: OperationAllocation): Promise<void> {
    await this.journal.withProviderResourceLock('provider_snapshot', allocation.resourceId, async client => {
      await this.heartbeat(fence, client)
      if (await this.state.findSnapshotByProviderIdForReconciliation(allocation.resourceId, client)) {
        this.counts.protected += 1
        throw new OperationOwnershipError()
      }
      await this.provider.deleteSnapshot(allocation.resourceId)
      await this.heartbeat(fence, client)
      await this.journal.updateAllocationState(
        fence, fence.generation, fence.workerId, allocation.allocationId, 'reclaimed', client)
      this.counts.reclaimed += 1
    })
  }

  private async cleanupInventory(
    fence: OperationIdentity & { generation: number; workerId: string }, ownerLeaseId: string): Promise<void> {
    const childLeaseId = deterministicChildId('lease', fence)
    const inventory = await this.withHeartbeat(fence, () =>
      this.provider.listManagedSandboxes({ metadata: {
        managedBy: this.options.managedBy, tenantId: fence.tenantId, childLeaseId,
      } }))
    if (inventory.length > this.options.maxInventorySandboxesPerOperation) {
      throw new Error('child sandbox inventory exceeded recovery bound')
    }
    for (const sandbox of inventory) {
      if (sandbox.metadata.managedBy !== this.options.managedBy
        || sandbox.metadata.tenantId !== fence.tenantId
        || sandbox.metadata.childLeaseId !== childLeaseId
        || sandbox.metadata.ownerLeaseId !== ownerLeaseId
        || !['capture', 'result'].includes(sandbox.metadata.resourcePurpose ?? '')) {
        throw new OperationOwnershipError()
      }
      if (await this.state.findLeaseByProviderSandboxForReconciliation(sandbox.sandboxId)
        || await this.journal.hasUnreclaimedAllocation('sandbox', sandbox.sandboxId)
        || await this.journal.hasUnreclaimedAllocation('capture_sandbox', sandbox.sandboxId)) continue
      await this.journal.withProviderResourceLock('sandbox', sandbox.sandboxId, async client => {
        await this.heartbeat(fence, client)
        if (await this.state.findLeaseByProviderSandboxForReconciliation(sandbox.sandboxId, client)
          || await this.journal.hasUnreclaimedAllocation('sandbox', sandbox.sandboxId, client)
          || await this.journal.hasUnreclaimedAllocation('capture_sandbox', sandbox.sandboxId, client)) return
        try { await this.provider.kill(sandbox.sandboxId) }
        catch (error) { if (!(error instanceof ProviderSandboxMissingError)) throw error }
        await this.heartbeat(fence, client)
      })
    }
    const remainingSandboxes = await this.withHeartbeat(fence, () =>
      this.provider.listManagedSandboxes({ metadata: {
        managedBy: this.options.managedBy, tenantId: fence.tenantId, childLeaseId,
      } }))
    if (remainingSandboxes.length > 0) throw new Error('child sandbox cleanup is not yet observable')

    for (const purpose of ['capture', 'result'] as const) {
      const name = childProviderSnapshotName(purpose, fence)
      const snapshots = await this.withHeartbeat(fence, () =>
        this.provider.listSnapshots({ name }))
      if (snapshots.length > 1 || snapshots.some(snapshot => !snapshot.names.includes(name))) {
        throw new Error('ambiguous deterministic child snapshot inventory')
      }
      const snapshot = snapshots[0]
      if (snapshot && !await this.state.findSnapshotByProviderIdForReconciliation(snapshot.snapshotId)
        && !await this.journal.hasUnreclaimedAllocation('provider_snapshot', snapshot.snapshotId)) {
        await this.journal.withProviderResourceLock('provider_snapshot', snapshot.snapshotId, async client => {
          await this.heartbeat(fence, client)
          if (await this.state.findSnapshotByProviderIdForReconciliation(snapshot.snapshotId, client)
            || await this.journal.hasUnreclaimedAllocation('provider_snapshot', snapshot.snapshotId, client)) return
          await this.provider.deleteSnapshot(snapshot.snapshotId)
          await this.heartbeat(fence, client)
        })
      }
      if ((await this.withHeartbeat(fence, () => this.provider.listSnapshots({ name }))).length > 0) {
        throw new Error('child snapshot cleanup is not yet observable')
      }
    }
  }

  private async allocations(
    fence: OperationIdentity & { generation: number; workerId: string }): Promise<OperationAllocation[]> {
    const allocations = await this.journal.listAllocations(
      fence, this.options.maxAllocationsPerOperation + 1)
    if (allocations.length > this.options.maxAllocationsPerOperation) {
      throw new Error('child allocation graph exceeded recovery bound')
    }
    return allocations
  }

  private async heartbeat(fence: OperationIdentity & { generation: number; workerId: string },
    executor?: Pick<PoolClient, 'query'>): Promise<void> {
    if (!await this.journal.heartbeatOperation(
      fence, fence.generation, fence.workerId, executor)) throw new OperationOwnershipError()
  }

  private async withHeartbeat<T>(
    fence: OperationIdentity & { generation: number; workerId: string },
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
