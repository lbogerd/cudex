import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { IDatabaseConnection } from '@pgtyped/runtime'
import { getWorkspacePreparation, getWorkspacePreparationForOperation, getWorkspacePreparationObject,
  hasOutstandingWorkspaceAllocations, insertWorkspacePreparation, insertWorkspacePreparationObject,
  listWorkspacePreparationAllocationIds, lockWorkspacePreparation, lockWorkspacePreparationObject,
  lockWorkspacePreparationObjects, markWorkspacePreparationCommitted, markWorkspacePreparationPrepared,
  markWorkspacePreparationReclaimed, markWorkspacePreparationReclaimPending,
  ownsWorkspacePreparationOperation } from './db/queries/workspace.queries.js'
import { begin, commit, rollbackQuietly } from './db/primitives.js'
import { canonicalJson } from './workspace-manifest.js'
import { OperationOwnershipError, type OperationIdentity } from './postgres-store.js'

const checksumPattern = /^sha256:[0-9a-f]{64}$/u
const purposes = new Set<WorkspacePreparationObjectPurpose>(['workspace_archive', 'manifest', 'content_blob'])
const intentKeys = [
  'tenantId', 'leaseId', 'environmentId', 'agentId', 'ownerAgentId', 'ownerLeaseId',
  'sourceSnapshotId', 'expectedSourceChecksum', 'restoreSourceLeaseId', 'restoreSourceSnapshotId',
  'expectedLatestSnapshotId', 'providerSandboxId', 'sandboxTemplate',
  'cwdUri', 'workspaceRootUris', 'toolPolicy', 'policyVersion', 'snapshotId',
  'providerSnapshotId', 'snapshotExpiresAt', 'archiveChecksum', 'manifestChecksum',
] as const
const maximumIntentBytes = 64 * 1024
const descriptorKeys = [
  'objectId', 'purpose', 'checksum', 'sizeBytes', 'expiresAt', 'storageBucket', 'storageKey',
] as const

export type WorkspacePreparationState =
  'publishing' | 'prepared' | 'committed' | 'reclaim_pending' | 'reclaimed'
export type WorkspacePreparationObjectPurpose = 'workspace_archive' | 'manifest' | 'content_blob'

/** Canonical, secret-free lineage bound before any workspace object is published. */
export interface WorkspacePreparationIntent {
  tenantId: string
  leaseId: string
  environmentId: string
  agentId: string
  ownerAgentId: string | null
  ownerLeaseId: string | null
  sourceSnapshotId: string | null
  expectedSourceChecksum: string | null
  restoreSourceLeaseId: string | null
  restoreSourceSnapshotId: string | null
  expectedLatestSnapshotId: string | null
  providerSandboxId: string
  sandboxTemplate: string
  cwdUri: string
  workspaceRootUris: string[]
  toolPolicy: Record<string, unknown>
  policyVersion: number
  snapshotId: string
  providerSnapshotId: string | null
  snapshotExpiresAt: string | null
  archiveChecksum: string
  manifestChecksum: string
}

export interface WorkspacePreparation {
  preparationId: string
  operation: string
  idempotencyKey: string
  tenantId: string
  createdGeneration: number
  intentHash: string
  intent: WorkspacePreparationIntent
  leaseId: string
  snapshotId: string
  sourceSnapshotId: string | null
  expectedObjectCount: number
  associatedObjectCount: number
  state: WorkspacePreparationState
  createdAt: Date
  updatedAt: Date
  committedAt: Date | null
  reclaimedAt: Date | null
}

export interface WorkspacePreparationObjectDescriptor {
  objectId: string
  purpose: WorkspacePreparationObjectPurpose
  checksum: string
  sizeBytes: number
  expiresAt: Date | null
  storageBucket: string
  storageKey: string
}

export interface WorkspacePreparationObject extends WorkspacePreparationObjectDescriptor {
  preparationId: string
  tenantId: string
  allocationId: string
}

export class WorkspacePreparationConflictError extends Error {}

interface PreparationRow {
  preparation_id: string
  operation: string
  idempotency_key: string
  tenant_id: string
  created_generation: string
  intent_hash: string
  intent: WorkspacePreparationIntent
  lease_id: string
  snapshot_id: string
  source_snapshot_id: string | null
  expected_object_count: number
  associated_object_count: string
  state: WorkspacePreparationState
  created_at: Date
  updated_at: Date
  committed_at: Date | null
  reclaimed_at: Date | null
}

interface ObjectRow {
  preparation_id: string
  tenant_id: string
  allocation_id: string
  object_id: string
  purpose: WorkspacePreparationObjectPurpose
  object_checksum: string
  object_size_bytes: string
  object_expires_at: Date | null
  storage_bucket: string
  storage_key: string
  object_kind: WorkspacePreparationObjectPurpose
  object_state: string
  allocation_state: string
}

export interface PreparationFence extends OperationIdentity {
  generation: number
  workerId: string
}

export interface LockedWorkspacePreparation {
  preparation: WorkspacePreparation
  objects: WorkspacePreparationObject[]
}

function id(label: string, value: string, maximum = 512): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

function nullableId(label: string, value: string | null): string | null {
  return value === null ? null : id(label, value)
}

function checksum(label: string, value: string): string {
  if (!checksumPattern.test(value)) throw new Error(`invalid ${label}`)
  return value
}

function allocationId(value: string): string {
  if (!/^[1-9][0-9]{0,18}$/u.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new Error('invalid allocation ID')
  }
  return value
}

function exactRecord(label: string, value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`invalid ${label}`)
  }
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some(key => typeof key !== 'string')) throw new Error(`invalid ${label}`)
  const actual = (ownKeys as string[]).sort(); const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`invalid ${label}`)
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error(`invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function validateToolPolicy(value: unknown): Record<string, unknown> {
  const policy = exactRecord('tool policy', value, ['allowedDomains', 'allowedTools'])
  if (!Array.isArray(policy.allowedDomains) || policy.allowedDomains.length > 8
    || policy.allowedDomains.some(domain => typeof domain !== 'string')) throw new Error('invalid tool policy')
  for (const domain of policy.allowedDomains as string[]) id('tool domain', domain, 128)
  if (!Array.isArray(policy.allowedTools) || policy.allowedTools.length > 256) throw new Error('invalid tool policy')
  for (const item of policy.allowedTools) {
    const tool = exactRecord('tool policy', item, ['name', 'namespace'])
    if (typeof tool.name !== 'string' || (tool.namespace !== null && typeof tool.namespace !== 'string')) {
      throw new Error('invalid tool policy')
    }
    id('tool name', tool.name, 512)
    if (tool.namespace !== null) id('tool namespace', tool.namespace as string, 512)
  }
  return structuredClone(policy)
}

function validateFence(fence: PreparationFence): void {
  id('operation', fence.operation, 128); id('idempotency key', fence.idempotencyKey)
  id('tenant ID', fence.tenantId); id('worker ID', fence.workerId)
  if (!Number.isSafeInteger(fence.generation) || fence.generation < 0) throw new Error('invalid operation generation')
}

function validateIntent(value: WorkspacePreparationIntent): WorkspacePreparationIntent {
  exactRecord('workspace preparation intent', value, intentKeys)
  id('tenant ID', value.tenantId); id('lease ID', value.leaseId); id('environment ID', value.environmentId)
  id('agent ID', value.agentId); nullableId('owner agent ID', value.ownerAgentId)
  nullableId('owner lease ID', value.ownerLeaseId); nullableId('source snapshot ID', value.sourceSnapshotId)
  nullableId('restore source lease ID', value.restoreSourceLeaseId)
  nullableId('restore source snapshot ID', value.restoreSourceSnapshotId)
  nullableId('expected latest snapshot ID', value.expectedLatestSnapshotId)
  id('provider sandbox ID', value.providerSandboxId); id('sandbox template', value.sandboxTemplate)
  id('cwd URI', value.cwdUri, 2048); id('snapshot ID', value.snapshotId)
  nullableId('provider snapshot ID', value.providerSnapshotId)
  if (!value.cwdUri.startsWith('file:///')) throw new Error('invalid cwd URI')
  if (value.ownerLeaseId !== null && value.ownerAgentId === null) throw new Error('owner lease requires owner agent')
  if ((value.sourceSnapshotId === null) !== (value.expectedSourceChecksum === null)) {
    throw new Error('source snapshot and checksum must be paired')
  }
  if ((value.restoreSourceLeaseId === null) !== (value.restoreSourceSnapshotId === null)) {
    throw new Error('restore source lease and snapshot must be paired')
  }
  const modes = Number(value.sourceSnapshotId !== null)
    + Number(value.restoreSourceLeaseId !== null) + Number(value.expectedLatestSnapshotId !== null)
  if (modes !== 1) throw new Error('workspace preparation requires exactly one source mode')
  if (value.expectedSourceChecksum !== null) checksum('source checksum', value.expectedSourceChecksum)
  checksum('archive checksum', value.archiveChecksum)
  if (!Array.isArray(value.workspaceRootUris) || value.workspaceRootUris.length < 1 || value.workspaceRootUris.length > 64) {
    throw new Error('invalid workspace roots')
  }
  for (const root of value.workspaceRootUris) {
    id('workspace root URI', root, 2048)
    if (!root.startsWith('file:///')) throw new Error('invalid workspace root URI')
  }
  validateToolPolicy(value.toolPolicy)
  if (!Number.isSafeInteger(value.policyVersion) || value.policyVersion < 1) throw new Error('invalid policy version')
  if (value.snapshotExpiresAt !== null) {
    const expiresAt = new Date(value.snapshotExpiresAt)
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== value.snapshotExpiresAt) {
      throw new Error('invalid snapshot expiry')
    }
  }
  checksum('manifest checksum', value.manifestChecksum)
  const encoded = canonicalJson(value)
  if (Buffer.byteLength(encoded, 'utf8') > maximumIntentBytes) throw new Error('workspace preparation intent is too large')
  return JSON.parse(encoded) as WorkspacePreparationIntent
}

export function canonicalWorkspacePreparationIntent(intent: WorkspacePreparationIntent): {
  intent: WorkspacePreparationIntent; canonicalJson: string; hash: string
} {
  const validated = validateIntent(intent)
  const encoded = canonicalJson(validated)
  return {
    intent: validated,
    canonicalJson: encoded,
    hash: `sha256:${createHash('sha256').update(encoded).digest('hex')}`,
  }
}

function deterministicId(domain: string, values: string[]): string {
  const hash = createHash('sha256').update(domain)
  for (const value of values) hash.update('\0').update(value)
  return hash.digest('hex')
}

export function workspacePreparationId(identity: OperationIdentity): string {
  id('operation', identity.operation, 128)
  id('idempotency key', identity.idempotencyKey)
  id('tenant ID', identity.tenantId)
  return `workspace_preparation_${deterministicId('cudex:workspace-preparation:v1', [
    identity.operation, identity.idempotencyKey, identity.tenantId,
  ])}`
}

export function workspacePreparationObjectId(preparationId: string,
  purpose: WorkspacePreparationObjectPurpose, objectChecksum: string): string {
  id('preparation ID', preparationId)
  if (!purposes.has(purpose)) throw new Error('invalid workspace object purpose')
  checksum('object checksum', objectChecksum)
  return `workspace_object_${deterministicId('cudex:workspace-preparation-object:v1', [
    preparationId, purpose, objectChecksum,
  ])}`
}

function validateDescriptor(value: WorkspacePreparationObjectDescriptor): WorkspacePreparationObjectDescriptor {
  exactRecord('workspace preparation object descriptor', value, descriptorKeys)
  id('object ID', value.objectId)
  if (!purposes.has(value.purpose)) throw new Error('invalid workspace object purpose')
  checksum('object checksum', value.checksum)
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) throw new Error('invalid object size')
  if (value.expiresAt !== null
    && (!(value.expiresAt instanceof Date) || !Number.isFinite(value.expiresAt.getTime()))) {
    throw new Error('invalid object expiry')
  }
  id('storage bucket', value.storageBucket)
  id('storage key', value.storageKey, 2048)
  return { ...value, expiresAt: value.expiresAt === null ? null : new Date(value.expiresAt) }
}

function preparationFromRow(row: PreparationRow): WorkspacePreparation {
  return {
    preparationId: row.preparation_id, operation: row.operation, idempotencyKey: row.idempotency_key,
    tenantId: row.tenant_id, createdGeneration: Number(row.created_generation), intentHash: row.intent_hash,
    intent: structuredClone(row.intent), leaseId: row.lease_id, snapshotId: row.snapshot_id,
    sourceSnapshotId: row.source_snapshot_id, expectedObjectCount: row.expected_object_count,
    associatedObjectCount: Number(row.associated_object_count), state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at, committedAt: row.committed_at,
    reclaimedAt: row.reclaimed_at,
  }
}

function objectFromRow(row: ObjectRow): WorkspacePreparationObject {
  return { preparationId: row.preparation_id, tenantId: row.tenant_id,
    allocationId: row.allocation_id, objectId: row.object_id, purpose: row.purpose,
    checksum: row.object_checksum, sizeBytes: Number(row.object_size_bytes),
    expiresAt: row.object_expires_at, storageBucket: row.storage_bucket, storageKey: row.storage_key }
}

const preparationColumns = `
  preparation.preparation_id, preparation.operation, preparation.idempotency_key,
  preparation.tenant_id, preparation.created_generation::text, preparation.intent_hash,
  preparation.intent, preparation.lease_id, preparation.snapshot_id, preparation.source_snapshot_id,
  preparation.expected_object_count, preparation.state, preparation.created_at, preparation.updated_at,
  preparation.committed_at, preparation.reclaimed_at,
  (SELECT count(*)::text FROM hosted_agent_workspace_preparation_objects AS associated
    WHERE associated.preparation_id = preparation.preparation_id) AS associated_object_count
`

export class PostgresWorkspacePreparations {
  constructor(private readonly pool: Pool) {}

  async getForOperation(identity: OperationIdentity,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<WorkspacePreparation | null> {
    id('operation', identity.operation, 128)
    id('idempotency key', identity.idempotencyKey)
    id('tenant ID', identity.tenantId)
    const [row] = await getWorkspacePreparationForOperation.run(identity, executor as IDatabaseConnection)
    if (!row) return null
    const preparation = preparationFromRow(row as unknown as PreparationRow)
    const canonical = canonicalWorkspacePreparationIntent(preparation.intent)
    if (preparation.preparationId !== workspacePreparationId(identity)
      || preparation.intentHash !== canonical.hash) {
      throw new WorkspacePreparationConflictError('workspace preparation identity mismatch')
    }
    return preparation
  }

  async createOrReplay(input: PreparationFence & {
    preparationId: string; intent: WorkspacePreparationIntent; expectedObjectCount: number
  }, executor?: PoolClient): Promise<WorkspacePreparation> {
    validateFence(input); id('preparation ID', input.preparationId)
    if (!Number.isSafeInteger(input.expectedObjectCount) || input.expectedObjectCount < 2
      || input.expectedObjectCount > 100_002) throw new Error('invalid expected object count')
    const canonical = canonicalWorkspacePreparationIntent(input.intent)
    if (canonical.intent.tenantId !== input.tenantId) throw new WorkspacePreparationConflictError('intent tenant mismatch')
    const create = async (client: PoolClient): Promise<WorkspacePreparation> => {
      await this.requireOwnership(client, input)
      await insertWorkspacePreparation.run({ ...input, intentHash: canonical.hash,
        intent: canonical.canonicalJson, leaseId: canonical.intent.leaseId,
        snapshotId: canonical.intent.snapshotId, sourceSnapshotId: canonical.intent.sourceSnapshotId }, client as IDatabaseConnection)
      const row = await this.selectPreparation(client, input.preparationId, true)
      if (!row || row.operation !== input.operation || row.idempotencyKey !== input.idempotencyKey
        || row.tenantId !== input.tenantId || row.intentHash !== canonical.hash
        || canonicalJson(row.intent) !== canonical.canonicalJson
        || row.expectedObjectCount !== input.expectedObjectCount) {
        throw new WorkspacePreparationConflictError('workspace preparation identity mismatch')
      }
      return row
    }
    return executor ? create(executor) : this.transaction(create)
  }

  async associateObject(input: PreparationFence & {
    preparationId: string; allocationId: string; objectId: string; purpose: WorkspacePreparationObjectPurpose
  }, executor?: PoolClient): Promise<WorkspacePreparationObject> {
    validateFence(input); id('preparation ID', input.preparationId); id('object ID', input.objectId)
    allocationId(input.allocationId)
    if (!purposes.has(input.purpose)) throw new Error('invalid workspace object purpose')
    const associate = async (client: PoolClient) => {
      await this.requireOwnership(client, input)
      const preparation = await this.selectPreparation(client, input.preparationId, true)
      if (!preparation || preparation.operation !== input.operation || preparation.idempotencyKey !== input.idempotencyKey
        || preparation.tenantId !== input.tenantId || preparation.state !== 'publishing') {
        throw new WorkspacePreparationConflictError('workspace preparation is not publishing')
      }
      await insertWorkspacePreparationObject.run(input, client as IDatabaseConnection)
      const [value] = await getWorkspacePreparationObject.run(input, client as IDatabaseConnection)
      const row = value as ObjectRow | undefined
      if (!row || row.tenant_id !== input.tenantId || row.object_id !== input.objectId || row.purpose !== input.purpose) {
        throw new WorkspacePreparationConflictError('workspace preparation object mismatch')
      }
      return objectFromRow(row)
    }
    return executor ? associate(executor) : this.transaction(associate)
  }

  async lockObjectForPublication(fence: PreparationFence, preparationId: string,
    intent: WorkspacePreparationIntent, descriptor: WorkspacePreparationObjectDescriptor,
    executor: PoolClient): Promise<WorkspacePreparationObject | null> {
    validateFence(fence); id('preparation ID', preparationId)
    const canonical = canonicalWorkspacePreparationIntent(intent)
    const expected = validateDescriptor(descriptor)
    await this.requireOwnership(executor, fence)
    const preparation = await this.selectPreparation(executor, preparationId, true)
    this.assertExact(preparation, fence, canonical.hash, canonical.canonicalJson, 'publishing')
    const [value] = await lockWorkspacePreparationObject.run({ preparationId,
      objectId: expected.objectId }, executor as IDatabaseConnection)
    const row = value as ObjectRow | undefined
    if (!row) return null
    this.assertObjectRow(row, expected, new Set(['allocated']))
    return objectFromRow(row)
  }

  async markPrepared(fence: PreparationFence, preparationId: string, intent: WorkspacePreparationIntent,
    descriptors: WorkspacePreparationObjectDescriptor[], executor?: PoolClient): Promise<WorkspacePreparation> {
    validateFence(fence); id('preparation ID', preparationId)
    const canonical = canonicalWorkspacePreparationIntent(intent)
    if (!Array.isArray(descriptors)) throw new Error('invalid workspace preparation object descriptors')
    const expected = descriptors.map(validateDescriptor)
    if (new Set(expected.map(descriptor => descriptor.objectId)).size !== expected.length) {
      throw new Error('duplicate workspace preparation object descriptor')
    }
    const mark = async (client: PoolClient) => {
      await this.requireOwnership(client, fence)
      const preparation = await this.selectPreparation(client, preparationId, true)
      if (!preparation || !['publishing', 'prepared', 'committed'].includes(preparation.state)) {
        throw new WorkspacePreparationConflictError('workspace preparation cannot become prepared')
      }
      this.assertExactIdentity(preparation, fence, canonical.hash, canonical.canonicalJson)
      const allocationStates = preparation.state === 'committed'
        ? new Set(['allocated', 'adopted']) : new Set(['allocated'])
      const objects = await this.lockObjects(client, preparationId, allocationStates)
      this.assertExactObjects(preparation, objects, expected)
      if (preparation.state === 'publishing') {
        await markWorkspacePreparationPrepared.run({ preparationId }, client as IDatabaseConnection)
      }
      return (await this.selectPreparation(client, preparationId, false))!
    }
    return executor ? mark(executor) : this.transaction(mark)
  }

  async lockForCommit(fence: PreparationFence, preparationId: string, intent: WorkspacePreparationIntent,
    executor: PoolClient): Promise<LockedWorkspacePreparation> {
    validateFence(fence); id('preparation ID', preparationId)
    const canonical = canonicalWorkspacePreparationIntent(intent)
    await this.requireOwnership(executor, fence)
    const preparation = await this.selectPreparation(executor, preparationId, true)
    this.assertExact(preparation, fence, canonical.hash, canonical.canonicalJson, 'prepared')
    const objects = await this.lockObjects(executor, preparationId, new Set(['allocated']))
    this.assertCompleteObjects(preparation!, objects)
    return { preparation: preparation!, objects }
  }

  async markCommitted(fence: PreparationFence, preparationId: string, intent: WorkspacePreparationIntent,
    executor: PoolClient): Promise<WorkspacePreparation> {
    validateFence(fence); id('preparation ID', preparationId)
    const canonical = canonicalWorkspacePreparationIntent(intent)
    await this.requireOwnership(executor, fence)
    const preparation = await this.selectPreparation(executor, preparationId, true)
    if (preparation?.state === 'committed') {
      this.assertExactIdentity(preparation, fence, canonical.hash, canonical.canonicalJson)
      return preparation
    }
    this.assertExact(preparation, fence, canonical.hash, canonical.canonicalJson, 'prepared')
    const objects = await this.lockObjects(executor, preparationId, new Set(['allocated']))
    this.assertCompleteObjects(preparation!, objects)
    const result = await markWorkspacePreparationCommitted.runWithCounts({ preparationId }, executor as IDatabaseConnection)
    if (result.rowCount !== 1) throw new WorkspacePreparationConflictError('workspace preparation commit lost')
    return (await this.selectPreparation(executor, preparationId, false))!
  }

  async beginAbort(fence: PreparationFence, preparationId: string,
    executor?: PoolClient): Promise<WorkspacePreparation> {
    validateFence(fence); id('preparation ID', preparationId)
    const abort = async (client: PoolClient) => {
      await this.requireOwnership(client, fence)
      const preparation = await this.selectPreparation(client, preparationId, true)
      if (!preparation || preparation.operation !== fence.operation || preparation.idempotencyKey !== fence.idempotencyKey
        || preparation.tenantId !== fence.tenantId) throw new WorkspacePreparationConflictError('workspace preparation mismatch')
      if (preparation.state === 'committed' || preparation.state === 'reclaimed') return preparation
      if (!['publishing', 'prepared', 'reclaim_pending'].includes(preparation.state)) {
        throw new WorkspacePreparationConflictError('workspace preparation cannot be aborted')
      }
      if (preparation.state !== 'reclaim_pending') {
        await markWorkspacePreparationReclaimPending.run({ preparationId }, client as IDatabaseConnection)
      }
      return (await this.selectPreparation(client, preparationId, false))!
    }
    return executor ? abort(executor) : this.transaction(abort)
  }

  async markReclaimed(fence: PreparationFence, preparationId: string,
    executor: PoolClient): Promise<WorkspacePreparation> {
    validateFence(fence); id('preparation ID', preparationId)
    await this.requireOwnership(executor, fence)
    const preparation = await this.selectPreparation(executor, preparationId, true)
    if (preparation?.state === 'reclaimed') {
      this.assertFenceIdentity(preparation, fence)
      return preparation
    }
    if (!preparation || preparation.operation !== fence.operation || preparation.idempotencyKey !== fence.idempotencyKey
      || preparation.tenantId !== fence.tenantId || preparation.state !== 'reclaim_pending') {
      throw new WorkspacePreparationConflictError('workspace preparation cannot be reclaimed')
    }
    const outstanding = await hasOutstandingWorkspaceAllocations.run({ preparationId }, executor as IDatabaseConnection)
    if (outstanding.length !== 0) throw new WorkspacePreparationConflictError('workspace allocations remain unreclaimed')
    await markWorkspacePreparationReclaimed.run({ preparationId }, executor as IDatabaseConnection)
    return (await this.selectPreparation(executor, preparationId, false))!
  }

  private async requireOwnership(client: Pick<PoolClient, 'query'>, fence: PreparationFence): Promise<void> {
    const rows = await ownsWorkspacePreparationOperation.run(fence, client as IDatabaseConnection)
    if (rows.length !== 1) throw new OperationOwnershipError()
  }

  private async selectPreparation(client: Pick<PoolClient, 'query'>, preparationId: string,
    lock: boolean): Promise<WorkspacePreparation | null> {
    const [row] = await (lock ? lockWorkspacePreparation : getWorkspacePreparation).run(
      { preparationId }, client as IDatabaseConnection)
    return row ? preparationFromRow(row as unknown as PreparationRow) : null
  }

  /** Read-only recovery identity for every object allocation associated with one preparation. */
  async listObjectAllocationIdsForReconciliation(identity: OperationIdentity,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<string[]> {
    id('operation', identity.operation, 128)
    id('idempotency key', identity.idempotencyKey)
    id('tenant ID', identity.tenantId)
    const rows = await listWorkspacePreparationAllocationIds.run(identity, executor as IDatabaseConnection)
    return rows.map(row => allocationId(row.allocation_id!))
  }

  private assertExact(preparation: WorkspacePreparation | null, fence: PreparationFence,
    intentHash: string, encodedIntent: string, expectedState: WorkspacePreparationState): void {
    if (!preparation || preparation.state !== expectedState) {
      throw new WorkspacePreparationConflictError('workspace preparation mismatch')
    }
    this.assertExactIdentity(preparation, fence, intentHash, encodedIntent)
  }

  private assertFenceIdentity(preparation: WorkspacePreparation, fence: PreparationFence): void {
    if (preparation.operation !== fence.operation || preparation.idempotencyKey !== fence.idempotencyKey
      || preparation.tenantId !== fence.tenantId) throw new WorkspacePreparationConflictError('workspace preparation mismatch')
  }

  private assertExactIdentity(preparation: WorkspacePreparation, fence: PreparationFence,
    intentHash: string, encodedIntent: string): void {
    this.assertFenceIdentity(preparation, fence)
    if (preparation.intentHash !== intentHash || canonicalJson(preparation.intent) !== encodedIntent) {
      throw new WorkspacePreparationConflictError('workspace preparation mismatch')
    }
  }

  private assertCompleteObjects(preparation: WorkspacePreparation, objects: WorkspacePreparationObject[]): void {
    if (objects.length !== preparation.expectedObjectCount
      || objects.filter(object => object.purpose === 'workspace_archive').length !== 1
      || objects.filter(object => object.purpose === 'manifest').length !== 1) {
      throw new WorkspacePreparationConflictError('workspace preparation object count changed')
    }
  }

  private assertObjectRow(row: ObjectRow, expected: WorkspacePreparationObjectDescriptor,
    allocationStates: ReadonlySet<string>): void {
    const expiresAt = row.object_expires_at?.getTime() ?? null
    const expectedExpiresAt = expected.expiresAt?.getTime() ?? null
    if (row.object_id !== expected.objectId || row.purpose !== expected.purpose
      || row.object_kind !== expected.purpose || row.object_checksum !== expected.checksum
      || Number(row.object_size_bytes) !== expected.sizeBytes || expiresAt !== expectedExpiresAt
      || row.storage_bucket !== expected.storageBucket || row.storage_key !== expected.storageKey
      || row.object_state !== 'available' || !allocationStates.has(row.allocation_state)) {
      throw new WorkspacePreparationConflictError('workspace preparation object mismatch')
    }
  }

  private assertExactObjects(preparation: WorkspacePreparation, objects: WorkspacePreparationObject[],
    expected: WorkspacePreparationObjectDescriptor[]): void {
    if (expected.length !== preparation.expectedObjectCount || objects.length !== expected.length
      || expected.filter(object => object.purpose === 'workspace_archive').length !== 1
      || expected.filter(object => object.purpose === 'manifest').length !== 1) {
      throw new WorkspacePreparationConflictError('workspace preparation object set is incomplete')
    }
    const actualById = new Map(objects.map(object => [object.objectId, object]))
    for (const descriptor of expected) {
      const actual = actualById.get(descriptor.objectId)
      if (!actual || actual.purpose !== descriptor.purpose || actual.checksum !== descriptor.checksum
        || actual.sizeBytes !== descriptor.sizeBytes
        || (actual.expiresAt?.getTime() ?? null) !== (descriptor.expiresAt?.getTime() ?? null)
        || actual.storageBucket !== descriptor.storageBucket || actual.storageKey !== descriptor.storageKey) {
        throw new WorkspacePreparationConflictError('workspace preparation object set mismatch')
      }
    }
    const archive = expected.find(object => object.purpose === 'workspace_archive')!
    const manifest = expected.find(object => object.purpose === 'manifest')!
    if (archive.checksum !== preparation.intent.archiveChecksum
      || manifest.checksum !== preparation.intent.manifestChecksum) {
      throw new WorkspacePreparationConflictError('workspace preparation object checksum mismatch')
    }
  }

  private async lockObjects(client: PoolClient, preparationId: string,
    allocationStates: ReadonlySet<string>): Promise<WorkspacePreparationObject[]> {
    const result = await lockWorkspacePreparationObjects.run({ preparationId }, client as IDatabaseConnection)
    const rows = result as ObjectRow[]
    for (const row of rows) {
      this.assertObjectRow(row, {
        objectId: row.object_id, purpose: row.purpose, checksum: row.object_checksum,
        sizeBytes: Number(row.object_size_bytes), expiresAt: row.object_expires_at,
        storageBucket: row.storage_bucket, storageKey: row.storage_key,
      }, allocationStates)
    }
    const objects = rows.map(objectFromRow)
    const archive = rows.find(row => row.purpose === 'workspace_archive')
    const manifest = rows.find(row => row.purpose === 'manifest')
    const preparation = await this.selectPreparation(client, preparationId, false)
    if (preparation && ((archive && archive.object_checksum !== preparation.intent.archiveChecksum)
      || (manifest && manifest.object_checksum !== preparation.intent.manifestChecksum))) {
      throw new WorkspacePreparationConflictError('workspace preparation object checksum changed')
    }
    return objects
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await begin(client)
      const value = await fn(client)
      await commit(client)
      return value
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    } finally { client.release() }
  }
}
