import type { IncomingMessage } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { Server as HttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { ProviderAdapter } from './provider.js'
import type { TicketAuthority } from './tickets.js'

export interface ActiveLeaseDirectory {
  activeSandbox(leaseId: string): Promise<string | undefined>
}

export interface GatewayLimits {
  maxPayloadBytes: number
  maxConnections: number
  maxConnectionsPerLease: number
  maxPendingMessages: number
  maxPendingBytes: number
  maxBufferedBytes: number
  leaseRevalidationMs: number
}

const defaultLimits: GatewayLimits = {
  maxPayloadBytes: 1024 * 1024,
  maxConnections: 1024,
  maxConnectionsPerLease: 8,
  maxPendingMessages: 64,
  maxPendingBytes: 1024 * 1024,
  maxBufferedBytes: 1024 * 1024,
  leaseRevalidationMs: 5_000,
}

function bytes(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0)
  return data.byteLength
}

function reject(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`)
}

export class ExecGateway {
  private readonly server: WebSocketServer
  private readonly active = new Map<string, Set<WebSocket>>()
  private readonly limits: GatewayLimits

  constructor(
    private readonly tickets: TicketAuthority,
    private readonly leases: ActiveLeaseDirectory,
    private readonly provider: ProviderAdapter,
    limits: Partial<GatewayLimits> = {},
  ) {
    this.limits = { ...defaultLimits, ...limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid gateway limit: ${name}`)
    }
    if (this.limits.leaseRevalidationMs > 60_000) throw new Error('invalid gateway limit: leaseRevalidationMs')
    this.server = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxPayloadBytes })
  }

  attach(server: HttpServer | HttpsServer): void {
    server.on('upgrade', (request, socket, head) => {
      void this.upgrade(request, socket, head).catch(() => reject(socket, 503, 'Service Unavailable'))
    })
  }

  revoke(leaseId: string): void {
    const connections = this.active.get(leaseId)
    this.active.delete(leaseId)
    for (const socket of connections ?? []) socket.close(1008, 'lease revoked')
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let leaseId = ''
    let ticket: string | null = null
    try {
      const url = new URL(request.url ?? '/', 'https://gateway.invalid')
      const match = /^\/leases\/([^/]+)$/.exec(url.pathname)
      leaseId = match?.[1] ? decodeURIComponent(match[1]) : ''
      ticket = url.searchParams.get('ticket')
    } catch {
      reject(socket, 401, 'Unauthorized')
      return
    }
    if (!ticket || !leaseId || leaseId.length > 512 || !(await this.tickets.validate(leaseId, ticket))) {
      reject(socket, 401, 'Unauthorized')
      return
    }
    const sandboxId = await this.activeSandbox(leaseId)
    if (!sandboxId) {
      reject(socket, 404, 'Not Found')
      return
    }
    const leaseConnections = this.active.get(leaseId)?.size ?? 0
    if (leaseConnections >= this.limits.maxConnectionsPerLease || this.activeConnections() >= this.limits.maxConnections) {
      reject(socket, 429, 'Too Many Requests')
      return
    }
    try {
      this.server.handleUpgrade(request, socket, head, client => { void this.proxy(client, leaseId, sandboxId) })
    } catch {
      reject(socket, 400, 'Bad Request')
    }
  }

  private async proxy(client: WebSocket, leaseId: string, sandboxId: string): Promise<void> {
    const connections = this.active.get(leaseId) ?? new Set<WebSocket>()
    connections.add(client)
    this.active.set(leaseId, connections)

    let upstream: WebSocket | undefined
    let closed = false
    let revalidation: NodeJS.Timeout | undefined
    let revalidationPending = false
    let pendingBytes = 0
    const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = []
    const cleanup = (code?: number, reason?: string) => {
      if (closed) return
      closed = true
      if (revalidation) clearInterval(revalidation)
      pending.splice(0)
      pendingBytes = 0
      connections.delete(client)
      if (connections.size === 0 && this.active.get(leaseId) === connections) this.active.delete(leaseId)
      if (client.readyState === WebSocket.OPEN) client.close(code, reason)
      if (upstream?.readyState === WebSocket.OPEN) upstream.close()
      else if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate()
    }
    revalidation = setInterval(() => {
      if (closed || revalidationPending) return
      revalidationPending = true
      void this.activeSandbox(leaseId)
        .then(active => { if (active !== sandboxId) cleanup(1008, 'lease inactive') })
        .catch(() => cleanup(1013, 'gateway unavailable'))
        .finally(() => { revalidationPending = false })
    }, this.limits.leaseRevalidationMs)
    revalidation.unref()
    client.on('close', () => cleanup())
    client.on('error', () => cleanup())

    if (await this.activeSandbox(leaseId) !== sandboxId) {
      cleanup(1008, 'lease inactive')
      return
    }
    if (closed) return
    let rawExecUrl: string
    try { rawExecUrl = (await this.provider.connect(sandboxId)).rawExecUrl }
    catch { cleanup(1013, 'gateway upstream unavailable'); return }
    if (closed) return
    if (await this.activeSandbox(leaseId) !== sandboxId) {
      cleanup(1008, 'lease inactive')
      return
    }
    if (closed) return

    try { upstream = new WebSocket(rawExecUrl, { maxPayload: this.limits.maxPayloadBytes }) }
    catch { cleanup(1013, 'gateway upstream unavailable'); return }

    client.on('message', (data, binary) => {
      if (closed || !upstream) return
      const size = bytes(data)
      if (upstream.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount + size > this.limits.maxBufferedBytes) cleanup(1013, 'gateway backpressure')
        else upstream.send(data, { binary }, error => { if (error) cleanup(1013, 'gateway upstream unavailable') })
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        if (pending.length >= this.limits.maxPendingMessages || pendingBytes + size > this.limits.maxPendingBytes) {
          cleanup(1009, 'gateway buffer limit exceeded')
        } else {
          pending.push({ data, binary })
          pendingBytes += size
        }
      } else cleanup(1013, 'gateway upstream unavailable')
    })
    upstream.once('open', () => {
      void (async () => {
        if (await this.activeSandbox(leaseId) !== sandboxId) {
          cleanup(1008, 'lease inactive')
          return
        }
        if (closed) return
        for (const frame of pending.splice(0)) {
          pendingBytes -= bytes(frame.data)
          if (!upstream || upstream.bufferedAmount + bytes(frame.data) > this.limits.maxBufferedBytes) {
            cleanup(1013, 'gateway backpressure')
            return
          }
          upstream.send(frame.data, { binary: frame.binary }, error => { if (error) cleanup(1013, 'gateway upstream unavailable') })
        }
        upstream.on('message', (data, binary) => {
          const size = bytes(data)
          if (client.readyState !== WebSocket.OPEN) return
          if (client.bufferedAmount + size > this.limits.maxBufferedBytes) cleanup(1013, 'gateway backpressure')
          else client.send(data, { binary }, error => { if (error) cleanup() })
        })
      })().catch(() => cleanup(1013, 'gateway unavailable'))
    })
    upstream.on('close', () => cleanup())
    upstream.on('error', () => cleanup(1013, 'gateway upstream unavailable'))
  }

  private async activeSandbox(leaseId: string): Promise<string | undefined> {
    return this.leases.activeSandbox(leaseId)
  }

  private activeConnections(): number {
    let count = 0
    for (const connections of this.active.values()) count += connections.size
    return count
  }
}
