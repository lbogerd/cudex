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
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: {
      authorization: 'Bearer test-token', 'content-type': 'application/json', ...headers,
    } }, response => {
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
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: {
      authorization: 'Bearer test-token', 'content-type': 'application/json',
    } }, response => {
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
        connectionGeneration: 1,
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

test('JSON routes require an explicit application/json content type', async t => {
  const { server, port } = await fixture({ async checkpoint() { return { snapshotId: 'snapshot' } } })
  t.after(() => server.close())
  const response = await post(port, '/v1/agents/checkpoint', JSON.stringify({
    leaseId: 'lease', idempotencyKey: 'checkpoint',
  }), { 'content-type': 'text/plain' })
  assert.equal(response.status, 415)
  assert.deepEqual(JSON.parse(response.body), { error: 'unsupported media type' })
})

test('HTTP retention route strictly dispatches the exact durable set', async t => {
  const seen: unknown[] = []
  const gateway = { attach() {} } as unknown as ExecGateway
  const server = await startServer({} as ControlPlane, gateway, {
    host: '127.0.0.1', port: 0, bearerToken: 'test-token', allowInsecureHttp: true,
    retention: { async retain(request) {
      seen.push(request); return { revision: 1, desiredHash: 'a'.repeat(64) }
    }, async clear(request) {
      seen.push(request); return { revision: 2, desiredHash: 'b'.repeat(64) }
    } },
  })
  t.after(() => server.close())
  const port = (server.address() as import('node:net').AddressInfo).port
  const request = { agentId: 'agent', leaseId: 'lease', baseSnapshotId: 'base',
    latestSnapshotId: 'latest', artifactId: 'artifact', expectedRevision: null }
  const response = await post(port, '/v1/agents/retain', JSON.stringify(request))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { revision: 1, desiredHash: 'a'.repeat(64) })
  assert.deepEqual(seen, [request])
  const clear = { agentId: 'agent', leaseId: 'lease', expectedRevision: 1 }
  const cleared = await post(port, '/v1/agents/references/clear', JSON.stringify(clear))
  assert.equal(cleared.status, 200)
  assert.deepEqual(JSON.parse(cleared.body), { revision: 2, desiredHash: 'b'.repeat(64) })
  assert.deepEqual(seen, [request, clear])
})

test('POC inspection routes are disabled by default and accept only bounded exact requests', async t => {
  const unavailable = await fixture({})
  t.after(() => unavailable.server.close())
  assert.equal((await post(unavailable.port, '/v1/poc/workspace-verification',
    JSON.stringify({ providerSandboxId: 'sandbox' }))).status, 404)

  const calls: unknown[] = []
  const gateway = { attach() {} } as unknown as ExecGateway
  const server = await startServer({} as ControlPlane, gateway, {
    host: '127.0.0.1', port: 0, bearerToken: 'test-token', allowInsecureHttp: true,
    pocInspection: {
      async verifyWorkspace(providerSandboxId) { calls.push(providerSandboxId); return true },
      async cleanupProviderSnapshots() { calls.push('cleanup'); return 3 },
    },
  })
  t.after(() => server.close())
  const port = (server.address() as import('node:net').AddressInfo).port
  const verified = await post(port, '/v1/poc/workspace-verification',
    JSON.stringify({ providerSandboxId: 'sandbox_123' }))
  assert.equal(verified.status, 200)
  assert.deepEqual(JSON.parse(verified.body), { verified: true })
  const cleaned = await post(port, '/v1/poc/provider-snapshots/cleanup', '{}')
  assert.equal(cleaned.status, 200)
  assert.deepEqual(JSON.parse(cleaned.body), { deleted: 3 })
  assert.deepEqual(calls, ['sandbox_123', 'cleanup'])

  assert.equal((await post(port, '/v1/poc/workspace-verification',
    JSON.stringify({ providerSandboxId: 'sandbox_123', tenantId: 'spoofed' }))).status, 400)
  assert.equal((await post(port, '/v1/poc/provider-snapshots/cleanup',
    JSON.stringify({ tenantId: 'spoofed' }))).status, 400)
  assert.deepEqual(calls, ['sandbox_123', 'cleanup'])
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

test('patch export route validates the exact wire and dispatches only to the durable service', async t => {
  const calls: unknown[] = []
  const gateway = { attach() {} } as unknown as ExecGateway
  const server = await startServer({} as ControlPlane, gateway, {
    host: '127.0.0.1', port: 0, bearerToken: 'test-token', allowInsecureHttp: true,
    patchExport: {
      async exportPatch(request) {
        calls.push(request)
        return {
          artifactId: 'artifact_123', agentId: request.agentId,
          baseSnapshotId: request.baseSnapshotId, checksum: `sha256:${'a'.repeat(64)}`,
          changedFiles: 2, sizeBytes: 128,
        }
      },
    },
  }); t.after(() => server.close())
  const port = (server.address() as import('node:net').AddressInfo).port
  const request = {
    leaseId: 'lease_child', agentId: 'agent_child', baseSnapshotId: 'snapshot_base',
    idempotencyKey: 'patch-export-1',
  }

  const exported = await post(port, '/v1/agents/patch/export', JSON.stringify(request))
  assert.equal(exported.status, 200)
  assert.deepEqual(JSON.parse(exported.body), {
    artifactId: 'artifact_123', agentId: 'agent_child', baseSnapshotId: 'snapshot_base',
    checksum: `sha256:${'a'.repeat(64)}`, changedFiles: 2, sizeBytes: 128,
  })
  assert.deepEqual(calls, [request])

  const spoofed = await post(port, '/v1/agents/patch/export', JSON.stringify({
    ...request, tenantId: 'spoofed',
  }))
  assert.equal(spoofed.status, 400)
  assert.equal(calls.length, 1)

  const unavailable = await fixture({})
  t.after(() => unavailable.server.close())
  const missing = await post(unavailable.port, '/v1/agents/patch/export', JSON.stringify(request))
  assert.equal(missing.status, 503)
  assert.deepEqual(JSON.parse(missing.body), { error: 'service unavailable' })
})

test('patch apply route validates exact tagged wires and dispatches only to the durable service', async t => {
  const calls: unknown[] = []
  const gateway = { attach() {} } as unknown as ExecGateway
  const server = await startServer({} as ControlPlane, gateway, {
    host: '127.0.0.1', port: 0, bearerToken: 'test-token', allowInsecureHttp: true,
    patchApply: {
      async applyPatch(request) {
        calls.push(request)
        if (request.artifactId === 'artifact_conflict') {
          return { type: 'conflict', paths: ['file:///workspace/roots/0/conflict'] }
        }
        if (request.artifactId === 'artifact_rejected') {
          return { type: 'rejected', reason: 'artifact is not applicable' }
        }
        return { type: 'applied', checkpoint: { snapshotId: 'snapshot_result' } }
      },
    },
  }); t.after(() => server.close())
  const port = (server.address() as import('node:net').AddressInfo).port
  const request = {
    targetLeaseId: 'lease_owner', artifactId: 'artifact_clean', idempotencyKey: 'patch-apply-1',
  }

  const applied = await post(port, '/v1/agents/patch/apply', JSON.stringify(request))
  assert.equal(applied.status, 200)
  assert.deepEqual(JSON.parse(applied.body), {
    type: 'applied', checkpoint: { snapshotId: 'snapshot_result' },
  })

  const conflictRequest = { ...request, artifactId: 'artifact_conflict', idempotencyKey: 'patch-apply-2' }
  const conflict = await post(port, '/v1/agents/patch/apply', JSON.stringify(conflictRequest))
  assert.equal(conflict.status, 200)
  assert.deepEqual(JSON.parse(conflict.body), {
    type: 'conflict', paths: ['file:///workspace/roots/0/conflict'],
  })

  const rejectedRequest = { ...request, artifactId: 'artifact_rejected', idempotencyKey: 'patch-apply-3' }
  const rejected = await post(port, '/v1/agents/patch/apply', JSON.stringify(rejectedRequest))
  assert.equal(rejected.status, 200)
  assert.deepEqual(JSON.parse(rejected.body), {
    type: 'rejected', reason: 'artifact is not applicable',
  })
  assert.deepEqual(calls, [request, conflictRequest, rejectedRequest])

  const spoofed = await post(port, '/v1/agents/patch/apply', JSON.stringify({
    ...request, tenantId: 'spoofed',
  }))
  assert.equal(spoofed.status, 400)
  assert.equal(calls.length, 3)

  const unavailable = await fixture({})
  t.after(() => unavailable.server.close())
  const missing = await post(unavailable.port, '/v1/agents/patch/apply', JSON.stringify(request))
  assert.equal(missing.status, 503)
  assert.deepEqual(JSON.parse(missing.body), { error: 'service unavailable' })

  const invalidServer = await startServer({} as ControlPlane, gateway, {
    host: '127.0.0.1', port: 0, bearerToken: 'test-token', allowInsecureHttp: true,
    patchApply: { async applyPatch() {
      return { type: 'conflict', paths: [
        'file:///workspace/roots/0/z', 'file:///workspace/roots/0/a',
      ] }
    } },
  }); t.after(() => invalidServer.close())
  const invalidPort = (invalidServer.address() as import('node:net').AddressInfo).port
  const invalid = await post(invalidPort, '/v1/agents/patch/apply', JSON.stringify(request))
  assert.equal(invalid.status, 503)
  assert.deepEqual(JSON.parse(invalid.body), { error: 'service unavailable' })
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
