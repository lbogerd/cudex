import process from 'node:process'
import { resolve } from 'node:path'
import { JsonStore } from './store.js'
import { TicketIssuer } from './tickets.js'
import { E2BProvider } from './e2b-provider.js'
import { ControlPlane } from './service.js'
import { ExecGateway } from './gateway.js'
import { startServer } from './http-server.js'
import { BlobStore, S3BlobStore } from './blob-store.js'
import { defaultArchiveManifestLimits, type ArchiveManifestLimits } from './archive-manifest.js'
import type { WorkspaceTransferMetric } from './workspace-transfer.js'

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}
const development = process.env.HOSTED_AGENT_DEVELOPMENT === 'true'
const host = process.env.HOSTED_AGENT_HOST ?? '127.0.0.1'; const port = positiveInteger('HOSTED_AGENT_PORT', 8443)
const store = new JsonStore(resolve(process.env.HOSTED_AGENT_STATE_PATH ?? 'e2b/.state/control-plane.json')); await store.open()
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
function observeWorkspaceTransfer(metric: WorkspaceTransferMetric): void {
  console.log(JSON.stringify({ event: 'workspace_transfer_phase', ...metric }))
}
const provider = new E2BProvider(connection, 120_000, {
  archiveLimits,
  maxRoots: ingress.maxRoots,
  observe: observeWorkspaceTransfer,
})
const gatewayUrl = new URL(required('HOSTED_AGENT_GATEWAY_URL'))
if (gatewayUrl.protocol !== 'wss:' && !(development && gatewayUrl.protocol === 'ws:')) throw new Error('HOSTED_AGENT_GATEWAY_URL must use WSS outside development')
if (gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash) throw new Error('HOSTED_AGENT_GATEWAY_URL must not contain credentials, query, or fragment')
const ticketTtlMs = positiveInteger('HOSTED_AGENT_TICKET_TTL_MS', 60_000)
if (!development && (ticketTtlMs < 5_000 || ticketTtlMs > 300_000)) throw new Error('HOSTED_AGENT_TICKET_TTL_MS must be between 5000 and 300000')
const tickets = new TicketIssuer(store, gatewayUrl.href, ticketTtlMs)
const templates = JSON.parse(required('HOSTED_AGENT_TEMPLATES')) as Record<string, string>
const allowedRoots = development ? required('HOSTED_AGENT_ALLOWED_ROOTS').split(':').map(root => resolve(root)) : []
const gateway = new ExecGateway(tickets, store, provider, {
  maxPayloadBytes: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_PAYLOAD_BYTES', 1024 * 1024),
  maxConnections: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS', 1024),
  maxConnectionsPerLease: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS_PER_LEASE', 8),
  maxPendingMessages: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_PENDING_MESSAGES', 64),
  maxPendingBytes: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_PENDING_BYTES', 1024 * 1024),
  maxBufferedBytes: positiveInteger('HOSTED_AGENT_GATEWAY_MAX_BUFFERED_BYTES', 1024 * 1024),
  leaseRevalidationMs: positiveInteger('HOSTED_AGENT_GATEWAY_LEASE_REVALIDATION_MS', 5_000),
})
const service = new ControlPlane(store, provider, tickets, blobs, { templates, allowedRoots,
  ingress,
  allowLocalIngress: development }, gateway)
await service.reconcile()
await startServer(service, gateway, { host, port, bearerToken: required('CODEX_HOSTED_AGENT_TOKEN'),
  ...(process.env.HOSTED_AGENT_TLS_CERT ? { tlsCertPath: process.env.HOSTED_AGENT_TLS_CERT } : {}),
  ...(process.env.HOSTED_AGENT_TLS_KEY ? { tlsKeyPath: process.env.HOSTED_AGENT_TLS_KEY } : {}),
  allowInsecureHttp: development })
console.log(JSON.stringify({ event: 'control_plane_started', host, port, tls: Boolean(process.env.HOSTED_AGENT_TLS_CERT) }))
