import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import type { ControlPlane } from './service.js'
import { ServiceError } from './types.js'
import type { ExecGateway } from './gateway.js'

interface ServerOptions {
  host: string
  port: number
  bearerToken: string
  tlsCertPath?: string
  tlsKeyPath?: string
  allowInsecureHttp?: boolean
}
const maxRequestBytes = 1024 * 1024
const routes = new Map([
  ['/v1/agents/provision', 'provision'], ['/v1/agents/reconnect', 'reconnect'],
  ['/v1/agents/checkpoint', 'checkpoint'], ['/v1/agents/release', 'release'],
] as const)

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
async function body(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers['content-length']
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) throw new ServiceError(400, 'invalid content length')
    if (Number(contentLength) > maxRequestBytes) throw new ServiceError(413, 'request too large')
  }
  const chunks: Buffer[] = []; let size = 0; let oversized = false
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxRequestBytes) oversized = true
    else if (!oversized) chunks.push(chunk)
  }
  if (oversized) throw new ServiceError(413, 'request too large')
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new ServiceError(400, 'invalid JSON') }
}
export async function startServer(service: ControlPlane, gateway: ExecGateway, options: ServerOptions) {
  if (Boolean(options.tlsCertPath) !== Boolean(options.tlsKeyPath)) throw new Error('TLS certificate and key must be configured together')
  if (!options.tlsCertPath && !options.allowInsecureHttp) throw new Error('TLS is required unless development HTTP is explicitly enabled')
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('cache-control', 'no-store')
    try {
      if (request.method !== 'POST') throw new ServiceError(404, 'not found')
      if (!authorized(request.headers.authorization, options.bearerToken)) throw new ServiceError(401, 'unauthorized')
      const method = routes.get(new URL(request.url ?? '/', 'http://localhost').pathname as '/v1/agents/provision')
      if (!method) throw new ServiceError(404, 'not found')
      const result = await (service[method] as (input: never) => Promise<unknown>)(await body(request) as never)
      response.statusCode = method === 'release' ? 204 : 200
      response.setHeader('content-type', 'application/json'); response.end(method === 'release' ? undefined : JSON.stringify(result))
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 503
      response.statusCode = status; response.setHeader('content-type', 'application/json')
      if (status === 413) response.setHeader('connection', 'close')
      response.end(JSON.stringify({ error: error instanceof ServiceError ? error.message : 'service unavailable' }))
    }
  }
  const server = options.tlsCertPath && options.tlsKeyPath
    ? createHttpsServer({ cert: await readFile(options.tlsCertPath), key: await readFile(options.tlsKeyPath) }, (request, response) => { void handler(request, response) })
    : createHttpServer((request, response) => { void handler(request, response) })
  gateway.attach(server); await new Promise<void>(resolve => server.listen(options.port, options.host, resolve)); return server
}
