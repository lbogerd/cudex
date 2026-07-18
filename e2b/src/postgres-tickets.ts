import { createHash, randomBytes } from 'node:crypto'
import type { TicketAuthority } from './tickets.js'
import { gatewayConnectTicketPurpose, maxTicketTtlMs } from './tickets.js'
import type { TicketPurpose } from './types.js'

const purposes = new Set<TicketPurpose>(['exec_gateway_connect', 'exec_gateway_probe'])

interface DurableTicketHashes {
  issueTicketHash(input: {
    tenantId: string
    leaseId: string
    ticketHash: Uint8Array
    purpose: TicketPurpose
    expiresAt: Date
  }): Promise<void>
  consumeTicketHash(input: {
    tenantId: string
    leaseId: string
    ticketHash: Uint8Array
    purpose: TicketPurpose
    at?: Date
  }): Promise<boolean>
  revokeLeaseTickets(tenantId: string, leaseId: string): Promise<number>
}

function validId(value: string): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 512
}

function hash(ticket: string): Buffer {
  return createHash('sha256').update(ticket).digest()
}

/**
 * Deployment-tenant-bound ticket authority backed by PostgreSQL hashes.
 * Raw bearer tickets exist only long enough to construct the returned WSS URL.
 */
export class PostgresTicketIssuer implements TicketAuthority {
  private readonly publicBaseUrl: string

  constructor(
    private readonly state: DurableTicketHashes,
    private readonly tenantId: string,
    publicBaseUrl: string,
    private readonly ttlMs = 60_000,
  ) {
    if (!validId(tenantId)) throw new Error('invalid tenant identifier')
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maxTicketTtlMs) throw new Error('invalid ticket TTL')
    let endpoint: URL
    try { endpoint = new URL(publicBaseUrl) } catch { throw new Error('invalid gateway URL') }
    if (endpoint.protocol !== 'wss:' || !endpoint.hostname || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) throw new Error('invalid gateway URL')
    this.publicBaseUrl = endpoint.href.replace(/\/$/, '')
  }

  async issue(leaseId: string, purpose: TicketPurpose = gatewayConnectTicketPurpose): Promise<string> {
    if (!validId(leaseId)) throw new Error('invalid lease identifier')
    if (!purposes.has(purpose)) throw new Error('invalid ticket purpose')
    const ticket = randomBytes(32).toString('base64url')
    await this.state.issueTicketHash({
      tenantId: this.tenantId,
      leaseId,
      ticketHash: hash(ticket),
      purpose,
      expiresAt: new Date(Date.now() + this.ttlMs),
    })
    return `${this.publicBaseUrl}/leases/${encodeURIComponent(leaseId)}?ticket=${ticket}`
  }

  async validate(leaseId: string, ticket: string, purpose: TicketPurpose = gatewayConnectTicketPurpose): Promise<boolean> {
    if (!validId(leaseId) || !/^[A-Za-z0-9_-]{43}$/.test(ticket) || !purposes.has(purpose)) return false
    return this.state.consumeTicketHash({
      tenantId: this.tenantId,
      leaseId,
      ticketHash: hash(ticket),
      purpose,
    })
  }

  async revokeLease(leaseId: string): Promise<void> {
    if (!validId(leaseId)) throw new Error('invalid lease identifier')
    await this.state.revokeLeaseTickets(this.tenantId, leaseId)
  }
}
