import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { JsonStore } from '../src/store.js'
import { TicketIssuer } from '../src/tickets.js'
import { ExecGateway } from '../src/gateway.js'
import { FakeProvider } from './fake-provider.js'

const listening = (server: ReturnType<typeof createServer> | WebSocketServer) => new Promise<void>(resolve => server.once('listening', resolve))
test('gateway rejects missing tickets, proxies frames, and closes revoked leases', async () => {
  const upstreamServer = createServer(); const upstream = new WebSocketServer({ server: upstreamServer })
  upstream.on('connection', socket => socket.on('message', data => socket.send(data)))
  upstreamServer.listen(0, '127.0.0.1'); await listening(upstreamServer)
  const upstreamPort = (upstreamServer.address() as import('node:net').AddressInfo).port

  const directory = await mkdtemp(join(tmpdir(), 'cudex-gateway-')); const store = new JsonStore(join(directory, 'state.json')); await store.open()
  const provider = new FakeProvider(); const created = await provider.create(); provider.rawExecUrl = `ws://127.0.0.1:${upstreamPort}`
  await store.transaction(database => { database.leases.lease_test = { leaseId: 'lease_test', environmentId: 'env_test', sandboxId: created.sandboxId,
    agentId: 'agent', ownerAgentId: null, template: 'general-v1', cwd: 'file:///workspace', workspaceRoots: ['file:///workspace'],
    baseSnapshotId: 'snapshot', latestSnapshotId: 'snapshot', state: 'active', toolPolicy: { allowedDomains: [], allowedTools: [] } } })
  const tickets = new TicketIssuer(store, 'wss://gateway.example'); const gateway = new ExecGateway(tickets, store, provider)
  const server = createServer(); gateway.attach(server); server.listen(0, '127.0.0.1'); await listening(server)
  const port = (server.address() as import('node:net').AddressInfo).port
  const issued = new URL(await tickets.issue('lease_test'))
  const client = new WebSocket(`ws://127.0.0.1:${port}${issued.pathname}${issued.search}`)
  await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
  const echoed = new Promise<string>(resolve => client.once('message', data => resolve(data.toString())))
  client.send('{"id":1,"method":"initialize"}'); assert.equal(await echoed, '{"id":1,"method":"initialize"}')
  const closed = new Promise<void>(resolve => client.once('close', () => resolve())); gateway.revoke('lease_test'); await closed
  const denied = new WebSocket(`ws://127.0.0.1:${port}/leases/lease_test`)
  await new Promise<void>(resolve => denied.once('error', () => resolve()))
  server.close(); upstream.close(); upstreamServer.close()
})
