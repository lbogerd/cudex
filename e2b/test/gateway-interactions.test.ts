import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { ExecGateway } from '../src/gateway.js'
import type {
  LeaseInteraction,
  LeaseInteractionIdentity,
  LeaseInteractionLedger,
  LeaseInteractionState,
} from '../src/postgres-lease-interactions.js'
import { JsonStore } from '../src/store.js'
import { TicketIssuer } from '../src/tickets.js'
import { FakeProvider } from './fake-provider.js'

const listening = (server: ReturnType<typeof createServer>) =>
  new Promise<void>(resolve => server.once('listening', resolve))
const opened = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
const immediate = () => new Promise<void>(resolve => setImmediate(resolve))

class RecordingLedger implements LeaseInteractionLedger {
  readonly values = new Map<string, LeaseInteraction>()
  beginBarrier: Promise<void> | undefined
  async begin(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    await this.beginBarrier
    return this.set(identity, 'active')
  }
  async resume(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    return this.set(identity, 'active')
  }
  async reattach(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    return this.set(identity, 'active')
  }
  async detach(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    return this.set(identity, 'detached')
  }
  async finish(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    return this.set(identity, 'finished')
  }
  async listUnfinishedProcesses(): Promise<LeaseInteractionIdentity[]> { return [] }
  async listUnfinishedFilesystem(): Promise<LeaseInteractionIdentity[]> { return [] }
  async assertQuiescent(): Promise<void> {}
  private set(identity: LeaseInteractionIdentity, state: LeaseInteractionState): LeaseInteraction {
    const now = new Date()
    const value: LeaseInteraction = {
      ...identity, state, createdAt: now, updatedAt: now,
      detachedAt: state === 'detached' ? now : null,
      finishedAt: state === 'finished' ? now : null,
    }
    this.values.set(identity.interactionId, value)
    return value
  }
}

test('production gateway journals before forwarding and settles only on quiescence or response',
  async t => {
    const upstreamServer = createServer()
    const upstreamWebSocket = new WebSocketServer({ noServer: true })
    const received: string[] = []
    let filesystemReceived!: () => void
    const filesystemForwarded = new Promise<void>(resolve => { filesystemReceived = resolve })
    upstreamServer.on('upgrade', (request, socket, head) => {
      assert.equal(request.headers['e2b-traffic-access-token'], 'traffic-token')
      upstreamWebSocket.handleUpgrade(request, socket, head, client => {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            id?: number; method: string; params?: { processId?: string }
          }
          received.push(message.method)
          if (message.method === 'initialize') {
            client.send(JSON.stringify({ id: message.id, result: { sessionId: 'session-1' } }))
          } else if (message.method === 'process/start') {
            client.send(JSON.stringify({
              id: message.id, result: { processId: message.params?.processId },
            }))
            client.send(JSON.stringify({
              method: 'process/quiesced', params: { processId: message.params?.processId },
            }))
          } else if (message.method === 'fs/writeFile') filesystemReceived()
        })
      })
    })
    upstreamServer.listen(0, '127.0.0.1'); await listening(upstreamServer)
    t.after(() => { upstreamWebSocket.close(); upstreamServer.close() })
    const upstreamPort = (upstreamServer.address() as import('node:net').AddressInfo).port

    const directory = await mkdtemp(join(tmpdir(), 'cudex-gateway-interactions-'))
    const store = new JsonStore(join(directory, 'state.json')); await store.open()
    const provider = new FakeProvider(); const created = await provider.create()
    provider.rawExecUpstream = {
      url: `ws://127.0.0.1:${upstreamPort}/`, accessToken: 'traffic-token',
    }
    await store.transaction(database => { database.leases.lease_test = {
      leaseId: 'lease_test', environmentId: 'environment', sandboxId: created.sandboxId,
      agentId: 'agent', ownerAgentId: null, template: 'general-v1',
      cwd: 'file:///workspace', workspaceRoots: ['file:///workspace'],
      baseSnapshotId: 'snapshot', latestSnapshotId: 'snapshot', state: 'active',
      connectionGeneration: 0,
      toolPolicy: { allowedDomains: [], allowedTools: [] },
    } })
    const tickets = new TicketIssuer(store, 'wss://gateway.example')
    const ledger = new RecordingLedger()
    const gateway = new ExecGateway(tickets, store, provider, {}, true,
      { tenantId: 'tenant', ledger })
    const server = createServer(); gateway.attach(server)
    server.listen(0, '127.0.0.1'); await listening(server); t.after(() => server.close())
    const port = (server.address() as import('node:net').AddressInfo).port
    const issued = new URL(await tickets.issue('lease_test'))
    const client = new WebSocket(`ws://127.0.0.1:${port}${issued.pathname}${issued.search}`)
    await opened(client)

    const initializeResponse = new Promise<void>(resolve => client.once('message', () => resolve()))
    client.send(JSON.stringify({
      id: 1, method: 'initialize', params: { clientName: 'test' },
    }))
    await initializeResponse

    let releaseAdmission!: () => void
    ledger.beginBarrier = new Promise<void>(resolve => { releaseAdmission = resolve })
    const quiesced = new Promise<void>(resolve => {
      const listener = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { method?: string }
        if (message.method === 'process/quiesced') {
          client.off('message', listener)
          resolve()
        }
      }
      client.on('message', listener)
    })
    client.send(JSON.stringify({
      id: 2, method: 'process/start', params: { processId: 'process-1' },
    }))
    await immediate()
    assert.deepEqual(received, ['initialize'])
    releaseAdmission()
    await quiesced
    assert.deepEqual(received, ['initialize', 'process/start'])
    assert.equal([...ledger.values.values()].at(-1)?.state, 'finished')

    ledger.beginBarrier = undefined
    client.send(JSON.stringify({
      id: 3, method: 'fs/writeFile', params: { path: 'file:///workspace/a', dataBase64: '' },
    }))
    await filesystemForwarded
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
    client.close(); await closed; await immediate(); await immediate()
    assert.equal([...ledger.values.values()].at(-1)?.state, 'detached')
  })
