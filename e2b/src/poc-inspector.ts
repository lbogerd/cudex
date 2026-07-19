import { readFile } from 'node:fs/promises'
import { Pool, type QueryResult } from 'pg'
import { Sandbox } from 'e2b'
import { E2BProvider } from './e2b-provider.js'
import type { PocAppServerEvidence } from './poc-app-server-client.js'

export interface PocLeaseInspection {
  leaseId: string
  environmentId: string
  agentId: string
  ownerAgentId: string | null
  ownerLeaseId: string | null
  providerSandboxId: string | null
  baseSnapshotId: string | null
  latestSnapshotId: string | null
  state: string
}

export interface PocDatabaseInspection {
  leases: PocLeaseInspection[]
  operations: Array<{ operation: string; state: string; primaryLeaseId: string | null; resultLeaseId: string | null }>
  snapshots: Array<{ snapshotId: string; leaseId: string; providerSnapshotId: string | null; state: string }>
  artifacts: Array<{ artifactId: string; agentId: string; sourceLeaseId: string; state: string }>
  patchApplications: Array<{ applicationId: string; targetLeaseId: string; artifactId: string;
    sourceTargetSnapshotId: string; resultSnapshotId: string; phase: string }>
  allocations: Array<{ allocationKind: string; resourceId: string; leaseId: string | null; state: string }>
  liveTicketCount: number
  unfinishedInteractionCount: number
}

interface Queryable {
  query(sql: string, values: unknown[]): Promise<QueryResult<Record<string, unknown>>>
}

interface LeaseRow extends Record<string, unknown> {
  lease_id: string; environment_id: string; agent_id: string; owner_agent_id: string | null
  owner_lease_id: string | null; provider_sandbox_id: string | null; base_snapshot_id: string | null
  latest_snapshot_id: string | null; state: string
}

function numberValue(value: unknown): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('invalid POC inspection count')
  return result
}

export class PocDatabaseInspector {
  constructor(private readonly database: Queryable, readonly tenantId: string) {
    if (!tenantId || !tenantId.startsWith('poc-')) throw new Error('invalid POC inspection tenant')
  }

  async leases(): Promise<PocLeaseInspection[]> {
    const result = await this.database.query(`SELECT lease_id, environment_id, agent_id,
      owner_agent_id, owner_lease_id, provider_sandbox_id, base_snapshot_id, latest_snapshot_id, state
      FROM hosted_agent_leases WHERE tenant_id = $1 ORDER BY created_at`, [this.tenantId])
    return (result.rows as LeaseRow[]).map(row => ({ leaseId: row.lease_id, environmentId: row.environment_id,
      agentId: row.agent_id, ownerAgentId: row.owner_agent_id, ownerLeaseId: row.owner_lease_id,
      providerSandboxId: row.provider_sandbox_id, baseSnapshotId: row.base_snapshot_id,
      latestSnapshotId: row.latest_snapshot_id, state: row.state }))
  }

  async inspect(): Promise<PocDatabaseInspection> {
    const [leases, operations, snapshots, artifacts, applications, allocations, tickets, interactions] = await Promise.all([
      this.leases(),
      this.database.query(`SELECT operation, state, primary_lease_id, result_lease_id
        FROM hosted_agent_operations WHERE tenant_id = $1 ORDER BY started_at`, [this.tenantId]),
      this.database.query(`SELECT snapshot_id, lease_id, provider_snapshot_id, state
        FROM hosted_agent_snapshots WHERE tenant_id = $1 ORDER BY created_at`, [this.tenantId]),
      this.database.query(`SELECT artifact_id, agent_id, source_lease_id, state
        FROM hosted_agent_artifacts WHERE tenant_id = $1 ORDER BY created_at`, [this.tenantId]),
      this.database.query(`SELECT application_id, target_lease_id, artifact_id,
        source_target_snapshot_id, result_snapshot_id, phase
        FROM hosted_agent_patch_applications WHERE tenant_id = $1 ORDER BY created_at`, [this.tenantId]),
      this.database.query(`SELECT allocation_kind, resource_id, lease_id, state
        FROM hosted_agent_operation_allocations WHERE tenant_id = $1 ORDER BY allocation_id`, [this.tenantId]),
      this.database.query(`SELECT count(*)::text AS count FROM hosted_agent_tickets AS ticket
        JOIN hosted_agent_leases AS lease ON lease.lease_id = ticket.lease_id
        WHERE lease.tenant_id = $1 AND ticket.revoked_at IS NULL AND ticket.consumed_at IS NULL
          AND ticket.expires_at > now()`, [this.tenantId]),
      this.database.query(`SELECT count(*)::text AS count FROM hosted_agent_lease_interactions
        WHERE tenant_id = $1 AND finished_at IS NULL`, [this.tenantId]),
    ])
    return {
      leases,
      operations: operations.rows.map(row => ({ operation: String(row.operation), state: String(row.state),
        primaryLeaseId: row.primary_lease_id === null ? null : String(row.primary_lease_id),
        resultLeaseId: row.result_lease_id === null ? null : String(row.result_lease_id) })),
      snapshots: snapshots.rows.map(row => ({ snapshotId: String(row.snapshot_id), leaseId: String(row.lease_id),
        providerSnapshotId: row.provider_snapshot_id === null ? null : String(row.provider_snapshot_id), state: String(row.state) })),
      artifacts: artifacts.rows.map(row => ({ artifactId: String(row.artifact_id), agentId: String(row.agent_id),
        sourceLeaseId: String(row.source_lease_id), state: String(row.state) })),
      patchApplications: applications.rows.map(row => ({ applicationId: String(row.application_id),
        targetLeaseId: String(row.target_lease_id), artifactId: String(row.artifact_id),
        sourceTargetSnapshotId: String(row.source_target_snapshot_id), resultSnapshotId: String(row.result_snapshot_id),
        phase: String(row.phase) })),
      allocations: allocations.rows.map(row => ({ allocationKind: String(row.allocation_kind),
        resourceId: String(row.resource_id), leaseId: row.lease_id === null ? null : String(row.lease_id), state: String(row.state) })),
      liveTicketCount: numberValue(tickets.rows[0]?.count),
      unfinishedInteractionCount: numberValue(interactions.rows[0]?.count),
    }
  }
}

export interface PocFunctionalInspection {
  rootLease?: PocLeaseInspection
  childLease?: PocLeaseInspection
  artifactId?: string
  assertions: Record<string, boolean>
}

export function evaluatePocFunctionalInspection(
  database: PocDatabaseInspection, evidence: PocAppServerEvidence | undefined,
): PocFunctionalInspection {
  const rootLease = evidence ? database.leases.find(lease => lease.agentId === evidence.rootThreadId) :
    database.leases.find(lease => lease.ownerLeaseId === null)
  const childLease = evidence?.childThreadId ? database.leases.find(lease => lease.agentId === evidence.childThreadId) :
    database.leases.find(lease => lease.ownerLeaseId !== null)
  const artifact = childLease ? database.artifacts.find(item => item.sourceLeaseId === childLease.leaseId && item.state === 'available') : undefined
  const application = rootLease && artifact ? database.patchApplications.find(item =>
    item.targetLeaseId === rootLease.leaseId && item.artifactId === artifact.artifactId) : undefined
  const assertions = {
    rootLeaseExists: Boolean(rootLease), childLeaseExists: Boolean(childLease),
    distinctLeaseIds: Boolean(rootLease && childLease && rootLease.leaseId !== childLease.leaseId),
    distinctEnvironmentIds: Boolean(rootLease && childLease && rootLease.environmentId !== childLease.environmentId),
    distinctProviderSandboxIds: Boolean(rootLease?.providerSandboxId && childLease?.providerSandboxId
      && rootLease.providerSandboxId !== childLease.providerSandboxId),
    childOwnedByRoot: Boolean(rootLease && childLease && childLease.ownerLeaseId === rootLease.leaseId
      && childLease.ownerAgentId === rootLease.agentId),
    childReleased: childLease?.state === 'released',
    durableChildArtifactAvailable: Boolean(artifact),
    patchApplicationApplied: application?.phase === 'checkpointed',
    rootLatestSnapshotAdvanced: Boolean(rootLease && application && application.phase === 'checkpointed'
      && rootLease.latestSnapshotId && rootLease.latestSnapshotId !== application.sourceTargetSnapshotId
      && database.snapshots.some(snapshot => snapshot.snapshotId === rootLease.latestSnapshotId
        && snapshot.leaseId === rootLease.leaseId)),
  }
  return { ...(rootLease ? { rootLease } : {}), ...(childLease ? { childLease } : {}),
    ...(artifact ? { artifactId: artifact.artifactId } : {}), assertions }
}

export interface PocProviderInspection {
  managedSandboxIds: string[]
  knownProviderSnapshotIds: string[]
}

export function evaluatePocCleanupInspection(
  database: PocDatabaseInspection, provider: PocProviderInspection,
): Record<string, boolean> {
  return {
    allLeasesReleased: database.leases.every(lease => lease.state === 'released'),
    noInProgressOperations: database.operations.every(operation => operation.state !== 'in_progress'),
    noPendingAllocations: database.allocations.every(allocation => allocation.state !== 'allocated'
      && allocation.state !== 'reclaim_pending'),
    noLiveTickets: database.liveTicketCount === 0,
    noUnfinishedInteractions: database.unfinishedInteractionCount === 0,
    noManagedProviderSandboxes: provider.managedSandboxIds.length === 0,
    noKnownProviderSnapshots: provider.knownProviderSnapshotIds.length === 0,
  }
}

interface E2BConnection { apiKey: string; apiUrl: string; domain: string; validateApiKey?: boolean }
interface ScopedProvider {
  listManagedSandboxes(query: { metadata: Record<string, string> }): Promise<Array<{ sandboxId: string }>>
  listSnapshots(query: { sandboxId: string }): Promise<Array<{ snapshotId: string }>>
  kill(sandboxId: string): Promise<void>
  deleteSnapshot(snapshotId: string): Promise<boolean>
}

export class PocProviderInspector {
  private readonly provider: ScopedProvider
  constructor(private readonly connection: E2BConnection, readonly managedBy: string, readonly tenantId: string,
    provider?: ScopedProvider) {
    if (!managedBy.startsWith('cudex-poc-') || !tenantId.startsWith('poc-')) throw new Error('invalid POC provider scope')
    this.provider = provider ?? new E2BProvider({ ...connection, requestTimeoutMs: 120_000 })
  }

  async inspect(database: PocDatabaseInspection): Promise<PocProviderInspection> {
    const managed = await this.provider.listManagedSandboxes({ metadata: { managedBy: this.managedBy, tenantId: this.tenantId } })
    const knownSnapshotIds = new Set(database.snapshots.flatMap(snapshot => snapshot.providerSnapshotId ? [snapshot.providerSnapshotId] : []))
    for (const allocation of database.allocations) if (allocation.allocationKind === 'provider_snapshot') knownSnapshotIds.add(allocation.resourceId)
    const sandboxIds = new Set(database.leases.flatMap(lease => lease.providerSandboxId ? [lease.providerSandboxId] : []))
    for (const allocation of database.allocations) {
      if (allocation.allocationKind === 'sandbox' || allocation.allocationKind === 'capture_sandbox') sandboxIds.add(allocation.resourceId)
    }
    const existingSnapshots = new Set<string>()
    for (const sandboxId of sandboxIds) {
      const snapshots = await this.provider.listSnapshots({ sandboxId }).catch(() => [])
      for (const snapshot of snapshots) if (knownSnapshotIds.has(snapshot.snapshotId)) existingSnapshots.add(snapshot.snapshotId)
    }
    return { managedSandboxIds: managed.map(item => item.sandboxId).sort(), knownProviderSnapshotIds: [...existingSnapshots].sort() }
  }

  async forceCleanup(database: PocDatabaseInspection): Promise<boolean> {
    let intervened = false
    const managed = await this.provider.listManagedSandboxes({ metadata: { managedBy: this.managedBy, tenantId: this.tenantId } })
    for (const sandbox of managed) { await this.provider.kill(sandbox.sandboxId).catch(() => undefined); intervened = true }
    const snapshotIds = new Set(database.snapshots.flatMap(snapshot => snapshot.providerSnapshotId ? [snapshot.providerSnapshotId] : []))
    for (const allocation of database.allocations) if (allocation.allocationKind === 'provider_snapshot') snapshotIds.add(allocation.resourceId)
    for (const snapshotId of snapshotIds) if (await this.provider.deleteSnapshot(snapshotId).catch(() => false)) intervened = true
    return intervened
  }

  async verifyRootWorkspace(root: PocLeaseInspection): Promise<boolean> {
    if (!root.providerSandboxId || root.state !== 'active') return false
    const sandbox = await Sandbox.connect(root.providerSandboxId, { ...this.connection, requestTimeoutMs: 120_000 })
    const result = await sandbox.commands.run('./verify.sh && test -e /tmp/cudex-poc-owner-secret', {
      cwd: '/workspace/roots/0/fixture', timeoutMs: 60_000,
    })
    return result.exitCode === 0
  }
}

export async function openPocDatabaseInspector(databaseUrl: string, tenantId: string): Promise<{
  inspector: PocDatabaseInspector
  close(): Promise<void>
}> {
  const pool = new Pool({ connectionString: databaseUrl })
  await pool.query('SELECT 1')
  return { inspector: new PocDatabaseInspector(pool, tenantId), async close() { await pool.end() } }
}

const forbiddenReportKey = /(?:bearer(?:token)?|password|api.?key|access.?token|traffic.?token|auth.?json|connection.?url|ticket(?:url|uri|token|secret|credential))/iu
const connectionMaterial = /(?:wss?:\/\/|postgres(?:ql)?:\/\/|[?&]ticket=|:\/\/[^/\s]*@)/iu

export function serializePocReport(report: unknown, secretValues: readonly string[]): string {
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (connectionMaterial.test(value) || secretValues.some(secret => secret && value.includes(secret))) {
        throw new Error('POC report contains forbidden connection or secret material')
      }
      return
    }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (forbiddenReportKey.test(key)) throw new Error('POC report contains a forbidden secret field')
        visit(item)
      }
    }
  }
  visit(report)
  return `${JSON.stringify(report, null, 2)}\n`
}

const retainedLogMaterial = /(?:wss?:\/\/|postgres(?:ql)?:\/\/|[?&]ticket=|trafficAccessToken|x-access-token|authorization:\s*bearer|"auths?"\s*:)/iu

export async function retainedFilesAreRedacted(paths: readonly string[], secretValues: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    const contents = await readFile(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
      throw error
    })
    if (contents.byteLength > 16 * 1024 * 1024) return false
    const text = contents.toString('utf8')
    if (retainedLogMaterial.test(text) || secretValues.some(secret => secret.length >= 8 && text.includes(secret))) return false
  }
  return true
}
