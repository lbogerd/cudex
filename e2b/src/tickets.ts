import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { JsonStore } from './store.js'
import type { Database, TicketPurpose } from './types.js'

const digest = (ticket: string) => createHash('sha256').update(ticket).digest('hex')
export const gatewayConnectTicketPurpose: TicketPurpose = 'exec_gateway_connect'
export const maxTicketTtlMs = 5 * 60_000
const purposes = new Set<TicketPurpose>(['exec_gateway_connect', 'exec_gateway_probe'])

export interface TicketAuthority {
  issue(leaseId: string, purpose?: TicketPurpose): Promise<string>
  validate(leaseId: string, ticket: string, purpose?: TicketPurpose): Promise<boolean>
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
  async issue(leaseId: string, purpose: TicketPurpose = gatewayConnectTicketPurpose): Promise<string> {
    if (!leaseId.trim() || Buffer.byteLength(leaseId) > 512) throw new Error('invalid lease identifier')
    if (!purposes.has(purpose)) throw new Error('invalid ticket purpose')
    const ticket = randomBytes(32).toString('base64url'); const ticketHash = digest(ticket)
    await this.store.transaction(database => {
      const now = Date.now(); cleanup(database, now)
      for (const record of Object.values(database.tickets)) if (record.leaseId === leaseId && !record.revokedAt) record.revokedAt = now
      cleanup(database, now)
      database.tickets[ticketHash] = { ticketHash, leaseId, purpose, issuedAt: now, expiresAt: now + this.ttlMs }
    })
    return `${this.publicBaseUrl.replace(/\/$/, '')}/leases/${encodeURIComponent(leaseId)}?ticket=${ticket}`
  }
  async validate(leaseId: string, ticket: string, purpose: TicketPurpose = gatewayConnectTicketPurpose): Promise<boolean> {
    if (!leaseId.trim() || Buffer.byteLength(leaseId) > 512 || !/^[A-Za-z0-9_-]{43}$/.test(ticket) || !purposes.has(purpose)) return false
    const supplied = Buffer.from(digest(ticket), 'hex')
    return this.store.transaction(database => {
      const now = Date.now(); cleanup(database, now)
      const record = database.tickets[supplied.toString('hex')]
      if (!record || !/^[a-f0-9]{64}$/.test(record.ticketHash)) return false
      const matches = timingSafeEqual(supplied, Buffer.from(record.ticketHash, 'hex'))
        && record.leaseId === leaseId && record.purpose === purpose && record.consumedAt === undefined
      if (!matches) return false
      record.consumedAt = now
      return true
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
