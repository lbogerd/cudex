import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import type { ExecGateway } from '../src/gateway.js'
import { startServer } from '../src/http-server.js'
import type { ControlPlane } from '../src/service.js'

interface Response {
  status: number
  headers: import('node:http').IncomingHttpHeaders
  body: string
}

function post(port: number, path: string, body: string | Buffer, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: 'Bearer test-token', ...headers } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

function postOversizedStream(port: number, path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: 'Bearer test-token' } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.write(Buffer.alloc(1024 * 1024))
    request.write(Buffer.alloc(1))
    request.end()
  })
}

async function fixture(service: object) {
  const gateway = { attach() {} } as unknown as ExecGateway
  const server = await startServer(service as ControlPlane, gateway, { host: '127.0.0.1', port: 0, bearerToken: 'test-token', allowInsecureHttp: true })
  const port = (server.address() as import('node:net').AddressInfo).port
  return { server, port }
}

test('HTTP responses disable caching and redact unexpected service errors', async t => {
  const service = {
    async reconnect() { return { ok: true } },
    async checkpoint() { throw new Error('provider URL contained a secret') },
  }
  const { server, port } = await fixture(service); t.after(() => server.close())

  const success = await post(port, '/v1/agents/reconnect', '{}')
  assert.equal(success.status, 200)
  assert.equal(success.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(success.body), { ok: true })

  const failure = await post(port, '/v1/agents/checkpoint', '{}')
  assert.equal(failure.status, 503)
  assert.equal(failure.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(failure.body), { error: 'service unavailable' })
  assert.equal(failure.body.includes('secret'), false)
})

test('HTTP rejects oversized declared and streamed bodies before service dispatch', async t => {
  let calls = 0
  const service = { async provision() { calls++; return { ok: true } } }
  const { server, port } = await fixture(service); t.after(() => server.close())

  const declared = await post(port, '/v1/agents/provision', '', { 'content-length': String(1024 * 1024 + 1) })
  assert.equal(declared.status, 413)
  assert.equal(declared.headers['cache-control'], 'no-store')

  const streamed = await postOversizedStream(port, '/v1/agents/provision')
  assert.equal(streamed.status, 413)
  assert.equal(calls, 0)
})

test('HTTP requires paired TLS configuration unless development mode is explicit', async () => {
  const gateway = { attach() {} } as unknown as ExecGateway
  const service = {} as ControlPlane
  await assert.rejects(startServer(service, gateway, { host: '127.0.0.1', port: 0, bearerToken: 'token' }), /TLS is required/)
  await assert.rejects(startServer(service, gateway, {
    host: '127.0.0.1', port: 0, bearerToken: 'token', tlsCertPath: '/tmp/cert', allowInsecureHttp: true,
  }), /configured together/)
})
