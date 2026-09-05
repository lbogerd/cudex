import type { IDatabaseConnection } from '@pgtyped/runtime'
import type { PoolClient } from 'pg'
import { resolvePatchExportLease, type IResolvePatchExportLeaseResult } from './db/queries/patches.queries.js'
import { ServiceError } from './types.js'

type Queryable = Pick<PoolClient, 'query'>
export type LineageLease = IResolvePatchExportLeaseResult

/** Follow only the immutable, authenticated restore chain, never arbitrary same-agent leases. */
export async function resolveRestoreLineage(executor: Queryable, tenantId: string,
  leaseId: string): Promise<LineageLease[]> {
  const chain: LineageLease[] = []
  const seen = new Set<string>()
  let next: string | null = leaseId
  while (next !== null) {
    if (chain.length >= 32 || seen.has(next)) throw new ServiceError(409, 'invalid restore lineage')
    seen.add(next)
    const [lease] = await resolvePatchExportLease.run({ tenantId, leaseId: next }, executor as IDatabaseConnection)
    if (!lease) throw new ServiceError(404, chain.length === 0 ? 'lease missing' : 'restore lineage missing')
    const child = chain.at(-1)
    if (child && (!['lost', 'released'].includes(lease.state)
      || child.agent_id !== lease.agent_id || child.owner_agent_id !== lease.owner_agent_id
      || child.owner_lease_id !== lease.owner_lease_id || child.sandbox_template !== lease.sandbox_template
      || child.cwd_uri !== lease.cwd_uri
      || JSON.stringify(child.workspace_root_uris) !== JSON.stringify(lease.workspace_root_uris)
      || child.restore_source_snapshot_id !== lease.latest_snapshot_id
      || child.source_snapshot_id !== null)) {
      throw new ServiceError(409, 'restore lineage identity mismatch')
    }
    if ((lease.restore_source_lease_id === null) !== (lease.restore_source_snapshot_id === null)) {
      throw new ServiceError(409, 'incomplete restore lineage')
    }
    chain.push(lease)
    next = lease.restore_source_lease_id
  }
  return chain
}

/** Baselines may only be the canonical base of this lease or a proven restore ancestor. */
export function baselineLease(chain: readonly LineageLease[], snapshotId: string): LineageLease {
  const lease = chain.find(candidate => candidate.base_snapshot_id === snapshotId)
  if (!lease) throw new ServiceError(409, 'snapshot is not an authorized restore baseline')
  return lease
}

/** A restored root is valid only when its chain accounts for every root in the run. */
export async function selectRootLease<T extends { leaseId: string; ownerAgentId: string | null; ownerLeaseId: string | null }>(
  executor: Queryable, tenantId: string, leases: readonly T[]): Promise<T | undefined> {
  const roots = leases.filter(lease => lease.ownerAgentId === null && lease.ownerLeaseId === null)
  if (roots.length === 0) return undefined
  if (roots.length > 32) throw new ServiceError(409, 'root restore lineage exceeds its bound')
  const rootIds = new Set(roots.map(lease => lease.leaseId))
  const candidates: T[] = []
  for (const root of roots) {
    const chain = await resolveRestoreLineage(executor, tenantId, root.leaseId)
    if (chain.length === roots.length && chain.every(lease => rootIds.has(lease.lease_id))) candidates.push(root)
  }
  if (candidates.length !== 1) throw new ServiceError(409, 'run has ambiguous root lineage')
  return candidates[0]
}
