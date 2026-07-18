import type { IncomingMessage } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { Server as HttpsServer } from 'node:https'
import WebSocket, { WebSocketServer } from 'ws'
import type { ProviderAdapter } from './provider.js'
import type { JsonStore } from './store.js'
import type { TicketIssuer } from './tickets.js'

export class ExecGateway {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly active = new Map<string, Set<WebSocket>>()
  constructor(private readonly tickets: TicketIssuer, private readonly store: JsonStore, private readonly provider: ProviderAdapter) {}
  attach(server: HttpServer | HttpsServer): void {
    server.on('upgrade', (request, socket, head) => { void this.upgrade(request, socket, head) })
  }
  revoke(leaseId: string): void {
    for (const socket of this.active.get(leaseId) ?? []) socket.close(1008, 'lease revoked')
    this.active.delete(leaseId)
  }
  private async upgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'https://gateway.invalid')
    const match = /^\/leases\/([^/]+)$/.exec(url.pathname); const ticket = url.searchParams.get('ticket')
    const leaseId = match?.[1] ? decodeURIComponent(match[1]) : ''
    if (!ticket || !leaseId || !(await this.tickets.validate(leaseId, ticket))) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
    const sandboxId = await this.store.read(database => database.leases[leaseId]?.state === 'active' ? database.leases[leaseId]!.sandboxId : undefined)
    if (!sandboxId) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return }
    this.server.handleUpgrade(request, socket, head, client => { void this.proxy(client, leaseId) })
  }
  private async proxy(client: WebSocket, leaseId: string): Promise<void> {
    const lease = await this.store.read(database => database.leases[leaseId])
    if (!lease) { client.close(1008, 'lease missing'); return }
    let upstream: WebSocket
    try { upstream = new WebSocket((await this.provider.connect(lease.sandboxId)).rawExecUrl) }
    catch { client.close(1013, 'gateway upstream unavailable'); return }
    const connections = this.active.get(leaseId) ?? new Set<WebSocket>(); connections.add(client); this.active.set(leaseId, connections)
    const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = []
    client.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
      else pending.push({ data, binary })
    })
    upstream.once('open', () => {
      for (const frame of pending.splice(0)) upstream.send(frame.data, { binary: frame.binary })
      upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }) })
    })
    const close = () => { client.close(); upstream.close(); connections.delete(client) }
    client.on('close', close); upstream.on('close', close); upstream.on('error', close)
  }
}
