import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import type { IDatabaseConnection } from '@pgtyped/runtime'
import { Sandbox } from 'e2b'
import { E2BProvider } from './e2b-provider.js'
import type { PocAppServerEvidence } from './poc-app-server-client.js'
import { inspectPocAllocations, inspectPocArtifacts, inspectPocInteractions, inspectPocLeases,
  inspectPocLiveTickets, inspectPocOperations, inspectPocPatchApplications, inspectPocSnapshots,
  findActivePocSandbox, inspectPocUnsettled, listPocProviderSnapshots, probeDatabase,
} from './db/queries/inspection.queries.js'

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
  interactions: Array<{ leaseId: string; connectionGeneration: number; processId: string | null; state: string }>
}

interface Queryable { query(sql: string, values: unknown[]): Promise<any> }
function pgTypedConnection(database: Queryable): IDatabaseConnection { return database as IDatabaseConnection }

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
    const rows = await inspectPocLeases.run({ tenantId: this.tenantId }, pgTypedConnection(this.database))
    return rows.map(row => ({ leaseId: row.lease_id, environmentId: row.environment_id,
      agentId: row.agent_id, ownerAgentId: row.owner_agent_id, ownerLeaseId: row.owner_lease_id,
      providerSandboxId: row.provider_sandbox_id, baseSnapshotId: row.base_snapshot_id,
      latestSnapshotId: row.latest_snapshot_id, state: row.state }))
  }

  async inspect(): Promise<PocDatabaseInspection> {
    const [leases, operations, snapshots, artifacts, applications, allocations, tickets, interactions] = await Promise.all([
      this.leases(),
      inspectPocOperations.run({ tenantId: this.tenantId }, pgTypedConnection(this.database)),
      inspectPocSnapshots.run({ tenantId: this.tenantId }, pgTypedConnection(this.database)),
      inspectPocArtifacts.run({ tenantId: this.tenantId }, pgTypedConnection(this.database)),
      inspectPocPatchApplications.run({ tenantId: this.tenantId }, pgTypedConnection(this.database)),
      inspectPocAllocations.run({ tenantId: this.tenantId }, pgTypedConnection(this.database)),
      inspectPocLiveTickets.run({ tenantId: this.tenantId }, pgTypedConnection(this.database)),
      inspectPocInteractions.run({ tenantId: this.tenantId }, pgTypedConnection(this.database)),
    ])
    return {
      leases,
      operations: operations.map(row => ({ operation: row.operation, state: row.state,
        primaryLeaseId: row.primary_lease_id === null ? null : String(row.primary_lease_id),
        resultLeaseId: row.result_lease_id === null ? null : String(row.result_lease_id) })),
      snapshots: snapshots.map(row => ({ snapshotId: row.snapshot_id, leaseId: row.lease_id,
        providerSnapshotId: row.provider_snapshot_id === null ? null : String(row.provider_snapshot_id), state: String(row.state) })),
      artifacts: artifacts.map(row => ({ artifactId: row.artifact_id, agentId: row.agent_id,
        sourceLeaseId: String(row.source_lease_id), state: String(row.state) })),
      patchApplications: applications.map(row => ({ applicationId: row.application_id,
        targetLeaseId: String(row.target_lease_id), artifactId: String(row.artifact_id),
        sourceTargetSnapshotId: String(row.source_target_snapshot_id), resultSnapshotId: String(row.result_snapshot_id),
        phase: String(row.phase) })),
      allocations: allocations.map(row => ({ allocationKind: row.allocation_kind,
        resourceId: String(row.resource_id), leaseId: row.lease_id === null ? null : String(row.lease_id), state: String(row.state) })),
      liveTicketCount: numberValue(tickets[0]?.count),
      interactions: interactions.map(row => ({ leaseId: row.lease_id,
        connectionGeneration: numberValue(row.connection_generation),
        processId: row.process_id === null ? null : String(row.process_id), state: String(row.state) })),
      unfinishedInteractionCount: interactions.filter(row => row.state !== 'finished').length,
    }
  }
}

/** Database boundary used by the optional control-plane POC inspection routes. */
export class PocRouteInspectionRepository {
  constructor(private readonly database: Queryable, readonly tenantId: string) {}

  async ownsActiveSandbox(providerSandboxId: string): Promise<boolean> {
    const rows = await findActivePocSandbox.run({ tenantId: this.tenantId, providerSandboxId }, pgTypedConnection(this.database))
    return rows.length === 1
  }

  async isFullyReleased(): Promise<boolean> {
    const [row] = await inspectPocUnsettled.run({ tenantId: this.tenantId }, pgTypedConnection(this.database))
    return Number(row?.leases) === 0 && Number(row?.operations) === 0
  }

  async providerSnapshotIds(): Promise<string[]> {
    const rows = await listPocProviderSnapshots.run({ tenantId: this.tenantId }, pgTypedConnection(this.database))
    if (rows.length > 1000) throw new Error('POC snapshot cleanup bound exceeded')
    return rows.flatMap(row => row.provider_snapshot_id === null ? [] : [row.provider_snapshot_id])
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
  const codeModeProcesses = database.interactions.filter(interaction =>
    interaction.processId?.startsWith('hosted-code-mode-'))
  const rootCodeMode = rootLease ? codeModeProcesses.filter(item => item.leaseId === rootLease.leaseId) : []
  const childCodeMode = childLease ? codeModeProcesses.filter(item => item.leaseId === childLease.leaseId) : []
  const assertions = {
    rootLeaseExists: Boolean(rootLease), childLeaseExists: Boolean(childLease),
    distinctLeaseIds: Boolean(rootLease && childLease && rootLease.leaseId !== childLease.leaseId),
    distinctEnvironmentIds: Boolean(rootLease && childLease && rootLease.environmentId !== childLease.environmentId),
    distinctProviderSandboxIds: Boolean(rootLease?.providerSandboxId && childLease?.providerSandboxId
      && rootLease.providerSandboxId !== childLease.providerSandboxId),
    rootCodeModeRuntimeReady: rootCodeMode.length === 1,
    childCodeModeRuntimeReady: childCodeMode.length === 1,
    distinctCodeModeEnvironmentIds: Boolean(rootCodeMode.length === 1 && childCodeMode.length === 1
      && rootLease && childLease && rootLease.environmentId !== childLease.environmentId),
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
  const rootLease = database.leases.find(lease => lease.ownerLeaseId === null)
  const childLease = database.leases.find(lease => lease.ownerLeaseId !== null)
  const codeModeProcesses = database.interactions.filter(interaction =>
    interaction.processId?.startsWith('hosted-code-mode-'))
  const quiesced = (leaseId: string | undefined) => Boolean(leaseId)
    && codeModeProcesses.some(item => item.leaseId === leaseId)
    && codeModeProcesses.filter(item => item.leaseId === leaseId).every(item => item.state === 'finished')
  return {
    allLeasesReleased: database.leases.every(lease => lease.state === 'released'),
    noInProgressOperations: database.operations.every(operation => operation.state !== 'in_progress'),
    noPendingAllocations: database.allocations.every(allocation => allocation.state !== 'allocated'
      && allocation.state !== 'reclaim_pending'),
    noLiveTickets: database.liveTicketCount === 0,
    noUnfinishedInteractions: database.unfinishedInteractionCount === 0,
    rootCodeModeRuntimeQuiesced: quiesced(rootLease?.leaseId),
    childCodeModeRuntimeQuiesced: quiesced(childLease?.leaseId),
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
  await probeDatabase.run(undefined, pgTypedConnection(pool))
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
