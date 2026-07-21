import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'
import { defaultArchiveManifestLimits, type ArchiveManifestLimits } from '../archive-manifest.js'
import { explicitBoolean, httpUrl, invalidEnvironment, nonemptyString, positiveInteger, scopedRuntimeEnv,
  type RuntimeEnvironment } from './shared.js'

const keys = [
  'HOSTED_AGENT_DEVELOPMENT', 'HOSTED_AGENT_HOST', 'HOSTED_AGENT_PORT', 'HOSTED_AGENT_STATE_PATH',
  'HOSTED_AGENT_OBJECT_BUCKET', 'HOSTED_AGENT_OBJECT_PREFIX', 'HOSTED_AGENT_OBJECT_REGION',
  'HOSTED_AGENT_OBJECT_ENDPOINT', 'HOSTED_AGENT_OBJECT_FORCE_PATH_STYLE', 'HOSTED_AGENT_MAX_OBJECT_BYTES',
  'HOSTED_AGENT_BLOB_PATH', 'HOSTED_AGENT_DATABASE_URL', 'HOSTED_AGENT_TENANT_ID', 'HOSTED_AGENT_WORKER_ID',
  'HOSTED_AGENT_MANAGED_BY', 'HOSTED_AGENT_ROLES', 'HOSTED_AGENT_WORKSPACE_MODE',
  'HOSTED_AGENT_MAX_ARCHIVE_BYTES', 'HOSTED_AGENT_MAX_ROOTS', 'HOSTED_AGENT_MAX_EXPANDED_BYTES',
  'HOSTED_AGENT_MAX_ENTRIES', 'HOSTED_AGENT_MAX_FILE_BYTES', 'HOSTED_AGENT_MAX_PATH_DEPTH',
  'HOSTED_AGENT_MAX_EXTRACTION_RATIO', 'HOSTED_AGENT_SOURCE_MAX_TTL_MS', 'HOSTED_AGENT_ARTIFACT_TTL_MS',
  'HOSTED_AGENT_PATCH_APPLY_STALE_MS', 'HOSTED_AGENT_PATCH_APPLY_RECONCILE_MS', 'HOSTED_AGENT_STALE_MS',
  'HOSTED_AGENT_RECONCILE_MS', 'HOSTED_AGENT_CHILD_STALE_MS', 'HOSTED_AGENT_CHILD_RECONCILE_MS',
  'HOSTED_AGENT_GATEWAY_URL', 'HOSTED_AGENT_TICKET_TTL_MS', 'HOSTED_AGENT_GATEWAY_MAX_PAYLOAD_BYTES',
  'HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS', 'HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS_PER_LEASE',
  'HOSTED_AGENT_GATEWAY_MAX_PENDING_MESSAGES', 'HOSTED_AGENT_GATEWAY_MAX_PENDING_BYTES',
  'HOSTED_AGENT_GATEWAY_MAX_BUFFERED_BYTES', 'HOSTED_AGENT_GATEWAY_LEASE_REVALIDATION_MS',
  'HOSTED_AGENT_TEMPLATES', 'HOSTED_AGENT_ALLOWED_ROOTS', 'HOSTED_AGENT_TLS_CERT', 'HOSTED_AGENT_TLS_KEY',
  'HOSTED_AGENT_POC_INSPECTION', 'E2B_API_KEY', 'E2B_API_URL', 'E2B_DOMAIN', 'E2B_VALIDATE_API_KEY',
  'CODEX_HOSTED_AGENT_TOKEN', 'HOSTED_AGENT_LOG_LEVEL',
] as const

const optional = z.preprocess(value => value === '' ? undefined : value, nonemptyString.optional())
const server = {
  HOSTED_AGENT_DEVELOPMENT: explicitBoolean.default(false), HOSTED_AGENT_HOST: nonemptyString.default('127.0.0.1'),
  HOSTED_AGENT_PORT: positiveInteger(8443), HOSTED_AGENT_STATE_PATH: nonemptyString.default('e2b/.state/control-plane.json'),
  HOSTED_AGENT_OBJECT_BUCKET: optional, HOSTED_AGENT_OBJECT_PREFIX: optional, HOSTED_AGENT_OBJECT_REGION: optional,
  HOSTED_AGENT_OBJECT_ENDPOINT: httpUrl.optional(), HOSTED_AGENT_OBJECT_FORCE_PATH_STYLE: explicitBoolean.default(false),
  HOSTED_AGENT_MAX_OBJECT_BYTES: positiveInteger(1_073_741_824), HOSTED_AGENT_BLOB_PATH: nonemptyString.default('e2b/.state/blobs'),
  HOSTED_AGENT_DATABASE_URL: z.url().optional(), HOSTED_AGENT_TENANT_ID: optional, HOSTED_AGENT_WORKER_ID: optional,
  HOSTED_AGENT_MANAGED_BY: nonemptyString.default('cudex'), HOSTED_AGENT_ROLES: optional,
  HOSTED_AGENT_WORKSPACE_MODE: z.enum(['default', 'git-working-set']).default('default'),
  HOSTED_AGENT_MAX_ARCHIVE_BYTES: positiveInteger(536_870_912), HOSTED_AGENT_MAX_ROOTS: positiveInteger(8),
  HOSTED_AGENT_MAX_EXPANDED_BYTES: positiveInteger(1_073_741_824), HOSTED_AGENT_MAX_ENTRIES: positiveInteger(100_000),
  HOSTED_AGENT_MAX_FILE_BYTES: positiveInteger(268_435_456), HOSTED_AGENT_MAX_PATH_DEPTH: positiveInteger(64),
  HOSTED_AGENT_MAX_EXTRACTION_RATIO: positiveInteger(4), HOSTED_AGENT_SOURCE_MAX_TTL_MS: positiveInteger(86_400_000),
  HOSTED_AGENT_ARTIFACT_TTL_MS: positiveInteger(604_800_000), HOSTED_AGENT_PATCH_APPLY_STALE_MS: positiveInteger(300_000),
  HOSTED_AGENT_PATCH_APPLY_RECONCILE_MS: positiveInteger(30_000), HOSTED_AGENT_STALE_MS: positiveInteger(300_000),
  HOSTED_AGENT_RECONCILE_MS: positiveInteger(30_000), HOSTED_AGENT_CHILD_STALE_MS: positiveInteger(300_000),
  HOSTED_AGENT_CHILD_RECONCILE_MS: positiveInteger(30_000), HOSTED_AGENT_GATEWAY_URL: z.url(),
  HOSTED_AGENT_TICKET_TTL_MS: positiveInteger(60_000), HOSTED_AGENT_GATEWAY_MAX_PAYLOAD_BYTES: positiveInteger(1_048_576),
  HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS: positiveInteger(1024), HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS_PER_LEASE: positiveInteger(8),
  HOSTED_AGENT_GATEWAY_MAX_PENDING_MESSAGES: positiveInteger(64), HOSTED_AGENT_GATEWAY_MAX_PENDING_BYTES: positiveInteger(1_048_576),
  HOSTED_AGENT_GATEWAY_MAX_BUFFERED_BYTES: positiveInteger(1_048_576), HOSTED_AGENT_GATEWAY_LEASE_REVALIDATION_MS: positiveInteger(5000),
  HOSTED_AGENT_TEMPLATES: optional, HOSTED_AGENT_ALLOWED_ROOTS: optional, HOSTED_AGENT_TLS_CERT: optional,
  HOSTED_AGENT_TLS_KEY: optional, HOSTED_AGENT_POC_INSPECTION: explicitBoolean.default(false), E2B_API_KEY: nonemptyString,
  E2B_API_URL: httpUrl.optional(), E2B_DOMAIN: nonemptyString.optional(), E2B_VALIDATE_API_KEY: explicitBoolean.default(true),
  CODEX_HOSTED_AGENT_TOKEN: nonemptyString,
  HOSTED_AGENT_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
} as const

export interface ServiceConfiguration {
  readonly development: boolean
  readonly http: Readonly<{ host: string; port: number; bearerToken: string }>
  readonly tls: Readonly<{ certificatePath?: string; keyPath?: string }>
  readonly storage: Readonly<{ statePath: string; blobPath: string; objectBucket?: string; objectPrefix?: string;
    objectRegion?: string; objectEndpoint?: string; forcePathStyle: boolean; maxObjectBytes: number }>
  readonly e2b: Readonly<{ apiKey: string; apiUrl?: string; domain?: string; validateApiKey: boolean }>
  readonly ingress: Readonly<{ maxBytes: number; maxRoots: number; maxExpandedBytes: number; maxEntries: number;
    maxFileBytes: number; maxPathDepth: number; maxExtractionRatio: number; archiveLimits: ArchiveManifestLimits }>
  readonly durability: Readonly<{ databaseUrl?: string; tenantId?: string; workerId?: string; managedBy: string; roles?: string;
    sourceMaxTtlMs: number; artifactTtlMs: number }>
  readonly gateway: Readonly<{ url: string; ticketTtlMs: number; maxPayloadBytes: number; maxConnections: number;
    maxConnectionsPerLease: number; maxPendingMessages: number; maxPendingBytes: number; maxBufferedBytes: number;
    leaseRevalidationMs: number }>
  readonly reconciliation: Readonly<{ staleMs: number; intervalMs: number; childStaleMs: number; childIntervalMs: number;
    patchApplyStaleMs: number; patchApplyIntervalMs: number }>
  readonly developmentOptions: Readonly<{ templates?: string; allowedRoots?: string }>
  readonly workspaceMode: 'default' | 'git-working-set'
  readonly pocInspection: boolean
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
}

function overhead(value: number, extra: number, name: string): number {
  const result = value + extra
  if (!Number.isSafeInteger(result)) throw new Error(`${name} is too large`)
  return result
}

export function loadServiceEnv(runtimeEnv: RuntimeEnvironment = process.env): ServiceConfiguration {
  if (runtimeEnv.DATABASE_URL && !runtimeEnv.HOSTED_AGENT_DATABASE_URL) {
    throw new Error('DATABASE_URL is not supported; use HOSTED_AGENT_DATABASE_URL')
  }
  const env = createEnv({ server, runtimeEnv: scopedRuntimeEnv(runtimeEnv, keys), onValidationError: invalidEnvironment })
  if (env.HOSTED_AGENT_MAX_ROOTS > 64) throw new Error('HOSTED_AGENT_MAX_ROOTS must not exceed 64')
  if (Boolean(env.HOSTED_AGENT_TLS_CERT) !== Boolean(env.HOSTED_AGENT_TLS_KEY)) throw new Error('TLS certificate and key must be configured together')
  if (!env.HOSTED_AGENT_DEVELOPMENT) {
    for (const [name, value] of [['HOSTED_AGENT_OBJECT_BUCKET', env.HOSTED_AGENT_OBJECT_BUCKET],
      ['HOSTED_AGENT_DATABASE_URL', env.HOSTED_AGENT_DATABASE_URL], ['HOSTED_AGENT_TENANT_ID', env.HOSTED_AGENT_TENANT_ID],
      ['HOSTED_AGENT_WORKER_ID', env.HOSTED_AGENT_WORKER_ID], ['HOSTED_AGENT_ROLES', env.HOSTED_AGENT_ROLES],
      ['HOSTED_AGENT_TLS_CERT', env.HOSTED_AGENT_TLS_CERT]] as const) if (!value) throw new Error(`${name} is required outside development`)
  }
  const gateway = new URL(env.HOSTED_AGENT_GATEWAY_URL)
  if (gateway.protocol !== 'wss:' && !(env.HOSTED_AGENT_DEVELOPMENT && gateway.protocol === 'ws:')) throw new Error('HOSTED_AGENT_GATEWAY_URL must use WSS outside development')
  if (gateway.username || gateway.password || gateway.search || gateway.hash) throw new Error('HOSTED_AGENT_GATEWAY_URL must not contain credentials, query, or fragment')
  if (!env.HOSTED_AGENT_DEVELOPMENT && (env.HOSTED_AGENT_TICKET_TTL_MS < 5000 || env.HOSTED_AGENT_TICKET_TTL_MS > 300000)) throw new Error('HOSTED_AGENT_TICKET_TTL_MS must be between 5000 and 300000')
  if (env.HOSTED_AGENT_DEVELOPMENT && (!env.HOSTED_AGENT_TEMPLATES || !env.HOSTED_AGENT_ALLOWED_ROOTS)) throw new Error('HOSTED_AGENT_TEMPLATES and HOSTED_AGENT_ALLOWED_ROOTS are required in development')
  const archiveLimits = { ...defaultArchiveManifestLimits, maxArchiveBytes: env.HOSTED_AGENT_MAX_ARCHIVE_BYTES,
    maxEntries: overhead(env.HOSTED_AGENT_MAX_ENTRIES, env.HOSTED_AGENT_MAX_ROOTS + 1, 'HOSTED_AGENT_MAX_ENTRIES'),
    maxFiles: env.HOSTED_AGENT_MAX_ENTRIES, maxTotalBytes: env.HOSTED_AGENT_MAX_EXPANDED_BYTES,
    maxFileBytes: env.HOSTED_AGENT_MAX_FILE_BYTES, maxPathDepth: overhead(env.HOSTED_AGENT_MAX_PATH_DEPTH, 3, 'HOSTED_AGENT_MAX_PATH_DEPTH'),
    maxExtractionRatio: env.HOSTED_AGENT_MAX_EXTRACTION_RATIO }
  return Object.freeze({ development: env.HOSTED_AGENT_DEVELOPMENT,
    http: Object.freeze({ host: env.HOSTED_AGENT_HOST, port: env.HOSTED_AGENT_PORT, bearerToken: env.CODEX_HOSTED_AGENT_TOKEN }),
    tls: Object.freeze({ ...(env.HOSTED_AGENT_TLS_CERT ? { certificatePath: env.HOSTED_AGENT_TLS_CERT, keyPath: env.HOSTED_AGENT_TLS_KEY! } : {}) }),
    storage: Object.freeze({ statePath: env.HOSTED_AGENT_STATE_PATH, blobPath: env.HOSTED_AGENT_BLOB_PATH,
      ...(env.HOSTED_AGENT_OBJECT_BUCKET ? { objectBucket: env.HOSTED_AGENT_OBJECT_BUCKET } : {}),
      ...(env.HOSTED_AGENT_OBJECT_PREFIX ? { objectPrefix: env.HOSTED_AGENT_OBJECT_PREFIX } : {}),
      ...(env.HOSTED_AGENT_OBJECT_REGION ? { objectRegion: env.HOSTED_AGENT_OBJECT_REGION } : {}),
      ...(env.HOSTED_AGENT_OBJECT_ENDPOINT ? { objectEndpoint: env.HOSTED_AGENT_OBJECT_ENDPOINT } : {}),
      forcePathStyle: env.HOSTED_AGENT_OBJECT_FORCE_PATH_STYLE, maxObjectBytes: env.HOSTED_AGENT_MAX_OBJECT_BYTES }),
    e2b: Object.freeze({ apiKey: env.E2B_API_KEY, ...(env.E2B_API_URL ? { apiUrl: env.E2B_API_URL } : {}),
      ...(env.E2B_DOMAIN ? { domain: env.E2B_DOMAIN } : {}), validateApiKey: env.E2B_VALIDATE_API_KEY }),
    ingress: Object.freeze({ maxBytes: env.HOSTED_AGENT_MAX_ARCHIVE_BYTES, maxRoots: env.HOSTED_AGENT_MAX_ROOTS,
      maxExpandedBytes: env.HOSTED_AGENT_MAX_EXPANDED_BYTES, maxEntries: env.HOSTED_AGENT_MAX_ENTRIES,
      maxFileBytes: env.HOSTED_AGENT_MAX_FILE_BYTES, maxPathDepth: env.HOSTED_AGENT_MAX_PATH_DEPTH,
      maxExtractionRatio: env.HOSTED_AGENT_MAX_EXTRACTION_RATIO, archiveLimits }),
    durability: Object.freeze({ ...(env.HOSTED_AGENT_DATABASE_URL ? { databaseUrl: env.HOSTED_AGENT_DATABASE_URL } : {}),
      ...(env.HOSTED_AGENT_TENANT_ID ? { tenantId: env.HOSTED_AGENT_TENANT_ID } : {}), ...(env.HOSTED_AGENT_WORKER_ID ? { workerId: env.HOSTED_AGENT_WORKER_ID } : {}),
      managedBy: env.HOSTED_AGENT_MANAGED_BY, ...(env.HOSTED_AGENT_ROLES ? { roles: env.HOSTED_AGENT_ROLES } : {}),
      sourceMaxTtlMs: env.HOSTED_AGENT_SOURCE_MAX_TTL_MS, artifactTtlMs: env.HOSTED_AGENT_ARTIFACT_TTL_MS }),
    gateway: Object.freeze({ url: gateway.href, ticketTtlMs: env.HOSTED_AGENT_TICKET_TTL_MS,
      maxPayloadBytes: env.HOSTED_AGENT_GATEWAY_MAX_PAYLOAD_BYTES, maxConnections: env.HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS,
      maxConnectionsPerLease: env.HOSTED_AGENT_GATEWAY_MAX_CONNECTIONS_PER_LEASE, maxPendingMessages: env.HOSTED_AGENT_GATEWAY_MAX_PENDING_MESSAGES,
      maxPendingBytes: env.HOSTED_AGENT_GATEWAY_MAX_PENDING_BYTES, maxBufferedBytes: env.HOSTED_AGENT_GATEWAY_MAX_BUFFERED_BYTES,
      leaseRevalidationMs: env.HOSTED_AGENT_GATEWAY_LEASE_REVALIDATION_MS }),
    reconciliation: Object.freeze({ staleMs: env.HOSTED_AGENT_STALE_MS, intervalMs: env.HOSTED_AGENT_RECONCILE_MS,
      childStaleMs: env.HOSTED_AGENT_CHILD_STALE_MS, childIntervalMs: env.HOSTED_AGENT_CHILD_RECONCILE_MS,
      patchApplyStaleMs: env.HOSTED_AGENT_PATCH_APPLY_STALE_MS, patchApplyIntervalMs: env.HOSTED_AGENT_PATCH_APPLY_RECONCILE_MS }),
    developmentOptions: Object.freeze({ ...(env.HOSTED_AGENT_TEMPLATES ? { templates: env.HOSTED_AGENT_TEMPLATES } : {}),
      ...(env.HOSTED_AGENT_ALLOWED_ROOTS ? { allowedRoots: env.HOSTED_AGENT_ALLOWED_ROOTS } : {}) }),
    workspaceMode: env.HOSTED_AGENT_WORKSPACE_MODE, pocInspection: env.HOSTED_AGENT_POC_INSPECTION,
    logLevel: env.HOSTED_AGENT_LOG_LEVEL })
}
