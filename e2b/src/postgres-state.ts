import type { Pool, PoolClient } from 'pg'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { TicketPurpose } from './types.js'

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
  providerSandboxId: string
  sandboxTemplate: string
  cwdUri: string
  workspaceRootUris: string[]
  toolPolicy: Record<string, unknown>
  policyVersion: number
  baseSnapshot: SnapshotInput
}

type LeaseState = Lease['state']

interface ObjectRow {
  object_id: string; tenant_id: string; kind: StoredObject['kind']; storage_bucket: string
  storage_key: string; checksum: string; size_bytes: string; state: StoredObject['state']; expires_at: Date | null
}
interface SourceRow {
  source_snapshot_id: string; tenant_id: string; archive_object_id: string; checksum: string
  cwd_uri: string; workspace_root_uris: string[]; state: SourceSnapshot['state']; expires_at: Date
}
interface LeaseRow {
  lease_id: string; environment_id: string; tenant_id: string; agent_id: string
  owner_agent_id: string | null; owner_lease_id: string | null; source_snapshot_id: string | null
  provider_sandbox_id: string | null; sandbox_template: string; cwd_uri: string
  workspace_root_uris: string[]; base_snapshot_id: string | null; latest_snapshot_id: string | null
  state: LeaseState; tool_policy: Record<string, unknown>; policy_version: string
  connection_generation: string; released_at: Date | null
}
interface SnapshotRow {
  snapshot_id: string; tenant_id: string; lease_id: string; provider_snapshot_id: string | null
  workspace_archive_object_id: string; manifest_object_id: string; manifest_checksum: string
  state: Snapshot['state']; expires_at: Date | null; created_at: Date
}

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

const leaseColumns = `lease_id, environment_id, tenant_id, agent_id, owner_agent_id,
  owner_lease_id, source_snapshot_id, provider_sandbox_id, sandbox_template, cwd_uri,
  workspace_root_uris, base_snapshot_id, latest_snapshot_id, state, tool_policy,
  policy_version::text, connection_generation::text, released_at`
const snapshotColumns = `snapshot_id, tenant_id, lease_id, provider_snapshot_id,
  workspace_archive_object_id, manifest_object_id, manifest_checksum, state, expires_at, created_at`

function objectFromRow(row: ObjectRow): StoredObject {
  return { objectId: row.object_id, tenantId: row.tenant_id, kind: row.kind,
    storageBucket: row.storage_bucket, storageKey: row.storage_key, checksum: row.checksum,
    sizeBytes: Number(row.size_bytes), state: row.state, expiresAt: row.expires_at }
}
function sourceFromRow(row: SourceRow): SourceSnapshot {
  return { sourceSnapshotId: row.source_snapshot_id, tenantId: row.tenant_id,
    archiveObjectId: row.archive_object_id, checksum: row.checksum, cwdUri: row.cwd_uri,
    workspaceRootUris: row.workspace_root_uris, state: row.state, expiresAt: row.expires_at }
}
function leaseFromRow(row: LeaseRow): Lease {
  return { leaseId: row.lease_id, environmentId: row.environment_id, tenantId: row.tenant_id,
    agentId: row.agent_id, ownerAgentId: row.owner_agent_id, ownerLeaseId: row.owner_lease_id,
    sourceSnapshotId: row.source_snapshot_id, providerSandboxId: row.provider_sandbox_id,
    sandboxTemplate: row.sandbox_template, cwdUri: row.cwd_uri, workspaceRootUris: row.workspace_root_uris,
    baseSnapshotId: row.base_snapshot_id, latestSnapshotId: row.latest_snapshot_id, state: row.state,
    toolPolicy: row.tool_policy, policyVersion: Number(row.policy_version),
    connectionGeneration: Number(row.connection_generation), releasedAt: row.released_at }
}
function snapshotFromRow(row: SnapshotRow): Snapshot {
  return { snapshotId: row.snapshot_id, tenantId: row.tenant_id, leaseId: row.lease_id,
    providerSnapshotId: row.provider_snapshot_id, workspaceArchiveObjectId: row.workspace_archive_object_id,
    manifestObjectId: row.manifest_object_id, manifestChecksum: row.manifest_checksum,
    state: row.state, expiresAt: row.expires_at, createdAt: row.created_at }
}

export class PostgresDurableState {
  constructor(private readonly pool: Pool) {}

  async withObjectLocationLock<T>(storageBucket: string, storageKey: string,
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    validateId('storage bucket', storageBucket); validateId('storage key', storageKey, 2048)
    return this.transaction(async client => {
      await client.query("SET LOCAL lock_timeout = '30s'")
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
        await client.query(`
          INSERT INTO hosted_agent_objects
            (object_id, tenant_id, kind, storage_bucket, storage_key, checksum, size_bytes, state, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (object_id) DO NOTHING
        `, [input.objectId, input.tenantId, input.kind, input.storageBucket, input.storageKey,
          input.checksum, input.sizeBytes, input.state, input.expiresAt])
        const result = await client.query<ObjectRow>(`
          SELECT object_id, tenant_id, kind, storage_bucket, storage_key, checksum,
                 size_bytes::text, state, expires_at
          FROM hosted_agent_objects WHERE object_id = $1 FOR UPDATE
        `, [input.objectId])
        const row = result.rows[0]
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
    const result = await this.pool.query(`
      INSERT INTO hosted_agent_snapshot_references
        (snapshot_id, reference_kind, reference_id, retain_until)
      SELECT snapshot_id, $3, $4, $5
      FROM hosted_agent_snapshots WHERE snapshot_id = $2 AND tenant_id = $1
      ON CONFLICT (snapshot_id, reference_kind, reference_id)
      DO UPDATE SET retain_until = CASE
        WHEN hosted_agent_snapshot_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
        ELSE GREATEST(hosted_agent_snapshot_references.retain_until, EXCLUDED.retain_until)
      END
    `, [input.tenantId, input.snapshotId, input.referenceKind, input.referenceId, input.retainUntil ?? null])
    if (result.rowCount !== 1) throw new DurableStateNotFoundError('snapshot was not found')
  }

  async registerSourceSnapshot(input: SourceSnapshot): Promise<SourceSnapshot> {
    validateId('source snapshot ID', input.sourceSnapshotId); validateId('tenant ID', input.tenantId)
    validateId('archive object ID', input.archiveObjectId); validateChecksum(input.checksum)
    validateRoots(input.cwdUri, input.workspaceRootUris)
    validateDate('source snapshot expiry', input.expiresAt)
    try {
      return await this.transaction(async client => {
        const existingIdentity = await client.query<{ tenant_id: string }>(`
          SELECT tenant_id FROM hosted_agent_source_snapshots WHERE source_snapshot_id = $1
        `, [input.sourceSnapshotId])
        if (existingIdentity.rows[0] && existingIdentity.rows[0].tenant_id !== input.tenantId) {
          throw new DurableStateConflictError('source snapshot identity does not match its existing registration')
        }
        await this.lockAvailableObject(client, input.tenantId, input.archiveObjectId, 'source_archive')
        await client.query(`
          INSERT INTO hosted_agent_source_snapshots
            (source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
             workspace_root_uris, state, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
          ON CONFLICT DO NOTHING
        `, [input.sourceSnapshotId, input.tenantId, input.archiveObjectId, input.checksum,
          input.cwdUri, JSON.stringify(input.workspaceRootUris), input.state, input.expiresAt])
        let result = await client.query<SourceRow>(`
          SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
                 workspace_root_uris, state, expires_at
          FROM hosted_agent_source_snapshots WHERE source_snapshot_id = $1 FOR UPDATE
        `, [input.sourceSnapshotId])
        if (!result.rows[0]) {
          result = await client.query<SourceRow>(`
            SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
                   workspace_root_uris, state, expires_at
            FROM hosted_agent_source_snapshots
            WHERE tenant_id = $1 AND checksum = $2 FOR UPDATE
          `, [input.tenantId, input.checksum])
        }
        const row = result.rows[0]
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
    const result = await this.pool.query<SourceRow>(`
      SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
             workspace_root_uris, state, expires_at
      FROM hosted_agent_source_snapshots
      WHERE source_snapshot_id = $1 AND tenant_id = $2
        AND state = 'available' AND expires_at > $3
    `, [sourceSnapshotId, tenantId, at])
    return result.rows[0] ? sourceFromRow(result.rows[0]) : null
  }

  async lockAuthorizedSourceSnapshot(tenantId: string, sourceSnapshotId: string, expectedChecksum: string,
    at: Date, executor: Pick<PoolClient, 'query'>): Promise<SourceSnapshot> {
    validateId('tenant ID', tenantId); validateId('source snapshot ID', sourceSnapshotId)
    validateChecksum(expectedChecksum); validateDate('source snapshot authorization time', at)
    const result = await executor.query<SourceRow>(`
      SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
             workspace_root_uris, state, expires_at
      FROM hosted_agent_source_snapshots
      WHERE source_snapshot_id = $1 AND tenant_id = $2 AND checksum = $3
        AND state = 'available' AND expires_at > $4
      FOR UPDATE
    `, [sourceSnapshotId, tenantId, expectedChecksum, at])
    if (result.rowCount !== 1) throw new DurableStateNotFoundError('authorized source snapshot was not found')
    return sourceFromRow(result.rows[0]!)
  }

  async findAuthorizedSourceSnapshotByChecksum(tenantId: string, checksum: string, at = new Date()): Promise<SourceSnapshot | null> {
    validateId('tenant ID', tenantId); validateChecksum(checksum); validateDate('source snapshot lookup time', at)
    const result = await this.pool.query<SourceRow>(`
      SELECT source_snapshot_id, tenant_id, archive_object_id, checksum, cwd_uri,
             workspace_root_uris, state, expires_at
      FROM hosted_agent_source_snapshots
      WHERE tenant_id = $1 AND checksum = $2 AND state = 'available' AND expires_at > $3
    `, [tenantId, checksum, at])
    return result.rows[0] ? sourceFromRow(result.rows[0]) : null
  }

  async createLeaseWithBaseSnapshot(input: CreateLeaseInput, executor?: PoolClient): Promise<{ lease: Lease; snapshot: Snapshot }> {
    validateLeaseInput(input); validateSnapshotInput(input.baseSnapshot)
    try {
      const create = async (client: PoolClient) => {
        await client.query(`
          INSERT INTO hosted_agent_leases
            (lease_id, environment_id, tenant_id, agent_id, owner_agent_id, owner_lease_id,
             source_snapshot_id, provider_sandbox_id, sandbox_template, cwd_uri,
             workspace_root_uris, state, tool_policy, policy_version)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                  'provisioning', $12::jsonb, $13)
        `, [input.leaseId, input.environmentId, input.tenantId, input.agentId,
          input.ownerAgentId ?? null, input.ownerLeaseId ?? null, input.sourceSnapshotId ?? null,
          input.providerSandboxId, input.sandboxTemplate, input.cwdUri,
          JSON.stringify(input.workspaceRootUris), JSON.stringify(input.toolPolicy), input.policyVersion])
        await this.referenceSnapshotObjects(client, input.tenantId, input.leaseId, input.baseSnapshot)
        await this.insertSnapshot(client, input.tenantId, input.leaseId, input.baseSnapshot)
        await client.query(`
          INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
          VALUES ($1, 'lease_base', $2), ($1, 'lease_latest', $2)
        `, [input.baseSnapshot.snapshotId, input.leaseId])
        const leaseResult = await client.query<LeaseRow>(`
          UPDATE hosted_agent_leases
          SET base_snapshot_id = $2, latest_snapshot_id = $2, state = 'active'
          WHERE lease_id = $1 AND tenant_id = $3
          RETURNING ${leaseColumns}
        `, [input.leaseId, input.baseSnapshot.snapshotId, input.tenantId])
        const snapshot = await this.snapshotWithClient(client, input.tenantId, input.baseSnapshot.snapshotId)
        return { lease: leaseFromRow(leaseResult.rows[0]!), snapshot }
      }
      return executor ? await create(executor) : await this.transaction(create)
    } catch (error) { return postgresError(error) }
  }

  async getLease(tenantId: string, leaseId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<Lease | null> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    const result = await executor.query<LeaseRow>(`
      SELECT ${leaseColumns} FROM hosted_agent_leases WHERE lease_id = $1 AND tenant_id = $2
    `, [leaseId, tenantId])
    return result.rows[0] ? leaseFromRow(result.rows[0]) : null
  }

  async activeLeaseTarget(leaseId: string): Promise<{ sandboxId: string; connectionGeneration: number } | undefined> {
    validateId('lease ID', leaseId)
    const result = await this.pool.query<{ provider_sandbox_id: string; connection_generation: string }>(`
      SELECT provider_sandbox_id, connection_generation::text FROM hosted_agent_leases
      WHERE lease_id = $1 AND state = 'active' AND provider_sandbox_id IS NOT NULL
    `, [leaseId])
    const row = result.rows[0]
    return row ? { sandboxId: row.provider_sandbox_id, connectionGeneration: Number(row.connection_generation) } : undefined
  }

  /** Internal global safety lookup used only to prevent provider reconciliation from killing a durable lease. */
  async findLeaseByProviderSandboxForReconciliation(providerSandboxId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<Lease | null> {
    validateId('provider sandbox ID', providerSandboxId)
    const result = await executor.query<LeaseRow>(`
      SELECT ${leaseColumns} FROM hosted_agent_leases
      WHERE provider_sandbox_id = $1
        AND state IN ('provisioning', 'active', 'paused', 'release_pending')
      ORDER BY created_at DESC LIMIT 1
    `, [providerSandboxId])
    return result.rows[0] ? leaseFromRow(result.rows[0]) : null
  }

  /** Internal global safety lookup used only to protect provider snapshots retained by durable state. */
  async findSnapshotByProviderIdForReconciliation(providerSnapshotId: string,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<Snapshot | null> {
    validateId('provider snapshot ID', providerSnapshotId)
    const result = await executor.query<SnapshotRow>(`
      SELECT ${snapshotColumns} FROM hosted_agent_snapshots
      WHERE provider_snapshot_id = $1 AND state <> 'deleted'
      ORDER BY created_at DESC LIMIT 1
    `, [providerSnapshotId])
    return result.rows[0] ? snapshotFromRow(result.rows[0]) : null
  }

  async getSnapshot(tenantId: string, snapshotId: string): Promise<Snapshot | null> {
    validateId('tenant ID', tenantId); validateId('snapshot ID', snapshotId)
    const result = await this.pool.query<SnapshotRow>(`
      SELECT ${snapshotColumns} FROM hosted_agent_snapshots WHERE snapshot_id = $1 AND tenant_id = $2
    `, [snapshotId, tenantId])
    return result.rows[0] ? snapshotFromRow(result.rows[0]) : null
  }

  async appendCheckpoint(tenantId: string, leaseId: string, snapshot: SnapshotInput, executor?: PoolClient): Promise<Snapshot> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId); validateSnapshotInput(snapshot)
    try {
      const append = async (client: PoolClient) => {
        const lease = await this.lockLease(client, tenantId, leaseId)
        if (!['active', 'paused'].includes(lease.state)) throw new DurableStateConflictError('lease cannot be checkpointed')
        await this.referenceSnapshotObjects(client, tenantId, leaseId, snapshot)
        await this.insertSnapshot(client, tenantId, leaseId, snapshot)
        await client.query(`
          DELETE FROM hosted_agent_snapshot_references
          WHERE reference_kind = 'lease_latest' AND reference_id = $1
        `, [leaseId])
        await client.query(`
          INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
          VALUES ($1, 'lease_latest', $2)
        `, [snapshot.snapshotId, leaseId])
        await client.query(`
          UPDATE hosted_agent_leases SET latest_snapshot_id = $3
          WHERE lease_id = $1 AND tenant_id = $2
        `, [leaseId, tenantId, snapshot.snapshotId])
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
      const result = await client.query<LeaseRow>(`
        UPDATE hosted_agent_leases
        SET state = $3, released_at = CASE WHEN $3 = 'released' THEN now() ELSE NULL END
        WHERE lease_id = $1 AND tenant_id = $2
        RETURNING ${leaseColumns}
      `, [leaseId, tenantId, next])
      return leaseFromRow(result.rows[0]!)
    })
  }

  async beginRelease(tenantId: string, leaseId: string, executor?: PoolClient): Promise<Lease> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    try {
      const begin = async (client: PoolClient) => {
        const lease = await this.lockLease(client, tenantId, leaseId)
        await client.query(`UPDATE hosted_agent_tickets SET revoked_at = COALESCE(revoked_at, now()) WHERE lease_id = $1`, [leaseId])
        if (lease.state === 'released' || lease.state === 'release_pending') return lease
        if (!['active', 'paused', 'lost', 'failed'].includes(lease.state)) {
          throw new DurableStateConflictError('lease cannot be released')
        }
        const result = await client.query<LeaseRow>(`
          UPDATE hosted_agent_leases SET state = 'release_pending', released_at = NULL
          WHERE lease_id = $1 AND tenant_id = $2 RETURNING ${leaseColumns}
        `, [leaseId, tenantId])
        return leaseFromRow(result.rows[0]!)
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
      await executor.query(`UPDATE hosted_agent_tickets
        SET revoked_at = COALESCE(revoked_at, now()) WHERE lease_id = $1`, [leaseId])
      const result = await executor.query<LeaseRow>(`
        UPDATE hosted_agent_leases
        SET state = 'active', released_at = NULL, connection_generation = connection_generation + 1
        WHERE lease_id = $1 AND tenant_id = $2 RETURNING ${leaseColumns}
      `, [leaseId, tenantId])
      return leaseFromRow(result.rows[0]!)
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
      await executor.query(`UPDATE hosted_agent_tickets
        SET revoked_at = COALESCE(revoked_at, now()) WHERE lease_id = $1`, [leaseId])
      const result = await executor.query<LeaseRow>(`
        UPDATE hosted_agent_leases
        SET connection_generation = connection_generation + 1
        WHERE lease_id = $1 AND tenant_id = $2 RETURNING ${leaseColumns}
      `, [leaseId, tenantId])
      return leaseFromRow(result.rows[0]!)
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
      await executor.query(`UPDATE hosted_agent_tickets
        SET revoked_at = COALESCE(revoked_at, now()) WHERE lease_id = $1`, [leaseId])
      if (lease.state === 'lost') return lease
      const result = await executor.query<LeaseRow>(`
        UPDATE hosted_agent_leases
        SET state = 'lost', released_at = NULL, connection_generation = connection_generation + 1
        WHERE lease_id = $1 AND tenant_id = $2 RETURNING ${leaseColumns}
      `, [leaseId, tenantId])
      return leaseFromRow(result.rows[0]!)
    } catch (error) { return postgresError(error) }
  }

  async releaseLease(tenantId: string, leaseId: string, executor?: PoolClient): Promise<Lease> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    try {
      const release = async (client: PoolClient) => {
        const lease = await this.lockLease(client, tenantId, leaseId)
        await client.query(`UPDATE hosted_agent_tickets SET revoked_at = COALESCE(revoked_at, now()) WHERE lease_id = $1`, [leaseId])
        if (lease.state === 'released') return lease
        if (lease.state !== 'release_pending') throw new DurableStateConflictError('lease release was not prepared')
        const result = await client.query<LeaseRow>(`
          UPDATE hosted_agent_leases SET state = 'released', released_at = now()
          WHERE lease_id = $1 AND tenant_id = $2 RETURNING ${leaseColumns}
        `, [leaseId, tenantId])
        return leaseFromRow(result.rows[0]!)
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
      await client.query(`
        UPDATE hosted_agent_tickets SET revoked_at = COALESCE(revoked_at, now())
        WHERE lease_id = $1 AND revoked_at IS NULL
      `, [input.leaseId])
      try {
        await client.query(`
          INSERT INTO hosted_agent_tickets
            (ticket_hash, lease_id, purpose, expires_at, connection_generation)
          VALUES ($1, $2, $3, $4, $5)
        `, [ticketHash, input.leaseId, input.purpose, input.expiresAt, lease.connectionGeneration])
      } catch (error) { postgresError(error) }
    })
  }

  async consumeTicketHash(input: { tenantId: string; leaseId: string; ticketHash: Uint8Array; purpose: TicketPurpose; at?: Date }): Promise<number | null> {
    validateId('tenant ID', input.tenantId); validateId('lease ID', input.leaseId); validateTicketPurpose(input.purpose)
    if (input.at) validateDate('ticket consumption time', input.at)
    const ticketHash = validateHash(input.ticketHash)
    const result = await this.pool.query(`
      UPDATE hosted_agent_tickets AS ticket
      SET consumed_at = $5
      FROM hosted_agent_leases AS lease
      WHERE ticket.ticket_hash = $1 AND ticket.lease_id = $2 AND ticket.purpose = $3
        AND ticket.lease_id = lease.lease_id AND lease.tenant_id = $4 AND lease.state = 'active'
        AND ticket.connection_generation = lease.connection_generation
        AND ticket.consumed_at IS NULL AND ticket.revoked_at IS NULL
        AND ticket.expires_at > $5
      RETURNING ticket.connection_generation::text
    `, [ticketHash, input.leaseId, input.purpose, input.tenantId, input.at ?? new Date()])
    const generation = (result.rows[0] as { connection_generation?: string } | undefined)?.connection_generation
    return generation === undefined ? null : Number(generation)
  }

  async revokeLeaseTickets(tenantId: string, leaseId: string): Promise<number> {
    validateId('tenant ID', tenantId); validateId('lease ID', leaseId)
    const result = await this.pool.query(`
      UPDATE hosted_agent_tickets AS ticket SET revoked_at = COALESCE(ticket.revoked_at, now())
      FROM hosted_agent_leases AS lease
      WHERE ticket.lease_id = lease.lease_id AND lease.lease_id = $1 AND lease.tenant_id = $2
        AND ticket.revoked_at IS NULL
    `, [leaseId, tenantId])
    return result.rowCount ?? 0
  }

  async cleanupTickets(before = new Date(), limit = 1000): Promise<number> {
    validateDate('ticket cleanup time', before)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('invalid ticket cleanup limit')
    const result = await this.pool.query(`
      DELETE FROM hosted_agent_tickets
      WHERE ctid IN (
        SELECT ctid FROM hosted_agent_tickets
        WHERE expires_at < $1 OR consumed_at < $1 OR revoked_at < $1
        LIMIT $2
      )
    `, [before, limit])
    return result.rowCount ?? 0
  }

  private async lockLease(client: PoolClient, tenantId: string, leaseId: string): Promise<Lease> {
    const result = await client.query<LeaseRow>(`
      SELECT ${leaseColumns} FROM hosted_agent_leases
      WHERE lease_id = $1 AND tenant_id = $2 FOR UPDATE
    `, [leaseId, tenantId])
    if (!result.rows[0]) throw new DurableStateNotFoundError('lease was not found')
    return leaseFromRow(result.rows[0])
  }

  private async insertSnapshot(client: PoolClient, tenantId: string, leaseId: string, snapshot: SnapshotInput): Promise<void> {
    await client.query(`
      INSERT INTO hosted_agent_snapshots
        (snapshot_id, tenant_id, lease_id, provider_snapshot_id, workspace_archive_object_id,
         manifest_object_id, manifest_checksum, state, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'available', $8)
    `, [snapshot.snapshotId, tenantId, leaseId, snapshot.providerSnapshotId,
      snapshot.workspaceArchiveObjectId, snapshot.manifestObjectId, snapshot.manifestChecksum,
      snapshot.expiresAt ?? null])
  }

  private async snapshotWithClient(client: PoolClient, tenantId: string, snapshotId: string): Promise<Snapshot> {
    const result = await client.query<SnapshotRow>(`
      SELECT ${snapshotColumns} FROM hosted_agent_snapshots WHERE snapshot_id = $1 AND tenant_id = $2
    `, [snapshotId, tenantId])
    if (!result.rows[0]) throw new DurableStateNotFoundError('snapshot was not found')
    return snapshotFromRow(result.rows[0])
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
    await client.query(`
      INSERT INTO hosted_agent_object_references
        (object_id, reference_kind, reference_id, purpose, retain_until)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (object_id, reference_kind, reference_id, purpose)
      DO UPDATE SET retain_until = CASE
        WHEN hosted_agent_object_references.retain_until IS NULL OR EXCLUDED.retain_until IS NULL THEN NULL
        ELSE GREATEST(hosted_agent_object_references.retain_until, EXCLUDED.retain_until)
      END
    `, [objectId, referenceKind, referenceId, purpose, retainUntil])
  }

  private async lockAvailableObject(client: PoolClient, tenantId: string, objectId: string,
    expectedKind?: StoredObject['kind']): Promise<void> {
    const result = await client.query(`
      SELECT 1 FROM hosted_agent_objects
      WHERE object_id = $1 AND tenant_id = $2 AND state = 'available'
        AND ($3::text IS NULL OR kind = $3)
      FOR UPDATE
    `, [objectId, tenantId, expectedKind ?? null])
    if (result.rowCount !== 1) throw new DurableStateNotFoundError('object was not found')
  }

  private async lockObjectLocation(client: PoolClient, storageBucket: string, storageKey: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`hosted-agent:object-location:${JSON.stringify([storageBucket, storageKey])}`])
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
  validateRoots(input.cwdUri, input.workspaceRootUris)
  if (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1) throw new Error('invalid policy version')
}
