import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { BlobStore } from '../src/blob-store.js'
import { ExecGateway } from '../src/gateway.js'
import { startServer } from '../src/http-server.js'
import { ControlPlane } from '../src/service.js'
import { JsonStore } from '../src/store.js'
import { TicketIssuer } from '../src/tickets.js'
import type { ProvisionRequest } from '../src/types.js'
import { FakeProvider } from './fake-provider.js'

interface HttpResponse {
  status: number
  body: string
}

const token = 'black-box-test-token'
const upstreamToken = 'fake-traffic-access-token'

function listening(server: Server): Promise<void> {
  return new Promise(resolve => server.once('listening', resolve))
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function post(port: number, path: string, value: unknown): Promise<HttpResponse> {
  const encoded = JSON.stringify(value)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(encoded)),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end(encoded)
  })
}

function localGatewayUrl(port: number, issued: string): string {
  const url = new URL(issued)
  return `ws://127.0.0.1:${port}${url.pathname}${url.search}`
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => socket.once('close', (code, reason) => resolve({
    code, reason: reason.toString(),
  })))
}

function rejectedStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    socket.once('error', reject)
  })
}

async function echoServer(t: TestContext) {
  const server = createServer()
  const websocket = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.headers['e2b-traffic-access-token'] !== upstreamToken) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    websocket.handleUpgrade(request, socket, head, client => websocket.emit('connection', client, request))
  })
  websocket.on('connection', socket => socket.on('message', data => socket.send(data)))
  server.listen(0, '127.0.0.1')
  await listening(server)
  t.after(async () => {
    websocket.close()
    await closeServer(server)
  })
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

interface Harness {
  directory: string
  statePath: string
  root: string
  blobs: BlobStore
  provider: FakeProvider
  request: ProvisionRequest
  start(): Promise<Runtime>
}

interface Runtime {
  store: JsonStore
  server: Server
  port: number
  close(): Promise<void>
}

async function harness(t: TestContext): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-http-lifecycle-'))
  const root = join(directory, 'project')
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'dirty.txt'), 'dirty workspace\n')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 255, 17, 128]))
  await writeFile(join(root, 'executable.sh'), '#!/bin/sh\necho ready\n')
  await chmod(join(root, 'executable.sh'), 0o755)
  await symlink('dirty.txt', join(root, 'link'))
  const statePath = join(directory, 'state.json')
  const blobs = new BlobStore(join(directory, 'blobs'))
  const provider = new FakeProvider()
  provider.rawExecUpstream = { url: await echoServer(t), accessToken: upstreamToken }
  const request: ProvisionRequest = {
    agentId: 'agent-root', ownerAgentId: null, agentType: 'default', sandboxTemplate: 'general-v1',
    source: {
      type: 'rootWorkspace', cwd: pathToFileURL(join(root, 'nested')).href,
      workspaceRoots: [pathToFileURL(root).href],
    },
    idempotencyKey: 'provision-root',
  }
  const runtimes = new Set<Runtime>()
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close()
  })
  return {
    directory, statePath, root, blobs, provider, request,
    async start() {
      const store = new JsonStore(statePath)
      await store.open()
      const tickets = new TicketIssuer(store, 'wss://gateway.invalid')
      const gateway = new ExecGateway(tickets, store, provider, { leaseRevalidationMs: 5 }, true)
      const service = new ControlPlane(store, provider, tickets, blobs, {
        templates: { 'general-v1': 'tpl-general' }, allowedRoots: [directory],
        ingress: { maxBytes: 10_000_000, maxRoots: 4 },
      }, gateway)
      const server = await startServer(service, gateway, {
        host: '127.0.0.1', port: 0, bearerToken: token, allowInsecureHttp: true,
      })
      const runtime: Runtime = {
        store, server, port: (server.address() as AddressInfo).port,
        async close() { await closeServer(server); runtimes.delete(runtime) },
      }
      runtimes.add(runtime)
      return runtime
    },
  }
}

test('black-box HTTP provision serializes duplicates and rejects changed-key replay before mutation', async t => {
  const context = await harness(t)
  const runtime = await context.start()

  const [left, right] = await Promise.all([
    post(runtime.port, '/v1/agents/provision', context.request),
    post(runtime.port, '/v1/agents/provision', context.request),
  ])
  assert.equal(left.status, 200)
  assert.equal(right.status, 200)
  const first = JSON.parse(left.body)
  const replay = JSON.parse(right.body)
  assert.equal(first.leaseId, replay.leaseId)
  assert.equal(first.environmentId, replay.environmentId)
  assert.equal(first.baseSnapshotId, replay.baseSnapshotId)
  assert.equal(context.provider.creates, 1)

  const changed = await post(runtime.port, '/v1/agents/provision', {
    ...context.request, agentType: 'reviewer',
  })
  assert.equal(changed.status, 409)
  assert.deepEqual(JSON.parse(changed.body), { error: 'idempotency key reused with different request' })
  assert.equal(context.provider.creates, 1)

  const distinct = await post(runtime.port, '/v1/agents/provision', {
    ...context.request, agentId: 'agent-distinct', idempotencyKey: 'provision-distinct',
  })
  assert.equal(distinct.status, 200)
  const second = JSON.parse(distinct.body)
  assert.notEqual(second.leaseId, first.leaseId)
  assert.notEqual(second.environmentId, first.environmentId)
  assert.equal(context.provider.creates, 2)
})

test('black-box HTTP and WebSocket lifecycle survives restart, restores loss, and releases idempotently', async t => {
  const context = await harness(t)
  let runtime = await context.start()
  const provisionedResponse = await post(runtime.port, '/v1/agents/provision', context.request)
  assert.equal(provisionedResponse.status, 200)
  const provisioned = JSON.parse(provisionedResponse.body)
  const sourceLease = await runtime.store.read(database => database.leases[provisioned.leaseId]!)

  const checkpointResponse = await post(runtime.port, '/v1/agents/checkpoint', {
    leaseId: provisioned.leaseId, idempotencyKey: 'checkpoint-before-restart',
  })
  assert.equal(checkpointResponse.status, 200)
  const checkpoint = JSON.parse(checkpointResponse.body)
  const durableSnapshot = await runtime.store.read(database => database.snapshots[checkpoint.snapshotId]!)
  assert.equal(durableSnapshot.leaseId, provisioned.leaseId)
  assert.ok((await context.blobs.get(durableSnapshot.workspaceArchiveId)).byteLength > 0)

  await runtime.close()
  runtime = await context.start()
  const reconnectedResponse = await post(runtime.port, '/v1/agents/reconnect', {
    leaseId: provisioned.leaseId, idempotencyKey: 'reconnect-after-restart',
  })
  assert.equal(reconnectedResponse.status, 200)
  const reconnected = JSON.parse(reconnectedResponse.body)
  assert.equal(reconnected.environmentId, provisioned.environmentId)
  assert.equal((await runtime.store.read(database => database.leases[provisioned.leaseId]!.sandboxId)), sourceLease.sandboxId)

  const client = new WebSocket(localGatewayUrl(runtime.port, reconnected.connection.execServerUrl))
  await opened(client)
  const echoed = new Promise<string>(resolve => client.once('message', data => resolve(data.toString())))
  client.send('{"id":1,"method":"initialize"}')
  assert.equal(await echoed, '{"id":1,"method":"initialize"}')
  const clientClosed = closed(client)
  client.close()
  await clientClosed

  assert.equal(await rejectedStatus(localGatewayUrl(runtime.port, provisioned.connection.execServerUrl)), 401)
  await context.provider.kill(sourceLease.sandboxId)
  const missing = await post(runtime.port, '/v1/agents/reconnect', {
    leaseId: provisioned.leaseId, idempotencyKey: 'reconnect-missing',
  })
  assert.equal(missing.status, 404)
  assert.deepEqual(JSON.parse(missing.body), { error: 'lease missing' })

  const restoredResponse = await post(runtime.port, '/v1/agents/provision', {
    ...context.request,
    source: { type: 'durableSnapshot', snapshotId: checkpoint.snapshotId },
    idempotencyKey: 'restore-after-loss',
  })
  assert.equal(restoredResponse.status, 200)
  const restored = JSON.parse(restoredResponse.body)
  assert.notEqual(restored.leaseId, provisioned.leaseId)
  assert.notEqual(restored.environmentId, provisioned.environmentId)
  assert.equal(context.provider.restores, 0)

  const restoredClient = new WebSocket(localGatewayUrl(runtime.port, restored.connection.execServerUrl))
  await opened(restoredClient)
  const restoredEcho = new Promise<string>(resolve => restoredClient.once('message', data => resolve(data.toString())))
  restoredClient.send('after restore')
  assert.equal(await restoredEcho, 'after restore')
  const revoked = closed(restoredClient)

  const release = { leaseId: restored.leaseId, idempotencyKey: 'release-restored' }
  assert.equal((await post(runtime.port, '/v1/agents/release', release)).status, 204)
  assert.deepEqual(await revoked, { code: 1008, reason: 'lease revoked' })
  assert.equal((await post(runtime.port, '/v1/agents/release', release)).status, 204)
  assert.deepEqual(context.provider.live(), [])
  assert.ok(await runtime.store.read(database => database.snapshots[checkpoint.snapshotId]))
  assert.ok((await context.blobs.get(durableSnapshot.workspaceArchiveId)).byteLength > 0)
})

test('black-box provider and gateway failures are final and secret-free', async t => {
  const secret = 'provider-credential-must-not-escape'
  const failed = await harness(t)
  failed.provider.create = async () => { throw new Error(secret) }
  const failedRuntime = await failed.start()
  const response = await post(failedRuntime.port, '/v1/agents/provision', failed.request)
  assert.equal(response.status, 503)
  assert.deepEqual(JSON.parse(response.body), { error: 'service unavailable' })
  assert.equal(response.body.includes(secret), false)
  const persisted = JSON.stringify(await failedRuntime.store.read(database => database))
  assert.equal(persisted.includes(secret), false)
  assert.deepEqual(failed.provider.live(), [])

  const denied = await harness(t)
  const deniedRuntime = await denied.start()
  const provisionedResponse = await post(deniedRuntime.port, '/v1/agents/provision', denied.request)
  assert.equal(provisionedResponse.status, 200)
  const provisioned = JSON.parse(provisionedResponse.body)
  const creates = denied.provider.creates
  denied.provider.rawExecUpstream = {
    url: denied.provider.rawExecUpstream && (denied.provider.rawExecUpstream as { url: string }).url,
    accessToken: secret,
  }
  const client = new WebSocket(localGatewayUrl(deniedRuntime.port, provisioned.connection.execServerUrl))
  const denial = closed(client)
  await opened(client)
  assert.deepEqual(await denial, { code: 1013, reason: 'gateway upstream unavailable' })
  assert.equal(denied.provider.creates, creates)
  const deniedState = JSON.stringify(await deniedRuntime.store.read(database => database))
  assert.equal(deniedState.includes(secret), false)
})
