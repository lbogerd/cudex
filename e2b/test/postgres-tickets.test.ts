import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresTicketIssuer } from '../src/postgres-tickets.js'
import type { TicketPurpose } from '../src/types.js'

interface HashRecord { hash: string; leaseId: string; purpose: TicketPurpose; expiresAt: Date; consumed: boolean; revoked: boolean }

class SharedTicketHashes {
  readonly records = new Map<string, HashRecord>()

  async issueTicketHash(input: { tenantId: string; leaseId: string; ticketHash: Uint8Array; purpose: TicketPurpose; expiresAt: Date }): Promise<void> {
    for (const record of this.records.values()) if (record.leaseId === input.leaseId && !record.revoked) record.revoked = true
    this.records.set(Buffer.from(input.ticketHash).toString('hex'), {
      hash: Buffer.from(input.ticketHash).toString('hex'), leaseId: input.leaseId, purpose: input.purpose,
      expiresAt: input.expiresAt, consumed: false, revoked: false,
    })
  }

  async consumeTicketHash(input: { tenantId: string; leaseId: string; ticketHash: Uint8Array; purpose: TicketPurpose; at?: Date }): Promise<boolean> {
    const record = this.records.get(Buffer.from(input.ticketHash).toString('hex'))
    if (!record || record.leaseId !== input.leaseId || record.purpose !== input.purpose || record.consumed
      || record.revoked || record.expiresAt <= (input.at ?? new Date())) return false
    record.consumed = true
    return true
  }

  async revokeLeaseTickets(_tenantId: string, leaseId: string): Promise<number> {
    let count = 0
    for (const record of this.records.values()) {
      if (record.leaseId === leaseId && !record.revoked) { record.revoked = true; count += 1 }
    }
    return count
  }
}

test('PostgreSQL issuer exposes opaque WSS tickets while retaining only hashes', async () => {
  const hashes = new SharedTicketHashes()
  const issuer = new PostgresTicketIssuer(hashes, 'tenant-1', 'wss://gateway.example/base/', 60_000)
  const issued = new URL(await issuer.issue('lease/one'))
  const ticket = issued.searchParams.get('ticket')!
  assert.equal(issued.href.startsWith('wss://gateway.example/base/leases/lease%2Fone?ticket='), true)
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(JSON.stringify([...hashes.records.values()]).includes(ticket), false)
})

test('separate issuer replicas share rotation, purpose, consumption, and revocation state', async () => {
  const hashes = new SharedTicketHashes()
  const first = new PostgresTicketIssuer(hashes, 'tenant-1', 'wss://gateway.example')
  const second = new PostgresTicketIssuer(hashes, 'tenant-1', 'wss://gateway.example')
  const old = new URL(await first.issue('lease-1')).searchParams.get('ticket')!
  const current = new URL(await second.issue('lease-1', 'exec_gateway_probe')).searchParams.get('ticket')!
  assert.equal(await second.validate('lease-1', old), false)
  assert.equal(await first.validate('lease-1', current), false)
  assert.equal(await first.validate('lease-1', current, 'exec_gateway_probe'), true)
  assert.equal(await second.validate('lease-1', current, 'exec_gateway_probe'), false)
  const revoked = new URL(await first.issue('lease-1')).searchParams.get('ticket')!
  await second.revokeLease('lease-1')
  assert.equal(await first.validate('lease-1', revoked), false)
})

test('constructor and request boundaries reject invalid configuration and bearer shapes', async () => {
  const hashes = new SharedTicketHashes()
  assert.throws(() => new PostgresTicketIssuer(hashes, '', 'wss://gateway.example'))
  assert.throws(() => new PostgresTicketIssuer(hashes, 'tenant-1', 'ws://gateway.example'))
  assert.throws(() => new PostgresTicketIssuer(hashes, 'tenant-1', 'wss://user@gateway.example'))
  assert.throws(() => new PostgresTicketIssuer(hashes, 'tenant-1', 'wss://gateway.example', 300_001))
  const issuer = new PostgresTicketIssuer(hashes, 'tenant-1', 'wss://gateway.example')
  assert.equal(await issuer.validate('lease-1', 'raw-ticket'), false)
  await assert.rejects(issuer.issue(' '.repeat(2)))
})
