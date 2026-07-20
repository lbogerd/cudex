import { resolve } from 'node:path'
import { JsonStore } from './store.js'
import { TicketIssuer, type TicketAuthority } from './tickets.js'
import { E2BProvider } from './e2b-provider.js'
import { ControlPlane } from './service.js'
import { ExecGateway } from './gateway.js'
import { createControlPlaneApp, type ControlPlaneDependencies } from './http/app.js'
import { startControlPlaneServer, type ListenerOptions } from './http/server.js'
import { BlobStore, S3BlobStore } from './blob-store.js'
import type { ArchiveManifestLimits } from './archive-manifest.js'
import type { WorkspaceTransferMetric } from './workspace-transfer.js'
import { createSourceSnapshotRuntime } from './source-runtime.js'
import { PostgresJournal } from './postgres-store.js'
import { PostgresDurableState } from './postgres-state.js'
import { PostgresObjectReclaimer } from './postgres-object-reclaimer.js'
import { PostgresPatchArtifactRepository } from './postgres-artifacts.js'
import { PostgresPatchExportSourceResolver } from './postgres-patch-export-source.js'
import { PostgresPatchExportCoordinator } from './postgres-patch-export.js'
import { PostgresPatchApplySourceResolver } from './postgres-patch-apply-source.js'
import { PostgresPatchApplicationRepository } from './postgres-patch-applications.js'
import { PostgresPatchApplyCoordinator } from './postgres-patch-apply.js'
import { PostgresPatchApplyReconciler } from './postgres-patch-apply-reconciler.js'
import { PostgresWorkspacePreparations } from './postgres-workspace-preparations.js'
import { WorkspaceSnapshotPublisher } from './workspace-snapshots.js'
import { PostgresTicketIssuer } from './postgres-tickets.js'
import { PostgresProvisionCoordinator } from './postgres-provision.js'
import { PostgresRestoreCoordinator } from './postgres-restore.js'
import { PostgresRestoreSourceResolver } from './postgres-restore-source.js'
import { PostgresCheckpointCoordinator } from './postgres-checkpoint.js'
import { PostgresReconnectCoordinator } from './postgres-reconnect.js'
import { PostgresReleaseCoordinator } from './postgres-release.js'
import { PostgresLifecycleService, type AgentLifecycleService } from './lifecycle-service.js'
import { PostgresReconciler } from './postgres-reconciler.js'
import { PostgresChildReconciler } from './postgres-child-reconciler.js'
import { PostgresChildCoordinator } from './postgres-child.js'
import { ServiceError } from './types.js'
import { parseTrustedRoles } from './trusted-roles.js'
import type { ActiveLeaseDirectory } from './gateway.js'
import { PostgresLeaseInteractionGate } from './postgres-lease-interactions.js'
import { PostgresReferenceRetention } from './postgres-reference-retention.js'
import type { ServiceConfiguration } from './config/service-env.js'
import { PocRouteInspectionRepository } from './poc-inspector.js'
import { createInfrastructureLoggers, safeFailureDiagnostic, type ServiceLogger } from './observability/logger.js'

export interface ControlPlaneRuntime {
  readonly app: ReturnType<typeof createControlPlaneApp>
  readonly gateway: ExecGateway
  readonly listenerOptions: ListenerOptions
}

export async function buildControlPlaneRuntime(
  config: ServiceConfiguration,
  logger: ServiceLogger,
): Promise<ControlPlaneRuntime> {
const infrastructureLoggers = createInfrastructureLoggers(logger)
const development = config.development
const { host, port } = config.http
const store = development
  ? new JsonStore(resolve(config.storage.statePath))
  : undefined
await store?.open()
const objectBucket = config.storage.objectBucket
const blobs = objectBucket
  ? new S3BlobStore({
      bucket: objectBucket,
      ...(config.storage.objectPrefix ? { prefix: config.storage.objectPrefix } : {}),
      ...(config.storage.objectRegion ? { region: config.storage.objectRegion } : {}),
      ...(config.storage.objectEndpoint ? { endpoint: config.storage.objectEndpoint } : {}),
      forcePathStyle: config.storage.forcePathStyle, maxObjectBytes: config.storage.maxObjectBytes,
    })
  : new BlobStore(resolve(config.storage.blobPath))
const connection = {
  ...config.e2b, requestTimeoutMs: 120_000,
}
const ingress = config.ingress
const archiveLimits: ArchiveManifestLimits = config.ingress.archiveLimits
const sourceDatabaseUrl = config.durability.databaseUrl
const workspaceMode = config.workspaceMode
const sourceRuntime = await createSourceSnapshotRuntime({
  ...(sourceDatabaseUrl ? { databaseUrl: sourceDatabaseUrl } : {}),
  ...(config.durability.tenantId ? { tenantId: config.durability.tenantId } : {}),
  required: !development,
  objects: blobs,
  archiveLimits,
  maxRoots: ingress.maxRoots,
  maxTtlMs: config.durability.sourceMaxTtlMs,
})
const durableJournal = sourceRuntime ? new PostgresJournal(sourceRuntime.pool) : undefined
const durableState = sourceRuntime ? new PostgresDurableState(sourceRuntime.pool) : undefined
const durableReclaimer = sourceRuntime ? new PostgresObjectReclaimer(sourceRuntime.pool, blobs) : undefined
const durablePreparations = sourceRuntime
  ? new PostgresWorkspacePreparations(sourceRuntime.pool)
  : undefined
const durableWorkerId = sourceRuntime ? config.durability.workerId : undefined
const durableManagedBy = sourceRuntime ? config.durability.managedBy : undefined
const durableRoles = sourceRuntime && !development
  ? parseTrustedRoles(config.durability.roles!)
  : undefined
const durableArtifacts = sourceRuntime
  ? new PostgresPatchArtifactRepository(sourceRuntime.pool)
  : undefined
const durableInteractionGate = sourceRuntime
  ? new PostgresLeaseInteractionGate(durableJournal!, durableState!)
  : undefined
const durableRetention = sourceRuntime
  ? new PostgresReferenceRetention(sourceRuntime.pool, sourceRuntime.principal.tenantId)
  : undefined
const retention = durableRetention ?? (development ? {
  async retain(request: { expectedRevision: number | null }) {
    return { revision: request.expectedRevision ?? 1, desiredHash: '0'.repeat(64) }
  },
  async clear(request: { expectedRevision: number }) {
    return { revision: request.expectedRevision + 1, desiredHash: '0'.repeat(64) }
  },
} : undefined)
const patchExport = sourceRuntime
  ? new PostgresPatchExportCoordinator(
      durableJournal!,
      durableState!,
      new PostgresPatchExportSourceResolver(sourceRuntime.pool, blobs),
      durableArtifacts!,
      blobs,
      durableReclaimer!,
      {
        tenantId: sourceRuntime.principal.tenantId,
        workerId: durableWorkerId!,
        artifactTtlMs: config.durability.artifactTtlMs,
      },
    )
  : undefined
function observeWorkspaceTransfer(metric: WorkspaceTransferMetric): void {
  infrastructureLoggers.workspaceTransfer.info({ event: 'workspace_transfer_phase', ...metric })
}
const provider = new E2BProvider(connection, 120_000, {
  archiveLimits,
  maxRoots: ingress.maxRoots,
  workspaceMode,
  observe: observeWorkspaceTransfer,
})
const durablePublisher = sourceRuntime
  ? new WorkspaceSnapshotPublisher(durableState!, blobs, {
      archiveLimits,
      reclaimer: {
        async reclaimUnreferencedWorkspaceObject(): Promise<void> {
          throw new Error('durable workspace publication requires preparation cleanup')
        },
      },
      durablePreparation: {
        journal: durableJournal!,
        preparations: durablePreparations!,
        reclaimer: durableReclaimer!,
      },
    })
  : undefined
const patchApply = sourceRuntime
  ? new PostgresPatchApplyCoordinator(
      durableJournal!,
      durableState!,
      new PostgresPatchApplySourceResolver(sourceRuntime.pool, blobs),
      new PostgresPatchApplicationRepository(sourceRuntime.pool),
      durablePublisher!,
      provider,
      {
        tenantId: sourceRuntime.principal.tenantId, workerId: durableWorkerId!,
        interactionGate: durableInteractionGate!,
      },
    )
  : undefined
const patchApplyReconciler = sourceRuntime
  ? new PostgresPatchApplyReconciler(
      durableJournal!, durableState!,
      new PostgresPatchApplySourceResolver(sourceRuntime.pool, blobs),
      new PostgresPatchApplicationRepository(sourceRuntime.pool), provider,
      { preparations: durablePreparations!, reclaimer: durableReclaimer!,
        interactionGate: durableInteractionGate! },
      {
        tenantId: sourceRuntime.principal.tenantId, workerId: durableWorkerId!,
        staleAfterMs: config.reconciliation.patchApplyStaleMs,
        pollIntervalMs: config.reconciliation.patchApplyIntervalMs,
        onError: error => infrastructureLoggers.reconciliation.error({ event: 'patch_apply_reconciliation_failed', ...safeFailureDiagnostic(error) }),
      },
    )
  : undefined
const gatewayUrl = new URL(config.gateway.url)
const ticketTtlMs = config.gateway.ticketTtlMs
const tickets: TicketAuthority = development
  ? new TicketIssuer(store!, gatewayUrl.href, ticketTtlMs)
  : new PostgresTicketIssuer(
      durableState!, sourceRuntime!.principal.tenantId, gatewayUrl.href, ticketTtlMs)
const leases: ActiveLeaseDirectory = development ? store! : durableState!
const templates = development
  ? JSON.parse(config.developmentOptions.templates!) as Record<string, string>
  : {}
const allowedRoots = development ? config.developmentOptions.allowedRoots!.split(':').map(root => resolve(root)) : []
const gateway = new ExecGateway(tickets, leases, provider, {
  maxPayloadBytes: config.gateway.maxPayloadBytes, maxConnections: config.gateway.maxConnections,
  maxConnectionsPerLease: config.gateway.maxConnectionsPerLease, maxPendingMessages: config.gateway.maxPendingMessages,
  maxPendingBytes: config.gateway.maxPendingBytes, maxBufferedBytes: config.gateway.maxBufferedBytes,
  leaseRevalidationMs: config.gateway.leaseRevalidationMs,
}, false, development ? undefined : {
  tenantId: sourceRuntime!.principal.tenantId,
  ledger: durableInteractionGate!,
}, infrastructureLoggers.gateway)
const developmentService = development
  ? new ControlPlane(store!, provider, tickets, blobs, {
      templates, allowedRoots, ingress,
      ...(sourceRuntime ? { sourceSnapshots: {
        principal: sourceRuntime.principal,
        resolver: sourceRuntime.lifecycle,
      } } : {}),
      allowLocalIngress: true,
    }, gateway)
  : undefined
const productionService = !development
  ? new PostgresLifecycleService({
      immutableSource: new PostgresProvisionCoordinator(
        durableJournal!, durableState!, durablePublisher!, provider, tickets, {
          principal: sourceRuntime!.principal, managedBy: durableManagedBy!,
          workerId: durableWorkerId!, roles: durableRoles!,
          sourceResolver: sourceRuntime!.lifecycle,
        }),
      durableRestore: new PostgresRestoreCoordinator(
        durableJournal!, durableState!, durablePublisher!, provider, tickets,
        new PostgresRestoreSourceResolver(durableState!, blobs), {
          principal: sourceRuntime!.principal, managedBy: durableManagedBy!,
          workerId: durableWorkerId!, roles: durableRoles!,
        }),
      child: new PostgresChildCoordinator(
        durableJournal!, durableState!, durablePublisher!, provider, tickets, {
          principal: sourceRuntime!.principal, managedBy: durableManagedBy!,
          workerId: durableWorkerId!, roles: durableRoles!,
          interactionGate: durableInteractionGate!,
        }),
      reconnect: new PostgresReconnectCoordinator(
        durableJournal!, durableState!, provider, tickets, {
          tenantId: sourceRuntime!.principal.tenantId,
          workerId: durableWorkerId!, connections: gateway,
        }),
      checkpoint: new PostgresCheckpointCoordinator(
        durableJournal!, durableState!, durablePublisher!, provider, {
          tenantId: sourceRuntime!.principal.tenantId, workerId: durableWorkerId!,
          interactionGate: durableInteractionGate!,
        }),
      release: new PostgresReleaseCoordinator(
        durableJournal!, durableState!, provider, {
          tenantId: sourceRuntime!.principal.tenantId,
          workerId: durableWorkerId!, connections: gateway, referenceRetention: durableRetention!,
        }),
    })
  : undefined
const service: AgentLifecycleService = developmentService ?? productionService!
const pocRouteInspection = sourceRuntime ? new PocRouteInspectionRepository(
  sourceRuntime.pool, sourceRuntime.principal.tenantId) : undefined
const generalReconciler = sourceRuntime
  ? new PostgresReconciler(durableJournal!, durableState!, provider, {
      managedBy: durableManagedBy!, tenantId: sourceRuntime.principal.tenantId,
      workerId: `${durableWorkerId}:general-reconciler`,
      staleAfterMs: config.reconciliation.staleMs, pollIntervalMs: config.reconciliation.intervalMs,
      workspaceRecovery: { preparations: durablePreparations!, reclaimer: durableReclaimer! },
      patchExportRecovery: { artifacts: durableArtifacts!, reclaimer: durableReclaimer! },
      objectRecovery: durableReclaimer!,
      connections: gateway,
      onError: error => infrastructureLoggers.reconciliation.error({ event: 'reconciliation_failed', ...safeFailureDiagnostic(error) }),
    })
  : undefined
const childReconciler = sourceRuntime
  ? new PostgresChildReconciler(
      durableJournal!, durableState!, provider,
      { preparations: durablePreparations!, reclaimer: durableReclaimer! },
      {
        tenantId: sourceRuntime.principal.tenantId, managedBy: durableManagedBy!,
        workerId: `${durableWorkerId}:child-reconciler`,
        staleAfterMs: config.reconciliation.childStaleMs, pollIntervalMs: config.reconciliation.childIntervalMs,
        onError: error => infrastructureLoggers.reconciliation.error({ event: 'child_reconciliation_failed', ...safeFailureDiagnostic(error) }),
      },
    )
  : undefined
await developmentService?.reconcile()
await generalReconciler?.runOnce()
await childReconciler?.runOnce()
await patchApplyReconciler?.runOnce()
generalReconciler?.start()
childReconciler?.start()
patchApplyReconciler?.start()
const dependencies: ControlPlaneDependencies = { lifecycle: service,
  ...(sourceRuntime ? { sourceSnapshots: {
    principal: sourceRuntime.principal,
    api: sourceRuntime.api,
    maxArchiveBytes: archiveLimits.maxArchiveBytes,
  } } : {}),
  ...(patchExport ? { patchExport } : {}),
  ...(patchApply ? { patchApply } : {}),
  ...(retention ? { retention } : {}),
  ...(sourceRuntime && config.pocInspection ? { pocInspection: {
    async verifyWorkspace(providerSandboxId: string): Promise<boolean> {
      if (!await pocRouteInspection!.ownsActiveSandbox(providerSandboxId)) throw new ServiceError(404, 'active POC sandbox not found')
      return provider.verifyPocWorkspace(providerSandboxId)
    },
    async cleanupProviderSnapshots(): Promise<number> {
      const tenantId = sourceRuntime.principal.tenantId
      if (!tenantId.startsWith('poc-')) throw new ServiceError(403, 'POC cleanup requires a POC tenant')
      if (!await pocRouteInspection!.isFullyReleased()) {
        throw new ServiceError(409, 'POC tenant is not fully released')
      }
      let snapshotIds: string[]
      try { snapshotIds = await pocRouteInspection!.providerSnapshotIds() }
      catch { throw new ServiceError(409, 'POC snapshot cleanup bound exceeded') }
      let deleted = 0
      for (const snapshotId of snapshotIds) {
        if (await provider.deleteSnapshot(snapshotId)) deleted += 1
      }
      return deleted
    },
  } } : {}) }
const app = createControlPlaneApp(dependencies, { bearerToken: config.http.bearerToken }, infrastructureLoggers.http)
const listenerOptions: ListenerOptions = { host, port,
  ...(config.tls.certificatePath ? {
    tlsCertPath: config.tls.certificatePath, tlsKeyPath: config.tls.keyPath!,
  } : {}),
  allowInsecureHttp: development }
return { app, gateway, listenerOptions }
}

export async function startControlPlaneRuntime(runtime: ControlPlaneRuntime) {
  return startControlPlaneServer(runtime.app, runtime.gateway, runtime.listenerOptions)
}
