import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JsonStore } from '../src/store.js'
import { gatewayConnectTicketPurpose, maxTicketTtlMs, TicketIssuer } from '../src/tickets.js'

async function fixture(ttlMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-tickets-'))
  const state = join(directory, 'state.json'); const store = new JsonStore(state); await store.open()
  const tickets = new TicketIssuer(store, 'wss://gateway.example', ttlMs)
  return { state, store, tickets }
}

test('ticket TTL must be a positive bounded integer', async () => {
  const { store } = await fixture()
  for (const ttl of [0, -1, 1.5, maxTicketTtlMs + 1]) {
    assert.throws(() => new TicketIssuer(store, 'wss://gateway.example', ttl), /invalid ticket TTL/)
  }
  assert.doesNotThrow(() => new TicketIssuer(store, 'wss://gateway.example', maxTicketTtlMs))
})

test('ticket purpose and lease must match and successful validation consumes once', async () => {
  const { state, store, tickets } = await fixture()
  const url = await tickets.issue('lease_a'); const raw = new URL(url).searchParams.get('ticket')!
  const persisted = await readFile(state, 'utf8')
  assert.equal(persisted.includes(raw), false)
  assert.equal(persisted.includes(url), false)
  assert.equal(persisted.includes('ticket='), false)
  assert.equal(persisted.includes('wss://'), false)

  assert.equal(await tickets.validate('lease_b', raw), false)
  assert.equal(await tickets.validate('lease_a', raw, 'exec_gateway_probe'), false)
  assert.equal(await tickets.validate('lease_a', raw, gatewayConnectTicketPurpose), true)
  assert.equal(await tickets.validate('lease_a', raw), false)
  const records = await store.read(database => Object.values(database.tickets))
  assert.equal(records.length, 1)
  assert.equal(records[0]!.purpose, gatewayConnectTicketPurpose)
  assert.equal(typeof records[0]!.consumedAt, 'number')
})

test('issuing a ticket rotates prior lease tickets and preserves wrong-purpose isolation', async () => {
  const { tickets } = await fixture()
  const old = new URL(await tickets.issue('lease_a')).searchParams.get('ticket')!
  const current = new URL(await tickets.issue('lease_a')).searchParams.get('ticket')!
  assert.equal(await tickets.validate('lease_a', old), false)
  assert.equal(await tickets.validate('lease_a', current), true)

  const probe = new URL(await tickets.issue('lease_a', 'exec_gateway_probe')).searchParams.get('ticket')!
  assert.equal(await tickets.validate('lease_a', probe), false)
  assert.equal(await tickets.validate('lease_a', probe, 'exec_gateway_probe'), true)
})

test('expired and revoked ticket records are reclaimed', async () => {
  const { store, tickets } = await fixture(1)
  const expired = new URL(await tickets.issue('lease_expired')).searchParams.get('ticket')!
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(await tickets.validate('lease_expired', expired), false)
  assert.equal(await store.read(database => Object.keys(database.tickets).length), 0)

  const revoked = new URL(await tickets.issue('lease_revoked')).searchParams.get('ticket')!
  await tickets.revokeLease('lease_revoked')
  assert.equal(await tickets.validate('lease_revoked', revoked), false)
  assert.equal(await store.read(database => Object.keys(database.tickets).length), 0)
})
