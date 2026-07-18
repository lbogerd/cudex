import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import type { ExecGateway } from '../src/gateway.js'
import { sourceSnapshotContentType, startServer } from '../src/http-server.js'
import type { ControlPlane } from '../src/service.js'
import { AuthenticatedSourceSnapshotApi } from '../src/source-snapshot-api.js'

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

function sourceEnvelope(metadata: unknown, archive: Uint8Array): Buffer {
  const encoded = Buffer.from(JSON.stringify(metadata)); const length = Buffer.alloc(4)
  length.writeUInt32BE(encoded.byteLength)
  return Buffer.concat([length, encoded, archive])
}

test('HTTP responses disable caching and redact unexpected service errors', async t => {
  const service = {
    async reconnect() {
      return {
        leaseId: 'lease', environmentId: 'environment', baseSnapshotId: 'snapshot',
        connection: { execServerUrl: 'wss://gateway.example/leases/lease?ticket=opaque_ticket' },
        cwd: 'file:///workspace/root', workspaceRoots: ['file:///workspace/root'],
        toolPolicy: { allowedDomains: [], allowedTools: [] },
      }
    },
    async checkpoint() { throw new Error('provider URL contained a secret') },
  }
  const { server, port } = await fixture(service); t.after(() => server.close())

  const success = await post(port, '/v1/agents/reconnect', JSON.stringify({ leaseId: 'lease', idempotencyKey: 'reconnect' }))
  assert.equal(success.status, 200)
  assert.equal(success.headers['cache-control'], 'no-store')
  assert.equal(JSON.parse(success.body).leaseId, 'lease')

  const failure = await post(port, '/v1/agents/checkpoint', JSON.stringify({ leaseId: 'lease', idempotencyKey: 'checkpoint' }))
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

test('HTTP strictly validates requests before dispatch and validates service responses', async t => {
  let provisionCalls = 0
  const service = {
    async provision() { provisionCalls++; return { leaseId: 'lease-only' } },
    async checkpoint() { return { snapshotId: 'snapshot', extra: 'invalid' } },
  }
  const { server, port } = await fixture(service); t.after(() => server.close())
  const malformed = await post(port, '/v1/agents/provision', JSON.stringify({ extra: true }))
  assert.equal(malformed.status, 400)
  assert.equal(provisionCalls, 0)

  const request = {
    agentId: 'agent', ownerAgentId: null, agentType: 'default', sandboxTemplate: 'general-v1',
    source: { type: 'rootWorkspace', cwd: 'file:///source', workspaceRoots: ['file:///source'] },
    idempotencyKey: 'provision',
  }
  const invalidProvision = await post(port, '/v1/agents/provision', JSON.stringify(request))
  assert.equal(invalidProvision.status, 503)
  assert.deepEqual(JSON.parse(invalidProvision.body), { error: 'service unavailable' })
  assert.equal(provisionCalls, 1)

  const invalidCheckpoint = await post(port, '/v1/agents/checkpoint', JSON.stringify({ leaseId: 'lease', idempotencyKey: 'checkpoint' }))
  assert.equal(invalidCheckpoint.status, 503)
  assert.deepEqual(JSON.parse(invalidCheckpoint.body), { error: 'service unavailable' })
})

test('source snapshot upload uses bounded binary framing and trusted tenant context', async t => {
  const principal = { tenantId: 'tenant-from-auth' }; const archive = Buffer.from('archive bytes')
  const checksum = `sha256:${'a'.repeat(64)}`; const manifestChecksum = `sha256:${'b'.repeat(64)}`
  const expiresAt = '2030-01-01T00:00:00.000Z'; const calls: unknown[] = []
  const api = new AuthenticatedSourceSnapshotApi({
    async create(receivedPrincipal, input) {
      calls.push({ receivedPrincipal, input })
      return {
        sourceSnapshotId: `source_${'c'.repeat(32)}`, checksum, expiresAt: new Date(expiresAt),
        manifestChecksum, sizeBytes: input.archive.byteLength,
      }
    },
    async resolve() { throw new Error('not used') },
  }, { maxRoots: 1, maxArchiveBytes: 1024 })
  const gateway = { attach() {} } as unknown as ExecGateway
  const server = await startServer({} as ControlPlane, gateway, {
    host: '127.0.0.1', port: 0, bearerToken: 'test-token', allowInsecureHttp: true,
    sourceSnapshots: { principal, api, maxArchiveBytes: 1024 },
  }); t.after(() => server.close())
  const port = (server.address() as import('node:net').AddressInfo).port
  const metadata = {
    checksum, cwdUri: 'file:///workspace/roots/0/project',
    workspaceRootUris: ['file:///workspace/roots/0/project'], expiresAt,
  }

  const created = await post(port, '/v1/source-snapshots', sourceEnvelope(metadata, archive), {
    'content-type': sourceSnapshotContentType,
  })
  assert.equal(created.status, 201)
  assert.equal(created.headers['cache-control'], 'no-store')
  assert.equal(created.headers['x-content-type-options'], 'nosniff')
  assert.equal(JSON.parse(created.body).sourceSnapshotId, `source_${'c'.repeat(32)}`)
  const call = calls[0] as { receivedPrincipal: unknown; input: { archive: Uint8Array } }
  assert.deepEqual(call.receivedPrincipal, principal)
  assert.deepEqual(call.input.archive, new Uint8Array(archive))

  const spoofed = await post(port, '/v1/source-snapshots', sourceEnvelope({ ...metadata, tenantId: 'spoofed' }, archive), {
    'content-type': sourceSnapshotContentType,
  })
  assert.equal(spoofed.status, 400); assert.equal(calls.length, 1)
  const unauthorized = await post(port, '/v1/source-snapshots', sourceEnvelope(metadata, archive), {
    authorization: 'Bearer wrong-token', 'content-type': sourceSnapshotContentType,
  })
  assert.equal(unauthorized.status, 401); assert.equal(calls.length, 1)
})

test('source snapshot upload rejects framing, content type, and archive overflow before lifecycle dispatch', async t => {
  let calls = 0
  const gateway = { attach() {} } as unknown as ExecGateway
  const server = await startServer({} as ControlPlane, gateway, {
    host: '127.0.0.1', port: 0, bearerToken: 'test-token', allowInsecureHttp: true,
    sourceSnapshots: {
      principal: { tenantId: 'tenant' }, maxArchiveBytes: 4,
      api: { async create() { calls += 1; throw new Error('must not dispatch') } },
    },
  }); t.after(() => server.close())
  const port = (server.address() as import('node:net').AddressInfo).port
  const metadata = {
    checksum: `sha256:${'a'.repeat(64)}`, cwdUri: 'file:///workspace/roots/0/project',
    workspaceRootUris: ['file:///workspace/roots/0/project'], expiresAt: '2030-01-01T00:00:00.000Z',
  }

  assert.equal((await post(port, '/v1/source-snapshots', Buffer.from([0, 0, 0, 8, 1]), {
    'content-type': sourceSnapshotContentType,
  })).status, 400)
  assert.equal((await post(port, '/v1/source-snapshots', sourceEnvelope(metadata, Buffer.from('large')), {
    'content-type': sourceSnapshotContentType,
  })).status, 413)
  assert.equal((await post(port, '/v1/source-snapshots', sourceEnvelope(metadata, Buffer.from('ok')), {
    'content-type': 'application/json',
  })).status, 415)
  assert.equal(calls, 0)
})
