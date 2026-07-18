import { createHash } from 'node:crypto'
import {
  captureArchiveManifest,
  defaultArchiveManifestLimits,
  type ArchiveManifestLimits,
  type CapturedArchiveManifest,
} from './archive-manifest.js'
import type { ObjectStore } from './blob-store.js'
import type {
  CreateLeaseInput,
  Lease,
  PostgresDurableState,
  Snapshot,
  SnapshotInput,
  StoredObject,
} from './postgres-state.js'
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
}

type DurableWorkspaceState = Pick<PostgresDurableState,
  'registerObject' | 'createLeaseWithBaseSnapshot' | 'appendCheckpoint'>

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

  private async prepare(tenantId: string, input: WorkspaceSnapshotArchiveInput): Promise<{
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
            objectId: logicalObjectId(tenantId, snapshotId, kind, objectChecksum), tenantId, kind,
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
      const storedId = await this.objects.put(plan.bytes)
      published.push(plan)
      if (storedId !== plan.physicalObjectId) throw new Error('object store returned a non-content-addressed identifier')
      const location = this.objects.location(storedId)
      plan.durable.storageBucket = opaque('storage bucket', location.storageBucket)
      plan.durable.storageKey = opaque('storage key', location.storageKey, 2048)
      verifyRegisteredObject(await this.state.registerObject(plan.durable), plan.durable)
    }
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
