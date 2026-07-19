import type { Pool, PoolClient } from 'pg'
import {
  OperationOwnershipError,
  type OperationIdentity,
} from './postgres-store.js'

const checksumPattern = /^sha256:[0-9a-f]{64}$/u

export type PatchApplicationPhase =
  | 'planned'
  | 'rollback_ready'
  | 'swap_started'
  | 'swapped'
  | 'checkpointed'
  | 'rollback_started'
  | 'rolled_back'
  | 'failed'

export interface PatchApplicationFence extends OperationIdentity {
  generation: number
  workerId: string
}

export interface CreatePatchApplicationInput extends OperationIdentity {
  applicationId: string
  createdGeneration: number
  targetLeaseId: string
  artifactId: string
  sourceTargetSnapshotId: string
  targetProviderSandboxId: string
  resultSnapshotId: string
  resultManifestChecksum: string
  resultArchiveChecksum: string
  resultArchiveSizeBytes: number
}

export interface PatchApplication {
  applicationId: string
  operation: string
  idempotencyKey: string
  tenantId: string
  createdGeneration: number
  targetLeaseId: string
  artifactId: string
  sourceTargetSnapshotId: string
  targetProviderSandboxId: string
  resultSnapshotId: string
  resultManifestChecksum: string
  resultArchiveChecksum: string
  resultArchiveSizeBytes: number
  rollbackAllocationId: string | null
  rollbackProviderSnapshotId: string | null
  phase: PatchApplicationPhase
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
  rollbackReadyAt: Date | null
  swapStartedAt: Date | null
  swappedAt: Date | null
  checkpointedAt: Date | null
  rollbackStartedAt: Date | null
  rolledBackAt: Date | null
  failedAt: Date | null
}

interface ApplicationRow {
  application_id: string
  operation: string
  idempotency_key: string
  tenant_id: string
  created_generation: string
  target_lease_id: string
  artifact_id: string
  source_target_snapshot_id: string
  target_provider_sandbox_id: string
  result_snapshot_id: string
  result_manifest_checksum: string
  result_archive_checksum: string
  result_archive_size_bytes: string
  rollback_allocation_id: string | null
  rollback_provider_snapshot_id: string | null
  phase: PatchApplicationPhase
  error_message: string | null
  created_at: Date
  updated_at: Date
  rollback_ready_at: Date | null
  swap_started_at: Date | null
  swapped_at: Date | null
  checkpointed_at: Date | null
  rollback_started_at: Date | null
  rolled_back_at: Date | null
  failed_at: Date | null
}

const columns = `application.application_id, application.operation,
  application.idempotency_key, application.tenant_id,
  application.created_generation::text, application.target_lease_id,
  application.artifact_id, application.source_target_snapshot_id,
  application.target_provider_sandbox_id, application.result_snapshot_id,
  application.result_manifest_checksum, application.result_archive_checksum,
  application.result_archive_size_bytes::text,
  application.rollback_allocation_id::text, application.rollback_provider_snapshot_id,
  application.phase, application.error_message, application.created_at,
  application.updated_at, application.rollback_ready_at,
  application.swap_started_at, application.swapped_at, application.checkpointed_at,
  application.rollback_started_at, application.rolled_back_at, application.failed_at`

export class PatchApplicationConflictError extends Error {}

function validateId(label: string, value: string, maxBytes = 512): void {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || Buffer.byteLength(value) > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid ${label}`)
  }
}

function validateGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid operation generation')
}

function validateIdentity(identity: OperationIdentity): void {
  validateId('operation', identity.operation, 128)
  validateId('idempotency key', identity.idempotencyKey)
  validateId('tenant ID', identity.tenantId)
}

function validateFence(fence: PatchApplicationFence): void {
  validateIdentity(fence); validateGeneration(fence.generation)
  validateId('worker ID', fence.workerId)
}

function validateInput(input: CreatePatchApplicationInput): void {
  validateIdentity(input); validateGeneration(input.createdGeneration)
  validateId('application ID', input.applicationId)
  validateId('target lease ID', input.targetLeaseId)
  validateId('artifact ID', input.artifactId)
  validateId('source target snapshot ID', input.sourceTargetSnapshotId)
  validateId('target provider sandbox ID', input.targetProviderSandboxId, 2048)
  validateId('result snapshot ID', input.resultSnapshotId)
  if (!checksumPattern.test(input.resultManifestChecksum)
    || !checksumPattern.test(input.resultArchiveChecksum)) throw new Error('invalid patch application checksum')
  if (!Number.isSafeInteger(input.resultArchiveSizeBytes) || input.resultArchiveSizeBytes < 0) {
    throw new Error('invalid patch application archive size')
  }
}

function fromRow(row: ApplicationRow): PatchApplication {
  return {
    applicationId: row.application_id, operation: row.operation,
    idempotencyKey: row.idempotency_key, tenantId: row.tenant_id,
    createdGeneration: Number(row.created_generation), targetLeaseId: row.target_lease_id,
    artifactId: row.artifact_id, sourceTargetSnapshotId: row.source_target_snapshot_id,
    targetProviderSandboxId: row.target_provider_sandbox_id,
    resultSnapshotId: row.result_snapshot_id,
    resultManifestChecksum: row.result_manifest_checksum,
    resultArchiveChecksum: row.result_archive_checksum,
    resultArchiveSizeBytes: Number(row.result_archive_size_bytes),
    rollbackAllocationId: row.rollback_allocation_id,
    rollbackProviderSnapshotId: row.rollback_provider_snapshot_id,
    phase: row.phase, errorMessage: row.error_message, createdAt: row.created_at,
    updatedAt: row.updated_at, rollbackReadyAt: row.rollback_ready_at,
    swapStartedAt: row.swap_started_at, swappedAt: row.swapped_at,
    checkpointedAt: row.checkpointed_at, rollbackStartedAt: row.rollback_started_at,
    rolledBackAt: row.rolled_back_at, failedAt: row.failed_at,
  }
}

function sameIdentity(application: PatchApplication, input: CreatePatchApplicationInput): boolean {
  return application.applicationId === input.applicationId
    && application.operation === input.operation
    && application.idempotencyKey === input.idempotencyKey
    && application.tenantId === input.tenantId
    && application.createdGeneration === input.createdGeneration
    && application.targetLeaseId === input.targetLeaseId
    && application.artifactId === input.artifactId
    && application.sourceTargetSnapshotId === input.sourceTargetSnapshotId
    && application.targetProviderSandboxId === input.targetProviderSandboxId
    && application.resultSnapshotId === input.resultSnapshotId
    && application.resultManifestChecksum === input.resultManifestChecksum
    && application.resultArchiveChecksum === input.resultArchiveChecksum
    && application.resultArchiveSizeBytes === input.resultArchiveSizeBytes
}

export class PostgresPatchApplicationRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreatePatchApplicationInput, fence: PatchApplicationFence,
    executor?: PoolClient): Promise<PatchApplication> {
    validateInput(input); validateFence(fence)
    if (input.operation !== fence.operation || input.idempotencyKey !== fence.idempotencyKey
      || input.tenantId !== fence.tenantId || input.createdGeneration !== fence.generation) {
      throw new Error('patch application fence does not match its identity')
    }
    return this.inTransaction(executor, async client => {
      await client.query(`
        INSERT INTO hosted_agent_patch_applications
          (application_id, operation, idempotency_key, tenant_id, created_generation,
           target_lease_id, artifact_id, source_target_snapshot_id,
           target_provider_sandbox_id, result_snapshot_id, result_manifest_checksum,
           result_archive_checksum, result_archive_size_bytes, phase)
        SELECT $6, operation, idempotency_key, tenant_id, $4, $7, $8, $9,
               $10, $11, $12, $13, $14, 'planned'
        FROM hosted_agent_operations
        WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
          AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
          AND primary_lease_id = $7
        ON CONFLICT DO NOTHING
      `, [fence.operation, fence.idempotencyKey, fence.tenantId, fence.generation,
        fence.workerId, input.applicationId, input.targetLeaseId, input.artifactId,
        input.sourceTargetSnapshotId, input.targetProviderSandboxId,
        input.resultSnapshotId, input.resultManifestChecksum,
        input.resultArchiveChecksum, input.resultArchiveSizeBytes])
      const application = await this.lockedForOperation(client, fence)
      if (!application) {
        const owned = await client.query(`
          SELECT 1 FROM hosted_agent_operations
          WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
            AND generation = $4 AND worker_id = $5 AND state = 'in_progress'
          FOR UPDATE
        `, [fence.operation, fence.idempotencyKey, fence.tenantId,
          fence.generation, fence.workerId])
        if (owned.rowCount === 1) {
          throw new PatchApplicationConflictError(
            'patch application identity conflicts with its durable record')
        }
        throw new OperationOwnershipError()
      }
      if (!sameIdentity(application, input)) {
        throw new PatchApplicationConflictError('patch application identity conflicts with its durable record')
      }
      return application
    })
  }

  async getForOperation(identity: OperationIdentity,
    executor: Pick<PoolClient, 'query'> = this.pool): Promise<PatchApplication | null> {
    validateIdentity(identity)
    const result = await executor.query<ApplicationRow>(`
      SELECT ${columns}
      FROM hosted_agent_patch_applications AS application
      WHERE application.operation = $1 AND application.idempotency_key = $2
        AND application.tenant_id = $3
    `, [identity.operation, identity.idempotencyKey, identity.tenantId])
    return result.rows[0] ? fromRow(result.rows[0]) : null
  }

  async recordRollback(fence: PatchApplicationFence, applicationId: string, rollback: {
    allocationId: string
    providerSnapshotId: string
  }, executor?: PoolClient): Promise<PatchApplication> {
    validateFence(fence); validateId('application ID', applicationId)
    if (!/^[1-9][0-9]*$/u.test(rollback.allocationId)) throw new Error('invalid rollback allocation ID')
    validateId('rollback provider snapshot ID', rollback.providerSnapshotId, 2048)
    return this.inTransaction(executor, async client => {
      const application = await this.locked(client, fence, applicationId)
      if (application.phase !== 'planned') {
        if (application.rollbackAllocationId === rollback.allocationId
          && application.rollbackProviderSnapshotId === rollback.providerSnapshotId) return application
        throw new PatchApplicationConflictError('patch application rollback identity conflicts')
      }
      const allocation = await client.query(`
        SELECT 1 FROM hosted_agent_operation_allocations
        WHERE allocation_id = $1::bigint AND operation = $2 AND idempotency_key = $3
          AND tenant_id = $4 AND allocation_kind = 'provider_snapshot'
          AND resource_id = $5 AND lease_id = $6 AND state = 'allocated'
          AND metadata ->> 'purpose' = 'patch_apply_rollback'
        FOR UPDATE
      `, [rollback.allocationId, fence.operation, fence.idempotencyKey, fence.tenantId,
        rollback.providerSnapshotId, application.targetLeaseId])
      if (allocation.rowCount !== 1) {
        throw new PatchApplicationConflictError('patch application rollback allocation is invalid')
      }
      return this.updated(client, applicationId, `
        phase = 'rollback_ready', rollback_allocation_id = $2::bigint,
        rollback_provider_snapshot_id = $3, rollback_ready_at = now()
      `, [rollback.allocationId, rollback.providerSnapshotId])
    })
  }

  async markSwapStarted(fence: PatchApplicationFence, applicationId: string,
    executor?: PoolClient): Promise<PatchApplication> {
    return this.transition(fence, applicationId, 'rollback_ready', 'swap_started',
      `phase = 'swap_started', swap_started_at = now()`, [], executor)
  }

  async markSwapped(fence: PatchApplicationFence, applicationId: string,
    executor?: PoolClient): Promise<PatchApplication> {
    return this.transition(fence, applicationId, 'swap_started', 'swapped',
      `phase = 'swapped', swapped_at = now()`, [], executor)
  }

  async markCheckpointed(fence: PatchApplicationFence, applicationId: string,
    executor?: PoolClient): Promise<PatchApplication> {
    validateFence(fence); validateId('application ID', applicationId)
    return this.inTransaction(executor, async client => {
      const application = await this.locked(client, fence, applicationId)
      if (application.phase !== 'swapped' && application.phase !== 'checkpointed') {
        throw new PatchApplicationConflictError('patch application is not ready to checkpoint')
      }
      await this.requireCheckpoint(client, application)
      if (application.phase === 'checkpointed') return application
      return this.updated(client, applicationId,
        `phase = 'checkpointed', checkpointed_at = now()`, [])
    })
  }

  async verifyCheckpointed(fence: PatchApplicationFence, applicationId: string,
    executor?: PoolClient): Promise<PatchApplication> {
    validateFence(fence); validateId('application ID', applicationId)
    return this.inTransaction(executor, async client => {
      const application = await this.locked(client, fence, applicationId)
      if (application.phase !== 'checkpointed') {
        throw new PatchApplicationConflictError('patch application is not checkpointed')
      }
      await this.requireCheckpoint(client, application)
      return application
    })
  }

  private async requireCheckpoint(client: Queryable, application: PatchApplication): Promise<void> {
      const snapshot = await client.query(`
        SELECT 1
        FROM hosted_agent_snapshots AS snapshot
        JOIN hosted_agent_leases AS lease
          ON lease.lease_id = snapshot.lease_id AND lease.tenant_id = snapshot.tenant_id
        JOIN hosted_agent_objects AS archive
          ON archive.object_id = snapshot.workspace_archive_object_id
         AND archive.tenant_id = snapshot.tenant_id
        WHERE snapshot.snapshot_id = $1 AND snapshot.lease_id = $2
          AND snapshot.tenant_id = $3 AND snapshot.state = 'available'
          AND snapshot.manifest_checksum = $4 AND lease.latest_snapshot_id = snapshot.snapshot_id
          AND lease.state IN ('active', 'paused')
          AND archive.kind = 'workspace_archive' AND archive.state = 'available'
          AND archive.checksum = $5 AND archive.size_bytes = $6
        FOR SHARE OF snapshot, lease, archive
      `, [application.resultSnapshotId, application.targetLeaseId,
        application.tenantId, application.resultManifestChecksum,
        application.resultArchiveChecksum, application.resultArchiveSizeBytes])
      if (snapshot.rowCount !== 1) {
        throw new PatchApplicationConflictError('patch application checkpoint is unavailable')
      }
  }

  async beginRollback(fence: PatchApplicationFence, applicationId: string,
    errorMessage: string, executor?: PoolClient): Promise<PatchApplication> {
    validateFence(fence); validateId('application ID', applicationId)
    if (Buffer.byteLength(errorMessage) > 4096) throw new Error('patch application error is too large')
    return this.inTransaction(executor, async client => {
      const application = await this.locked(client, fence, applicationId)
      if (application.phase === 'rollback_started' || application.phase === 'rolled_back') {
        return application
      }
      if (!['rollback_ready', 'swap_started', 'swapped'].includes(application.phase)) {
        throw new PatchApplicationConflictError('patch application cannot roll back')
      }
      return this.updated(client, applicationId, `
        phase = 'rollback_started', rollback_started_at = now(), error_message = $2
      `, [errorMessage])
    })
  }

  async markRolledBack(fence: PatchApplicationFence, applicationId: string,
    executor?: PoolClient): Promise<PatchApplication> {
    return this.transition(fence, applicationId, 'rollback_started', 'rolled_back',
      `phase = 'rolled_back', rolled_back_at = now()`, [], executor)
  }

  async markFailed(fence: PatchApplicationFence, applicationId: string,
    errorMessage: string, executor?: PoolClient): Promise<PatchApplication> {
    validateFence(fence); validateId('application ID', applicationId)
    if (Buffer.byteLength(errorMessage) > 4096) throw new Error('patch application error is too large')
    return this.transition(fence, applicationId, 'planned', 'failed',
      `phase = 'failed', failed_at = now(), error_message = $2`, [errorMessage], executor)
  }

  private async transition(fence: PatchApplicationFence, applicationId: string,
    expected: PatchApplicationPhase, next: PatchApplicationPhase, assignment: string,
    parameters: unknown[], executor?: PoolClient): Promise<PatchApplication> {
    validateFence(fence); validateId('application ID', applicationId)
    return this.inTransaction(executor, async client => {
      const application = await this.locked(client, fence, applicationId)
      if (application.phase === next) return application
      if (application.phase !== expected) {
        throw new PatchApplicationConflictError(`patch application cannot transition to ${next}`)
      }
      return this.updated(client, applicationId, assignment, parameters)
    })
  }

  private async locked(client: Queryable, fence: PatchApplicationFence,
    applicationId: string): Promise<PatchApplication> {
    const result = await client.query<ApplicationRow>(`
      SELECT ${columns}
      FROM hosted_agent_patch_applications AS application
      JOIN hosted_agent_operations AS operation
        USING (operation, idempotency_key, tenant_id)
      WHERE application.application_id = $1 AND application.tenant_id = $2
        AND operation.operation = $3 AND operation.idempotency_key = $4
        AND operation.generation = $5 AND operation.worker_id = $6
        AND operation.state = 'in_progress'
      FOR UPDATE OF application, operation
    `, [applicationId, fence.tenantId, fence.operation, fence.idempotencyKey,
      fence.generation, fence.workerId])
    if (!result.rows[0]) throw new OperationOwnershipError()
    return fromRow(result.rows[0])
  }

  private async lockedForOperation(client: Queryable,
    fence: PatchApplicationFence): Promise<PatchApplication | null> {
    const result = await client.query<ApplicationRow>(`
      SELECT ${columns}
      FROM hosted_agent_patch_applications AS application
      JOIN hosted_agent_operations AS operation
        USING (operation, idempotency_key, tenant_id)
      WHERE operation.operation = $1 AND operation.idempotency_key = $2
        AND operation.tenant_id = $3 AND operation.generation = $4
        AND operation.worker_id = $5 AND operation.state = 'in_progress'
      FOR UPDATE OF application, operation
    `, [fence.operation, fence.idempotencyKey, fence.tenantId,
      fence.generation, fence.workerId])
    return result.rows[0] ? fromRow(result.rows[0]) : null
  }

  private async updated(client: Queryable, applicationId: string, assignment: string,
    parameters: unknown[]): Promise<PatchApplication> {
    const result = await client.query<ApplicationRow>(`
      UPDATE hosted_agent_patch_applications AS application
      SET ${assignment}
      WHERE application_id = $1
      RETURNING ${columns}
    `, [applicationId, ...parameters])
    if (!result.rows[0]) throw new Error('patch application disappeared while locked')
    return fromRow(result.rows[0])
  }

  private async inTransaction<T>(executor: PoolClient | undefined,
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (executor) return fn(executor)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
}

type Queryable = Pick<PoolClient, 'query'>
