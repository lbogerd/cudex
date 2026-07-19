import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
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
    const result = await executor.query<PreparationRow>(`
      SELECT ${preparationColumns}
      FROM hosted_agent_workspace_preparations AS preparation
      WHERE preparation.operation = $1 AND preparation.idempotency_key = $2
        AND preparation.tenant_id = $3
    `, [identity.operation, identity.idempotencyKey, identity.tenantId])
    if (!result.rows[0]) return null
    const preparation = preparationFromRow(result.rows[0])
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
      await client.query(`
        INSERT INTO hosted_agent_workspace_preparations
          (preparation_id, operation, idempotency_key, tenant_id, created_generation,
           intent_hash, intent, lease_id, snapshot_id, source_snapshot_id, expected_object_count, state)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, 'publishing')
        ON CONFLICT DO NOTHING
      `, [input.preparationId, input.operation, input.idempotencyKey, input.tenantId, input.generation,
        canonical.hash, canonical.canonicalJson, canonical.intent.leaseId, canonical.intent.snapshotId,
        canonical.intent.sourceSnapshotId, input.expectedObjectCount])
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
      await client.query(`
        INSERT INTO hosted_agent_workspace_preparation_objects
          (preparation_id, operation, idempotency_key, tenant_id, allocation_id, object_id, purpose)
        SELECT $1, $6, $7, $2, allocation.allocation_id, object_row.object_id, $5
        FROM hosted_agent_operation_allocations AS allocation
        JOIN hosted_agent_objects AS object_row
          ON object_row.object_id = $4 AND object_row.tenant_id = $2 AND object_row.state = 'available'
         AND object_row.kind = $5
        WHERE allocation.allocation_id = $3::bigint AND allocation.operation = $6
          AND allocation.idempotency_key = $7 AND allocation.tenant_id = $2
          AND allocation.allocation_kind = 'object' AND allocation.resource_id = $4
          AND allocation.state = 'allocated'
        ON CONFLICT DO NOTHING
      `, [input.preparationId, input.tenantId, input.allocationId, input.objectId, input.purpose,
        input.operation, input.idempotencyKey])
      const result = await client.query<ObjectRow>(`
        SELECT prepared_object.preparation_id, prepared_object.tenant_id,
               prepared_object.allocation_id::text, prepared_object.object_id, prepared_object.purpose,
               object_row.checksum AS object_checksum, object_row.size_bytes::text AS object_size_bytes,
               object_row.expires_at AS object_expires_at, object_row.storage_bucket, object_row.storage_key,
               object_row.kind AS object_kind, object_row.state AS object_state,
               allocation.state AS allocation_state
        FROM hosted_agent_workspace_preparation_objects AS prepared_object
        JOIN hosted_agent_operation_allocations AS allocation
          ON allocation.allocation_id = prepared_object.allocation_id
        JOIN hosted_agent_objects AS object_row
          ON object_row.object_id = prepared_object.object_id
         AND object_row.tenant_id = prepared_object.tenant_id
        WHERE prepared_object.preparation_id = $1 AND prepared_object.allocation_id = $2::bigint
      `, [input.preparationId, input.allocationId])
      const row = result.rows[0]
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
    const result = await executor.query<ObjectRow>(`
      SELECT prepared_object.preparation_id, prepared_object.tenant_id,
             prepared_object.allocation_id::text, prepared_object.object_id, prepared_object.purpose,
             object_row.checksum AS object_checksum, object_row.size_bytes::text AS object_size_bytes,
             object_row.expires_at AS object_expires_at, object_row.storage_bucket, object_row.storage_key,
             object_row.kind AS object_kind, object_row.state AS object_state,
             allocation.state AS allocation_state
      FROM hosted_agent_workspace_preparation_objects AS prepared_object
      JOIN hosted_agent_operation_allocations AS allocation
        ON allocation.allocation_id = prepared_object.allocation_id
       AND allocation.tenant_id = prepared_object.tenant_id
      JOIN hosted_agent_objects AS object_row
        ON object_row.object_id = prepared_object.object_id
       AND object_row.tenant_id = prepared_object.tenant_id
      WHERE prepared_object.preparation_id = $1 AND prepared_object.object_id = $2
      FOR UPDATE OF prepared_object, allocation, object_row
    `, [preparationId, expected.objectId])
    const row = result.rows[0]
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
        await client.query(`UPDATE hosted_agent_workspace_preparations SET state = 'prepared' WHERE preparation_id = $1`,
          [preparationId])
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
    const result = await executor.query(`
      UPDATE hosted_agent_workspace_preparations
      SET state = 'committed', committed_at = now(), reclaimed_at = NULL
      WHERE preparation_id = $1 AND state = 'prepared'
    `, [preparationId])
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
        await client.query(`UPDATE hosted_agent_workspace_preparations SET state = 'reclaim_pending'
          WHERE preparation_id = $1`, [preparationId])
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
    const outstanding = await executor.query(`
      SELECT 1 FROM hosted_agent_workspace_preparation_objects AS prepared_object
      JOIN hosted_agent_operation_allocations AS allocation
        ON allocation.allocation_id = prepared_object.allocation_id
      WHERE prepared_object.preparation_id = $1 AND allocation.state <> 'reclaimed' LIMIT 1
    `, [preparationId])
    if (outstanding.rowCount !== 0) throw new WorkspacePreparationConflictError('workspace allocations remain unreclaimed')
    await executor.query(`UPDATE hosted_agent_workspace_preparations
      SET state = 'reclaimed', reclaimed_at = now(), committed_at = NULL WHERE preparation_id = $1`, [preparationId])
    return (await this.selectPreparation(executor, preparationId, false))!
  }

  private async requireOwnership(client: Pick<PoolClient, 'query'>, fence: PreparationFence): Promise<void> {
    const result = await client.query(`
      SELECT 1 FROM hosted_agent_operations
      WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
        AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
      FOR UPDATE
    `, [fence.operation, fence.idempotencyKey, fence.tenantId, fence.generation, fence.workerId])
    if (result.rowCount !== 1) throw new OperationOwnershipError()
  }

  private async selectPreparation(client: Pick<PoolClient, 'query'>, preparationId: string,
    lock: boolean): Promise<WorkspacePreparation | null> {
    const result = await client.query<PreparationRow>(`
      SELECT ${preparationColumns}
      FROM hosted_agent_workspace_preparations AS preparation
      WHERE preparation.preparation_id = $1 ${lock ? 'FOR UPDATE' : ''}
    `, [preparationId])
    return result.rows[0] ? preparationFromRow(result.rows[0]) : null
  }

  /** Read-only recovery identity for every object allocation associated with one preparation. */
  async listObjectAllocationIdsForReconciliation(identity: OperationIdentity,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<string[]> {
    id('operation', identity.operation, 128)
    id('idempotency key', identity.idempotencyKey)
    id('tenant ID', identity.tenantId)
    const result = await executor.query<{ allocation_id: string }>(`
      SELECT prepared_object.allocation_id::text
      FROM hosted_agent_workspace_preparation_objects AS prepared_object
      JOIN hosted_agent_workspace_preparations AS preparation
        ON preparation.preparation_id = prepared_object.preparation_id
       AND preparation.tenant_id = prepared_object.tenant_id
      WHERE preparation.operation = $1 AND preparation.idempotency_key = $2
        AND preparation.tenant_id = $3
      ORDER BY prepared_object.allocation_id
    `, [identity.operation, identity.idempotencyKey, identity.tenantId])
    return result.rows.map(row => allocationId(row.allocation_id))
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
    const result = await client.query<ObjectRow>(`
      SELECT prepared_object.preparation_id, prepared_object.tenant_id,
             prepared_object.allocation_id::text, prepared_object.object_id, prepared_object.purpose,
             object_row.checksum AS object_checksum, object_row.size_bytes::text AS object_size_bytes,
             object_row.expires_at AS object_expires_at, object_row.storage_bucket, object_row.storage_key,
             object_row.kind AS object_kind, object_row.state AS object_state,
             allocation.state AS allocation_state
      FROM hosted_agent_workspace_preparation_objects AS prepared_object
      JOIN hosted_agent_operation_allocations AS allocation
        ON allocation.allocation_id = prepared_object.allocation_id
       AND allocation.tenant_id = prepared_object.tenant_id
      JOIN hosted_agent_objects AS object_row
        ON object_row.object_id = prepared_object.object_id
       AND object_row.tenant_id = prepared_object.tenant_id
      WHERE prepared_object.preparation_id = $1
        AND allocation.allocation_kind = 'object'
      ORDER BY prepared_object.allocation_id, prepared_object.object_id
      FOR UPDATE OF prepared_object, allocation, object_row
    `, [preparationId])
    for (const row of result.rows) {
      this.assertObjectRow(row, {
        objectId: row.object_id, purpose: row.purpose, checksum: row.object_checksum,
        sizeBytes: Number(row.object_size_bytes), expiresAt: row.object_expires_at,
        storageBucket: row.storage_bucket, storageKey: row.storage_key,
      }, allocationStates)
    }
    const objects = result.rows.map(objectFromRow)
    const archive = result.rows.find(row => row.purpose === 'workspace_archive')
    const manifest = result.rows.find(row => row.purpose === 'manifest')
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
      await client.query('BEGIN')
      const value = await fn(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
}
