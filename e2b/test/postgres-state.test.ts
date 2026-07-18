import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { runMigrations } from '../src/migrate.js'
import { DurableStateConflictError, PostgresDurableState, type CreateLeaseInput, type StoredObject } from '../src/postgres-state.js'
import { PostgresTicketIssuer } from '../src/postgres-tickets.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
interface Fixture { admin: Pool; firstPool: Pool; secondPool: Pool; first: PostgresDurableState; second: PostgresDurableState; schema: string }

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_state_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`)
  const config = { connectionString: databaseUrl, options: `-c search_path=${schema}` }
  const firstPool = new Pool(config); const secondPool = new Pool(config); await runMigrations(firstPool)
  return { admin, firstPool, secondPool, first: new PostgresDurableState(firstPool), second: new PostgresDurableState(secondPool), schema }
}
async function cleanup(context: Fixture): Promise<void> {
  await context.firstPool.end(); await context.secondPool.end()
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`); await context.admin.end()
}
const live = (name: string, fn: (context: Fixture) => Promise<void>) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => { const context = await fixture(); try { await fn(context) } finally { await cleanup(context) } })

const digest = (character: string) => `sha256:${character.repeat(64)}`
const object = (tenantId: string, objectId: string, kind: StoredObject['kind'], character: string): StoredObject => ({
  objectId, tenantId, kind, storageBucket: 'hosted-agent-test', storageKey: `${tenantId}/${objectId}`,
  checksum: digest(character), sizeBytes: 10, state: 'available', expiresAt: null,
})
async function objects(context: Fixture, tenant = 'tenant-1', suffix = '') {
  const archive = object(tenant, `archive${suffix}`, 'workspace_archive', suffix ? 'c' : 'a')
  const manifest = object(tenant, `manifest${suffix}`, 'manifest', suffix ? 'd' : 'b')
  await context.first.registerObject(archive); await context.first.registerObject(manifest)
  return { archive, manifest }
}
function leaseInput(ids: { archive: StoredObject; manifest: StoredObject }, overrides: Partial<CreateLeaseInput> = {}): CreateLeaseInput {
  return {
    leaseId: 'lease-1', environmentId: 'env-1', tenantId: 'tenant-1', agentId: 'agent-1',
    providerSandboxId: 'sandbox-1', sandboxTemplate: 'general-v1', cwdUri: 'file:///workspace/root',
    workspaceRootUris: ['file:///workspace/root'], toolPolicy: {}, policyVersion: 1,
    baseSnapshot: { snapshotId: 'snapshot-1', providerSnapshotId: 'provider-snapshot-1',
      workspaceArchiveObjectId: ids.archive.objectId, manifestObjectId: ids.manifest.objectId,
      manifestChecksum: ids.manifest.checksum },
    ...overrides,
  }
}

live('source snapshots and object references deny cross-tenant access and preserve immutable identity', async context => {
  const sourceObject = object('tenant-1', 'source-object', 'source_archive', 'a'); await context.first.registerObject(sourceObject)
  const source = { sourceSnapshotId: 'source-1', tenantId: 'tenant-1', archiveObjectId: sourceObject.objectId,
    checksum: sourceObject.checksum, cwdUri: 'file:///source/root', workspaceRootUris: ['file:///source/root'],
    state: 'available' as const, expiresAt: new Date(Date.now() + 60_000) }
  await context.first.registerSourceSnapshot(source)
  assert.equal((await context.second.findAuthorizedSourceSnapshot('tenant-1', 'source-1'))?.sourceSnapshotId, 'source-1')
  assert.equal(await context.second.findAuthorizedSourceSnapshot('tenant-2', 'source-1'), null)
  await assert.rejects(context.second.registerSourceSnapshot({ ...source, tenantId: 'tenant-2' }), DurableStateConflictError)
  await assert.rejects(context.second.registerSourceSnapshot({ ...source, sourceSnapshotId: 'source-cross-tenant', tenantId: 'tenant-2' }))
  await assert.rejects(context.firstPool.query(`UPDATE hosted_agent_source_snapshots SET checksum = $1 WHERE source_snapshot_id = 'source-1'`, [digest('f')]))
  await assert.rejects(context.first.registerSourceSnapshot({ ...source, sourceSnapshotId: 'source-invalid',
    cwdUri: 'file:///source/other', workspaceRootUris: ['file:///source/root'] }))
  await assert.rejects(context.first.registerSourceSnapshot({ ...source, sourceSnapshotId: 'source-overlap',
    workspaceRootUris: ['file:///source/root', 'file:///source/root/nested'] }))
  await assert.rejects(context.second.addObjectReference({ tenantId: 'tenant-2', objectId: sourceObject.objectId,
    referenceKind: 'codex_thread', referenceId: 'thread-1', purpose: 'source' }))
})

live('lease and base snapshot creation is atomic and unique across two pools', async context => {
  const ids = await objects(context)
  await assert.rejects(context.first.createLeaseWithBaseSnapshot(leaseInput(ids, {
    leaseId: 'rolled-back', environmentId: 'rolled-back-env', providerSandboxId: 'rolled-back-sandbox',
    baseSnapshot: { ...leaseInput(ids).baseSnapshot, snapshotId: 'rolled-back-snapshot', manifestObjectId: 'missing-object' },
  })))
  assert.equal(await context.first.getLease('tenant-1', 'rolled-back'), null)

  const other = await objects(context, 'tenant-1', '-other')
  const attempts = await Promise.allSettled([
    context.first.createLeaseWithBaseSnapshot(leaseInput(ids)),
    context.second.createLeaseWithBaseSnapshot(leaseInput(other, {
      leaseId: 'lease-2', environmentId: 'env-1', providerSandboxId: 'sandbox-2',
      baseSnapshot: { ...leaseInput(other).baseSnapshot, snapshotId: 'snapshot-2', providerSnapshotId: 'provider-snapshot-2' },
    })),
  ])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1)
  const counts = await context.firstPool.query<{ leases: string; snapshots: string }>(`
    SELECT (SELECT count(*) FROM hosted_agent_leases)::text AS leases,
           (SELECT count(*) FROM hosted_agent_snapshots)::text AS snapshots
  `)
  assert.deepEqual(counts.rows[0], { leases: '1', snapshots: '1' })
})

live('checkpoint references and durable data survive release', async context => {
  const ids = await objects(context); const created = await context.first.createLeaseWithBaseSnapshot(leaseInput(ids))
  const checkpointObjects = await objects(context, 'tenant-1', '-checkpoint')
  const checkpoint = await context.second.appendCheckpoint('tenant-1', created.lease.leaseId, {
    snapshotId: 'snapshot-checkpoint', providerSnapshotId: 'provider-checkpoint',
    workspaceArchiveObjectId: checkpointObjects.archive.objectId,
    manifestObjectId: checkpointObjects.manifest.objectId, manifestChecksum: checkpointObjects.manifest.checksum,
  })
  await context.first.addSnapshotReference({ tenantId: 'tenant-1', snapshotId: checkpoint.snapshotId,
    referenceKind: 'codex_thread', referenceId: 'thread-1' })
  const released = await context.second.releaseLease('tenant-1', created.lease.leaseId)
  assert.equal(released.state, 'released')
  assert.equal((await context.first.getLease('tenant-1', created.lease.leaseId))?.latestSnapshotId, checkpoint.snapshotId)
  assert.equal((await context.first.getSnapshot('tenant-1', checkpoint.snapshotId))?.state, 'available')
  const retained = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_snapshot_references
    WHERE snapshot_id = $1 AND reference_kind = 'codex_thread' AND reference_id = 'thread-1'
  `, [checkpoint.snapshotId])
  assert.equal(retained.rows[0]!.count, '1')
})

live('ticket hashes rotate, consume once, expire, revoke, and clean up across pools', async context => {
  const ids = await objects(context); const created = await context.first.createLeaseWithBaseSnapshot(leaseInput(ids))
  const firstIssuer = new PostgresTicketIssuer(context.first, 'tenant-1', 'wss://gateway.example')
  const secondIssuer = new PostgresTicketIssuer(context.second, 'tenant-1', 'wss://gateway.example')
  const issued = new URL(await firstIssuer.issue(created.lease.leaseId))
  const rawTicket = issued.searchParams.get('ticket')!
  assert.equal(await secondIssuer.validate(created.lease.leaseId, rawTicket), true)
  assert.equal(await firstIssuer.validate(created.lease.leaseId, rawTicket), false)
  const persistedTicket = await context.firstPool.query<{ ticket_hash: Buffer }>('SELECT ticket_hash FROM hosted_agent_tickets')
  assert.equal(persistedTicket.rows.some(row => row.ticket_hash.includes(Buffer.from(rawTicket))), false)
  const firstHash = randomBytes(32); const secondHash = randomBytes(32); const expiredHash = randomBytes(32)
  await context.first.issueTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId,
    ticketHash: firstHash, purpose: 'exec_gateway_connect', expiresAt: new Date(Date.now() + 60_000) })
  assert.equal(await context.second.consumeTicketHash({ tenantId: 'tenant-2', leaseId: created.lease.leaseId, ticketHash: firstHash, purpose: 'exec_gateway_connect' }), false)
  assert.equal(await context.second.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: firstHash, purpose: 'exec_gateway_connect' }), true)
  assert.equal(await context.first.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: firstHash, purpose: 'exec_gateway_connect' }), false)
  await context.second.issueTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId,
    ticketHash: secondHash, purpose: 'exec_gateway_probe', expiresAt: new Date(Date.now() + 60_000) })
  assert.equal(await context.first.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: firstHash, purpose: 'exec_gateway_connect' }), false)
  assert.equal(await context.first.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: secondHash, purpose: 'exec_gateway_connect' }), false)
  assert.equal(await context.first.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: secondHash, purpose: 'exec_gateway_probe' }), true)
  await context.first.issueTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId,
    ticketHash: expiredHash, purpose: 'exec_gateway_connect', expiresAt: new Date(Date.now() + 60_000) })
  assert.equal(await context.second.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: expiredHash,
    purpose: 'exec_gateway_connect', at: new Date(Date.now() + 120_000) }), false)
  await context.second.revokeLeaseTickets('tenant-1', created.lease.leaseId)
  assert.ok(await context.first.cleanupTickets(new Date(Date.now() + 180_000)) >= 3)
  const remaining = await context.firstPool.query<{ count: string }>('SELECT count(*)::text AS count FROM hosted_agent_tickets')
  assert.equal(remaining.rows[0]!.count, '0')
})
