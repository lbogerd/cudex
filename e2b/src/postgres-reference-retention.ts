import type { Pool, PoolClient } from 'pg'
import { createHash } from 'node:crypto'
import type { ReferenceClearRequest, RetentionRequest, RetentionResponse } from './types.js'
import { ServiceError } from './types.js'
import { begin, commit, lockLeaseTransaction, rollbackQuietly, setLocalLockTimeout } from './db/primitives.js'
import { addCodexArtifactReference, addCodexSnapshotReferences, authorizeCodexArtifact,
  authorizeCodexLease, authorizeCodexSnapshot, clearCodexReferenceSet,
  copyCodexArtifactObjectReferences, copyCodexSnapshotObjectReferences,
  deleteCodexArtifactReferences, deleteCodexObjectReferences,
  deleteOtherCodexArtifactReferences, deleteOtherCodexSnapshotReferences,
  insertCodexReferenceSet, lockCodexReferenceSet, removeReleasedLeaseRoots,
  updateCodexReferenceSet, assertCodexReferencesSynchronized } from './db/queries/objects.queries.js'

function validId(value: string): boolean {
  return value.length > 0 && value === value.trim() && Buffer.byteLength(value) <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Synchronizes the exact durable snapshots/artifact currently held by one Codex thread. */
export class PostgresReferenceRetention {
  constructor(private readonly pool: Pool, private readonly tenantId: string) {
    if (!validId(tenantId)) throw new Error('invalid tenant ID')
  }

  async retain(input: RetentionRequest): Promise<RetentionResponse> {
    if (![input.agentId, input.leaseId, input.baseSnapshotId, input.latestSnapshotId]
      .every(validId) || (input.artifactId !== null && !validId(input.artifactId))) {
      throw new ServiceError(400, 'invalid retention request')
    }
    const client = await this.pool.connect()
    try {
      await begin(client)
      await setLocalLockTimeout(client)
      await lockLeaseTransaction(client, `codex-reference:${this.tenantId}:${input.agentId}`)
      await this.authorizeLease(client, input)
      await this.authorizeSnapshot(client, input.agentId, input.baseSnapshotId)
      await this.authorizeSnapshot(client, input.agentId, input.latestSnapshotId)
      if (input.artifactId !== null) await this.authorizeArtifact(client, input.agentId, input.artifactId)
      const desiredHash = createHash('sha256').update(JSON.stringify([
        input.agentId, input.leaseId, input.baseSnapshotId, input.latestSnapshotId, input.artifactId,
      ])).digest('hex')
      const existing = await lockCodexReferenceSet.run({ tenantId: this.tenantId, agentId: input.agentId }, client)
      let revision: number
      if (!existing[0]) {
        if (input.expectedRevision !== null) throw new ServiceError(409, 'reference revision mismatch')
        revision = 1
        await insertCodexReferenceSet.run({ tenantId: this.tenantId, agentId: input.agentId,
          leaseId: input.leaseId, baseSnapshotId: input.baseSnapshotId,
          latestSnapshotId: input.latestSnapshotId, artifactId: input.artifactId, revision, desiredHash }, client)
      } else {
        if (existing[0].cleared_at !== null) {
          throw new ServiceError(409, 'references were permanently cleared')
        }
        const currentRevision = Number(existing[0].revision)
        if (!Number.isSafeInteger(currentRevision) || currentRevision <= 0
          || (input.expectedRevision !== null && input.expectedRevision > currentRevision)
          || (existing[0].desired_hash !== desiredHash
            && input.expectedRevision !== currentRevision)) {
          throw new ServiceError(409, 'reference revision mismatch')
        }
        revision = existing[0].desired_hash === desiredHash
          ? currentRevision : currentRevision + 1
        if (!Number.isSafeInteger(revision)) throw new ServiceError(503, 'reference revision exhausted')
        if (revision !== currentRevision) await updateCodexReferenceSet.run({ tenantId: this.tenantId,
          agentId: input.agentId, leaseId: input.leaseId, baseSnapshotId: input.baseSnapshotId,
          latestSnapshotId: input.latestSnapshotId, artifactId: input.artifactId, revision, desiredHash }, client)
      }
      const snapshotIds = [...new Set([input.baseSnapshotId, input.latestSnapshotId])]
      await addCodexSnapshotReferences.run({ tenantId: this.tenantId, snapshotIds, agentId: input.agentId }, client)
      await deleteOtherCodexSnapshotReferences.run({ tenantId: this.tenantId, snapshotIds, agentId: input.agentId }, client)
      if (input.artifactId === null) {
        await deleteCodexArtifactReferences.run({ tenantId: this.tenantId, agentId: input.agentId }, client)
      } else {
        await addCodexArtifactReference.run({ artifactId: input.artifactId, agentId: input.agentId }, client)
        await deleteOtherCodexArtifactReferences.run({ tenantId: this.tenantId,
          agentId: input.agentId, artifactId: input.artifactId }, client)
      }
      await deleteCodexObjectReferences.run({ tenantId: this.tenantId, agentId: input.agentId }, client)
      await copyCodexSnapshotObjectReferences.run({ tenantId: this.tenantId, snapshotIds,
        agentId: input.agentId, baseSnapshotId: input.baseSnapshotId }, client)
      if (input.artifactId !== null) {
        await copyCodexArtifactObjectReferences.run({ tenantId: this.tenantId,
          artifactId: input.artifactId, agentId: input.agentId }, client)
      }
      await commit(client)
      return { revision, desiredHash }
    } catch (error) {
      await rollbackQuietly(client)
      if (error instanceof ServiceError) throw error
      throw new ServiceError(503, 'service unavailable')
    } finally { client.release() }
  }

  /** Permanently clears one deleted Codex thread's exact roots with revision fencing. */
  async clear(input: ReferenceClearRequest): Promise<RetentionResponse> {
    if (![input.agentId, input.leaseId].every(validId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
      throw new ServiceError(400, 'invalid reference clear request')
    }
    const client = await this.pool.connect()
    try {
      await begin(client)
      await setLocalLockTimeout(client)
      await lockLeaseTransaction(client, `codex-reference:${this.tenantId}:${input.agentId}`)
      const existing = await lockCodexReferenceSet.run({ tenantId: this.tenantId, agentId: input.agentId }, client)
      const row = existing[0]
      if (!row || row.lease_id !== input.leaseId) throw new ServiceError(404, 'references missing')
      const currentRevision = Number(row.revision)
      if (!Number.isSafeInteger(currentRevision) || currentRevision <= 0
        || input.expectedRevision > currentRevision
        || (row.cleared_at === null && input.expectedRevision !== currentRevision)) {
        throw new ServiceError(409, 'reference revision mismatch')
      }
      let revision = currentRevision
      let desiredHash = row.desired_hash
      if (row.cleared_at === null) {
        revision = currentRevision + 1
        if (!Number.isSafeInteger(revision)) throw new ServiceError(503, 'reference revision exhausted')
        desiredHash = createHash('sha256').update(JSON.stringify([input.agentId])).digest('hex')
        await clearCodexReferenceSet.run({ tenantId: this.tenantId, agentId: input.agentId,
          revision, desiredHash }, client)
      }
      await deleteCodexArtifactReferences.run({ tenantId: this.tenantId, agentId: input.agentId }, client)
      await deleteCodexObjectReferences.run({ tenantId: this.tenantId, agentId: input.agentId }, client)
      await deleteOtherCodexSnapshotReferences.run({ tenantId: this.tenantId,
        agentId: input.agentId, snapshotIds: [] }, client)
      await commit(client)
      return { revision, desiredHash }
    } catch (error) {
      await rollbackQuietly(client)
      if (error instanceof ServiceError) throw error
      throw new ServiceError(503, 'service unavailable')
    } finally { client.release() }
  }

  async assertSynchronized(client: PoolClient, leaseId: string): Promise<void> {
    const result = await assertCodexReferencesSynchronized.run({ tenantId: this.tenantId, leaseId }, client)
    if (result.length !== 1) throw new ServiceError(409, 'durable references are not synchronized')
  }

  async removeReleasedLeaseRoots(client: PoolClient, leaseId: string): Promise<void> {
    await removeReleasedLeaseRoots.run({ leaseId }, client)
  }

  private async authorizeLease(client: PoolClient, input: RetentionRequest): Promise<void> {
    const result = await authorizeCodexLease.run({ tenantId: this.tenantId,
      leaseId: input.leaseId, agentId: input.agentId }, client)
    if (result.length !== 1) throw new ServiceError(404, 'lease missing')
  }

  private async authorizeSnapshot(client: PoolClient, agentId: string, snapshotId: string): Promise<void> {
    const result = await authorizeCodexSnapshot.run({ tenantId: this.tenantId, snapshotId, agentId }, client)
    if (result.length !== 1) throw new ServiceError(404, 'snapshot missing')
  }

  private async authorizeArtifact(client: PoolClient, agentId: string, artifactId: string): Promise<void> {
    const result = await authorizeCodexArtifact.run({ tenantId: this.tenantId, artifactId, agentId }, client)
    if (result.length !== 1) throw new ServiceError(404, 'artifact missing')
  }
}
