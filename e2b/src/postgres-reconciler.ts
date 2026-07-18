import type { ProviderAdapter } from './provider.js'
import { ProviderSandboxMissingError } from './provider.js'
import type { PoolClient } from 'pg'
import type { Lease, PostgresDurableState } from './postgres-state.js'
import { logicalReconnectFromLease } from './postgres-reconnect.js'
import {
  OperationOwnershipError,
  type OperationAllocation,
  type OperationIdentity,
  type PostgresJournal,
  type StaleOperation,
} from './postgres-store.js'

export interface PostgresReconcilerOptions {
  managedBy: string
  tenantId: string
  workerId: string
  staleAfterMs?: number
  pollIntervalMs?: number
  maxOperationsPerRun?: number
  maxAllocationsPerOperation?: number
  maxInventorySandboxesPerRun?: number
  maxInventorySnapshotsPerSandbox?: number
  maxTicketsPerRun?: number
  ticketRetentionMs?: number
  connections?: { revoke(leaseId: string): void }
  onError?: (error: unknown) => void
}

export interface ReconcileRunResult {
  operationsClaimed: number
  allocationsReclaimed: number
  allocationsPending: number
  protectedResources: number
  inventorySandboxesReclaimed: number
  ticketsDeleted: number
}

const defaults = {
  staleAfterMs: 5 * 60_000,
  pollIntervalMs: 30_000,
  maxOperationsPerRun: 100,
  maxAllocationsPerOperation: 100,
  maxInventorySandboxesPerRun: 100,
  maxInventorySnapshotsPerSandbox: 100,
  maxTicketsPerRun: 1000,
  ticketRetentionMs: 5 * 60_000,
}

function boundedString(label: string, value: string): void {
  if (!value.trim() || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
}

function positiveInteger(label: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`invalid ${label}`)
}

export class PostgresReconciler {
  private readonly options: Required<Omit<PostgresReconcilerOptions, 'connections' | 'onError'>>
    & Pick<PostgresReconcilerOptions, 'connections' | 'onError'>
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<ReconcileRunResult> | undefined
  private stopped = true

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly provider: ProviderAdapter,
    options: PostgresReconcilerOptions,
  ) {
    this.options = { ...defaults, ...options }
    boundedString('managedBy marker', this.options.managedBy)
    boundedString('tenant ID', this.options.tenantId)
    boundedString('worker ID', this.options.workerId)
    positiveInteger('stale timeout', this.options.staleAfterMs, 24 * 60 * 60_000)
    positiveInteger('poll interval', this.options.pollIntervalMs, 24 * 60 * 60_000)
    positiveInteger('operation batch size', this.options.maxOperationsPerRun, 1000)
    positiveInteger('allocation batch size', this.options.maxAllocationsPerOperation, 10_000)
    positiveInteger('inventory batch size', this.options.maxInventorySandboxesPerRun, 1000)
    positiveInteger('snapshot inventory batch size', this.options.maxInventorySnapshotsPerSandbox, 1000)
    positiveInteger('ticket cleanup batch size', this.options.maxTicketsPerRun, 10_000)
    positiveInteger('ticket retention', this.options.ticketRetentionMs, 30 * 24 * 60 * 60_000)
  }

  /** Runs at most one reconciliation pass at a time; concurrent callers share the same result. */
  runOnce(): Promise<ReconcileRunResult> {
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
  }

  private async runBounded(): Promise<ReconcileRunResult> {
    const result: ReconcileRunResult = {
      operationsClaimed: 0,
      allocationsReclaimed: 0,
      allocationsPending: 0,
      protectedResources: 0,
      inventorySandboxesReclaimed: 0,
      ticketsDeleted: 0,
    }
    const staleBefore = new Date(Date.now() - this.options.staleAfterMs)
    const operations = await this.journal.claimStaleOperations(
      staleBefore, this.options.maxOperationsPerRun, this.options.workerId, this.options.tenantId,
    )
    result.operationsClaimed = operations.length
    for (const operation of operations) await this.reconcileOperation(operation, result)
    await this.reconcileInventory(result)
    result.ticketsDeleted = await this.state.cleanupTickets(
      new Date(Date.now() - this.options.ticketRetentionMs), this.options.maxTicketsPerRun,
    )
    return result
  }

  private async reconcileOperation(operation: StaleOperation, result: ReconcileRunResult): Promise<void> {
    const identity: OperationIdentity = operation
    const allocations = await this.journal.listAllocations(identity, this.options.maxAllocationsPerOperation + 1)
    if (allocations.length > this.options.maxAllocationsPerOperation) {
      result.allocationsPending += allocations.length
      return
    }
    if (operation.operation === 'release') {
      await this.reconcileRelease(operation, allocations, result)
      return
    }
    if (operation.operation === 'reconnect') {
      await this.reconcileReconnect(operation, allocations, result)
      return
    }
    for (const allocation of allocations) {
      if (allocation.state === 'adopted' || allocation.state === 'reclaimed') continue
      if (allocation.allocationKind === 'sandbox' || allocation.allocationKind === 'capture_sandbox') {
        await this.reclaimSandbox(identity, operation, allocation, result)
      } else if (allocation.allocationKind === 'provider_snapshot') {
        await this.reclaimSnapshot(identity, operation, allocation, result)
      } else {
        result.allocationsPending += 1
      }
    }
    const finalAllocations = await this.journal.listAllocations(identity, this.options.maxAllocationsPerOperation + 1)
    if (finalAllocations.length > 0
      && finalAllocations.every(allocation => allocation.state === 'adopted' || allocation.state === 'reclaimed')
      && finalAllocations.some(allocation => allocation.state === 'adopted')) {
      await this.recoverLogicalCompletion(identity, operation, finalAllocations)
      return
    }
    if (finalAllocations.every(allocation => allocation.state === 'reclaimed')) {
      try {
        await this.journal.failOperation(identity, operation.generation, operation.workerId,
          'reconciled_abandoned', 'abandoned operation allocations were reclaimed')
      } catch (error) {
        if (!(error instanceof OperationOwnershipError)) throw error
      }
    }
  }

  private async reconcileReconnect(operation: StaleOperation, allocations: OperationAllocation[],
    result: ReconcileRunResult): Promise<void> {
    const identity: OperationIdentity = operation
    const leaseId = operation.primaryLeaseId
    if (!leaseId || allocations.length !== 0) { result.allocationsPending += 1; return }
    let accessChanged = false
    try {
      await this.journal.withLeaseLocks(operation.tenantId, [leaseId], async client => {
        if (!await this.journal.heartbeatOperation(identity, operation.generation, operation.workerId, client)) {
          throw new OperationOwnershipError()
        }
        const lease = await this.state.getLease(operation.tenantId, leaseId, client)
        if (lease && ['active', 'paused'].includes(lease.state) && !lease.providerSandboxId) {
          throw new OperationOwnershipError()
        }
        if (!lease || !['active', 'paused'].includes(lease.state) || !lease.providerSandboxId) {
          const status = lease && !['release_pending', 'released', 'lost'].includes(lease.state) ? 409 : 404
          await this.journal.failOperation(identity, operation.generation, operation.workerId,
            `service_${status}`, status === 404 ? 'lease missing' : 'lease cannot be reconnected', client)
          return
        }
        await this.journal.bindLeaseAndAdoptAllocations(
          identity, operation.generation, operation.workerId, lease.leaseId, [], client)
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
            operation.tenantId, lease.leaseId, lease.providerSandboxId, client)
          accessChanged = true
          await this.journal.failOperation(identity, operation.generation, operation.workerId,
            'service_404', 'lease missing', client)
          return
        }
        const active = await this.state.completeReconnect(
          operation.tenantId, lease.leaseId, lease.providerSandboxId, client)
        accessChanged = true
        const logical = logicalReconnectFromLease(active)
        await this.journal.completeOperation(
          identity, operation.generation, operation.workerId, logical, client)
      })
      if (accessChanged) {
        try { this.options.connections?.revoke(leaseId) }
        catch { /* The durable generation remains authoritative across gateway replicas. */ }
      }
    } catch { result.allocationsPending += 1 }
  }

  private async reconcileRelease(operation: StaleOperation, allocations: OperationAllocation[],
    result: ReconcileRunResult): Promise<void> {
    const identity: OperationIdentity = operation
    const leaseId = operation.primaryLeaseId
    if (!leaseId || allocations.length > 1) { result.allocationsPending += 1; return }
    let allocation = allocations[0]
    if (allocation && (allocation.allocationKind !== 'sandbox' || allocation.leaseId !== leaseId
      || allocation.metadata.action !== 'release' || allocation.state === 'adopted')) {
      result.allocationsPending += 1
      return
    }
    let completed = false
    try {
      await this.journal.withLeaseLocks(operation.tenantId, [leaseId], async client => {
        if (!await this.journal.heartbeatOperation(identity, operation.generation, operation.workerId, client)) {
          throw new OperationOwnershipError()
        }
        const lease = await this.state.getLease(operation.tenantId, leaseId, client)
        if (!lease) throw new OperationOwnershipError()
        if (lease.state === 'released') {
          if (allocation && allocation.state !== 'reclaimed') {
            await this.journal.updateAllocationState(identity, operation.generation, operation.workerId,
              allocation.allocationId, 'reclaimed', client)
          }
          await this.journal.completeOperation(
            identity, operation.generation, operation.workerId, { released: true }, client)
          completed = true
          return
        }
        const pending = await this.state.beginRelease(operation.tenantId, leaseId, client)
        if (pending.state === 'release_pending' && !pending.providerSandboxId) {
          await this.state.releaseLease(operation.tenantId, leaseId, client)
          await this.journal.completeOperation(
            identity, operation.generation, operation.workerId, { released: true }, client)
          completed = true
          return
        }
        if (pending.state !== 'release_pending' || !pending.providerSandboxId) {
          throw new OperationOwnershipError()
        }
        await this.journal.lockProviderResources(
          [{ kind: 'sandbox', resourceId: pending.providerSandboxId }], client)
        if (!allocation) {
          allocation = await this.journal.recordAllocation(
            identity, operation.generation, operation.workerId, {
              kind: 'sandbox', resourceId: pending.providerSandboxId, leaseId,
              metadata: { action: 'release' },
            }, client)
        } else if (allocation.resourceId !== pending.providerSandboxId) {
          throw new OperationOwnershipError()
        }
      })
    } catch { result.allocationsPending += 1; return }
    if (completed || !allocation) return
    try {
      await this.journal.withLeaseLocks(operation.tenantId, [leaseId], async client => {
        if (!await this.journal.heartbeatOperation(identity, operation.generation, operation.workerId, client)) {
          throw new OperationOwnershipError()
        }
        const lease = await this.state.getLease(operation.tenantId, leaseId, client)
        if (!lease) throw new OperationOwnershipError()
        if (lease.state !== 'released') {
          if (lease.state !== 'release_pending' || lease.providerSandboxId !== allocation!.resourceId) {
            throw new OperationOwnershipError()
          }
          await this.journal.lockProviderResources(
            [{ kind: 'sandbox', resourceId: allocation!.resourceId }], client)
          try { await this.provider.kill(allocation!.resourceId) }
          catch (error) { if (!(error instanceof ProviderSandboxMissingError)) throw error }
          await this.state.releaseLease(operation.tenantId, leaseId, client)
        }
        await this.journal.updateAllocationState(identity, operation.generation, operation.workerId,
          allocation!.allocationId, 'reclaimed', client)
        await this.journal.completeOperation(
          identity, operation.generation, operation.workerId, { released: true }, client)
      })
      result.allocationsReclaimed += 1
    } catch { result.allocationsPending += 1 }
  }

  private async recoverLogicalCompletion(identity: OperationIdentity, operation: StaleOperation,
    allocations: OperationAllocation[]): Promise<void> {
    let response: Record<string, unknown> | undefined
    if (operation.operation === 'provision') {
      const leaseIds = [...new Set(allocations.flatMap(allocation =>
        allocation.state === 'adopted' && allocation.leaseId ? [allocation.leaseId] : []))]
      if (leaseIds.length === 1) {
        const lease = await this.state.getLease(operation.tenantId, leaseIds[0]!)
        if (lease?.baseSnapshotId) {
          response = {
            leaseId: lease.leaseId,
            environmentId: lease.environmentId,
            cwd: lease.cwdUri,
            workspaceRoots: lease.workspaceRootUris,
            baseSnapshotId: lease.baseSnapshotId,
            toolPolicy: lease.toolPolicy,
          }
        }
      }
    } else if (operation.operation === 'checkpoint') {
      const providerSnapshots = allocations.filter(allocation =>
        allocation.state === 'adopted' && allocation.allocationKind === 'provider_snapshot')
      if (providerSnapshots.length === 1) {
        const snapshot = await this.state.findSnapshotByProviderIdForReconciliation(providerSnapshots[0]!.resourceId)
        if (snapshot?.tenantId === operation.tenantId && snapshot.state === 'available') {
          response = { snapshotId: snapshot.snapshotId }
        }
      }
    }
    if (!response) return
    try {
      await this.journal.completeOperation(identity, operation.generation, operation.workerId, response)
    } catch (error) {
      if (!(error instanceof OperationOwnershipError)) throw error
    }
  }

  private async reclaimSandbox(identity: OperationIdentity, operation: StaleOperation,
    allocation: OperationAllocation, result: ReconcileRunResult): Promise<void> {
    await this.journal.withProviderResourceLock('sandbox', allocation.resourceId, async client => {
      if (!await this.journal.heartbeatOperation(identity, operation.generation, operation.workerId, client)) {
        throw new OperationOwnershipError()
      }
      const lease = await this.state.findLeaseByProviderSandboxForReconciliation(allocation.resourceId, client)
      if (lease) {
        await this.protectAllocation(identity, operation, allocation, lease, result, client)
        return
      }
      await this.markPending(identity, operation, allocation, client)
      const secondCheck = await this.state.findLeaseByProviderSandboxForReconciliation(allocation.resourceId, client)
      if (secondCheck) {
        await this.protectAllocation(identity, operation, allocation, secondCheck, result, client)
        return
      }
      try {
        await this.provider.kill(allocation.resourceId)
        await this.journal.updateAllocationState(identity, operation.generation, operation.workerId,
          allocation.allocationId, 'reclaimed', client)
        result.allocationsReclaimed += 1
      } catch (error) {
        if (error instanceof OperationOwnershipError) throw error
        result.allocationsPending += 1
      }
    })
  }

  private async reclaimSnapshot(identity: OperationIdentity, operation: StaleOperation,
    allocation: OperationAllocation, result: ReconcileRunResult): Promise<void> {
    await this.journal.withProviderResourceLock('provider_snapshot', allocation.resourceId, async client => {
      if (!await this.journal.heartbeatOperation(identity, operation.generation, operation.workerId, client)) {
        throw new OperationOwnershipError()
      }
      const snapshot = await this.state.findSnapshotByProviderIdForReconciliation(allocation.resourceId, client)
      if (snapshot) {
        const lease = await this.state.getLease(snapshot.tenantId, snapshot.leaseId, client)
        if (lease) await this.protectAllocation(identity, operation, allocation, lease, result, client)
        else await this.protectUnboundAllocation(identity, operation, allocation, result, client)
        return
      }
      await this.markPending(identity, operation, allocation, client)
      const secondCheck = await this.state.findSnapshotByProviderIdForReconciliation(allocation.resourceId, client)
      if (secondCheck) {
        const lease = await this.state.getLease(secondCheck.tenantId, secondCheck.leaseId, client)
        if (lease) await this.protectAllocation(identity, operation, allocation, lease, result, client)
        else await this.protectUnboundAllocation(identity, operation, allocation, result, client)
        return
      }
      try {
        await this.provider.deleteSnapshot(allocation.resourceId)
        await this.journal.updateAllocationState(identity, operation.generation, operation.workerId,
          allocation.allocationId, 'reclaimed', client)
        result.allocationsReclaimed += 1
      } catch (error) {
        if (error instanceof OperationOwnershipError) throw error
        result.allocationsPending += 1
      }
    })
  }

  private async protectAllocation(identity: OperationIdentity, operation: StaleOperation,
    allocation: OperationAllocation, lease: Lease, result: ReconcileRunResult, client: PoolClient): Promise<void> {
    await this.journal.bindLeaseAndAdoptAllocations(identity, operation.generation, operation.workerId,
      lease.leaseId, [allocation.allocationId], client)
    result.protectedResources += 1
  }

  private async protectUnboundAllocation(identity: OperationIdentity, operation: StaleOperation,
    allocation: OperationAllocation, result: ReconcileRunResult, client: PoolClient): Promise<void> {
    await this.journal.updateAllocationState(identity, operation.generation, operation.workerId,
      allocation.allocationId, 'adopted', client)
    result.protectedResources += 1
  }

  private async markPending(identity: OperationIdentity, operation: StaleOperation,
    allocation: OperationAllocation, client: PoolClient): Promise<void> {
    if (allocation.state !== 'reclaim_pending') {
      await this.journal.updateAllocationState(identity, operation.generation, operation.workerId,
        allocation.allocationId, 'reclaim_pending', client)
    }
  }

  private async reconcileInventory(result: ReconcileRunResult): Promise<void> {
    const metadata = { managedBy: this.options.managedBy, tenantId: this.options.tenantId }
    const inventory = await this.provider.listManagedSandboxes({ metadata })
    for (const sandbox of inventory.slice(0, this.options.maxInventorySandboxesPerRun)) {
      if (!Number.isFinite(sandbox.startedAt.getTime()) || sandbox.startedAt > new Date(Date.now() - this.options.staleAfterMs)) continue
      if (await this.state.findLeaseByProviderSandboxForReconciliation(sandbox.sandboxId)) {
        result.protectedResources += 1
        continue
      }
      if (await this.journal.hasUnreclaimedAllocation('sandbox', sandbox.sandboxId)
        || await this.journal.hasUnreclaimedAllocation('capture_sandbox', sandbox.sandboxId)) {
        continue
      }
      // E2B snapshot metadata is unavailable. Only enumerate snapshots through this known,
      // service-owned sandbox and never use an unscoped global snapshot query.
      let cleanupFailed = false
      try {
        const snapshots = await this.provider.listSnapshots({ sandboxId: sandbox.sandboxId })
        if (snapshots.length > this.options.maxInventorySnapshotsPerSandbox) cleanupFailed = true
        for (const snapshot of snapshots.slice(0, this.options.maxInventorySnapshotsPerSandbox)) {
          if (await this.state.findSnapshotByProviderIdForReconciliation(snapshot.snapshotId)) continue
          if (await this.journal.hasUnreclaimedAllocation('provider_snapshot', snapshot.snapshotId)) continue
          await this.journal.withProviderResourceLock('provider_snapshot', snapshot.snapshotId,
            async client => {
              if (await this.state.findSnapshotByProviderIdForReconciliation(snapshot.snapshotId, client)) return
              if (await this.journal.hasUnreclaimedAllocation('provider_snapshot', snapshot.snapshotId, client)) return
              await this.provider.deleteSnapshot(snapshot.snapshotId)
            })
        }
      } catch {
        cleanupFailed = true
      }
      if (cleanupFailed) continue
      await this.journal.withProviderResourceLock('sandbox', sandbox.sandboxId, async client => {
        if (await this.state.findLeaseByProviderSandboxForReconciliation(sandbox.sandboxId, client)) {
          result.protectedResources += 1
          return
        }
        if (await this.journal.hasUnreclaimedAllocation('sandbox', sandbox.sandboxId, client)
          || await this.journal.hasUnreclaimedAllocation('capture_sandbox', sandbox.sandboxId, client)) return
        try {
          await this.provider.kill(sandbox.sandboxId)
          result.inventorySandboxesReclaimed += 1
        } catch {
          // Provider inventory will surface the sandbox again on the next bounded pass.
        }
      })
    }
  }
}
