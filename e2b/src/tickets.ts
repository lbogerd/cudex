import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { JsonStore } from './store.js'
import type { Database, TicketPurpose } from './types.js'

const digest = (ticket: string) => createHash('sha256').update(ticket).digest('hex')
export const gatewayConnectTicketPurpose: TicketPurpose = 'exec_gateway_connect'
export const maxTicketTtlMs = 5 * 60_000
const purposes = new Set<TicketPurpose>(['exec_gateway_connect', 'exec_gateway_probe'])

export interface ValidatedTicket { connectionGeneration: number }

export interface TicketAuthority {
  issue(leaseId: string, purpose?: TicketPurpose, expectedConnectionGeneration?: number): Promise<string>
  validate(leaseId: string, ticket: string, purpose?: TicketPurpose): Promise<ValidatedTicket | null>
  revokeLease(leaseId: string): Promise<void>
}

function cleanup(database: Database, now: number): void {
  for (const [ticketHash, record] of Object.entries(database.tickets)) {
    if (record.expiresAt <= now || record.revokedAt !== undefined) delete database.tickets[ticketHash]
  }
}

export class TicketIssuer {
  constructor(private readonly store: JsonStore, private readonly publicBaseUrl: string, private readonly ttlMs = 60_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maxTicketTtlMs) throw new Error('invalid ticket TTL')
  }
  async issue(leaseId: string, purpose: TicketPurpose = gatewayConnectTicketPurpose,
    expectedConnectionGeneration?: number): Promise<string> {
    if (!leaseId.trim() || Buffer.byteLength(leaseId) > 512) throw new Error('invalid lease identifier')
    if (!purposes.has(purpose)) throw new Error('invalid ticket purpose')
    if (expectedConnectionGeneration !== undefined
      && (!Number.isSafeInteger(expectedConnectionGeneration) || expectedConnectionGeneration < 0)) {
      throw new Error('invalid connection generation')
    }
    const ticket = randomBytes(32).toString('base64url'); const ticketHash = digest(ticket)
    await this.store.transaction(database => {
      const now = Date.now(); cleanup(database, now)
      const connectionGeneration = database.leases[leaseId]?.connectionGeneration ?? 0
      if (expectedConnectionGeneration !== undefined
        && connectionGeneration !== expectedConnectionGeneration) throw new Error('connection generation changed')
      for (const record of Object.values(database.tickets)) if (record.leaseId === leaseId && !record.revokedAt) record.revokedAt = now
      cleanup(database, now)
      database.tickets[ticketHash] = { ticketHash, leaseId, purpose, issuedAt: now, expiresAt: now + this.ttlMs,
        connectionGeneration }
    })
    return `${this.publicBaseUrl.replace(/\/$/, '')}/leases/${encodeURIComponent(leaseId)}?ticket=${ticket}`
  }
  async validate(leaseId: string, ticket: string,
    purpose: TicketPurpose = gatewayConnectTicketPurpose): Promise<ValidatedTicket | null> {
    if (!leaseId.trim() || Buffer.byteLength(leaseId) > 512 || !/^[A-Za-z0-9_-]{43}$/.test(ticket) || !purposes.has(purpose)) return null
    const supplied = Buffer.from(digest(ticket), 'hex')
    return this.store.transaction(database => {
      const now = Date.now(); cleanup(database, now)
      const record = database.tickets[supplied.toString('hex')]
      if (!record || !/^[a-f0-9]{64}$/.test(record.ticketHash)) return null
      const matches = timingSafeEqual(supplied, Buffer.from(record.ticketHash, 'hex'))
        && record.leaseId === leaseId && record.purpose === purpose && record.consumedAt === undefined
      if (!matches) return null
      record.consumedAt = now
      return { connectionGeneration: record.connectionGeneration ?? 0 }
    })
  }
  async revokeLease(leaseId: string): Promise<void> {
    await this.store.transaction(database => {
      const now = Date.now(); cleanup(database, now)
      for (const ticket of Object.values(database.tickets)) if (ticket.leaseId === leaseId && !ticket.revokedAt) ticket.revokedAt = now
      cleanup(database, now)
    })
  }
}
