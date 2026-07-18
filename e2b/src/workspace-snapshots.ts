import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  captureArchiveManifest,
  defaultArchiveManifestLimits,
  type ArchiveManifestLimits,
  type CapturedArchiveManifest,
} from './archive-manifest.js'
import type { ObjectStore } from './blob-store.js'
import type { PostgresObjectReclaimer } from './postgres-object-reclaimer.js'
import type {
  CreateLeaseInput,
  Lease,
  PostgresDurableState,
  Snapshot,
  SnapshotInput,
  StoredObject,
} from './postgres-state.js'
import type { PostgresJournal } from './postgres-store.js'
import {
  canonicalWorkspacePreparationIntent,
  workspacePreparationId,
  workspacePreparationObjectId,
  type PreparationFence,
  type PostgresWorkspacePreparations,
  type WorkspacePreparation,
  type WorkspacePreparationIntent,
  type WorkspacePreparationObjectDescriptor,
  type WorkspacePreparationObjectPurpose,
} from './postgres-workspace-preparations.js'
import { ServiceError } from './types.js'
import { WorkspaceManifestError, type WorkspaceManifest } from './workspace-manifest.js'

const checksumPattern = /^sha256:[0-9a-f]{64}$/

export interface WorkspaceSnapshotArchiveInput {
  snapshotId: string
  providerSnapshotId: string | null
  archive: Uint8Array
  expiresAt?: Date | null
}

export interface CreateBaseWorkspaceSnapshotInput extends Omit<CreateLeaseInput, 'baseSnapshot'> {
  snapshot: WorkspaceSnapshotArchiveInput
}

export interface AppendWorkspaceCheckpointInput {
  tenantId: string
  leaseId: string
  snapshot: WorkspaceSnapshotArchiveInput
}

export interface PrepareDurableBaseWorkspaceSnapshotInput extends CreateBaseWorkspaceSnapshotInput {
  fence: PreparationFence
  expectedSourceChecksum: string | null
}

export interface PreparedDurableBaseWorkspaceSnapshot {
  kind: 'prepared' | 'committed'
  preparation: WorkspacePreparation
  intent: WorkspacePreparationIntent
  snapshotInput: Readonly<SnapshotInput>
  manifest: WorkspaceManifest
  contentObjects: readonly PublishedWorkspaceContent[]
}

export interface CommittedDurableBaseWorkspaceSnapshot {
  lease: Lease
  snapshot: Snapshot
  objectAllocationIds: string[]
}

export interface PublishedWorkspaceContent {
  path: string
  objectId: string
  checksum: string
  sizeBytes: number
}

export interface PublishedWorkspaceSnapshot {
  snapshot: Snapshot
  manifest: WorkspaceManifest
  contentObjects: PublishedWorkspaceContent[]
}

export interface PublishedBaseWorkspaceSnapshot extends PublishedWorkspaceSnapshot {
  lease: Lease
}

export interface WorkspaceSnapshotReclaimer {
  /** Must remove the logical registration and physical content only when neither has durable references. */
  reclaimUnreferencedWorkspaceObject(
    tenantId: string,
    objectId: string,
    physicalObjectId: string,
  ): Promise<void>
}

export interface WorkspaceSnapshotPublisherOptions {
  archiveLimits?: ArchiveManifestLimits
  reclaimer: WorkspaceSnapshotReclaimer
  durablePreparation?: {
    journal: Pick<PostgresJournal, 'recordAllocation'>
    preparations: Pick<PostgresWorkspacePreparations,
      'createOrReplay' | 'lockObjectForPublication' | 'associateObject' | 'markPrepared' | 'beginAbort'
      | 'lockForCommit' | 'markCommitted'>
    reclaimer: Pick<PostgresObjectReclaimer, 'reclaimPreparationObjects'>
    cleanupBatchSize?: number
  }
}

type DurableWorkspaceState = Pick<PostgresDurableState,
  'withObjectLocationLock' | 'registerObject' | 'createLeaseWithBaseSnapshot' | 'appendCheckpoint'>
  & Partial<Pick<PostgresDurableState, 'lockAuthorizedSourceSnapshot'>>

interface PlannedObject {
  bytes: Uint8Array
  durable: StoredObject
  physicalObjectId: string
}

class StagingObjectStore implements ObjectStore {
  private readonly values = new Map<string, Uint8Array>()

  async put(bytes: Uint8Array): Promise<string> {
    const id = digest(bytes)
    this.values.set(id, Uint8Array.from(bytes))
    return id
  }

  async get(id: string): Promise<Uint8Array> {
    const value = this.values.get(id)
    if (!value) throw new Error('staged workspace object is missing')
    return Uint8Array.from(value)
  }

  async delete(id: string): Promise<void> { this.values.delete(id) }

  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'staging', storageKey: id }
  }

  clear(): void { this.values.clear() }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function checksum(bytes: Uint8Array): string {
  return `sha256:${digest(bytes)}`
}

function opaque(label: string, value: string, maxBytes = 512): string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > maxBytes
    || Buffer.from(value, 'utf8').toString('utf8') !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new ServiceError(400, `invalid ${label}`)
  return value
}

function expiry(value: Date | null | undefined): Date | null {
  if (value === undefined || value === null) return null
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ServiceError(400, 'invalid snapshot expiry')
  return new Date(value)
}

function logicalObjectId(tenantId: string, snapshotId: string, kind: StoredObject['kind'], objectChecksum: string): string {
  return `workspace_object_${createHash('sha256')
    .update(tenantId).update('\0').update(snapshotId).update('\0').update(kind).update('\0').update(objectChecksum)
    .digest('hex')}`
}

function preparationPurpose(kind: StoredObject['kind']): WorkspacePreparationObjectPurpose {
  if (kind === 'workspace_archive' || kind === 'manifest' || kind === 'content_blob') return kind
  throw new Error('invalid prepared workspace object kind')
}

function verifyRegisteredObject(actual: StoredObject, expected: StoredObject): void {
  if (actual.objectId !== expected.objectId || actual.tenantId !== expected.tenantId
    || actual.kind !== expected.kind || actual.storageBucket !== expected.storageBucket
    || actual.storageKey !== expected.storageKey || actual.checksum !== expected.checksum
    || actual.sizeBytes !== expected.sizeBytes || actual.state !== 'available'
    || actual.expiresAt?.getTime() !== expected.expiresAt?.getTime()) {
    throw new Error('durable workspace object registration mismatch')
  }
}

function verifySnapshot(actual: Snapshot, tenantId: string, leaseId: string, expected: SnapshotInput): void {
  if (actual.snapshotId !== expected.snapshotId || actual.tenantId !== tenantId || actual.leaseId !== leaseId
    || actual.providerSnapshotId !== expected.providerSnapshotId
    || actual.workspaceArchiveObjectId !== expected.workspaceArchiveObjectId
    || actual.manifestObjectId !== expected.manifestObjectId
    || actual.manifestChecksum !== expected.manifestChecksum || actual.state !== 'available'
    || actual.expiresAt?.getTime() !== expected.expiresAt?.getTime()) {
    throw new Error('durable workspace snapshot registration mismatch')
  }
}

function mapCaptureError(error: unknown): never {
  if (error instanceof ServiceError) throw error
  if (error instanceof WorkspaceManifestError) {
    throw new ServiceError(error.kind === 'quota' ? 429 : 400,
      error.kind === 'quota' ? 'workspace snapshot quota exceeded' : 'invalid workspace snapshot archive')
  }
  throw new ServiceError(503, 'workspace snapshot service unavailable')
}

export class WorkspaceSnapshotPublisher {
  private readonly limits: ArchiveManifestLimits

  constructor(
    private readonly state: DurableWorkspaceState,
    private readonly objects: ObjectStore,
    private readonly options: WorkspaceSnapshotPublisherOptions,
  ) {
    this.limits = options.archiveLimits ?? defaultArchiveManifestLimits
  }

  async createBase(input: CreateBaseWorkspaceSnapshotInput): Promise<PublishedBaseWorkspaceSnapshot> {
    const tenantId = opaque('tenant ID', input.tenantId)
    const leaseId = opaque('lease ID', input.leaseId)
    const publication = await this.prepare(tenantId, input.snapshot)
    const published: PlannedObject[] = []
    try {
      await this.publishObjects(publication.objects, published)
      const created = await this.state.createLeaseWithBaseSnapshot({
        leaseId,
        environmentId: input.environmentId,
        tenantId,
        agentId: input.agentId,
        ...(input.ownerAgentId === undefined ? {} : { ownerAgentId: input.ownerAgentId }),
        ...(input.ownerLeaseId === undefined ? {} : { ownerLeaseId: input.ownerLeaseId }),
        ...(input.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: input.sourceSnapshotId }),
        providerSandboxId: input.providerSandboxId,
        sandboxTemplate: input.sandboxTemplate,
        cwdUri: input.cwdUri,
        workspaceRootUris: input.workspaceRootUris,
        toolPolicy: input.toolPolicy,
        policyVersion: input.policyVersion,
        baseSnapshot: publication.snapshotInput,
      })
      verifySnapshot(created.snapshot, tenantId, leaseId, publication.snapshotInput)
      if (created.lease.tenantId !== tenantId || created.lease.leaseId !== leaseId
        || created.lease.baseSnapshotId !== publication.snapshotInput.snapshotId
        || created.lease.latestSnapshotId !== publication.snapshotInput.snapshotId
        || created.lease.state !== 'active') throw new Error('durable base lease registration mismatch')
      return { lease: created.lease, snapshot: created.snapshot, manifest: publication.captured.manifest,
        contentObjects: publication.contentObjects }
    } catch {
      await this.cleanup(tenantId, published)
      throw new ServiceError(503, 'workspace snapshot service unavailable')
    }
  }

  async prepareDurableBase(input: PrepareDurableBaseWorkspaceSnapshotInput): Promise<PreparedDurableBaseWorkspaceSnapshot> {
    const coordinator = this.options.durablePreparation
    if (!coordinator) throw new ServiceError(503, 'durable workspace preparation is unavailable')
    if (input.fence.operation !== 'provision') throw new ServiceError(400, 'invalid workspace preparation operation')
    const tenantId = opaque('tenant ID', input.tenantId)
    if (tenantId !== input.fence.tenantId) throw new ServiceError(400, 'workspace preparation tenant mismatch')
    const preparationId = workspacePreparationId(input.fence)
    const publication = await this.prepare(tenantId, input.snapshot, preparationId)
    const descriptors = this.describePreparationObjects(publication.objects)
    let intent: WorkspacePreparationIntent
    try {
      intent = canonicalWorkspacePreparationIntent({
        tenantId, leaseId: input.leaseId, environmentId: input.environmentId, agentId: input.agentId,
        ownerAgentId: input.ownerAgentId ?? null, ownerLeaseId: input.ownerLeaseId ?? null,
        sourceSnapshotId: input.sourceSnapshotId ?? null, expectedSourceChecksum: input.expectedSourceChecksum,
        providerSandboxId: input.providerSandboxId, sandboxTemplate: input.sandboxTemplate,
        cwdUri: input.cwdUri, workspaceRootUris: [...input.workspaceRootUris],
        toolPolicy: structuredClone(input.toolPolicy), policyVersion: input.policyVersion,
        snapshotId: publication.snapshotInput.snapshotId,
        providerSnapshotId: publication.snapshotInput.providerSnapshotId,
        snapshotExpiresAt: publication.snapshotInput.expiresAt?.toISOString() ?? null,
        archiveChecksum: publication.objects.find(plan => plan.durable.kind === 'workspace_archive')!.durable.checksum,
        manifestChecksum: publication.captured.manifestChecksum,
      }).intent
    } catch { throw new ServiceError(400, 'invalid durable workspace preparation') }
    const result = (verified: WorkspacePreparation): PreparedDurableBaseWorkspaceSnapshot => ({
      kind: verified.state === 'committed' ? 'committed' : 'prepared', preparation: verified, intent,
      snapshotInput: structuredClone(publication.snapshotInput),
      manifest: structuredClone(publication.captured.manifest),
      contentObjects: publication.contentObjects.map(content => ({ ...content })),
    })
    let abortEligible = false
    try {
      const preparation = await coordinator.preparations.createOrReplay({
        ...input.fence, preparationId, intent, expectedObjectCount: descriptors.length,
      })
      if (preparation.state === 'reclaim_pending') {
        await this.resumePreparationCleanup(input.fence, preparationId, coordinator)
      }
      if (preparation.state === 'reclaimed') throw new ServiceError(409, 'workspace preparation was aborted')
      if (preparation.state === 'publishing') {
        abortEligible = true
        await this.publishPreparationObjects(input.fence, preparationId, intent,
          publication.objects, descriptors, coordinator)
      }
      const verified = await coordinator.preparations.markPrepared(
        input.fence, preparationId, intent, descriptors)
      return result(verified)
    } catch (error) {
      if (abortEligible) {
        try {
          const completedByPeer = await coordinator.preparations.markPrepared(
            input.fence, preparationId, intent, descriptors)
          return result(completedByPeer)
        } catch { /* The exact preparation is still incomplete, so this owner may abort it. */ }
        try {
          const aborted = await coordinator.preparations.beginAbort(input.fence, preparationId)
          if (aborted.state === 'reclaim_pending') {
            await this.resumePreparationCleanup(input.fence, preparationId, coordinator)
          }
        } catch { throw new ServiceError(503, 'workspace snapshot cleanup pending') }
      }
      if (error instanceof ServiceError) throw error
      throw new ServiceError(503, 'workspace snapshot service unavailable')
    }
  }

  async commitDurableBase(fence: PreparationFence, prepared: PreparedDurableBaseWorkspaceSnapshot,
    executor: PoolClient): Promise<CommittedDurableBaseWorkspaceSnapshot> {
    const coordinator = this.options.durablePreparation
    if (!coordinator) throw new ServiceError(503, 'durable workspace preparation is unavailable')
    if (fence.operation !== 'provision') throw new ServiceError(400, 'invalid workspace preparation operation')
    try {
      const locked = await coordinator.preparations.lockForCommit(
        fence, prepared.preparation.preparationId, prepared.intent, executor)
      const intent = locked.preparation.intent
      if (intent.sourceSnapshotId !== null && intent.expectedSourceChecksum !== null) {
        if (!this.state.lockAuthorizedSourceSnapshot) throw new Error('source authorization is unavailable')
        await this.state.lockAuthorizedSourceSnapshot(intent.tenantId, intent.sourceSnapshotId,
          intent.expectedSourceChecksum, new Date(), executor)
      }
      const archive = locked.objects.find(object => object.purpose === 'workspace_archive')
      const manifest = locked.objects.find(object => object.purpose === 'manifest')
      if (!archive || !manifest) throw new Error('prepared workspace object set is incomplete')
      const snapshotInput: SnapshotInput = {
        snapshotId: intent.snapshotId, providerSnapshotId: intent.providerSnapshotId,
        workspaceArchiveObjectId: archive.objectId, manifestObjectId: manifest.objectId,
        manifestChecksum: intent.manifestChecksum,
        contentObjectIds: locked.objects.filter(object => object.purpose === 'content_blob')
          .map(object => object.objectId).sort(),
        expiresAt: intent.snapshotExpiresAt === null ? null : new Date(intent.snapshotExpiresAt),
      }
      const created = await this.state.createLeaseWithBaseSnapshot({
        leaseId: intent.leaseId, environmentId: intent.environmentId, tenantId: intent.tenantId,
        agentId: intent.agentId, ownerAgentId: intent.ownerAgentId, ownerLeaseId: intent.ownerLeaseId,
        sourceSnapshotId: intent.sourceSnapshotId, providerSandboxId: intent.providerSandboxId,
        sandboxTemplate: intent.sandboxTemplate, cwdUri: intent.cwdUri,
        workspaceRootUris: [...intent.workspaceRootUris], toolPolicy: structuredClone(intent.toolPolicy),
        policyVersion: intent.policyVersion, baseSnapshot: snapshotInput,
      }, executor)
      verifySnapshot(created.snapshot, intent.tenantId, intent.leaseId, snapshotInput)
      await coordinator.preparations.markCommitted(
        fence, prepared.preparation.preparationId, prepared.intent, executor)
      return { lease: created.lease, snapshot: created.snapshot,
        objectAllocationIds: locked.objects.map(object => object.allocationId) }
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(503, 'workspace snapshot service unavailable')
    }
  }

  async abortDurableBase(fence: PreparationFence,
    prepared: PreparedDurableBaseWorkspaceSnapshot): Promise<void> {
    const coordinator = this.options.durablePreparation
    if (!coordinator) throw new ServiceError(503, 'durable workspace preparation is unavailable')
    const limit = coordinator.cleanupBatchSize ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new ServiceError(503, 'workspace snapshot cleanup pending')
    }
    try {
      const aborted = await coordinator.preparations.beginAbort(
        fence, prepared.preparation.preparationId)
      if (aborted.state === 'committed') throw new Error('committed workspace preparation cannot be aborted')
      if (aborted.state === 'reclaimed') return
      const maximumBatches = Math.ceil(aborted.expectedObjectCount / limit) + 1
      for (let batch = 0; batch < maximumBatches; batch++) {
        const result = await coordinator.reclaimer.reclaimPreparationObjects(
          fence, aborted.preparationId, limit)
        if (result.claimed < limit) return
      }
      throw new Error('workspace preparation cleanup exceeded its bound')
    } catch {
      throw new ServiceError(503, 'workspace snapshot cleanup pending')
    }
  }

  async appendCheckpoint(input: AppendWorkspaceCheckpointInput): Promise<PublishedWorkspaceSnapshot> {
    const tenantId = opaque('tenant ID', input.tenantId)
    const leaseId = opaque('lease ID', input.leaseId)
    const publication = await this.prepare(tenantId, input.snapshot)
    const published: PlannedObject[] = []
    try {
      await this.publishObjects(publication.objects, published)
      const snapshot = await this.state.appendCheckpoint(tenantId, leaseId, publication.snapshotInput)
      verifySnapshot(snapshot, tenantId, leaseId, publication.snapshotInput)
      return { snapshot, manifest: publication.captured.manifest, contentObjects: publication.contentObjects }
    } catch {
      await this.cleanup(tenantId, published)
      throw new ServiceError(503, 'workspace snapshot service unavailable')
    }
  }

  private async prepare(tenantId: string, input: WorkspaceSnapshotArchiveInput,
    preparationId?: string): Promise<{
    captured: CapturedArchiveManifest
    snapshotInput: SnapshotInput
    objects: PlannedObject[]
    contentObjects: PublishedWorkspaceContent[]
  }> {
    const snapshotId = opaque('snapshot ID', input.snapshotId)
    if (input.providerSnapshotId !== null) opaque('provider snapshot ID', input.providerSnapshotId)
    if (!(input.archive instanceof Uint8Array)) throw new ServiceError(400, 'invalid workspace snapshot archive')
    const expiresAt = expiry(input.expiresAt)
    const staging = new StagingObjectStore()
    let captured: CapturedArchiveManifest
    try { captured = await captureArchiveManifest(input.archive, snapshotId, staging, this.limits) }
    catch (error) { return mapCaptureError(error) }

    try {
      const archiveChecksum = checksum(input.archive)
      const plans: PlannedObject[] = []
      const add = (kind: StoredObject['kind'], bytes: Uint8Array, objectChecksum: string): PlannedObject => {
        if (!checksumPattern.test(objectChecksum) || checksum(bytes) !== objectChecksum) {
          throw new Error('workspace object checksum mismatch')
        }
        const physicalObjectId = objectChecksum.slice('sha256:'.length)
        const plan: PlannedObject = {
          bytes: Uint8Array.from(bytes),
          physicalObjectId,
          durable: {
            objectId: preparationId === undefined
              ? logicalObjectId(tenantId, snapshotId, kind, objectChecksum)
              : workspacePreparationObjectId(preparationId, preparationPurpose(kind), objectChecksum),
            tenantId, kind,
            storageBucket: '', storageKey: '', checksum: objectChecksum, sizeBytes: bytes.byteLength,
            state: 'available', expiresAt,
          },
        }
        plans.push(plan)
        return plan
      }
      const archivePlan = add('workspace_archive', input.archive, archiveChecksum)
      const manifestPlan = add('manifest', captured.manifestBytes, captured.manifestChecksum)
      const contentPlans = new Map<string, PlannedObject>()
      for (const physical of [...new Set(captured.contentObjects.map(object => object.objectId))].sort()) {
        const bytes = await staging.get(physical)
        contentPlans.set(physical, add('content_blob', bytes, `sha256:${physical}`))
      }
      const fileEntries = new Map(captured.manifest.entries.flatMap(entry => entry.type === 'file' ? [[entry.path, entry] as const] : []))
      const contentObjects = captured.contentObjects.map(content => {
        const plan = contentPlans.get(content.objectId)
        const entry = fileEntries.get(content.path)
        if (!plan || !entry || entry.digest !== plan.durable.checksum || entry.sizeBytes !== plan.durable.sizeBytes) {
          throw new Error('captured workspace content mismatch')
        }
        return { path: content.path, objectId: plan.durable.objectId, checksum: entry.digest, sizeBytes: entry.sizeBytes }
      })
      return {
        captured,
        objects: plans,
        contentObjects,
        snapshotInput: {
          snapshotId, providerSnapshotId: input.providerSnapshotId,
          workspaceArchiveObjectId: archivePlan.durable.objectId,
          manifestObjectId: manifestPlan.durable.objectId,
          manifestChecksum: captured.manifestChecksum,
          contentObjectIds: [...new Set(contentObjects.map(content => content.objectId))].sort(),
          expiresAt,
        },
      }
    } catch { throw new ServiceError(503, 'workspace snapshot service unavailable') }
    finally { staging.clear() }
  }

  private async publishObjects(plans: PlannedObject[], published: PlannedObject[]): Promise<void> {
    for (const plan of plans) {
      const expected = this.objects.location(plan.physicalObjectId)
      const storageBucket = opaque('storage bucket', expected.storageBucket)
      const storageKey = opaque('storage key', expected.storageKey, 2048)
      await this.state.withObjectLocationLock(storageBucket, storageKey, async client => {
        const storedId = await this.objects.put(plan.bytes)
        published.push(plan)
        if (storedId !== plan.physicalObjectId) throw new Error('object store returned a non-content-addressed identifier')
        const location = this.objects.location(storedId)
        if (location.storageBucket !== storageBucket || location.storageKey !== storageKey) {
          throw new Error('object store location changed during publication')
        }
        plan.durable.storageBucket = storageBucket
        plan.durable.storageKey = storageKey
        verifyRegisteredObject(await this.state.registerObject(plan.durable, client), plan.durable)
      })
    }
  }

  private describePreparationObjects(plans: PlannedObject[]): WorkspacePreparationObjectDescriptor[] {
    for (const plan of plans) {
      const location = this.objects.location(plan.physicalObjectId)
      plan.durable.storageBucket = opaque('storage bucket', location.storageBucket)
      plan.durable.storageKey = opaque('storage key', location.storageKey, 2048)
    }
    plans.sort((left, right) => {
      const leftKey = JSON.stringify([left.durable.storageBucket, left.durable.storageKey, left.durable.objectId])
      const rightKey = JSON.stringify([right.durable.storageBucket, right.durable.storageKey, right.durable.objectId])
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    return plans.map(plan => ({
      objectId: plan.durable.objectId, purpose: preparationPurpose(plan.durable.kind),
      checksum: plan.durable.checksum, sizeBytes: plan.durable.sizeBytes,
      expiresAt: plan.durable.expiresAt === null ? null : new Date(plan.durable.expiresAt),
      storageBucket: plan.durable.storageBucket, storageKey: plan.durable.storageKey,
    }))
  }

  private async publishPreparationObjects(fence: PreparationFence, preparationId: string,
    intent: WorkspacePreparationIntent, plans: PlannedObject[], descriptors: WorkspacePreparationObjectDescriptor[],
    coordinator: NonNullable<WorkspaceSnapshotPublisherOptions['durablePreparation']>): Promise<void> {
    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index]!; const descriptor = descriptors[index]!
      await this.state.withObjectLocationLock(descriptor.storageBucket, descriptor.storageKey, async client => {
        const existing = await coordinator.preparations.lockObjectForPublication(
          fence, preparationId, intent, descriptor, client)
        if (existing) return
        const storedId = await this.objects.put(plan.bytes)
        if (storedId !== plan.physicalObjectId) throw new Error('object store returned a non-content-addressed identifier')
        const location = this.objects.location(storedId)
        if (location.storageBucket !== descriptor.storageBucket || location.storageKey !== descriptor.storageKey) {
          throw new Error('object store location changed during publication')
        }
        verifyRegisteredObject(await this.state.registerObject(plan.durable, client), plan.durable)
        const allocation = await coordinator.journal.recordAllocation(fence, fence.generation, fence.workerId, {
          kind: 'object', resourceId: plan.durable.objectId,
          metadata: { preparationId, purpose: descriptor.purpose },
        }, client)
        await coordinator.preparations.associateObject({ ...fence, preparationId,
          allocationId: allocation.allocationId, objectId: descriptor.objectId, purpose: descriptor.purpose }, client)
      })
    }
  }

  private async resumePreparationCleanup(fence: PreparationFence, preparationId: string,
    coordinator: NonNullable<WorkspaceSnapshotPublisherOptions['durablePreparation']>): Promise<never> {
    const limit = coordinator.cleanupBatchSize ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new ServiceError(503, 'workspace snapshot cleanup pending')
    }
    await coordinator.reclaimer.reclaimPreparationObjects(fence, preparationId, limit)
    throw new ServiceError(503, 'workspace snapshot cleanup pending')
  }

  private async cleanup(tenantId: string, plans: PlannedObject[]): Promise<void> {
    let failed = false
    for (const plan of [...plans].reverse()) {
      try {
        await this.options.reclaimer.reclaimUnreferencedWorkspaceObject(
          tenantId, plan.durable.objectId, plan.physicalObjectId)
      } catch { failed = true }
    }
    if (failed) throw new ServiceError(503, 'workspace snapshot cleanup pending')
  }
}
