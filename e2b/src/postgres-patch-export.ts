import { createHash } from 'node:crypto'
import type { ObjectStore } from './blob-store.js'
import {
  PatchArtifactConflictError,
  PatchArtifactNotFoundError,
  type PostgresPatchArtifactRepository,
} from './postgres-artifacts.js'
import {
  PatchArtifactFormatError,
  serializePatchArtifact,
  type SerializedPatchArtifact,
} from './patch-artifact.js'
import {
  type PostgresPatchExportSourceResolver,
  type ResolvedPatchExportSource,
} from './postgres-patch-export-source.js'
import type { PostgresObjectReclaimer } from './postgres-object-reclaimer.js'
import type { PostgresDurableState, StoredObject } from './postgres-state.js'
import {
  canonicalRequestHash,
  OperationRequestMismatchError,
  type OperationAllocation,
  type OperationClaim,
  type OperationIdentity,
  type PostgresJournal,
} from './postgres-store.js'
import type { AgentPatchArtifact, PatchExportRequest } from './types.js'
import { ServiceError } from './types.js'
import { validatePatchExportRequest, validatePatchExportResponse } from './validation.js'
import { diffWorkspaceManifests } from './workspace-manifest.js'

export interface PostgresPatchExportOptions {
  tenantId: string
  workerId: string
  artifactTtlMs?: number
  waitTimeoutMs?: number
  cleanupBatchSize?: number
}

const operation = 'patch_export'

function bounded(label: string, value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

export function deterministicPatchExportId(label: 'artifact' | 'object',
  identity: OperationIdentity, checksum = ''): string {
  const hash = createHash('sha256').update(JSON.stringify([
    identity.tenantId, identity.operation, identity.idempotencyKey, checksum,
  ])).digest('hex')
  return `${label}_${hash}`
}

function contentReferences(source: ResolvedPatchExportSource): Array<{ path: string; objectId: string }> {
  const changes = diffWorkspaceManifests(source.base.manifest, source.current.manifest)
  return changes.flatMap(change => {
    if (change.current?.type !== 'file') return []
    const current = change.current
    const matches = source.current.contentObjects.filter(object =>
      object.checksum === current.digest && object.sizeBytes === current.sizeBytes)
    const ids = [...new Set(matches.map(object => object.objectId))]
    if (ids.length !== 1) throw new ServiceError(503, 'patch export content unavailable')
    return [{ path: change.path, objectId: ids[0]! }]
  })
}

function serializedSource(source: ResolvedPatchExportSource): SerializedPatchArtifact {
  try {
    return serializePatchArtifact({
      agentId: source.lease.agentId,
      baseSnapshotId: source.base.snapshotId,
      currentSnapshotId: source.current.snapshotId,
      baseManifest: source.base.manifest,
      currentManifest: source.current.manifest,
      contentObjects: contentReferences(source),
    })
  } catch (error) {
    if (error instanceof ServiceError) throw error
    if (error instanceof PatchArtifactFormatError && error.kind === 'quota') {
      throw new ServiceError(413, error.message)
    }
    throw new ServiceError(503, 'patch export material is invalid')
  }
}

function sameSerialization(left: SerializedPatchArtifact, right: SerializedPatchArtifact): boolean {
  return left.checksum === right.checksum && left.changedFiles === right.changedFiles
    && left.sizeBytes === right.sizeBytes
    && left.artifact.baseSnapshotId === right.artifact.baseSnapshotId
    && left.artifact.currentSnapshotId === right.artifact.currentSnapshotId
    && JSON.stringify(left.contentObjectIds) === JSON.stringify(right.contentObjectIds)
}

export class PostgresPatchExportCoordinator {
  private readonly tenantId: string
  private readonly workerId: string
  private readonly artifactTtlMs: number
  private readonly waitTimeoutMs: number
  private readonly cleanupBatchSize: number

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly sourceResolver: PostgresPatchExportSourceResolver,
    private readonly artifacts: PostgresPatchArtifactRepository,
    private readonly objects: ObjectStore,
    private readonly reclaimer: Pick<PostgresObjectReclaimer, 'reclaimOperationObjects'>,
    options: PostgresPatchExportOptions,
  ) {
    this.tenantId = bounded('tenant ID', options.tenantId)
    this.workerId = bounded('worker ID', options.workerId)
    this.artifactTtlMs = options.artifactTtlMs ?? 7 * 24 * 60 * 60_000
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000
    this.cleanupBatchSize = options.cleanupBatchSize ?? 100
    if (!Number.isSafeInteger(this.artifactTtlMs) || this.artifactTtlMs < 1000
      || this.artifactTtlMs > 30 * 24 * 60 * 60_000) throw new Error('invalid artifact TTL')
    if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs <= 0
      || this.waitTimeoutMs > 5 * 60_000) throw new Error('invalid operation wait timeout')
    if (!Number.isSafeInteger(this.cleanupBatchSize) || this.cleanupBatchSize < 1
      || this.cleanupBatchSize > 1000) throw new Error('invalid cleanup batch size')
  }

  async exportPatch(untrustedRequest: PatchExportRequest): Promise<AgentPatchArtifact> {
    const request = validatePatchExportRequest(untrustedRequest)
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
      throw new ServiceError(503, 'durable patch export service unavailable')
    }
    if (claim.kind === 'in_progress') {
      try {
        claim = await this.journal.waitForTerminal(
          { ...identity, requestHash }, { timeoutMs: this.waitTimeoutMs })
      } catch { throw new ServiceError(503, 'durable patch export is still in progress') }
    }
    if (claim.kind !== 'claimed') return this.replay(claim, request)

    const fence = { ...identity, generation: claim.generation, workerId: this.workerId }
    let allocation: OperationAllocation | undefined
    let finalCommitStarted = false
    try {
      await this.heartbeat(fence)
      const initial = await this.sourceResolver.resolve({
        tenantId: this.tenantId, leaseId: request.leaseId,
        agentId: request.agentId, baseSnapshotId: request.baseSnapshotId,
      })
      const serialized = serializedSource(initial)
      const artifactId = deterministicPatchExportId('artifact', identity)
      const objectId = deterministicPatchExportId('object', identity, serialized.checksum)
      const physicalId = await this.objects.put(serialized.bytes)
      if (serialized.checksum !== `sha256:${physicalId}`) {
        throw new ServiceError(503, 'patch artifact storage mismatch')
      }
      const location = this.objects.location(physicalId)
      const durable: StoredObject = {
        objectId, tenantId: this.tenantId, kind: 'patch_artifact',
        storageBucket: location.storageBucket, storageKey: location.storageKey,
        checksum: serialized.checksum, sizeBytes: serialized.bytes.byteLength,
        state: 'available', expiresAt: null,
      }
      await this.state.withObjectLocationLock(location.storageBucket, location.storageKey, async client => {
        await this.state.registerObject(durable, client)
        allocation = await this.journal.recordAllocation(
          identity, fence.generation, fence.workerId, {
            kind: 'object', resourceId: objectId,
            metadata: { artifactId, checksum: serialized.checksum },
          }, client)
      })
      await this.heartbeat(fence)
      finalCommitStarted = true
      const response = await this.journal.withLeaseLocks(this.tenantId, [request.leaseId], async client => {
        if (!await this.journal.heartbeatOperation(identity, fence.generation, fence.workerId, client)) {
          throw new ServiceError(503, 'durable patch export ownership changed')
        }
        const finalSource = await this.sourceResolver.resolve({
          tenantId: this.tenantId, leaseId: request.leaseId,
          agentId: request.agentId, baseSnapshotId: request.baseSnapshotId,
        }, client)
        const finalSerialized = serializedSource(finalSource)
        if (!sameSerialization(serialized, finalSerialized)) {
          throw new ServiceError(409, 'patch export source changed')
        }
        const expiresAt = new Date(Date.now() + this.artifactTtlMs)
        const artifact = await this.artifacts.create({
          artifactId, tenantId: this.tenantId, agentId: finalSource.lease.agentId,
          ownerAgentId: finalSource.lease.ownerAgentId, sourceLeaseId: finalSource.lease.leaseId,
          baseSnapshotId: finalSource.base.snapshotId,
          currentSnapshotId: finalSource.current.snapshotId,
          baseManifestObjectId: finalSource.base.manifestObjectId,
          currentManifestObjectId: finalSource.current.manifestObjectId,
          artifactObjectId: objectId, contentObjects: contentReferences(finalSource),
          checksum: finalSerialized.checksum, changedFiles: finalSerialized.changedFiles,
          sizeBytes: finalSerialized.sizeBytes, state: 'available', expiresAt,
          baseManifest: finalSource.base.manifest, currentManifest: finalSource.current.manifest,
        }, client)
        await this.journal.bindLeaseAndAdoptAllocations(
          identity, fence.generation, fence.workerId, request.leaseId,
          [allocation!.allocationId], client)
        const logical = validatePatchExportResponse({
          artifactId: artifact.artifactId, agentId: artifact.agentId,
          baseSnapshotId: artifact.baseSnapshotId, checksum: artifact.checksum,
          changedFiles: artifact.changedFiles, sizeBytes: artifact.sizeBytes,
        })
        await this.journal.completeOperation(
          identity, fence.generation, fence.workerId, logical, client)
        return logical
      })
      return response
    } catch (error) {
      if (finalCommitStarted) {
        const succeeded = await this.recoverCommitOutcome(identity, requestHash, request.leaseId, fence)
        if (succeeded) return this.replay(succeeded, request)
      }
      if (await this.cleanup(fence)) {
        const failure = this.failure(error)
        await this.journal.failOperation(identity, fence.generation, fence.workerId,
          `service_${failure.status}`, failure.message).catch(() => undefined)
        throw failure
      }
      throw new ServiceError(503, 'durable patch export cleanup pending')
    }
  }

  private async replay(claim: Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }>,
    request: PatchExportRequest): Promise<AgentPatchArtifact> {
    if (claim.kind === 'failed_terminal') {
      const status = /^service_([0-9]{3})$/u.exec(claim.errorCode ?? '')
      const parsed = status ? Number(status[1]) : 503
      throw new ServiceError(parsed >= 400 && parsed <= 599 ? parsed : 503,
        claim.errorMessage || 'durable patch export failed')
    }
    const response = validatePatchExportResponse(claim.response)
    const expectedId = deterministicPatchExportId('artifact', {
      operation, idempotencyKey: request.idempotencyKey, tenantId: this.tenantId,
    })
    const artifact = await this.artifacts.getAuthorized(
      this.tenantId, response.artifactId, request.agentId)
    if (!artifact || artifact.artifactId !== expectedId || artifact.sourceLeaseId !== request.leaseId
      || artifact.agentId !== request.agentId || artifact.baseSnapshotId !== request.baseSnapshotId
      || artifact.checksum !== response.checksum || artifact.changedFiles !== response.changedFiles
      || artifact.sizeBytes !== response.sizeBytes) {
      throw new ServiceError(503, 'durable patch export response is unavailable')
    }
    return response
  }

  private async heartbeat(fence: OperationIdentity & { generation: number; workerId: string }): Promise<void> {
    if (!await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)) {
      throw new ServiceError(503, 'durable patch export ownership changed')
    }
  }

  private async recoverCommitOutcome(identity: OperationIdentity, requestHash: string, leaseId: string,
    fence: OperationIdentity & { generation: number; workerId: string }): Promise<
      Extract<OperationClaim, { kind: 'succeeded' }> | null> {
    try {
      const claim = await this.journal.claimOperation({
        ...identity, requestHash, workerId: this.workerId,
        primaryLeaseId: leaseId,
      })
      if (claim.kind === 'succeeded') return claim
      if (claim.kind === 'in_progress' && claim.generation === fence.generation
        && await this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)) return null
    } catch { /* An unreadable outcome remains for reconciliation. */ }
    throw new ServiceError(503, 'durable patch export cleanup pending')
  }

  private async cleanup(fence: OperationIdentity & { generation: number; workerId: string }): Promise<boolean> {
    try {
      await this.reclaimer.reclaimOperationObjects(
        fence, fence.generation, fence.workerId, this.cleanupBatchSize)
      const allocations = await this.journal.listAllocations(fence, this.cleanupBatchSize + 1)
      return allocations.length <= this.cleanupBatchSize
        && allocations.every(item => item.state === 'reclaimed')
    } catch { return false }
  }

  private failure(error: unknown): ServiceError {
    if (error instanceof ServiceError && error.status < 500) return error
    if (error instanceof PatchArtifactConflictError) return new ServiceError(409, error.message)
    if (error instanceof PatchArtifactNotFoundError) return new ServiceError(404, error.message)
    return new ServiceError(503, 'durable patch export failed')
  }
}
