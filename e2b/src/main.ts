import process from 'node:process'
import { resolve } from 'node:path'
import { JsonStore } from './store.js'
import { TicketIssuer, type TicketAuthority } from './tickets.js'
import { E2BProvider } from './e2b-provider.js'
import { ControlPlane } from './service.js'
import { ExecGateway } from './gateway.js'
import { startServer } from './http-server.js'
import { BlobStore, S3BlobStore } from './blob-store.js'
import { defaultArchiveManifestLimits, type ArchiveManifestLimits } from './archive-manifest.js'
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
import { parseTrustedRoles } from './trusted-roles.js'
import type { ActiveLeaseDirectory } from './gateway.js'
import { PostgresLeaseInteractionGate } from './postgres-lease-interactions.js'
import { PostgresReferenceRetention } from './postgres-reference-retention.js'

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}
const development = process.env.HOSTED_AGENT_DEVELOPMENT === 'true'
const host = process.env.HOSTED_AGENT_HOST ?? '127.0.0.1'; const port = positiveInteger('HOSTED_AGENT_PORT', 8443)
const store = development
  ? new JsonStore(resolve(process.env.HOSTED_AGENT_STATE_PATH ?? 'e2b/.state/control-plane.json'))
  : undefined
await store?.open()
const objectBucket = process.env.HOSTED_AGENT_OBJECT_BUCKET
if (!development && !objectBucket) throw new Error('HOSTED_AGENT_OBJECT_BUCKET is required outside development')
const blobs = objectBucket
  ? new S3BlobStore({
      bucket: objectBucket,
      ...(process.env.HOSTED_AGENT_OBJECT_PREFIX ? { prefix: process.env.HOSTED_AGENT_OBJECT_PREFIX } : {}),
      ...(process.env.HOSTED_AGENT_OBJECT_REGION ? { region: process.env.HOSTED_AGENT_OBJECT_REGION } : {}),
      ...(process.env.HOSTED_AGENT_OBJECT_ENDPOINT ? { endpoint: process.env.HOSTED_AGENT_OBJECT_ENDPOINT } : {}),
      forcePathStyle: process.env.HOSTED_AGENT_OBJECT_FORCE_PATH_STYLE === 'true',
      maxObjectBytes: Number(process.env.HOSTED_AGENT_MAX_OBJECT_BYTES ?? 1_073_741_824),
    })
  : new BlobStore(resolve(process.env.HOSTED_AGENT_BLOB_PATH ?? 'e2b/.state/blobs'))
const connection = {
  apiKey: required('E2B_API_KEY'),
  ...(process.env.E2B_API_URL ? { apiUrl: process.env.E2B_API_URL } : {}),
  ...(process.env.E2B_DOMAIN ? { domain: process.env.E2B_DOMAIN } : {}),
  validateApiKey: process.env.E2B_VALIDATE_API_KEY !== 'false', requestTimeoutMs: 120_000,
}
const ingress = {
  maxBytes: positiveInteger('HOSTED_AGENT_MAX_ARCHIVE_BYTES', 536_870_912),
  maxRoots: positiveInteger('HOSTED_AGENT_MAX_ROOTS', 8),
  maxExpandedBytes: positiveInteger('HOSTED_AGENT_MAX_EXPANDED_BYTES', 1_073_741_824),
  maxEntries: positiveInteger('HOSTED_AGENT_MAX_ENTRIES', 100_000),
  maxFileBytes: positiveInteger('HOSTED_AGENT_MAX_FILE_BYTES', 268_435_456),
  maxPathDepth: positiveInteger('HOSTED_AGENT_MAX_PATH_DEPTH', 64),
  maxExtractionRatio: positiveInteger('HOSTED_AGENT_MAX_EXTRACTION_RATIO', 4),
}
if (ingress.maxRoots > 64) throw new Error('HOSTED_AGENT_MAX_ROOTS must not exceed 64')
function withOverhead(name: string, value: number, overhead: number): number {
  const result = value + overhead
  if (!Number.isSafeInteger(result)) throw new Error(`${name} is too large`)
  return result
}
const archiveLimits: ArchiveManifestLimits = {
  ...defaultArchiveManifestLimits,
  maxArchiveBytes: ingress.maxBytes,
  maxEntries: withOverhead('HOSTED_AGENT_MAX_ENTRIES', ingress.maxEntries, ingress.maxRoots + 1),
  maxFiles: ingress.maxEntries,
  maxTotalBytes: ingress.maxExpandedBytes,
  maxFileBytes: ingress.maxFileBytes,
  maxPathDepth: withOverhead('HOSTED_AGENT_MAX_PATH_DEPTH', ingress.maxPathDepth, 3),
  maxExtractionRatio: ingress.maxExtractionRatio,
}
const sourceDatabaseUrl = process.env.HOSTED_AGENT_DATABASE_URL ?? process.env.DATABASE_URL
const sourceRuntime = await createSourceSnapshotRuntime({
  ...(sourceDatabaseUrl ? { databaseUrl: sourceDatabaseUrl } : {}),
  ...(process.env.HOSTED_AGENT_TENANT_ID ? { tenantId: process.env.HOSTED_AGENT_TENANT_ID } : {}),
  required: !development,
  objects: blobs,
  archiveLimits,
  maxRoots: ingress.maxRoots,
  maxTtlMs: positiveInteger('HOSTED_AGENT_SOURCE_MAX_TTL_MS', 24 * 60 * 60_000),
})
const durableJournal = sourceRuntime ? new PostgresJournal(sourceRuntime.pool) : undefined
const durableState = sourceRuntime ? new PostgresDurableState(sourceRuntime.pool) : undefined
const durableReclaimer = sourceRuntime ? new PostgresObjectReclaimer(sourceRuntime.pool, blobs) : undefined
const durablePreparations = sourceRuntime
  ? new PostgresWorkspacePreparations(sourceRuntime.pool)
  : undefined
const durableWorkerId = sourceRuntime ? required('HOSTED_AGENT_WORKER_ID') : undefined
const durableManagedBy = sourceRuntime ? (process.env.HOSTED_AGENT_MANAGED_BY ?? 'cudex') : undefined
const durableRoles = sourceRuntime && !development
  ? parseTrustedRoles(required('HOSTED_AGENT_ROLES'))
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
        artifactTtlMs: positiveInteger('HOSTED_AGENT_ARTIFACT_TTL_MS', 7 * 24 * 60 * 60_000),
      },
    )
  : undefined
function observeWorkspaceTransfer(metric: WorkspaceTransferMetric): void {
  console.log(JSON.stringify({ event: 'workspace_transfer_phase', ...metric }))
}
const provider = new E2BProvider(connection, 120_000, {
  archiveLimits,
  maxRoots: ingress.maxRoots,
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
        staleAfterMs: positiveInteger('HOSTED_AGENT_PATCH_APPLY_STALE_MS', 5 * 60_000),
        pollIntervalMs: positiveInteger('HOSTED_AGENT_PATCH_APPLY_RECONCILE_MS', 30_000),
        onError: () => console.error(JSON.stringify({ event: 'patch_apply_reconciliation_failed' })),
      },
    )
  : undefined
const gatewayUrl = new URL(required('HOSTED_AGENT_GATEWAY_URL'))
if (gatewayUrl.protocol !== 'wss:' && !(development && gatewayUrl.protocol === 'ws:')) throw new Error('HOSTED_AGENT_GATEWAY_URL must use WSS outside development')
if (gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash) throw new Error('HOSTED_AGENT_GATEWAY_URL must not contain credentials, query, or fragment')
const ticketTtlMs = positiveInteger('HOSTED_AGENT_TICKET_TTL_MS', 60_000)
if (!development && (ticketTtlMs < 5_000 || ticketTtlMs > 300_000)) throw new Error('HOSTED_AGENT_TICKET_TTL_MS must be between 5000 and 300000')
const tickets: TicketAuthority = development
  ? new TicketIssuer(store!, gatewayUrl.href, ticketTtlMs)
  : new PostgresTicketIssuer(
      durableState!, sourceRuntime!.principal.tenantId, gatewayUrl.href, ticketTtlMs)
const leases: ActiveLeaseDirectory = development ? store! : durableState!
const templates = development
  ? JSON.parse(required('HOSTED_AGENT_TEMPLATES')) as Record<string, string>
  : {}
const allowedRoots = development ? required('HOSTED_AGENT_ALLOWED_ROOTS').split(':').map(root => resolve(root)) : []
const gateway = new ExecGateway(tickets, leases, provider, {
  maxPayloadBytes: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_PAYLOAD_BYTES', 1024 * 1024),
  maxConnections: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS', 1024),
  maxConnectionsPerLease: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS_PER_LEASE', 8),
  maxPendingMessages: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_PENDING_MESSAGES', 64),
  maxPendingBytes: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_PENDING_BYTES', 1024 * 1024),
  maxBufferedBytes: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_BUFFERED_BYTES', 1024 * 1024),
  leaseRevalidationMs: positiveInteger('HOSTED_AGENT_GATEWAY_LEASE_REVALIDATION_MS', 5_000),
}, false, development ? undefined : {
  tenantId: sourceRuntime!.principal.tenantId,
  ledger: durableInteractionGate!,
})
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
const generalReconciler = sourceRuntime
  ? new PostgresReconciler(durableJournal!, durableState!, provider, {
      managedBy: durableManagedBy!, tenantId: sourceRuntime.principal.tenantId,
      workerId: `${durableWorkerId}:general-reconciler`,
      staleAfterMs: positiveInteger('HOSTED_AGENT_STALE_MS', 5 * 60_000),
      pollIntervalMs: positiveInteger('HOSTED_AGENT_RECONCILE_MS', 30_000),
      workspaceRecovery: { preparations: durablePreparations!, reclaimer: durableReclaimer! },
      patchExportRecovery: { artifacts: durableArtifacts!, reclaimer: durableReclaimer! },
      connections: gateway,
      onError: () => console.error(JSON.stringify({ event: 'reconciliation_failed' })),
    })
  : undefined
const childReconciler = sourceRuntime
  ? new PostgresChildReconciler(
      durableJournal!, durableState!, provider,
      { preparations: durablePreparations!, reclaimer: durableReclaimer! },
      {
        tenantId: sourceRuntime.principal.tenantId, managedBy: durableManagedBy!,
        workerId: `${durableWorkerId}:child-reconciler`,
        staleAfterMs: positiveInteger('HOSTED_AGENT_CHILD_STALE_MS', 5 * 60_000),
        pollIntervalMs: positiveInteger('HOSTED_AGENT_CHILD_RECONCILE_MS', 30_000),
        onError: () => console.error(JSON.stringify({ event: 'child_reconciliation_failed' })),
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
await startServer(service, gateway, { host, port, bearerToken: required('CODEX_HOSTED_AGENT_TOKEN'),
  ...(process.env.HOSTED_AGENT_TLS_CERT ? { tlsCertPath: process.env.HOSTED_AGENT_TLS_CERT } : {}),
  ...(process.env.HOSTED_AGENT_TLS_KEY ? { tlsKeyPath: process.env.HOSTED_AGENT_TLS_KEY } : {}),
  ...(sourceRuntime ? { sourceSnapshots: {
    principal: sourceRuntime.principal,
    api: sourceRuntime.api,
    maxArchiveBytes: archiveLimits.maxArchiveBytes,
  } } : {}),
  ...(patchExport ? { patchExport } : {}),
  ...(patchApply ? { patchApply } : {}),
  ...(retention ? { retention } : {}),
  allowInsecureHttp: development })
console.log(JSON.stringify({ event: 'control_plane_started', host, port, tls: Boolean(process.env.HOSTED_AGENT_TLS_CERT) }))
