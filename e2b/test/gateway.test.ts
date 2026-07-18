import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { ExecGateway, type GatewayLimits } from '../src/gateway.js'
import { JsonStore } from '../src/store.js'
import { TicketIssuer } from '../src/tickets.js'
import { FakeProvider } from './fake-provider.js'

const listening = (server: ReturnType<typeof createServer> | WebSocketServer) => new Promise<void>(resolve => server.once('listening', resolve))
const opened = (socket: WebSocket) => new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
const closed = (socket: WebSocket) => new Promise<number>(resolve => socket.once('close', code => resolve(code)))
const immediate = () => new Promise<void>(resolve => setImmediate(resolve))

async function rejectedStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0) })
    socket.once('error', reject)
  })
}

async function fixture(rawExecUrl: string, limits: Partial<GatewayLimits> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-gateway-'))
  const store = new JsonStore(join(directory, 'state.json')); await store.open()
  const provider = new FakeProvider(); const created = await provider.create(); provider.rawExecUrl = rawExecUrl
  await store.transaction(database => { database.leases.lease_test = { leaseId: 'lease_test', environmentId: 'env_test', sandboxId: created.sandboxId,
    agentId: 'agent', ownerAgentId: null, template: 'general-v1', cwd: 'file:///workspace', workspaceRoots: ['file:///workspace'],
    baseSnapshotId: 'snapshot', latestSnapshotId: 'snapshot', state: 'active', toolPolicy: { allowedDomains: [], allowedTools: [] } } })
  const tickets = new TicketIssuer(store, 'wss://gateway.example'); const gateway = new ExecGateway(tickets, store, provider, limits)
  const server = createServer(); gateway.attach(server); server.listen(0, '127.0.0.1'); await listening(server)
  const port = (server.address() as import('node:net').AddressInfo).port
  const issueUrl = async () => {
    const issued = new URL(await tickets.issue('lease_test'))
    return `ws://127.0.0.1:${port}${issued.pathname}${issued.search}`
  }
  return { store, provider, gateway, server, tickets, issueUrl, url: await issueUrl() }
}

async function echoServer() {
  const server = createServer(); const websocket = new WebSocketServer({ server })
  websocket.on('connection', socket => socket.on('message', data => socket.send(data)))
  server.listen(0, '127.0.0.1'); await listening(server)
  const port = (server.address() as import('node:net').AddressInfo).port
  return { server, websocket, url: `ws://127.0.0.1:${port}` }
}

test('gateway rejects missing tickets, proxies frames, and closes revoked leases', async t => {
  const upstream = await echoServer(); t.after(() => { upstream.websocket.close(); upstream.server.close() })
  const context = await fixture(upstream.url); t.after(() => context.server.close())
  const client = new WebSocket(context.url); await opened(client)
  const echoed = new Promise<string>(resolve => client.once('message', data => resolve(data.toString())))
  client.send('{"id":1,"method":"initialize"}'); assert.equal(await echoed, '{"id":1,"method":"initialize"}')
  const close = closed(client); context.gateway.revoke('lease_test'); assert.equal(await close, 1008)
  assert.equal(await rejectedStatus(context.url.replace(/\?.*/, '')), 401)
})

test('gateway handles malformed lease paths without an unhandled upgrade failure', async t => {
  const context = await fixture('ws://127.0.0.1:1'); t.after(() => context.server.close())
  const malformed = context.url.replace('/leases/lease_test', '/leases/%E0%A4%A')
  assert.equal(await rejectedStatus(malformed), 401)
  assert.equal(await rejectedStatus(context.url.replace(/\?.*/, '')), 401)
})

test('gateway bounds connections and removes empty active-lease entries', async t => {
  const upstream = await echoServer(); t.after(() => { upstream.websocket.close(); upstream.server.close() })
  const context = await fixture(upstream.url, { maxConnections: 1, maxConnectionsPerLease: 1 }); t.after(() => context.server.close())
  const first = new WebSocket(context.url); await opened(first)
  assert.equal(await rejectedStatus(context.url), 401)
  assert.equal(await rejectedStatus(await context.issueUrl()), 429)
  const firstClosed = closed(first); first.close(); await firstClosed; await immediate()
  const active = (context.gateway as unknown as { active: Map<string, Set<WebSocket>> }).active
  assert.equal(active.size, 0)
  const replacement = new WebSocket(await context.issueUrl()); await opened(replacement)
  const replacementClosed = closed(replacement); replacement.close(); await replacementClosed
})

test('gateway enforces WebSocket payload and pre-upstream pending-byte limits', async t => {
  const upstream = await echoServer(); t.after(() => { upstream.websocket.close(); upstream.server.close() })
  const payloadContext = await fixture(upstream.url, { maxPayloadBytes: 8 }); t.after(() => payloadContext.server.close())
  const oversized = new WebSocket(payloadContext.url); await opened(oversized)
  const oversizedClosed = closed(oversized); oversized.send(Buffer.alloc(9)); assert.equal(await oversizedClosed, 1009)

  const holdingServer = createServer(); const held = new Set<import('node:stream').Duplex>()
  holdingServer.on('upgrade', (_request, socket) => { held.add(socket); socket.once('close', () => held.delete(socket)) })
  holdingServer.listen(0, '127.0.0.1'); await listening(holdingServer)
  t.after(() => { for (const socket of held) socket.destroy(); holdingServer.close() })
  const holdingPort = (holdingServer.address() as import('node:net').AddressInfo).port
  const pendingContext = await fixture(`ws://127.0.0.1:${holdingPort}`, { maxPendingBytes: 4 }); t.after(() => pendingContext.server.close())
  const pending = new WebSocket(pendingContext.url); await opened(pending); await immediate()
  const pendingClosed = closed(pending); pending.send('12345'); assert.equal(await pendingClosed, 1009)
})

test('gateway revalidates active lease state after provider connection', async t => {
  const context = await fixture('ws://127.0.0.1:1'); t.after(() => context.server.close())
  const originalConnect = context.provider.connect.bind(context.provider)
  let releaseConnect!: () => void
  let connectEntered!: () => void
  const connectGate = new Promise<void>(resolve => { releaseConnect = resolve })
  const entered = new Promise<void>(resolve => { connectEntered = resolve })
  context.provider.connect = async sandboxId => { connectEntered(); await connectGate; return originalConnect(sandboxId) }

  const client = new WebSocket(context.url); await opened(client); await entered
  const close = closed(client)
  await context.store.transaction(database => { database.leases.lease_test!.state = 'released' })
  releaseConnect()
  assert.equal(await close, 1008)
})

test('gateway closes an established connection after another replica durably releases its lease', async t => {
  const upstream = await echoServer(); t.after(() => { upstream.websocket.close(); upstream.server.close() })
  const context = await fixture(upstream.url, { leaseRevalidationMs: 5 }); t.after(() => context.server.close())
  const client = new WebSocket(context.url); await opened(client)
  const close = closed(client)
  await context.store.transaction(database => { database.leases.lease_test!.state = 'released' })
  assert.equal(await close, 1008)
})
