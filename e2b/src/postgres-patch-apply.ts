import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { captureArchiveManifest } from './archive-manifest.js'
import type { ObjectStore } from './blob-store.js'
import {
  buildPatchApplyArchive,
  type PatchApplyArchiveContent,
} from './patch-apply-archive.js'
import type { PlannedContentObject } from './patch-apply.js'
import {
  PatchApplyRejectedError,
  type PostgresPatchApplySourceResolver,
  type ResolvedPatchApplyContentObject,
  type ResolvedPatchApplySource,
} from './postgres-patch-apply-source.js'
import {
  type PatchApplication,
  type PatchApplicationFence,
  type PostgresPatchApplicationRepository,
} from './postgres-patch-applications.js'
import type { ProviderAdapter } from './provider.js'
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
import type { PatchApplyRequest, PatchApplyResult } from './types.js'
import { ServiceError } from './types.js'
import { validatePatchApplyRequest, validatePatchApplyResponse } from './validation.js'
import {
  canonicalJson,
  workspaceManifestChecksum,
  type WorkspaceManifest,
} from './workspace-manifest.js'
import type {
  PreparedDurableBaseWorkspaceSnapshot,
  WorkspaceSnapshotPublisher,
} from './workspace-snapshots.js'
import type { LeaseQuiescenceGate } from './postgres-lease-interactions.js'

const operation = 'patch_apply'

export interface PostgresPatchApplyOptions {
  tenantId: string
  workerId: string
  waitTimeoutMs?: number
  heartbeatIntervalMs?: number
  interactionGate?: LeaseQuiescenceGate
}

interface MutationContext {
  application: PatchApplication
  source: ResolvedPatchApplySource
  resultArchive: Uint8Array
  rollbackArchive: Uint8Array
}

class ValidationObjects implements ObjectStore {
  async put(bytes: Uint8Array): Promise<string> {
    return createHash('sha256').update(bytes).digest('hex')
  }
  async get(): Promise<Uint8Array> { throw new Error('validation store is write-only') }
  async delete(): Promise<void> {}
  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'validation', storageKey: id }
  }
}

function bounded(label: string, value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

export function deterministicPatchApplyId(prefix: 'application' | 'snapshot',
  identity: OperationIdentity): string {
  const hash = createHash('sha256').update('hosted-agent-patch-apply\0')
    .update(prefix).update('\0').update(identity.tenantId).update('\0')
    .update(identity.idempotencyKey).digest('hex')
  return `${prefix}_${hash}`
}

export function patchApplyProviderSnapshotName(kind: 'rollback' | 'result',
  identity: OperationIdentity): string {
  return `patch-apply-${kind}-${createHash('sha256')
    .update('hosted-agent-patch-apply-provider\0').update(kind).update('\0')
    .update(identity.tenantId).update('\0').update(identity.idempotencyKey)
    .digest('hex').slice(0, 32)}`
}

function checksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function contentMap(source: ResolvedPatchApplySource): Map<string, ResolvedPatchApplyContentObject> {
  const result = new Map<string, ResolvedPatchApplyContentObject>()
  for (const object of [...source.target.contentObjects, ...source.artifact.contentObjects]) {
    const prior = result.get(object.objectId)
    if (prior && (prior.checksum !== object.checksum || prior.sizeBytes !== object.sizeBytes
      || !Buffer.from(prior.bytes).equals(Buffer.from(object.bytes)))) {
      throw new ServiceError(503, 'patch apply content identity is inconsistent')
    }
    result.set(object.objectId, object)
  }
  return result
}

function plannedArchiveContent(source: ResolvedPatchApplySource,
  planned: PlannedContentObject[]): PatchApplyArchiveContent[] {
  const objects = contentMap(source)
  return planned.map(value => {
    const object = objects.get(value.objectId)
    if (!object || object.checksum !== value.checksum || object.sizeBytes !== value.sizeBytes) {
      throw new ServiceError(503, 'patch apply planned content is unavailable')
    }
    return { path: value.path, ...object }
  })
}

function snapshotArchiveContent(manifest: WorkspaceManifest,
  objects: ResolvedPatchApplyContentObject[]): PatchApplyArchiveContent[] {
  return manifest.entries.flatMap(entry => {
    if (entry.type !== 'file') return []
    const matches = objects.filter(object => object.checksum === entry.digest
      && object.sizeBytes === entry.sizeBytes)
    if (matches.length !== 1) throw new ServiceError(503, 'patch apply rollback content is unavailable')
    return [{ path: entry.path, ...matches[0]! }]
  })
}

export class PostgresPatchApplyCoordinator {
  private readonly tenantId: string
  private readonly workerId: string
  private readonly waitTimeoutMs: number
  private readonly heartbeatIntervalMs: number
  private readonly interactionGate: LeaseQuiescenceGate | undefined

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly sources: PostgresPatchApplySourceResolver,
    private readonly applications: PostgresPatchApplicationRepository,
    private readonly publisher: WorkspaceSnapshotPublisher,
    private readonly provider: ProviderAdapter,
    options: PostgresPatchApplyOptions,
  ) {
    this.tenantId = bounded('tenant ID', options.tenantId)
    this.workerId = bounded('worker ID', options.workerId)
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
    this.interactionGate = options.interactionGate
    if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs <= 0
      || this.waitTimeoutMs > 5 * 60_000) throw new Error('invalid operation wait timeout')
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0
      || this.heartbeatIntervalMs > 60_000) throw new Error('invalid operation heartbeat interval')
  }

  async applyPatch(untrustedRequest: PatchApplyRequest): Promise<PatchApplyResult> {
    const request = validatePatchApplyRequest(untrustedRequest)
    const identity: OperationIdentity = {
      operation, idempotencyKey: request.idempotencyKey, tenantId: this.tenantId,
    }
    const requestHash = canonicalRequestHash(request)
    let claim: OperationClaim
    try {
      claim = await this.journal.claimOperation({
        ...identity, requestHash, workerId: this.workerId,
        primaryLeaseId: request.targetLeaseId,
      })
    } catch (error) {
      if (error instanceof OperationRequestMismatchError) throw new ServiceError(409, error.message)
      if (error instanceof OperationTargetNotFoundError) throw new ServiceError(404, 'target lease missing')
      throw new ServiceError(503, 'durable patch apply service unavailable')
    }
    if (claim.kind === 'in_progress') {
      try {
        claim = await this.journal.waitForTerminal(
          { ...identity, requestHash }, { timeoutMs: this.waitTimeoutMs })
      } catch { throw new ServiceError(503, 'durable patch apply is still in progress') }
    }
    if (claim.kind !== 'claimed') return this.replay(claim, request.targetLeaseId)
    const fence: PatchApplicationFence = {
      ...identity, generation: claim.generation, workerId: this.workerId,
    }

    return this.journal.withSessionLeaseLocks(
      this.tenantId, [request.targetLeaseId], client =>
        this.runOwned(request, requestHash, fence, client))
  }

  private async runOwned(request: PatchApplyRequest, requestHash: string,
    fence: PatchApplicationFence, client: PoolClient): Promise<PatchApplyResult> {
    let mutation: MutationContext | undefined
    let rollback: { resourceId: string; allocation?: OperationAllocation } | undefined
    let resultSnapshot: { resourceId: string; allocation?: OperationAllocation } | undefined
    let prepared: PreparedDurableBaseWorkspaceSnapshot | undefined
    let finalCommitStarted = false
    let providerSnapshotOutcomeAmbiguous = false
    try {
      const initial = await this.transaction(client, async () => {
        await this.heartbeat(fence, client)
        const resultSnapshotId = deterministicPatchApplyId('snapshot', fence)
        let source: ResolvedPatchApplySource
        try {
          source = await this.sources.resolve({
            tenantId: this.tenantId, targetLeaseId: request.targetLeaseId,
            artifactId: request.artifactId, resultSnapshotId,
          }, client)
        } catch (error) {
          if (!(error instanceof PatchApplyRejectedError)) throw error
          const logical = validatePatchApplyResponse({ type: 'rejected', reason: error.reason })
          await this.journal.completeOperation(
            fence, fence.generation, fence.workerId, logical, client)
          return logical
        }
        if (source.plan.type === 'conflict') {
          const logical = validatePatchApplyResponse({
            type: 'conflict', paths: source.plan.paths,
          })
          await this.journal.completeOperation(
            fence, fence.generation, fence.workerId, logical, client)
          return logical
        }
        if (source.plan.type === 'rejected') {
          const logical = validatePatchApplyResponse(source.plan)
          await this.journal.completeOperation(
            fence, fence.generation, fence.workerId, logical, client)
          return logical
        }
        const lease = await this.state.getLease(this.tenantId, request.targetLeaseId, client)
        if (!lease || lease.latestSnapshotId !== source.target.latestSnapshotId
          || lease.providerSandboxId !== source.target.providerSandboxId
          || !['active', 'paused'].includes(lease.state)) {
          throw new ServiceError(409, 'target lease changed before patch application')
        }
        await this.interactionGate?.assertQuiescent(
          this.tenantId, lease.leaseId, lease.connectionGeneration, client)
        const resultArchive = await buildPatchApplyArchive(
          source.plan.manifest, plannedArchiveContent(source, source.plan.contentObjects))
        const rollbackArchive = await buildPatchApplyArchive(
          source.target.manifest,
          snapshotArchiveContent(source.target.manifest, source.target.contentObjects))
        const application = await this.applications.create({
          ...fence, applicationId: deterministicPatchApplyId('application', fence),
          createdGeneration: fence.generation, targetLeaseId: lease.leaseId,
          artifactId: request.artifactId,
          sourceTargetSnapshotId: source.target.latestSnapshotId,
          targetProviderSandboxId: source.target.providerSandboxId,
          resultSnapshotId, resultManifestChecksum: workspaceManifestChecksum(source.plan.manifest),
          resultArchiveChecksum: checksum(resultArchive),
          resultArchiveSizeBytes: resultArchive.byteLength,
        }, fence, client)
        return { application, source, resultArchive, rollbackArchive }
      })
      if (!('application' in initial)) return initial
      mutation = initial

      providerSnapshotOutcomeAmbiguous = true
      const rollbackId = await this.withHeartbeat(fence, () => this.provider.snapshot(
        mutation!.source.target.providerSandboxId,
        { name: patchApplyProviderSnapshotName('rollback', fence) }))
      providerSnapshotOutcomeAmbiguous = false
      rollback = { resourceId: rollbackId }
      await this.transaction(client, async () => {
        await this.journal.lockProviderResources(
          [{ kind: 'provider_snapshot', resourceId: rollbackId }], client)
        rollback!.allocation = await this.journal.recordAllocation(
          fence, fence.generation, fence.workerId, {
            kind: 'provider_snapshot', resourceId: rollbackId,
            leaseId: request.targetLeaseId,
            metadata: { purpose: 'patch_apply_rollback',
              applicationId: mutation!.application.applicationId,
              name: patchApplyProviderSnapshotName('rollback', fence) },
          }, client)
        mutation!.application = await this.applications.recordRollback(
          fence, mutation!.application.applicationId, {
            allocationId: rollback!.allocation.allocationId,
            providerSnapshotId: rollbackId,
          }, client)
      })
      await this.transaction(client, async () => {
        await this.heartbeat(fence, client)
        mutation!.application = await this.applications.markSwapStarted(
          fence, mutation!.application.applicationId, client)
      })
      await this.withHeartbeat(fence, () => this.provider.uploadArchive(
        mutation!.source.target.providerSandboxId, mutation!.resultArchive))
      await this.transaction(client, async () => {
        mutation!.application = await this.applications.markSwapped(
          fence, mutation!.application.applicationId, client)
      })

      const observedArchive = await this.withHeartbeat(fence, () => this.provider.exportWorkspace(
        mutation!.source.target.providerSandboxId))
      const observed = await captureArchiveManifest(observedArchive,
        mutation.application.resultSnapshotId, new ValidationObjects())
      if (canonicalJson(observed.manifest) !== canonicalJson(mutation.source.plan.type === 'ready'
        ? mutation.source.plan.manifest : null)) {
        throw new ServiceError(503, 'provider patch application did not match its plan')
      }
      providerSnapshotOutcomeAmbiguous = true
      const resultProviderId = await this.withHeartbeat(fence, () => this.provider.snapshot(
        mutation!.source.target.providerSandboxId,
        { name: patchApplyProviderSnapshotName('result', fence) }))
      providerSnapshotOutcomeAmbiguous = false
      resultSnapshot = { resourceId: resultProviderId }
      await this.transaction(client, async () => {
        await this.journal.lockProviderResources(
          [{ kind: 'provider_snapshot', resourceId: resultProviderId }], client)
        resultSnapshot!.allocation = await this.journal.recordAllocation(
          fence, fence.generation, fence.workerId, {
            kind: 'provider_snapshot', resourceId: resultProviderId,
            leaseId: request.targetLeaseId,
            metadata: { purpose: 'patch_apply_checkpoint',
              applicationId: mutation!.application.applicationId,
              name: patchApplyProviderSnapshotName('result', fence) },
          }, client)
      })
      const lease = await this.state.getLease(this.tenantId, request.targetLeaseId)
      if (!lease || !lease.environmentId || !lease.providerSandboxId) {
        throw new ServiceError(503, 'patch apply target lease unavailable')
      }
      prepared = await this.publisher.prepareDurableBase({
        fence, expectedSourceChecksum: null,
        expectedLatestSnapshotId: mutation.source.target.latestSnapshotId,
        leaseId: lease.leaseId, environmentId: lease.environmentId, tenantId: lease.tenantId,
        agentId: lease.agentId, ownerAgentId: lease.ownerAgentId,
        ownerLeaseId: lease.ownerLeaseId, sourceSnapshotId: null,
        providerSandboxId: lease.providerSandboxId, sandboxTemplate: lease.sandboxTemplate,
        cwdUri: lease.cwdUri, workspaceRootUris: [...lease.workspaceRootUris],
        toolPolicy: structuredClone(lease.toolPolicy), policyVersion: lease.policyVersion,
        snapshot: {
          snapshotId: mutation.application.resultSnapshotId,
          providerSnapshotId: resultProviderId, archive: mutation.resultArchive, expiresAt: null,
        },
      })
      finalCommitStarted = true
      await this.transaction(client, async () => {
        await this.heartbeat(fence, client)
        await this.journal.lockProviderResources([
          { kind: 'provider_snapshot', resourceId: rollback!.resourceId },
          { kind: 'provider_snapshot', resourceId: resultSnapshot!.resourceId },
        ], client)
        const durable = await this.publisher.commitDurableCheckpoint(fence, prepared!, client)
        await this.journal.bindLeaseAndAdoptAllocations(
          fence, fence.generation, fence.workerId, request.targetLeaseId,
          [resultSnapshot!.allocation!.allocationId, ...durable.objectAllocationIds], client)
        mutation!.application = await this.applications.markCheckpointed(
          fence, mutation!.application.applicationId, client)
      })
      await this.cleanupProviderSnapshot(fence, rollback, client)
      const logical = validatePatchApplyResponse({
        type: 'applied', checkpoint: { snapshotId: mutation.application.resultSnapshotId },
      })
      await this.transaction(client, () => this.journal.completeOperation(
        fence, fence.generation, fence.workerId, logical, client))
      return logical
    } catch (error) {
      if (finalCommitStarted) {
        const application = await this.applications.getForOperation(fence)
        if (application?.phase === 'checkpointed') {
          const outcome = await this.journal.claimOperation({
            operation: fence.operation, idempotencyKey: fence.idempotencyKey,
            tenantId: fence.tenantId, requestHash, workerId: this.workerId,
            primaryLeaseId: request.targetLeaseId,
          })
          if (outcome.kind === 'succeeded') return this.replay(outcome, request.targetLeaseId)
          if (outcome.kind !== 'in_progress' || outcome.generation !== fence.generation) {
            throw new ServiceError(503, 'durable patch apply cleanup pending')
          }
          if (rollback?.allocation) {
            const allocations = await this.journal.listAllocations(fence)
            const durableRollback = allocations.find(value =>
              value.allocationId === rollback!.allocation!.allocationId)
            if (durableRollback?.state !== 'reclaimed') {
              await this.cleanupProviderSnapshot(fence, rollback, client)
            }
          }
          const logical = validatePatchApplyResponse({
            type: 'applied', checkpoint: { snapshotId: application.resultSnapshotId },
          })
          await this.transaction(client, () => this.journal.completeOperation(
            fence, fence.generation, fence.workerId, logical, client))
          return logical
        }
      }
      const rolledBack = await this.rollbackFailure(
        fence, mutation, rollback, resultSnapshot, prepared, client)
      if (!rolledBack) throw new ServiceError(503, 'durable patch apply cleanup pending')
      if (providerSnapshotOutcomeAmbiguous) {
        throw new ServiceError(503, 'durable patch apply cleanup pending')
      }
      const failure = error instanceof ServiceError && error.status < 500
        ? error : new ServiceError(503, 'durable patch apply failed')
      await this.transaction(client, () => this.journal.failOperation(
        fence, fence.generation, fence.workerId,
        `service_${failure.status}`, failure.message, client)).catch(() => undefined)
      throw failure
    }
  }

  private async rollbackFailure(fence: PatchApplicationFence,
    mutation: MutationContext | undefined,
    rollback: { resourceId: string; allocation?: OperationAllocation } | undefined,
    resultSnapshot: { resourceId: string; allocation?: OperationAllocation } | undefined,
    prepared: PreparedDurableBaseWorkspaceSnapshot | undefined,
    client: PoolClient): Promise<boolean> {
    let failed = false
    let rollbackRestored = rollback?.allocation === undefined
    if (mutation && !rollback?.allocation && mutation.application.phase === 'planned') {
      try {
        await this.transaction(client, async () => {
          mutation!.application = await this.applications.markFailed(
            fence, mutation!.application.applicationId,
            'patch application failed before provider mutation', client)
        })
      } catch { failed = true }
    }
    if (mutation && rollback?.allocation) {
      try {
        await this.transaction(client, async () => {
          mutation.application = await this.applications.beginRollback(
            fence, mutation.application.applicationId, 'patch application failed', client)
        })
        await this.withHeartbeat(fence, () => this.provider.uploadArchive(
          mutation!.source.target.providerSandboxId, mutation!.rollbackArchive))
        await this.transaction(client, async () => {
          mutation!.application = await this.applications.markRolledBack(
            fence, mutation!.application.applicationId, client)
        })
        rollbackRestored = true
      } catch { failed = true }
    }
    if (prepared) {
      try { await this.publisher.abortDurableBase(fence, prepared) }
      catch { failed = true }
    }
    for (const snapshot of [resultSnapshot, ...(rollbackRestored ? [rollback] : [])]) {
      if (!snapshot) continue
      try { await this.cleanupProviderSnapshot(fence, snapshot, client) }
      catch { failed = true }
    }
    for (const kind of ['rollback', 'result'] as const) {
      try { await this.cleanupUnledgeredProviderSnapshot(fence, kind) }
      catch { failed = true }
    }
    return !failed
  }

  private async cleanupUnledgeredProviderSnapshot(fence: PatchApplicationFence,
    kind: 'rollback' | 'result'): Promise<void> {
    const name = patchApplyProviderSnapshotName(kind, fence)
    const snapshots = await this.provider.listSnapshots({ name })
    if (snapshots.length > 1 || snapshots.some(value => !value.names.includes(name))) {
      throw new Error(`ambiguous deterministic patch apply ${kind} snapshot inventory`)
    }
    const snapshot = snapshots[0]
    if (!snapshot || await this.state.findSnapshotByProviderIdForReconciliation(snapshot.snapshotId)
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

  private async cleanupProviderSnapshot(fence: PatchApplicationFence,
    snapshot: { resourceId: string; allocation?: OperationAllocation },
    client: PoolClient): Promise<void> {
    await this.transaction(client, async () => {
      await this.journal.lockProviderResources(
        [{ kind: 'provider_snapshot', resourceId: snapshot.resourceId }], client)
      await this.provider.deleteSnapshot(snapshot.resourceId)
      if (snapshot.allocation) {
        await this.journal.updateAllocationState(
          fence, fence.generation, fence.workerId,
          snapshot.allocation.allocationId, 'reclaimed', client)
      }
    })
  }

  private async replay(claim: Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }>,
    targetLeaseId: string): Promise<PatchApplyResult> {
    if (claim.kind === 'failed_terminal') {
      const status = /^service_([0-9]{3})$/u.exec(claim.errorCode ?? '')
      const parsed = status ? Number(status[1]) : 503
      throw new ServiceError(parsed >= 400 && parsed <= 599 ? parsed : 503,
        claim.errorMessage || 'durable patch apply failed')
    }
    const logical = validatePatchApplyResponse(claim.response)
    if (logical.type === 'applied') {
      const snapshot = await this.state.getSnapshot(this.tenantId, logical.checkpoint.snapshotId)
      if (!snapshot || snapshot.leaseId !== targetLeaseId || snapshot.state !== 'available') {
        throw new ServiceError(503, 'durable patch apply response is unavailable')
      }
    }
    return logical
  }

  private async heartbeat(fence: PatchApplicationFence,
    executor?: Pick<PoolClient, 'query'>): Promise<void> {
    if (!await this.journal.heartbeatOperation(
      fence, fence.generation, fence.workerId, executor)) {
      throw new ServiceError(503, 'durable patch apply ownership changed')
    }
  }

  private async withHeartbeat<T>(fence: PatchApplicationFence,
    operationCall: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      void this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)
        .catch(() => undefined)
    }, this.heartbeatIntervalMs)
    timer.unref()
    try {
      const result = await operationCall()
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
