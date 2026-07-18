import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { JsonStore } from './store.js'
const digest = (ticket: string) => createHash('sha256').update(ticket).digest('hex')
export class TicketIssuer {
  constructor(private readonly store: JsonStore, private readonly publicBaseUrl: string, private readonly ttlMs = 60_000) {}
  async issue(leaseId: string): Promise<string> {
    const ticket = randomBytes(32).toString('base64url'); const ticketHash = digest(ticket)
    await this.store.transaction(database => {
      for (const record of Object.values(database.tickets)) if (record.leaseId === leaseId && !record.revokedAt) record.revokedAt = Date.now()
      database.tickets[ticketHash] = { ticketHash, leaseId, expiresAt: Date.now() + this.ttlMs }
    })
    return `${this.publicBaseUrl.replace(/\/$/, '')}/leases/${encodeURIComponent(leaseId)}?ticket=${ticket}`
  }
  async validate(leaseId: string, ticket: string): Promise<boolean> {
    const supplied = Buffer.from(digest(ticket), 'hex')
    return this.store.read(database => {
      const record = database.tickets[supplied.toString('hex')]; if (!record) return false
      return timingSafeEqual(supplied, Buffer.from(record.ticketHash, 'hex')) && record.leaseId === leaseId && !record.revokedAt && record.expiresAt > Date.now()
    })
  }
  async revokeLease(leaseId: string): Promise<void> {
    await this.store.transaction(database => {
      for (const ticket of Object.values(database.tickets)) if (ticket.leaseId === leaseId && !ticket.revokedAt) ticket.revokedAt = Date.now()
    })
  }
}
