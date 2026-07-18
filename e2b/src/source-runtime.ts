import { Pool } from 'pg'
import type { ObjectStore } from './blob-store.js'
import type { ArchiveManifestLimits } from './archive-manifest.js'
import { AuthenticatedSourceSnapshotApi } from './source-snapshot-api.js'
import { runMigrations } from './migrate.js'
import { PostgresObjectReclaimer } from './postgres-object-reclaimer.js'
import { PostgresDurableState } from './postgres-state.js'
import { SourceSnapshotLifecycle, type AuthenticatedTenant } from './source-snapshots.js'

export interface SourceSnapshotRuntimeOptions {
  databaseUrl?: string
  tenantId?: string
  required: boolean
  objects: ObjectStore
  archiveLimits: ArchiveManifestLimits
  maxRoots: number
  maxTtlMs: number
}

export interface SourceSnapshotRuntime {
  pool: Pool
  principal: AuthenticatedTenant
  lifecycle: SourceSnapshotLifecycle
  api: AuthenticatedSourceSnapshotApi
  close(): Promise<void>
}

function opaque(label: string, value: string | undefined): string {
  if (!value?.trim() || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is required and must be a bounded opaque value`)
  }
  return value
}

/** Constructs the single-tenant durable source boundary used by production startup. */
export async function createSourceSnapshotRuntime(
  options: SourceSnapshotRuntimeOptions,
): Promise<SourceSnapshotRuntime | null> {
  if (!options.databaseUrl && !options.tenantId && !options.required) return null
  const databaseUrl = opaque('HOSTED_AGENT_DATABASE_URL', options.databaseUrl)
  const tenantId = opaque('HOSTED_AGENT_TENANT_ID', options.tenantId)
  if (!Number.isSafeInteger(options.maxRoots) || options.maxRoots <= 0 || options.maxRoots > 64
    || !Number.isSafeInteger(options.maxTtlMs) || options.maxTtlMs <= 0) {
    throw new Error('invalid source snapshot runtime limits')
  }
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    await runMigrations(pool)
    const state = new PostgresDurableState(pool)
    const reclaimer = new PostgresObjectReclaimer(pool, options.objects)
    const lifecycle = new SourceSnapshotLifecycle(state, options.objects, {
      maxRoots: options.maxRoots,
      maxTtlMs: options.maxTtlMs,
      archiveLimits: options.archiveLimits,
      reclaimer,
    })
    return {
      pool,
      principal: { tenantId },
      lifecycle,
      api: new AuthenticatedSourceSnapshotApi(lifecycle, {
        maxRoots: options.maxRoots,
        maxArchiveBytes: options.archiveLimits.maxArchiveBytes,
      }),
      async close() { await pool.end() },
    }
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw error
  }
}
