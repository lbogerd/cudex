import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ObjectStore } from './blob-store.js'
import { parseWorkspaceManifest, type WorkspaceManifest } from './workspace-manifest.js'
import { ServiceError } from './types.js'
import type { IDatabaseConnection } from '@pgtyped/runtime'
import { resolvePatchExportLease, resolvePatchExportSnapshotMaterial,
  type IResolvePatchExportSnapshotMaterialResult } from './db/queries/patches.queries.js'

type SnapshotMaterialRow = IResolvePatchExportSnapshotMaterialResult

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
function connection(executor: Queryable): IDatabaseConnection { return executor as IDatabaseConnection }

/** Resolves only tenant-owned, referenced, checksum-verified snapshot material. */
export class PostgresPatchExportSourceResolver {
  constructor(private readonly pool: Pool, private readonly objects: ObjectStore) {}

  async resolve(input: { tenantId: string; leaseId: string; agentId: string;
    baseSnapshotId: string; rootSourceSnapshotId?: string }, executor: Queryable = this.pool): Promise<ResolvedPatchExportSource> {
    try {
      const [lease] = await resolvePatchExportLease.run({ tenantId: input.tenantId, leaseId: input.leaseId }, connection(executor))
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
    const rows = await resolvePatchExportSnapshotMaterial.run({ tenantId, leaseId, snapshotId }, connection(executor))
    if (rows.length === 0) throw new ServiceError(404, 'snapshot missing')
    const now = new Date()
    const first = rows[0]!
    if (first.snapshot_state !== 'available'
      || (first.snapshot_expires_at !== null && first.snapshot_expires_at <= now)) {
      throw new ServiceError(404, 'snapshot missing')
    }
    const manifests = rows.filter(row => row.purpose === 'manifest'
      && row.kind === 'manifest' && row.object_id === first.manifest_object_id)
    if (manifests.length !== 1 || manifests[0]!.checksum !== first.manifest_checksum) {
      throw new ServiceError(503, 'patch export manifest unavailable')
    }
    const manifestBytes = await this.verifiedBytes(manifests[0]!, now)
    const manifest = parseWorkspaceManifest(manifestBytes, snapshotId, first.manifest_checksum)
    const contentRows = rows.filter(row => row.purpose === 'content_blob'
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
