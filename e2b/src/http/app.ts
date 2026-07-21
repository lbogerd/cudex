import { Hono } from 'hono'
import type { AgentLifecycleService } from '../lifecycle-service.js'
import type { AuthenticatedSourceSnapshotApi } from '../source-snapshot-api.js'
import type { AuthenticatedTenant } from '../source-snapshots.js'
import { ServiceError } from '../types.js'
import { safeFailureDiagnostic, type ServiceLogger } from '../observability/logger.js'
import { hasValidBearer } from './middleware/auth.js'
import { boundedBytes, requiredJson } from './middleware/json.js'
import { lifecycleRouteDefinitions } from './routes/agents.js'
import { pocRoutePaths } from './routes/poc.js'
import { sourceSnapshotRoutePath } from './routes/source-snapshots.js'
import {
  CheckpointRequestSchema, CheckpointResponseSchema, PatchApplyRequestSchema, PatchApplyResponseSchema,
  PatchExportRequestSchema, PatchExportResponseSchema, ProvisionedAgentSchema, ProvisionRequestSchema,
  ReconnectRequestSchema, ReferenceClearRequestSchema, ReleaseRequestSchema, RetentionRequestSchema,
  RetentionResponseSchema, type PatchApplyRequest, type PatchExportRequest, type ReferenceClearRequest,
  type RetentionRequest,
} from '../contracts/lifecycle.js'

export const sourceSnapshotContentType = 'application/vnd.codex.source-snapshot.v1'
const maxRequestBytes = 1024 * 1024
const maxSourceMetadataBytes = 64 * 1024

export interface ControlPlaneDependencies {
  lifecycle: AgentLifecycleService
  patchExport?: { exportPatch(request: PatchExportRequest): Promise<unknown> }
  patchApply?: { applyPatch(request: PatchApplyRequest): Promise<unknown> }
  retention?: {
    retain(request: RetentionRequest): Promise<unknown>
    clear(request: ReferenceClearRequest): Promise<unknown>
  }
  sourceSnapshots?: {
    principal: AuthenticatedTenant
    api: Pick<AuthenticatedSourceSnapshotApi, 'create'>
    maxArchiveBytes: number
  }
  pocInspection?: {
    verifyWorkspace(providerSandboxId: string): Promise<boolean>
    cleanupProviderSnapshots(): Promise<number>
  }
}

export interface ControlPlaneAppOptions { bearerToken: string }
type AppEnvironment = { Variables: { operation: string } }

async function json(request: Request): Promise<unknown> {
  return requiredJson(request, maxRequestBytes)
}

function sourceEnvelope(value: Uint8Array): { metadata: unknown; archive: Uint8Array } {
  const bytes = Buffer.from(value)
  if (bytes.byteLength < 4) throw new ServiceError(400, 'invalid source snapshot envelope')
  const metadataLength = bytes.readUInt32BE(0)
  if (metadataLength === 0 || metadataLength > maxSourceMetadataBytes || metadataLength > bytes.byteLength - 4) {
    throw new ServiceError(400, 'invalid source snapshot envelope')
  }
  const metadataBytes = bytes.subarray(4, 4 + metadataLength)
  const text = metadataBytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(metadataBytes)) throw new ServiceError(400, 'invalid source snapshot metadata')
  try { return { metadata: JSON.parse(text), archive: Uint8Array.from(bytes.subarray(4 + metadataLength)) } }
  catch { throw new ServiceError(400, 'invalid source snapshot metadata') }
}

export function createControlPlaneApp(
  dependencies: ControlPlaneDependencies,
  options: ControlPlaneAppOptions,
  logger: ServiceLogger,
): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff')
    await next()
  })
  app.use('*', async (c, next) => {
    if (!hasValidBearer(c.req.header('authorization'), options.bearerToken)) throw new ServiceError(401, 'unauthorized')
    await next()
  })

  for (const [path, operation, inputSchema, outputSchema] of lifecycleRouteDefinitions) {
    app.post(path, async c => {
      c.set('operation', operation)
      const input = inputSchema.parse(await json(c.req.raw)) as never
      const result = await (dependencies.lifecycle[operation] as (request: never) => Promise<unknown>)(input)
      if (operation === 'release') return c.body(null, 204)
      return c.json(outputSchema!.parse(result))
    })
  }
  app.post('/v1/agents/patch/export', async c => {
    c.set('operation', 'exportPatch')
    if (!dependencies.patchExport) throw new ServiceError(503, 'durable patch service unavailable')
    const result = await dependencies.patchExport.exportPatch(PatchExportRequestSchema.parse(await json(c.req.raw)))
    return c.json(PatchExportResponseSchema.parse(result))
  })
  app.post('/v1/agents/patch/apply', async c => {
    c.set('operation', 'applyPatch')
    if (!dependencies.patchApply) throw new ServiceError(503, 'durable patch service unavailable')
    const result = await dependencies.patchApply.applyPatch(PatchApplyRequestSchema.parse(await json(c.req.raw)))
    return c.json(PatchApplyResponseSchema.parse(result))
  })
  app.post('/v1/agents/retain', async c => {
    c.set('operation', 'retain')
    if (!dependencies.retention) throw new ServiceError(503, 'durable patch service unavailable')
    return c.json(RetentionResponseSchema.parse(await dependencies.retention.retain(
      RetentionRequestSchema.parse(await json(c.req.raw)))))
  })
  app.post('/v1/agents/references/clear', async c => {
    c.set('operation', 'clearReferences')
    if (!dependencies.retention) throw new ServiceError(503, 'durable patch service unavailable')
    return c.json(RetentionResponseSchema.parse(await dependencies.retention.clear(
      ReferenceClearRequestSchema.parse(await json(c.req.raw)))))
  })
  app.post(sourceSnapshotRoutePath, async c => {
    c.set('operation', 'sourceSnapshot')
    const source = dependencies.sourceSnapshots
    if (!source) throw new ServiceError(503, 'source snapshot service unavailable')
    if (c.req.header('content-type') !== sourceSnapshotContentType) {
      throw new ServiceError(415, 'unsupported source snapshot content type')
    }
    const envelope = sourceEnvelope(await boundedBytes(c.req.raw, source.maxArchiveBytes + maxSourceMetadataBytes + 4))
    if (envelope.archive.byteLength > source.maxArchiveBytes) throw new ServiceError(413, 'request too large')
    return c.json(await source.api.create(source.principal, envelope.metadata, envelope.archive), 201)
  })
  app.post(pocRoutePaths.workspaceVerification, async c => {
    c.set('operation', 'pocWorkspaceVerification')
    if (!dependencies.pocInspection) throw new ServiceError(404, 'not found')
    const input = await json(c.req.raw)
    if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== 1
      || typeof (input as Record<string, unknown>).providerSandboxId !== 'string'
      || !/^[A-Za-z0-9_.-]{1,512}$/u.test((input as Record<string, string>).providerSandboxId!)) {
      throw new ServiceError(400, 'invalid POC workspace verification request')
    }
    return c.json({ verified: await dependencies.pocInspection.verifyWorkspace(
      (input as Record<string, string>).providerSandboxId!) })
  })
  app.post(pocRoutePaths.providerSnapshotCleanup, async c => {
    c.set('operation', 'pocProviderSnapshotCleanup')
    if (!dependencies.pocInspection) throw new ServiceError(404, 'not found')
    const input = await json(c.req.raw)
    if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== 0) {
      throw new ServiceError(400, 'invalid POC provider snapshot cleanup request')
    }
    return c.json({ deleted: await dependencies.pocInspection.cleanupProviderSnapshots() })
  })
  app.notFound(c => c.json({ error: 'not found' }, 404))
  app.onError((error, c) => {
    const status = error instanceof ServiceError ? error.status : 503
    if (status >= 500) logger.error({ event: 'control_plane_request_failed',
      operation: c.get('operation') ?? 'unrouted', status, ...safeFailureDiagnostic(error) })
    if (status === 413) c.header('Connection', 'close')
    return c.json({ error: error instanceof ServiceError && status < 500 ? error.message : 'service unavailable' }, status as 400)
  })
  return app
}
