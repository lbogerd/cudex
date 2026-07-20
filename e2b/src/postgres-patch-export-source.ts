import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ObjectStore } from './blob-store.js'
import { parseWorkspaceManifest, type WorkspaceManifest } from './workspace-manifest.js'
import { ServiceError } from './types.js'

interface SnapshotMaterialRow {
  snapshot_id: string
  lease_id: string
  manifest_object_id: string
  manifest_checksum: string
  snapshot_state: string
  snapshot_expires_at: Date | null
  object_id: string
  kind: 'manifest' | 'content_blob'
  storage_bucket: string
  storage_key: string
  checksum: string
  size_bytes: string
  object_state: string
  object_expires_at: Date | null
  purpose: string
}

export interface ResolvedPatchSnapshot {
  snapshotId: string
  manifestObjectId: string
  manifest: WorkspaceManifest
  contentObjects: Array<{ objectId: string; checksum: string; sizeBytes: number }>
}

export interface ResolvedPatchExportSource {
  lease: {
    leaseId: string
    agentId: string
    ownerAgentId: string | null
    baseSnapshotId: string
    latestSnapshotId: string
  }
  base: ResolvedPatchSnapshot
  current: ResolvedPatchSnapshot
}

type Queryable = Pick<PoolClient, 'query'>

/** Resolves only tenant-owned, referenced, checksum-verified snapshot material. */
export class PostgresPatchExportSourceResolver {
  constructor(private readonly pool: Pool, private readonly objects: ObjectStore) {}

  async resolve(input: { tenantId: string; leaseId: string; agentId: string;
    baseSnapshotId: string; rootSourceSnapshotId?: string }, executor: Queryable = this.pool): Promise<ResolvedPatchExportSource> {
    try {
      const leaseResult = await executor.query<{
        lease_id: string; agent_id: string; owner_agent_id: string | null; owner_lease_id: string | null
        source_snapshot_id: string | null
        base_snapshot_id: string | null; latest_snapshot_id: string | null; state: string
      }>(`
        SELECT lease_id, agent_id, owner_agent_id, owner_lease_id, source_snapshot_id,
               base_snapshot_id, latest_snapshot_id, state
        FROM hosted_agent_leases WHERE tenant_id = $1 AND lease_id = $2
      `, [input.tenantId, input.leaseId])
      const lease = leaseResult.rows[0]
      if (!lease) throw new ServiceError(404, 'lease missing')
      const allowedOwner = input.rootSourceSnapshotId === undefined
        ? lease.owner_agent_id !== null
        : lease.owner_agent_id === null && lease.owner_lease_id === null
          && lease.source_snapshot_id === input.rootSourceSnapshotId
      if (!['active', 'paused'].includes(lease.state) || lease.agent_id !== input.agentId
        || !allowedOwner || lease.base_snapshot_id !== input.baseSnapshotId
        || lease.latest_snapshot_id === null) throw new ServiceError(409, 'lease cannot export a patch')
      const snapshots = await Promise.all([
        this.snapshot(executor, input.tenantId, lease.lease_id, input.baseSnapshotId),
        this.snapshot(executor, input.tenantId, lease.lease_id, lease.latest_snapshot_id),
      ])
      return {
        lease: { leaseId: lease.lease_id, agentId: lease.agent_id,
          ownerAgentId: lease.owner_agent_id, baseSnapshotId: lease.base_snapshot_id,
          latestSnapshotId: lease.latest_snapshot_id },
        base: snapshots[0], current: snapshots[1],
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(503, 'patch export source unavailable')
    }
  }

  private async snapshot(executor: Queryable, tenantId: string, leaseId: string,
    snapshotId: string): Promise<ResolvedPatchSnapshot> {
    const result = await executor.query<SnapshotMaterialRow>(`
      SELECT snapshot.snapshot_id, snapshot.lease_id, snapshot.manifest_object_id,
             snapshot.manifest_checksum, snapshot.state AS snapshot_state,
             snapshot.expires_at AS snapshot_expires_at,
             object_row.object_id, object_row.kind, object_row.storage_bucket,
             object_row.storage_key, object_row.checksum, object_row.size_bytes::text,
             object_row.state AS object_state, object_row.expires_at AS object_expires_at,
             reference.purpose
      FROM hosted_agent_snapshots AS snapshot
      JOIN hosted_agent_object_references AS reference
        ON reference.reference_kind = 'snapshot' AND reference.reference_id = snapshot.snapshot_id
      JOIN hosted_agent_objects AS object_row
        ON object_row.object_id = reference.object_id AND object_row.tenant_id = snapshot.tenant_id
      WHERE snapshot.tenant_id = $1 AND snapshot.lease_id = $2 AND snapshot.snapshot_id = $3
        AND reference.purpose IN ('manifest', 'content_blob')
      ORDER BY object_row.object_id
    `, [tenantId, leaseId, snapshotId])
    if (result.rows.length === 0) throw new ServiceError(404, 'snapshot missing')
    const now = new Date()
    const first = result.rows[0]!
    if (first.snapshot_state !== 'available'
      || (first.snapshot_expires_at !== null && first.snapshot_expires_at <= now)) {
      throw new ServiceError(404, 'snapshot missing')
    }
    const manifests = result.rows.filter(row => row.purpose === 'manifest'
      && row.kind === 'manifest' && row.object_id === first.manifest_object_id)
    if (manifests.length !== 1 || manifests[0]!.checksum !== first.manifest_checksum) {
      throw new ServiceError(503, 'patch export manifest unavailable')
    }
    const manifestBytes = await this.verifiedBytes(manifests[0]!, now)
    const manifest = parseWorkspaceManifest(manifestBytes, snapshotId, first.manifest_checksum)
    const contentRows = result.rows.filter(row => row.purpose === 'content_blob'
      && row.kind === 'content_blob')
    const contentObjects: ResolvedPatchSnapshot['contentObjects'] = []
    for (const row of contentRows) {
      await this.verifiedBytes(row, now)
      contentObjects.push({ objectId: row.object_id, checksum: row.checksum,
        sizeBytes: Number(row.size_bytes) })
    }
    return { snapshotId, manifestObjectId: first.manifest_object_id, manifest, contentObjects }
  }

  private async verifiedBytes(row: SnapshotMaterialRow, now: Date): Promise<Uint8Array> {
    if (row.object_state !== 'available'
      || (row.object_expires_at !== null && row.object_expires_at <= now)
      || !/^sha256:[0-9a-f]{64}$/u.test(row.checksum)) {
      throw new ServiceError(503, 'patch export object unavailable')
    }
    const physicalId = row.checksum.slice('sha256:'.length)
    const location = this.objects.location(physicalId)
    if (location.storageBucket !== row.storage_bucket || location.storageKey !== row.storage_key) {
      throw new ServiceError(503, 'patch export object unavailable')
    }
    const bytes = await this.objects.get(physicalId)
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (checksum !== row.checksum || bytes.byteLength !== Number(row.size_bytes)) {
      throw new ServiceError(503, 'patch export object unavailable')
    }
    return bytes
  }
}
