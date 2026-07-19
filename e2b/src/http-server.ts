import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import type { AgentLifecycleService } from './lifecycle-service.js'
import { ServiceError } from './types.js'
import type { ExecGateway } from './gateway.js'
import type { AuthenticatedSourceSnapshotApi } from './source-snapshot-api.js'
import type { AuthenticatedTenant } from './source-snapshots.js'
import {
  validateCheckpointRequest,
  validateCheckpointResponse,
  validatePatchApplyRequest,
  validatePatchApplyResponse,
  validatePatchExportRequest,
  validatePatchExportResponse,
  validateProvisionedAgent,
  validateProvisionRequest,
  validateReconnectRequest,
  validateReferenceClearRequest,
  validateRetentionRequest,
  validateRetentionResponse,
  validateReleaseRequest,
} from './validation.js'

interface ServerOptions {
  host: string
  port: number
  bearerToken: string
  tlsCertPath?: string
  tlsKeyPath?: string
  allowInsecureHttp?: boolean
  patchExport?: {
    exportPatch: (request: ReturnType<typeof validatePatchExportRequest>) => Promise<unknown>
  }
  patchApply?: {
    applyPatch: (request: ReturnType<typeof validatePatchApplyRequest>) => Promise<unknown>
  }
  sourceSnapshots?: {
    principal: AuthenticatedTenant
    api: Pick<AuthenticatedSourceSnapshotApi, 'create'>
    maxArchiveBytes: number
  }
  retention?: {
    retain: (request: ReturnType<typeof validateRetentionRequest>) => Promise<unknown>
    clear: (request: ReturnType<typeof validateReferenceClearRequest>) => Promise<unknown>
  }
  pocInspection?: {
    verifyWorkspace(providerSandboxId: string): Promise<boolean>
    cleanupProviderSnapshots(): Promise<number>
  }
}
const maxRequestBytes = 1024 * 1024
const maxSourceMetadataBytes = 64 * 1024
export const sourceSnapshotContentType = 'application/vnd.codex.source-snapshot.v1'
const routes = new Map([
  ['/v1/agents/provision', 'provision'], ['/v1/agents/reconnect', 'reconnect'],
  ['/v1/agents/checkpoint', 'checkpoint'], ['/v1/agents/patch/export', 'exportPatch'],
  ['/v1/agents/patch/apply', 'applyPatch'],
  ['/v1/agents/release', 'release'],
  ['/v1/agents/retain', 'retain'],
  ['/v1/agents/references/clear', 'clearReferences'],
] as const)
type Method = 'provision' | 'reconnect' | 'checkpoint' | 'exportPatch' | 'applyPatch' | 'release' | 'retain' | 'clearReferences'

function safeFailureDiagnostic(error: unknown): { errorType: string; errorCode?: string } {
  let current = error
  let errorType = 'UnknownError'
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as { name?: unknown; code?: unknown; cause?: unknown }
    if (typeof record.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(record.name)) errorType = record.name
    if (typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(record.code)) {
      return { errorType, errorCode: record.code }
    }
    current = record.cause
  }
  return { errorType }
}

function validateInput(method: Method, value: unknown): unknown {
  switch (method) {
    case 'provision': return validateProvisionRequest(value)
    case 'reconnect': return validateReconnectRequest(value)
    case 'checkpoint': return validateCheckpointRequest(value)
    case 'exportPatch': return validatePatchExportRequest(value)
    case 'applyPatch': return validatePatchApplyRequest(value)
    case 'release': return validateReleaseRequest(value)
    case 'retain': return validateRetentionRequest(value)
    case 'clearReferences': return validateReferenceClearRequest(value)
  }
}

function validateOutput(method: Method, value: unknown): unknown {
  switch (method) {
    case 'provision':
    case 'reconnect': return validateProvisionedAgent(value)
    case 'checkpoint': return validateCheckpointResponse(value)
    case 'exportPatch': return validatePatchExportResponse(value)
    case 'applyPatch': return validatePatchApplyResponse(value)
    case 'release': return value
    case 'retain': return validateRetentionResponse(value)
    case 'clearReferences': return validateRetentionResponse(value)
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
async function body(request: IncomingMessage): Promise<unknown> {
  const bytes = await boundedBody(request, maxRequestBytes)
  try { return JSON.parse(bytes.toString('utf8')) }
  catch { throw new ServiceError(400, 'invalid JSON') }
}

async function boundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const contentLength = request.headers['content-length']
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) throw new ServiceError(400, 'invalid content length')
    if (Number(contentLength) > maximum) throw new ServiceError(413, 'request too large')
  }
  const chunks: Buffer[] = []; let size = 0; let oversized = false
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximum) oversized = true
    else if (!oversized) chunks.push(chunk)
  }
  if (oversized) throw new ServiceError(413, 'request too large')
  return Buffer.concat(chunks)
}

function sourceEnvelope(bytes: Buffer): { metadata: unknown; archive: Uint8Array } {
  if (bytes.byteLength < 5) throw new ServiceError(400, 'invalid source snapshot envelope')
  const metadataLength = bytes.readUInt32BE(0)
  if (metadataLength === 0 || metadataLength > maxSourceMetadataBytes || metadataLength > bytes.byteLength - 5) {
    throw new ServiceError(400, 'invalid source snapshot envelope')
  }
  const metadataBytes = bytes.subarray(4, 4 + metadataLength)
  const metadataText = metadataBytes.toString('utf8')
  if (!Buffer.from(metadataText, 'utf8').equals(metadataBytes)) throw new ServiceError(400, 'invalid source snapshot metadata')
  let metadata: unknown
  try { metadata = JSON.parse(metadataText) } catch { throw new ServiceError(400, 'invalid source snapshot metadata') }
  return { metadata, archive: Uint8Array.from(bytes.subarray(4 + metadataLength)) }
}
export async function startServer(service: AgentLifecycleService, gateway: ExecGateway, options: ServerOptions) {
  if (Boolean(options.tlsCertPath) !== Boolean(options.tlsKeyPath)) throw new Error('TLS certificate and key must be configured together')
  if (!options.tlsCertPath && !options.allowInsecureHttp) throw new Error('TLS is required unless development HTTP is explicitly enabled')
  if (options.sourceSnapshots && (!Number.isSafeInteger(options.sourceSnapshots.maxArchiveBytes)
    || options.sourceSnapshots.maxArchiveBytes <= 0
    || !Number.isSafeInteger(options.sourceSnapshots.maxArchiveBytes + maxSourceMetadataBytes + 4))) {
    throw new Error('invalid source snapshot HTTP limit')
  }
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    let operation = 'unrouted'
    try {
      if (request.method !== 'POST') throw new ServiceError(404, 'not found')
      if (!authorized(request.headers.authorization, options.bearerToken)) throw new ServiceError(401, 'unauthorized')
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.search || url.hash) throw new ServiceError(404, 'not found')
      if (url.pathname === '/v1/source-snapshots') {
        operation = 'sourceSnapshot'
        const source = options.sourceSnapshots
        if (!source) throw new ServiceError(503, 'source snapshot service unavailable')
        if (request.headers['content-type'] !== sourceSnapshotContentType) {
          throw new ServiceError(415, 'unsupported source snapshot content type')
        }
        const bytes = await boundedBody(request, source.maxArchiveBytes + maxSourceMetadataBytes + 4)
        const envelope = sourceEnvelope(bytes)
        if (envelope.archive.byteLength > source.maxArchiveBytes) throw new ServiceError(413, 'request too large')
        const result = await source.api.create(source.principal, envelope.metadata, envelope.archive)
        response.statusCode = 201; response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(result)); return
      }
      if (url.pathname === '/v1/poc/workspace-verification') {
        operation = 'pocWorkspaceVerification'
        if (!options.pocInspection) throw new ServiceError(404, 'not found')
        const input = await body(request)
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Reflect.ownKeys(input).length !== 1
          || typeof (input as Record<string, unknown>).providerSandboxId !== 'string'
          || !/^[A-Za-z0-9_.-]{1,512}$/u.test((input as Record<string, string>).providerSandboxId!)) {
          throw new ServiceError(400, 'invalid POC workspace verification request')
        }
        const verified = await options.pocInspection.verifyWorkspace(
          (input as Record<string, string>).providerSandboxId!,
        )
        response.statusCode = 200; response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ verified })); return
      }
      if (url.pathname === '/v1/poc/provider-snapshots/cleanup') {
        operation = 'pocProviderSnapshotCleanup'
        if (!options.pocInspection) throw new ServiceError(404, 'not found')
        const input = await body(request)
        if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== 0) {
          throw new ServiceError(400, 'invalid POC provider snapshot cleanup request')
        }
        const deleted = await options.pocInspection.cleanupProviderSnapshots()
        response.statusCode = 200; response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ deleted })); return
      }
      const method = routes.get(url.pathname as '/v1/agents/provision')
      if (!method) throw new ServiceError(404, 'not found')
      operation = method
      const input = validateInput(method, await body(request))
      const patchExport = options.patchExport
      const patchApply = options.patchApply
      const dispatch = method === 'retain' || method === 'clearReferences'
        ? options.retention && ((value: never) => method === 'retain'
          ? options.retention!.retain(value) : options.retention!.clear(value))
        : method === 'exportPatch'
        ? patchExport && ((value: never) => patchExport.exportPatch(value))
        : method === 'applyPatch'
          ? patchApply && ((value: never) => patchApply.applyPatch(value))
        : (value: never) => (service[method] as (input: never) => Promise<unknown>)(value)
      if (!dispatch) throw new ServiceError(503, 'durable patch service unavailable')
      const result = validateOutput(method, await dispatch(input as never))
      response.statusCode = method === 'release' ? 204 : 200
      response.setHeader('content-type', 'application/json')
      response.end(method === 'release' ? undefined : JSON.stringify(result))
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 503
      if (status >= 500) console.error(JSON.stringify({ event: 'control_plane_request_failed', operation, status,
        ...safeFailureDiagnostic(error) }))
      response.statusCode = status; response.setHeader('content-type', 'application/json')
      if (status === 413) response.setHeader('connection', 'close')
      const message = error instanceof ServiceError && error.status < 500 ? error.message : 'service unavailable'
      response.end(JSON.stringify({ error: message }))
    }
  }
  const server = options.tlsCertPath && options.tlsKeyPath
    ? createHttpsServer({ cert: await readFile(options.tlsCertPath), key: await readFile(options.tlsKeyPath) }, (request, response) => { void handler(request, response) })
    : createHttpServer((request, response) => { void handler(request, response) })
  gateway.attach(server); await new Promise<void>(resolve => server.listen(options.port, options.host, resolve)); return server
}
