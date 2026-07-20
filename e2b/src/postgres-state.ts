import type { Pool, PoolClient } from 'pg'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { TicketPurpose } from './types.js'
import { begin, commit, lockTransaction, rollbackQuietly, setLocalLockTimeout } from './db/primitives.js'
import {
  stateAddSnapshotReference,
  stateFindAuthorizedSource,
  stateFindAuthorizedSourceByChecksum,
  stateGetSourceTenant,
  stateInsertObject,
  stateInsertSourceSnapshot,
  stateLockAuthorizedSource,
  stateLockAvailableObject,
  stateLockObjectById,
  stateLockObjectByTenant,
  stateLockSourceByChecksum,
  stateLockSourceById,
  stateUpsertObjectReference,
  type IStateLockObjectByIdResult,
  type IStateLockSourceByIdResult,
} from './db/queries/objects.queries.js'
import {
  activeLeaseTarget as activeLeaseTargetQuery,
  activateLease,
  beginRelease as beginReleaseQuery,
  cleanupTickets as cleanupTicketsQuery,
  completeReconnect as completeReconnectQuery,
  completeRelease as completeReleaseQuery,
  consumeTicket as consumeTicketQuery,
  findLeaseByProviderSandboxForReconciliation as findLeaseByProviderSandboxQuery,
  findRestoreReplacementForUpdate,
  findSnapshotByProviderIdForReconciliation as findSnapshotByProviderIdQuery,
  getLease as getLeaseQuery,
  getSnapshot as getSnapshotQuery,
  insertLatestSnapshotReference,
  insertLease,
  insertLeaseBaseReferences,
  insertLeaseRestoreSourceReference,
  insertSnapshot as insertSnapshotQuery,
  insertTicket as insertTicketQuery,
  lockLease as lockLeaseQuery,
  markLeaseLost as markLeaseLostQuery,
  lockSnapshot,
  deleteLatestSnapshotReference,
  releaseLostRestoreSource,
  revokeLeaseTickets as revokeLeaseTicketsQuery,
  revokeTicketsByLeaseId,
  rotateReconnectReplayAccess as rotateReconnectReplayAccessQuery,
  setLatestSnapshot,
  transitionLeaseState as transitionLeaseStateQuery,
  type IGetLeaseResult,
  type IGetSnapshotResult,
} from './db/queries/lifecycle.queries.js'

const checksumPattern = /^sha256:[0-9a-f]{64}$/
const ticketPurposes = new Set<TicketPurpose>(['exec_gateway_connect', 'exec_gateway_probe'])
const maxTicketTtlMs = 5 * 60_000

export class DurableStateConflictError extends Error {}
export class DurableStateNotFoundError extends Error {}

export interface StoredObject {
  objectId: string
  tenantId: string
  kind: 'source_archive' | 'workspace_archive' | 'manifest' | 'content_blob' | 'patch_artifact'
  storageBucket: string
  storageKey: string
  checksum: string
  sizeBytes: number
  state: 'pending' | 'available' | 'deleting' | 'deleted' | 'failed'
  expiresAt: Date | null
}

export interface SourceSnapshot {
  sourceSnapshotId: string
  tenantId: string
  archiveObjectId: string
  checksum: string
  cwdUri: string
  workspaceRootUris: string[]
  state: 'pending' | 'available' | 'expired' | 'deleted' | 'failed'
  expiresAt: Date
}

export interface Lease {
  leaseId: string
  environmentId: string
  tenantId: string
  agentId: string
  ownerAgentId: string | null
  ownerLeaseId: string | null
  sourceSnapshotId: string | null
  restoreSourceLeaseId: string | null
  restoreSourceSnapshotId: string | null
  providerSandboxId: string | null
  sandboxTemplate: string
  cwdUri: string
  workspaceRootUris: string[]
  baseSnapshotId: string | null
  latestSnapshotId: string | null
  state: 'provisioning' | 'active' | 'paused' | 'release_pending' | 'released' | 'lost' | 'failed'
  toolPolicy: Record<string, unknown>
  policyVersion: number
  connectionGeneration: number
  releasedAt: Date | null
}

export interface Snapshot {
  snapshotId: string
  tenantId: string
  leaseId: string
  providerSnapshotId: string | null
  workspaceArchiveObjectId: string
  manifestObjectId: string
  manifestChecksum: string
  state: 'creating' | 'available' | 'deleting' | 'deleted' | 'failed'
  expiresAt: Date | null
  createdAt: Date
}

export interface SnapshotInput {
  snapshotId: string
  providerSnapshotId: string | null
  workspaceArchiveObjectId: string
  manifestObjectId: string
  manifestChecksum: string
  contentObjectIds?: string[]
  expiresAt?: Date | null
}

export interface CreateLeaseInput {
  leaseId: string
  environmentId: string
  tenantId: string
  agentId: string
  ownerAgentId?: string | null
  ownerLeaseId?: string | null
  sourceSnapshotId?: string | null
  restoreSourceLeaseId?: string | null
  restoreSourceSnapshotId?: string | null
  providerSandboxId: string
  sandboxTemplate: string
  cwdUri: string
  workspaceRootUris: string[]
  toolPolicy: Record<string, unknown>
  policyVersion: number
  baseSnapshot: SnapshotInput
}

export interface CreateRestoredLeaseInput extends CreateLeaseInput {
  restoreSourceLeaseId: string
  restoreSourceSnapshotId: string
}

export interface CreateChildLeaseInput extends CreateLeaseInput {
  ownerAgentId: string
  ownerLeaseId: string
  expectedOwnerLatestSnapshotId: string
  expectedOwnerProviderSandboxId: string
  expectedOwnerConnectionGeneration: number
}

export interface RestoreSourceAuthorization {
  tenantId: string
  sourceLeaseId: string
  sourceSnapshotId: string
  agentId: string
  ownerAgentId: string | null
  ownerLeaseId: string | null
  sandboxTemplate: string
}

export interface AuthorizedRestoreSource {
  lease: Lease
  snapshot: Snapshot
  archiveObject: StoredObject
}

type LeaseState = Lease['state']


function validateId(label: string, value: string, max = 512): void {
  if (!value.trim() || Buffer.byteLength(value) > max) throw new Error(`invalid ${label}`)
}
function validateChecksum(checksum: string): void {
  if (!checksumPattern.test(checksum)) throw new Error('invalid checksum')
}
function validateHash(hash: Uint8Array): Buffer {
  const bytes = Buffer.from(hash)
  if (bytes.byteLength !== 32) throw new Error('ticket hash must contain 32 bytes')
  return bytes
}
function canonicalFileUri(value: string): { uri: string; path: string } {
  if (Buffer.byteLength(value, 'utf8') > 4096 || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error('invalid workspace URIs')
  }
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('invalid workspace URIs') }
  if (parsed.protocol !== 'file:' || parsed.hostname || parsed.username || parsed.password || parsed.search
    || parsed.hash || parsed.href !== value) throw new Error('invalid workspace URIs')
  let path: string
  try { path = fileURLToPath(parsed) } catch { throw new Error('invalid workspace URIs') }
  if (!isAbsolute(path) || pathToFileURL(path).href !== value) throw new Error('invalid workspace URIs')
  return { uri: value, path }
}
function below(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}
function validateRoots(cwd: string, roots: string[]): void {
  if (roots.length < 1 || roots.length > 64) throw new Error('invalid workspace URIs')
  const parsedCwd = canonicalFileUri(cwd)
  const parsedRoots = roots.map(canonicalFileUri)
  if (new Set(parsedRoots.map(root => root.uri)).size !== parsedRoots.length) throw new Error('invalid workspace URIs')
  for (const [index, root] of parsedRoots.entries()) {
    if (parsedRoots.some((candidate, candidateIndex) => candidateIndex !== index
      && (below(root.path, candidate.path) || below(candidate.path, root.path)))) {
      throw new Error('invalid workspace URIs')
    }
  }
  if (!parsedRoots.some(root => below(parsedCwd.path, root.path))) throw new Error('invalid workspace URIs')
}
function validateDate(label: string, value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`invalid ${label}`)
}
function validateTicketPurpose(purpose: TicketPurpose): void {
  if (!ticketPurposes.has(purpose)) throw new Error('invalid ticket purpose')
}
function postgresError(error: unknown): never {
  const code = (error as { code?: string }).code
  if (code === '23505') throw new DurableStateConflictError('durable identity already exists')
  if (code === '23503') throw new DurableStateNotFoundError('referenced durable state was not found')
  throw error
}

function objectFromRow(row: IStateLockObjectByIdResult): StoredObject {
  return { objectId: row.object_id, tenantId: row.tenant_id, kind: row.kind as StoredObject['kind'],
    storageBucket: row.storage_bucket, storageKey: row.storage_key, checksum: row.checksum,
    sizeBytes: Number(row.size_bytes), state: row.state as StoredObject['state'], expiresAt: row.expires_at }
}
function sourceFromRow(row: IStateLockSourceByIdResult): SourceSnapshot {
  return { sourceSnapshotId: row.source_snapshot_id, tenantId: row.tenant_id,
    archiveObjectId: row.archive_object_id, checksum: row.checksum, cwdUri: row.cwd_uri,
    workspaceRootUris: row.workspace_root_uris as string[], state: row.state as SourceSnapshot['state'], expiresAt: row.expires_at }
}
function leaseFromRow(row: IGetLeaseResult): Lease {
  return { leaseId: row.lease_id, environmentId: row.environment_id, tenantId: row.tenant_id,
    agentId: row.agent_id, ownerAgentId: row.owner_agent_id, ownerLeaseId: row.owner_lease_id,
    sourceSnapshotId: row.source_snapshot_id, restoreSourceLeaseId: row.restore_source_lease_id,
    restoreSourceSnapshotId: row.restore_source_snapshot_id, providerSandboxId: row.provider_sandbox_id,
    sandboxTemplate: row.sandbox_template, cwdUri: row.cwd_uri, workspaceRootUris: row.workspace_root_uris as string[],
    baseSnapshotId: row.base_snapshot_id, latestSnapshotId: row.latest_snapshot_id,
    state: row.state as LeaseState, toolPolicy: row.tool_policy as Record<string, unknown>, policyVersion: Number(row.policy_version),
    connectionGeneration: Number(row.connection_generation), releasedAt: row.released_at }
}
function snapshotFromRow(row: IGetSnapshotResult): Snapshot {
  return { snapshotId: row.snapshot_id, tenantId: row.tenant_id, leaseId: row.lease_id,
    providerSnapshotId: row.provider_snapshot_id, workspaceArchiveObjectId: row.workspace_archive_object_id,
    manifestObjectId: row.manifest_object_id, manifestChecksum: row.manifest_checksum,
    state: row.state as Snapshot['state'], expiresAt: row.expires_at, createdAt: row.created_at }
}

export class PostgresDurableState {
  constructor(private readonly pool: Pool) {}

  async withObjectLocationLock<T>(storageBucket: string, storageKey: string,
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    validateId('storage bucket', storageBucket); validateId('storage key', storageKey, 2048)
    return this.transaction(async client => {
      await setLocalLockTimeout(client)
      await this.lockObjectLocation(client, storageBucket, storageKey)
      return fn(client)
    })
  }

  async registerObject(input: StoredObject, executor?: PoolClient): Promise<StoredObject> {
    validateId('object ID', input.objectId); validateId('tenant ID', input.tenantId)
    validateId('storage bucket', input.storageBucket); validateId('storage key', input.storageKey, 2048)
    validateChecksum(input.checksum)
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('invalid object size')
    try {
      const register = async (client: PoolClient): Promise<StoredObject> => {
        await this.lockObjectLocation(client, input.storageBucket, input.storageKey)
        await stateInsertObject.run({ objectId: input.objectId, tenantId: input.tenantId,
          kind: input.kind, storageBucket: input.storageBucket, storageKey: input.storageKey,
          checksum: input.checksum, sizeBytes: input.sizeBytes, state: input.state,
          expiresAt: input.expiresAt }, client)
        const result = await stateLockObjectById.run({ objectId: input.objectId }, client)
        const row = result[0]
        if (!row || row.tenant_id !== input.tenantId || row.kind !== input.kind ||
          row.storage_bucket !== input.storageBucket || row.storage_key !== input.storageKey ||
          row.checksum !== input.checksum || Number(row.size_bytes) !== input.sizeBytes) {
          throw new DurableStateConflictError('object identity does not match its existing registration')
        }
        return objectFromRow(row)
      }
      return executor ? await register(executor) : await this.transaction(register)
    } catch (error) { return postgresError(error) }
  }

  async addObjectReference(input: { tenantId: string; objectId: string; referenceKind: string; referenceId: string; purpose: string; retainUntil?: Date | null }): Promise<void> {
    validateId('tenant ID', input.tenantId); validateId('object ID', input.objectId)
    validateId('reference ID', input.referenceId); validateId('reference purpose', input.purpose, 128)
    await this.transaction(async client => this.addObjectReferenceWithClient(client, input.tenantId, input.objectId,
      input.referenceKind, input.referenceId, input.purpose, input.retainUntil ?? null))
  }

  async addSnapshotReference(input: { tenantId: string; snapshotId: string; referenceKind: string; referenceId: string; retainUntil?: Date | null }): Promise<void> {
    validateId('tenant ID', input.tenantId); validateId('snapshot ID', input.snapshotId); validateId('reference ID', input.referenceId)
    const result = await stateAddSnapshotReference.run({ tenantId: input.tenantId,
      snapshotId: input.snapshotId, referenceKind: input.referenceKind,
      referenceId: input.referenceId, retainUntil: input.retainUntil ?? null }, this.pool)
    if (result.length !== 1) throw new DurableStateNotFoundError('snapshot was not found')
  }

  async registerSourceSnapshot(input: SourceSnapshot): Promise<SourceSnapshot> {
    validateId('source snapshot ID', input.sourceSnapshotId); validateId('tenant ID', input.tenantId)
    validateId('archive object ID', input.archiveObjectId); validateChecksum(input.checksum)
    validateRoots(input.cwdUri, input.workspaceRootUris)
    validateDate('source snapshot expiry', input.expiresAt)
    try {
      return await this.transaction(async client => {
        const existingIdentity = await stateGetSourceTenant.run({
          sourceSnapshotId: input.sourceSnapshotId }, client)
        if (existingIdentity[0] && existingIdentity[0].tenant_id !== input.tenantId) {
          throw new DurableStateConflictError('source snapshot identity does not match its existing registration')
        }
        await this.lockAvailableObject(client, input.tenantId, input.archiveObjectId, 'source_archive')
        await stateInsertSourceSnapshot.run({ sourceSnapshotId: input.sourceSnapshotId,
          tenantId: input.tenantId, archiveObjectId: input.archiveObjectId, checksum: input.checksum,
          cwdUri: input.cwdUri, workspaceRootUris: JSON.stringify(input.workspaceRootUris),
          state: input.state, expiresAt: input.expiresAt }, client)
        let result = await stateLockSourceById.run({ sourceSnapshotId: input.sourceSnapshotId }, client)
        if (!result[0]) {
          result = await stateLockSourceByChecksum.run({ tenantId: input.tenantId,
            checksum: input.checksum }, client)
        }
        const row = result[0]
        if (!row || row.tenant_id !== input.tenantId || row.archive_object_id !== input.archiveObjectId ||
          row.checksum !== input.checksum || row.cwd_uri !== input.cwdUri ||
          JSON.stringify(row.workspace_root_uris) !== JSON.stringify(input.workspaceRootUris) ||
          row.state !== input.state || row.expires_at.getTime() !== input.expiresAt.getTime()) {
          throw new DurableStateConflictError('source snapshot identity does not match its existing registration')
        }
        await this.addObjectReferenceWithClient(client, input.tenantId, input.archiveObjectId,
          'source_snapshot', input.sourceSnapshotId, 'source_archive', input.expiresAt, 'source_archive')
        return sourceFromRow(row)
      })
    } catch (error) { return postgresError(error) }
  }

  async findAuthorizedSourceSnapshot(tenantId: string, sourceSnapshotId: string, at = new Date()): Promise<SourceSnapshot | null> {
    validateId('tenant ID', tenantId); validateId('source snapshot ID', sourceSnapshotId)
    const result = await stateFindAuthorizedSource.run({ sourceSnapshotId, tenantId, at }, this.pool)
    return result[0] ? sourceFromRow(result[0]) : null
  }

  async lockAuthorizedSourceSnapshot(tenantId: string, sourceSnapshotId: string, expectedChecksum: string,
    at: Date, executor: Pick<PoolClient, 'query'>): Promise<SourceSnapshot> {
    validateId('tenant ID', tenantId); validateId('source snapshot ID', sourceSnapshotId)
    validateChecksum(expectedChecksum); validateDate('source snapshot authorization time', at)
    const result = await stateLockAuthorizedSource.run({ sourceSnapshotId, tenantId,
      checksum: expectedChecksum, at }, executor)
    if (result.length !== 1) throw new DurableStateNotFoundError('authorized source snapshot was not found')
    return sourceFromRow(result[0]!)
  }

  async findAuthorizedSourceSnapshotByChecksum(tenantId: string, checksum: string, at = new Date()): Promise<SourceSnapshot | null> {
    validateId('tenant ID', tenantId); validateChecksum(checksum); validateDate('source snapshot lookup time', at)
    const result = await stateFindAuthorizedSourceByChecksum.run({ tenantId, checksum, at }, this.pool)
    return result[0] ? sourceFromRow(result[0]) : null
  }

  async createLeaseWithBaseSnapshot(input: CreateLeaseInput, executor?: PoolClient): Promise<{ lease: Lease; snapshot: Snapshot }> {
    validateLeaseInput(input); validateSnapshotInput(input.baseSnapshot)
    try {
      const create = async (client: PoolClient) => {
        await insertLease.run({ leaseId: input.leaseId, environmentId: input.environmentId,
          tenantId: input.tenantId, agentId: input.agentId, ownerAgentId: input.ownerAgentId ?? null,
          ownerLeaseId: input.ownerLeaseId ?? null, sourceSnapshotId: input.sourceSnapshotId ?? null,
          restoreSourceLeaseId: input.restoreSourceLeaseId ?? null,
          restoreSourceSnapshotId: input.restoreSourceSnapshotId ?? null,
          providerSandboxId: input.providerSandboxId, sandboxTemplate: input.sandboxTemplate,
          cwdUri: input.cwdUri, workspaceRootUris: JSON.stringify(input.workspaceRootUris),
          toolPolicy: JSON.stringify(input.toolPolicy), policyVersion: input.policyVersion }, client)
        await this.referenceSnapshotObjects(client, input.tenantId, input.leaseId, input.baseSnapshot)
        await this.insertSnapshot(client, input.tenantId, input.leaseId, input.baseSnapshot)
        await insertLeaseBaseReferences.run({ snapshotId: input.baseSnapshot.snapshotId,
          leaseId: input.leaseId }, client)
        if (input.restoreSourceSnapshotId) {
          await insertLeaseRestoreSourceReference.run({ snapshotId: input.restoreSourceSnapshotId,
            leaseId: input.leaseId }, client)
        }
        const leaseResult = await activateLease.run({ leaseId: input.leaseId,
          snapshotId: input.baseSnapshot.snapshotId, tenantId: input.tenantId }, client)
        const snapshot = await this.snapshotWithClient(client, input.tenantId, input.baseSnapshot.snapshotId)
        return { lease: leaseFromRow(leaseResult[0]!), snapshot }
      }
      return executor ? await create(executor) : await this.transaction(create)
    } catch (error) { return postgresError(error) }
  }

  async createRestoredLeaseWithBaseSnapshot(input: CreateRestoredLeaseInput,
    executor?: PoolClient): Promise<{ lease: Lease; snapshot: Snapshot }> {
    validateLeaseInput(input); validateSnapshotInput(input.baseSnapshot)
    try {
      const create = async (client: PoolClient) => {
        const authorized = await this.lockAuthorizedRestoreSource({
          tenantId: input.tenantId, sourceLeaseId: input.restoreSourceLeaseId,
          sourceSnapshotId: input.restoreSourceSnapshotId, agentId: input.agentId,
          ownerAgentId: input.ownerAgentId ?? null, ownerLeaseId: input.ownerLeaseId ?? null,
          sandboxTemplate: input.sandboxTemplate,
        }, client)
        const source = authorized.lease
        const created = await this.createLeaseWithBaseSnapshot(input, client)
        await revokeTicketsByLeaseId.run({ leaseId: source.leaseId }, client)
        if (source.state === 'lost') {
          await releaseLostRestoreSource.run({ leaseId: source.leaseId, tenantId: input.tenantId }, client)
        }
        return created
      }
      return executor ? await create(executor) : await this.transaction(create)
    } catch (error) { return postgresError(error) }
  }

  async createChildLeaseWithBaseSnapshot(input: CreateChildLeaseInput,
    executor?: PoolClient): Promise<{ lease: Lease; snapshot: Snapshot }> {
    validateLeaseInput(input); validateSnapshotInput(input.baseSnapshot)
    validateId('expected owner snapshot ID', input.expectedOwnerLatestSnapshotId)
    validateId('expected owner provider sandbox ID', input.expectedOwnerProviderSandboxId)
    if (!Number.isSafeInteger(input.expectedOwnerConnectionGeneration)
      || input.expectedOwnerConnectionGeneration < 0) throw new Error('invalid owner connection generation')
    if (input.agentId === input.ownerAgentId) throw new Error('child and owner agents must be distinct')
    if (input.sourceSnapshotId != null || input.restoreSourceLeaseId != null
      || input.restoreSourceSnapshotId != null) throw new Error('child lease cannot have another source lineage')
    try {
      const create = async (client: PoolClient) => {
        const owner = await this.lockLease(client, input.tenantId, input.ownerLeaseId)
        if (!['active', 'paused'].includes(owner.state)
          || owner.agentId !== input.ownerAgentId
          || owner.latestSnapshotId !== input.expectedOwnerLatestSnapshotId
          || owner.providerSandboxId !== input.expectedOwnerProviderSandboxId
          || owner.connectionGeneration !== input.expectedOwnerConnectionGeneration) {
          throw new DurableStateNotFoundError('authorized child owner was not found')
        }
        return this.createLeaseWithBaseSnapshot(input, client)
      }
      return executor ? await create(executor) : await this.transaction(create)
    } catch (error) { return postgresError(error) }
  }

  async lockAuthorizedRestoreSource(input: RestoreSourceAuthorization,
    executor?: PoolClient): Promise<AuthorizedRestoreSource> {
    validateId('tenant ID', input.tenantId); validateId('restore source lease ID', input.sourceLeaseId)
    validateId('restore source snapshot ID', input.sourceSnapshotId); validateId('agent ID', input.agentId)
    validateId('sandbox template', input.sandboxTemplate)
    if (input.ownerAgentId) validateId('owner agent ID', input.ownerAgentId)
    if (input.ownerLeaseId) validateId('owner lease ID', input.ownerLeaseId)
    try {
      const authorize = async (client: PoolClient) => {
        const lease = await this.lockLease(client, input.tenantId, input.sourceLeaseId)
        if (!['lost', 'released'].includes(lease.state)) {
          throw new DurableStateConflictError('restore source lease is not terminal')
        }
        if (lease.latestSnapshotId !== input.sourceSnapshotId || lease.agentId !== input.agentId
          || lease.ownerAgentId !== input.ownerAgentId || lease.ownerLeaseId !== input.ownerLeaseId
          || lease.sandboxTemplate !== input.sandboxTemplate) {
          throw new DurableStateNotFoundError('authorized restore source was not found')
        }
        const replacement = await findRestoreReplacementForUpdate.run({
          sourceLeaseId: lease.leaseId, tenantId: input.tenantId }, client)
        if (replacement.length !== 0) {
          throw new DurableStateConflictError('restore source already has a replacement')
        }
        const snapshotResult = await lockSnapshot.run({ snapshotId: input.sourceSnapshotId,
          tenantId: input.tenantId }, client)
        const snapshot = snapshotResult[0] ? snapshotFromRow(snapshotResult[0]) : null
        if (!snapshot || snapshot.leaseId !== lease.leaseId || snapshot.state !== 'available'
          || (snapshot.expiresAt !== null && snapshot.expiresAt <= new Date())) {
          throw new DurableStateNotFoundError('authorized restore source was not found')
        }
        const objectResult = await stateLockObjectByTenant.run({
          objectId: snapshot.workspaceArchiveObjectId, tenantId: input.tenantId }, client)
        const archiveObject = objectResult[0] ? objectFromRow(objectResult[0]) : null
        if (!archiveObject || archiveObject.kind !== 'workspace_archive' || archiveObject.state !== 'available'
          || (archiveObject.expiresAt !== null && archiveObject.expiresAt <= new Date())) {
          throw new DurableStateNotFoundError('authorized restore source was not found')
        }
        return { lease, snapshot, archiveObject }
      }
      return executor ? await authorize(executor) : await this.transaction(authorize)
    } catch (error) { return postgresError(error) }
  }

  async getLease(tenantId: string, leaseId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<Lease | null> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    const result = await getLeaseQuery.run({ leaseId, tenantId }, executor)
    return result[0] ? leaseFromRow(result[0]) : null
  }

  async activeLeaseTarget(leaseId: string): Promise<{ sandboxId: string; connectionGeneration: number } | undefined> {
    validateId('lease ID', leaseId)
    const result = await activeLeaseTargetQuery.run({ leaseId }, this.pool)
    const row = result[0]
    return row?.provider_sandbox_id
      ? { sandboxId: row.provider_sandbox_id, connectionGeneration: Number(row.connection_generation) } : undefined
  }

  /** Internal global safety lookup used only to prevent provider reconciliation from killing a durable lease. */
  async findLeaseByProviderSandboxForReconciliation(providerSandboxId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<Lease | null> {
    validateId('provider sandbox ID', providerSandboxId)
    const result = await findLeaseByProviderSandboxQuery.run({ providerSandboxId }, executor)
    return result[0] ? leaseFromRow(result[0]) : null
  }

  /** Internal global safety lookup used only to protect provider snapshots retained by durable state. */
  async findSnapshotByProviderIdForReconciliation(providerSnapshotId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<Snapshot | null> {
    validateId('provider snapshot ID', providerSnapshotId)
    const result = await findSnapshotByProviderIdQuery.run({ providerSnapshotId }, executor)
    return result[0] ? snapshotFromRow(result[0]) : null
  }

  async getSnapshot(tenantId: string, snapshotId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<Snapshot | null> {
    validateId('tenant ID', tenantId); validateId('snapshot ID', snapshotId)
    const result = await getSnapshotQuery.run({ snapshotId, tenantId }, executor)
    return result[0] ? snapshotFromRow(result[0]) : null
  }

  async appendCheckpoint(tenantId: string, leaseId: string, snapshot: SnapshotInput, executor?: PoolClient): Promise<Snapshot> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId); validateSnapshotInput(snapshot)
    try {
      const append = async (client: PoolClient) => {
        const lease = await this.lockLease(client, tenantId, leaseId)
        if (!['active', 'paused'].includes(lease.state)) throw new DurableStateConflictError('lease cannot be checkpointed')
        await this.referenceSnapshotObjects(client, tenantId, leaseId, snapshot)
        await this.insertSnapshot(client, tenantId, leaseId, snapshot)
        await deleteLatestSnapshotReference.run({ leaseId }, client)
        await insertLatestSnapshotReference.run({ snapshotId: snapshot.snapshotId, leaseId }, client)
        await setLatestSnapshot.run({ snapshotId: snapshot.snapshotId, leaseId, tenantId }, client)
        return this.snapshotWithClient(client, tenantId, snapshot.snapshotId)
      }
      return executor ? await append(executor) : await this.transaction(append)
    } catch (error) { return postgresError(error) }
  }

  async transitionLeaseState(tenantId: string, leaseId: string, expected: LeaseState[], next: LeaseState): Promise<Lease> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    return this.transaction(async client => {
      const lease = await this.lockLease(client, tenantId, leaseId)
      if (!expected.includes(lease.state)) throw new DurableStateConflictError('lease state changed concurrently')
      const result = await transitionLeaseStateQuery.run({ leaseId, tenantId, next }, client)
      return leaseFromRow(result[0]!)
    })
  }

  async beginRelease(tenantId: string, leaseId: string, executor?: PoolClient): Promise<Lease> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    try {
      const begin = async (client: PoolClient) => {
        const lease = await this.lockLease(client, tenantId, leaseId)
        await revokeTicketsByLeaseId.run({ leaseId }, client)
        if (lease.state === 'released' || lease.state === 'release_pending') return lease
        if (!['active', 'paused', 'lost', 'failed'].includes(lease.state)) {
          throw new DurableStateConflictError('lease cannot be released')
        }
        const result = await beginReleaseQuery.run({ leaseId, tenantId }, client)
        return leaseFromRow(result[0]!)
      }
      return executor ? await begin(executor) : await this.transaction(begin)
    } catch (error) { return postgresError(error) }
  }

  async completeReconnect(tenantId: string, leaseId: string, expectedSandboxId: string,
    executor: PoolClient): Promise<Lease> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    validateId('provider sandbox ID', expectedSandboxId)
    try {
      const lease = await this.lockLease(executor, tenantId, leaseId)
      if (!['active', 'paused'].includes(lease.state)
        || lease.providerSandboxId !== expectedSandboxId) {
        throw new DurableStateConflictError('lease cannot be reconnected')
      }
      await revokeTicketsByLeaseId.run({ leaseId }, executor)
      const result = await completeReconnectQuery.run({ leaseId, tenantId }, executor)
      return leaseFromRow(result[0]!)
    } catch (error) { return postgresError(error) }
  }

  async rotateReconnectReplayAccess(tenantId: string, leaseId: string, expectedSandboxId: string,
    executor: PoolClient): Promise<Lease> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    validateId('provider sandbox ID', expectedSandboxId)
    try {
      const lease = await this.lockLease(executor, tenantId, leaseId)
      if (lease.state !== 'active' || lease.providerSandboxId !== expectedSandboxId) {
        throw new DurableStateConflictError('lease reconnect cannot be replayed')
      }
      await revokeTicketsByLeaseId.run({ leaseId }, executor)
      const result = await rotateReconnectReplayAccessQuery.run({ leaseId, tenantId }, executor)
      return leaseFromRow(result[0]!)
    } catch (error) { return postgresError(error) }
  }

  async markLeaseLost(tenantId: string, leaseId: string, expectedSandboxId: string,
    executor: PoolClient): Promise<Lease> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    validateId('provider sandbox ID', expectedSandboxId)
    try {
      const lease = await this.lockLease(executor, tenantId, leaseId)
      if (lease.providerSandboxId !== expectedSandboxId
        || (!['active', 'paused'].includes(lease.state) && lease.state !== 'lost')) {
        throw new DurableStateConflictError('lease cannot be marked lost')
      }
      await revokeTicketsByLeaseId.run({ leaseId }, executor)
      if (lease.state === 'lost') return lease
      const result = await markLeaseLostQuery.run({ leaseId, tenantId }, executor)
      return leaseFromRow(result[0]!)
    } catch (error) { return postgresError(error) }
  }

  async releaseLease(tenantId: string, leaseId: string, executor?: PoolClient): Promise<Lease> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    try {
      const release = async (client: PoolClient) => {
        const lease = await this.lockLease(client, tenantId, leaseId)
        await revokeTicketsByLeaseId.run({ leaseId }, client)
        if (lease.state === 'released') return lease
        if (lease.state !== 'release_pending') throw new DurableStateConflictError('lease release was not prepared')
        const result = await completeReleaseQuery.run({ leaseId, tenantId }, client)
        return leaseFromRow(result[0]!)
      }
      return executor ? await release(executor) : await this.transaction(release)
    } catch (error) { return postgresError(error) }
  }

  async issueTicketHash(input: { tenantId: string; leaseId: string; ticketHash: Uint8Array; purpose: TicketPurpose;
    expiresAt: Date; expectedConnectionGeneration?: number }): Promise<void> {
    validateId('tenant ID', input.tenantId); validateId('lease ID', input.leaseId)
    validateTicketPurpose(input.purpose); validateDate('ticket expiry', input.expiresAt)
    const now = Date.now()
    if (input.expiresAt.getTime() <= now || input.expiresAt.getTime() > now + maxTicketTtlMs) throw new Error('invalid ticket expiry')
    if (input.expectedConnectionGeneration !== undefined
      && (!Number.isSafeInteger(input.expectedConnectionGeneration) || input.expectedConnectionGeneration < 0)) {
      throw new Error('invalid connection generation')
    }
    const ticketHash = validateHash(input.ticketHash)
    await this.transaction(async client => {
      const lease = await this.lockLease(client, input.tenantId, input.leaseId)
      if (lease.state !== 'active') throw new DurableStateConflictError('tickets require an active lease')
      if (input.expectedConnectionGeneration !== undefined
        && lease.connectionGeneration !== input.expectedConnectionGeneration) {
        throw new DurableStateConflictError('lease connection generation changed')
      }
      await revokeTicketsByLeaseId.run({ leaseId: input.leaseId }, client)
      try {
        await insertTicketQuery.run({ ticketHash, leaseId: input.leaseId, purpose: input.purpose,
          expiresAt: input.expiresAt, connectionGeneration: lease.connectionGeneration }, client)
      } catch (error) { postgresError(error) }
    })
  }

  async consumeTicketHash(input: { tenantId: string; leaseId: string; ticketHash: Uint8Array; purpose: TicketPurpose; at?: Date }): Promise<number | null> {
    validateId('tenant ID', input.tenantId); validateId('lease ID', input.leaseId); validateTicketPurpose(input.purpose)
    if (input.at) validateDate('ticket consumption time', input.at)
    const ticketHash = validateHash(input.ticketHash)
    const result = await consumeTicketQuery.run({ ticketHash, leaseId: input.leaseId,
      purpose: input.purpose, tenantId: input.tenantId, at: input.at ?? new Date() }, this.pool)
    const generation = result[0]?.connection_generation
    return generation === undefined ? null : Number(generation)
  }

  async revokeLeaseTickets(tenantId: string, leaseId: string): Promise<number> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    const result = await revokeLeaseTicketsQuery.run({ leaseId, tenantId }, this.pool)
    return result.length
  }

  async cleanupTickets(before = new Date(), limit = 1000): Promise<number> {
    validateDate('ticket cleanup time', before)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('invalid ticket cleanup limit')
    const result = await cleanupTicketsQuery.run({ before, limit }, this.pool)
    return result.length
  }

  private async lockLease(client: PoolClient, tenantId: string, leaseId: string): Promise<Lease> {
    const result = await lockLeaseQuery.run({ leaseId, tenantId }, client)
    if (!result[0]) throw new DurableStateNotFoundError('lease was not found')
    return leaseFromRow(result[0])
  }

  private async insertSnapshot(client: PoolClient, tenantId: string, leaseId: string, snapshot: SnapshotInput): Promise<void> {
    await insertSnapshotQuery.run({ snapshotId: snapshot.snapshotId, tenantId, leaseId,
      providerSnapshotId: snapshot.providerSnapshotId,
      workspaceArchiveObjectId: snapshot.workspaceArchiveObjectId,
      manifestObjectId: snapshot.manifestObjectId, manifestChecksum: snapshot.manifestChecksum,
      expiresAt: snapshot.expiresAt ?? null }, client)
  }

  private async snapshotWithClient(client: PoolClient, tenantId: string, snapshotId: string): Promise<Snapshot> {
    const result = await getSnapshotQuery.run({ snapshotId, tenantId }, client)
    if (!result[0]) throw new DurableStateNotFoundError('snapshot was not found')
    return snapshotFromRow(result[0])
  }

  private async referenceSnapshotObjects(client: PoolClient, tenantId: string, leaseId: string, snapshot: SnapshotInput): Promise<void> {
    await this.addObjectReferenceWithClient(client, tenantId, snapshot.workspaceArchiveObjectId,
      'snapshot', snapshot.snapshotId, 'workspace_archive', snapshot.expiresAt ?? null, 'workspace_archive')
    await this.addObjectReferenceWithClient(client, tenantId, snapshot.manifestObjectId,
      'snapshot', snapshot.snapshotId, 'manifest', snapshot.expiresAt ?? null, 'manifest')
    for (const objectId of snapshot.contentObjectIds ?? []) {
      await this.addObjectReferenceWithClient(client, tenantId, objectId,
        'snapshot', snapshot.snapshotId, 'content_blob', snapshot.expiresAt ?? null, 'content_blob')
    }
  }

  private async addObjectReferenceWithClient(client: PoolClient, tenantId: string, objectId: string,
    referenceKind: string, referenceId: string, purpose: string, retainUntil: Date | null,
    expectedKind?: StoredObject['kind']): Promise<void> {
    await this.lockAvailableObject(client, tenantId, objectId, expectedKind)
    await stateUpsertObjectReference.run({ objectId, referenceKind, referenceId,
      purpose, retainUntil }, client)
  }

  private async lockAvailableObject(client: PoolClient, tenantId: string, objectId: string,
    expectedKind?: StoredObject['kind']): Promise<void> {
    const result = await stateLockAvailableObject.run({ objectId, tenantId,
      expectedKind: expectedKind ?? null }, client)
    if (result.length !== 1) throw new DurableStateNotFoundError('object was not found')
  }

  private async lockObjectLocation(client: PoolClient, storageBucket: string, storageKey: string): Promise<void> {
    await lockTransaction(client,
      `hosted-agent:object-location:${JSON.stringify([storageBucket, storageKey])}`)
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

function validateSnapshotInput(input: SnapshotInput): void {
  validateId('snapshot ID', input.snapshotId); validateId('workspace archive object ID', input.workspaceArchiveObjectId)
  validateId('manifest object ID', input.manifestObjectId); validateChecksum(input.manifestChecksum)
  if (input.providerSnapshotId !== null) validateId('provider snapshot ID', input.providerSnapshotId)
  if (input.contentObjectIds !== undefined) {
    if (!Array.isArray(input.contentObjectIds) || input.contentObjectIds.length > 100_000
      || new Set(input.contentObjectIds).size !== input.contentObjectIds.length) throw new Error('invalid snapshot content object IDs')
    for (const objectId of input.contentObjectIds) validateId('snapshot content object ID', objectId)
  }
}

function validateLeaseInput(input: CreateLeaseInput): void {
  validateId('lease ID', input.leaseId); validateId('environment ID', input.environmentId)
  validateId('tenant ID', input.tenantId); validateId('agent ID', input.agentId)
  validateId('provider sandbox ID', input.providerSandboxId); validateId('sandbox template', input.sandboxTemplate)
  if (input.ownerAgentId) validateId('owner agent ID', input.ownerAgentId)
  if (input.ownerLeaseId) validateId('owner lease ID', input.ownerLeaseId)
  if (input.sourceSnapshotId) validateId('source snapshot ID', input.sourceSnapshotId)
  if (input.restoreSourceLeaseId) validateId('restore source lease ID', input.restoreSourceLeaseId)
  if (input.restoreSourceSnapshotId) validateId('restore source snapshot ID', input.restoreSourceSnapshotId)
  if ((input.restoreSourceLeaseId == null) !== (input.restoreSourceSnapshotId == null)) {
    throw new Error('restore source lease and snapshot must be paired')
  }
  if (input.sourceSnapshotId && input.restoreSourceSnapshotId) throw new Error('lease cannot have two source kinds')
  validateRoots(input.cwdUri, input.workspaceRootUris)
  if (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1) throw new Error('invalid policy version')
}
