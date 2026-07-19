import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { runMigrations } from '../src/migrate.js'
import { DurableStateConflictError, DurableStateNotFoundError, PostgresDurableState,
  type CreateLeaseInput, type CreateRestoredLeaseInput, type StoredObject } from '../src/postgres-state.js'
import { canonicalRequestHash, PostgresJournal } from '../src/postgres-store.js'
import { PostgresTicketIssuer } from '../src/postgres-tickets.js'
import { PostgresReferenceRetention } from '../src/postgres-reference-retention.js'

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
  const replay = await context.second.registerSourceSnapshot({ ...source, sourceSnapshotId: 'source-replay' })
  assert.equal(replay.sourceSnapshotId, source.sourceSnapshotId)
  assert.equal((await context.second.findAuthorizedSourceSnapshot('tenant-1', 'source-1'))?.sourceSnapshotId, 'source-1')
  assert.equal((await context.second.findAuthorizedSourceSnapshotByChecksum('tenant-1', source.checksum))?.sourceSnapshotId, 'source-1')
  assert.equal(await context.second.findAuthorizedSourceSnapshot('tenant-2', 'source-1'), null)
  await assert.rejects(context.second.registerSourceSnapshot({ ...source, tenantId: 'tenant-2' }), DurableStateConflictError)
  await assert.rejects(context.second.registerSourceSnapshot({ ...source, sourceSnapshotId: 'source-cross-tenant', tenantId: 'tenant-2' }))
  const sharedPhysicalObject = { ...sourceObject, objectId: 'source-object-tenant-2', tenantId: 'tenant-2' }
  await context.second.registerObject(sharedPhysicalObject)
  const secondTenantSource = await context.second.registerSourceSnapshot({ ...source, sourceSnapshotId: 'source-tenant-2',
    tenantId: 'tenant-2', archiveObjectId: sharedPhysicalObject.objectId })
  assert.equal(secondTenantSource.tenantId, 'tenant-2')
  await assert.rejects(context.firstPool.query(`UPDATE hosted_agent_source_snapshots SET checksum = $1 WHERE source_snapshot_id = 'source-1'`, [digest('f')]))
  await assert.rejects(context.first.registerSourceSnapshot({ ...source, sourceSnapshotId: 'source-invalid',
    cwdUri: 'file:///source/other', workspaceRootUris: ['file:///source/root'] }))
  await assert.rejects(context.first.registerSourceSnapshot({ ...source, sourceSnapshotId: 'source-overlap',
    workspaceRootUris: ['file:///source/root', 'file:///source/root/nested'] }))
  await assert.rejects(context.second.addObjectReference({ tenantId: 'tenant-2', objectId: sourceObject.objectId,
    referenceKind: 'codex_thread', referenceId: 'thread-1', purpose: 'source' }))
})

live('final source authorization locks the exact tenant, checksum, state, and unexpired row', async context => {
  const sourceObject = object('tenant-1', 'source-final-auth', 'source_archive', 'a')
  await context.first.registerObject(sourceObject)
  const expiresAt = new Date(Date.now() + 60_000)
  await context.first.registerSourceSnapshot({
    sourceSnapshotId: 'source-final-auth', tenantId: 'tenant-1', archiveObjectId: sourceObject.objectId,
    checksum: sourceObject.checksum, cwdUri: 'file:///source/root', workspaceRootUris: ['file:///source/root'],
    state: 'available', expiresAt,
  })
  const client = await context.firstPool.connect()
  try {
    await client.query('BEGIN')
    const authorized = await context.first.lockAuthorizedSourceSnapshot(
      'tenant-1', 'source-final-auth', sourceObject.checksum, new Date(), client)
    assert.equal(authorized.archiveObjectId, sourceObject.objectId)
    await assert.rejects(context.first.lockAuthorizedSourceSnapshot(
      'tenant-2', 'source-final-auth', sourceObject.checksum, new Date(), client), DurableStateNotFoundError)
    await assert.rejects(context.first.lockAuthorizedSourceSnapshot(
      'tenant-1', 'source-final-auth', digest('f'), new Date(), client), DurableStateNotFoundError)
    await assert.rejects(context.first.lockAuthorizedSourceSnapshot(
      'tenant-1', 'source-final-auth', sourceObject.checksum, expiresAt, client), DurableStateNotFoundError)
    await client.query('ROLLBACK')
  } finally { client.release() }
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

live('one max-one-connection transaction composes allocation, lease, adoption, and logical completion', async context => {
  const singlePool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${context.schema}`, max: 1 })
  const journal = new PostgresJournal(singlePool)
  const state = new PostgresDurableState(singlePool)
  try {
    const ids = await objects(context)
    const identity = { operation: 'provision', idempotencyKey: 'atomic-compose', tenantId: 'tenant-1' }
    const workerId = 'compose-worker'
    const claim = await journal.claimOperation({ ...identity, workerId, requestHash: canonicalRequestHash(identity) })
    assert.equal(claim.kind, 'claimed')
    if (claim.kind !== 'claimed') return

    await journal.withProviderResourceLocks([
      { kind: 'provider_snapshot', resourceId: 'provider-snapshot-1' },
      { kind: 'sandbox', resourceId: 'sandbox-1' },
    ], async client => {
      const sandbox = await journal.recordAllocation(identity, claim.generation, workerId,
        { kind: 'sandbox', resourceId: 'sandbox-1' }, client)
      const providerSnapshot = await journal.recordAllocation(identity, claim.generation, workerId,
        { kind: 'provider_snapshot', resourceId: 'provider-snapshot-1' }, client)
      const created = await state.createLeaseWithBaseSnapshot(leaseInput(ids), client)
      await journal.bindLeaseAndAdoptAllocations(identity, claim.generation, workerId,
        created.lease.leaseId, [sandbox.allocationId, providerSnapshot.allocationId], client)
      await journal.completeOperation(identity, claim.generation, workerId, {
        leaseId: created.lease.leaseId,
        connection: { execServerUrl: 'wss://gateway.invalid/leases/lease-1?ticket=secret' },
      }, client)
    })

    assert.deepEqual(await journal.claimOperation({
      ...identity, workerId: 'replay-worker', requestHash: canonicalRequestHash(identity),
    }), { kind: 'succeeded', generation: claim.generation, response: { leaseId: 'lease-1' } })
    const committed = await context.firstPool.query<{ allocations: string; adopted: string; leases: string; snapshots: string }>(`
      SELECT
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'provision' AND idempotency_key = 'atomic-compose') AS allocations,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'provision' AND idempotency_key = 'atomic-compose' AND state = 'adopted') AS adopted,
        (SELECT count(*)::text FROM hosted_agent_leases WHERE lease_id = 'lease-1') AS leases,
        (SELECT count(*)::text FROM hosted_agent_snapshots WHERE snapshot_id = 'snapshot-1') AS snapshots
    `)
    assert.deepEqual(committed.rows[0], { allocations: '2', adopted: '2', leases: '1', snapshots: '1' })

    const rollbackIds = await objects(context, 'tenant-1', '-rollback')
    const rollbackIdentity = { operation: 'provision', idempotencyKey: 'atomic-rollback', tenantId: 'tenant-1' }
    const rollbackClaim = await journal.claimOperation({
      ...rollbackIdentity, workerId, requestHash: canonicalRequestHash(rollbackIdentity),
    })
    assert.equal(rollbackClaim.kind, 'claimed')
    if (rollbackClaim.kind !== 'claimed') return
    const rollbackInput = leaseInput(rollbackIds, {
      leaseId: 'lease-rollback', environmentId: 'env-rollback', agentId: 'agent-rollback',
      providerSandboxId: 'sandbox-rollback',
      baseSnapshot: {
        snapshotId: 'snapshot-rollback', providerSnapshotId: 'provider-snapshot-rollback',
        workspaceArchiveObjectId: rollbackIds.archive.objectId,
        manifestObjectId: rollbackIds.manifest.objectId, manifestChecksum: rollbackIds.manifest.checksum,
      },
    })
    await assert.rejects(journal.withProviderResourceLocks([
      { kind: 'sandbox', resourceId: 'sandbox-rollback' },
      { kind: 'provider_snapshot', resourceId: 'provider-snapshot-rollback' },
    ], async client => {
      const sandbox = await journal.recordAllocation(rollbackIdentity, rollbackClaim.generation, workerId,
        { kind: 'sandbox', resourceId: 'sandbox-rollback' }, client)
      const providerSnapshot = await journal.recordAllocation(rollbackIdentity, rollbackClaim.generation, workerId,
        { kind: 'provider_snapshot', resourceId: 'provider-snapshot-rollback' }, client)
      await state.createLeaseWithBaseSnapshot(rollbackInput, client)
      await journal.bindLeaseAndAdoptAllocations(rollbackIdentity, rollbackClaim.generation, workerId,
        rollbackInput.leaseId, [sandbox.allocationId, providerSnapshot.allocationId], client)
      await journal.completeOperation(rollbackIdentity, rollbackClaim.generation, workerId,
        { leaseId: rollbackInput.leaseId }, client)
      throw new Error('injected final transaction failure')
    }), /injected final transaction failure/)

    const rolledBack = await context.firstPool.query<{
      operation_state: string; allocations: string; leases: string; snapshots: string
    }>(`
      SELECT
        (SELECT state FROM hosted_agent_operations
          WHERE operation = 'provision' AND idempotency_key = 'atomic-rollback') AS operation_state,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'provision' AND idempotency_key = 'atomic-rollback') AS allocations,
        (SELECT count(*)::text FROM hosted_agent_leases WHERE lease_id = 'lease-rollback') AS leases,
        (SELECT count(*)::text FROM hosted_agent_snapshots WHERE snapshot_id = 'snapshot-rollback') AS snapshots
    `)
    assert.deepEqual(rolledBack.rows[0], {
      operation_state: 'in_progress', allocations: '0', leases: '0', snapshots: '0',
    })
  } finally { await singlePool.end() }
})

live('checkpoint references and durable data survive release', async context => {
  const ids = await objects(context); const created = await context.first.createLeaseWithBaseSnapshot(leaseInput(ids))
  assert.deepEqual(await context.second.activeLeaseTarget(created.lease.leaseId),
    { sandboxId: 'sandbox-1', connectionGeneration: 0 })
  const checkpointObjects = await objects(context, 'tenant-1', '-checkpoint')
  const checkpointContent = object('tenant-1', 'content-checkpoint', 'content_blob', 'e')
  await context.first.registerObject(checkpointContent)
  const checkpoint = await context.second.appendCheckpoint('tenant-1', created.lease.leaseId, {
    snapshotId: 'snapshot-checkpoint', providerSnapshotId: 'provider-checkpoint',
    workspaceArchiveObjectId: checkpointObjects.archive.objectId,
    manifestObjectId: checkpointObjects.manifest.objectId, manifestChecksum: checkpointObjects.manifest.checksum,
    contentObjectIds: [checkpointContent.objectId],
  })
  const snapshotTransaction = await context.firstPool.connect()
  try {
    await snapshotTransaction.query('BEGIN')
    await snapshotTransaction.query(`
      UPDATE hosted_agent_snapshots SET state = 'failed' WHERE snapshot_id = $1
    `, [checkpoint.snapshotId])
    assert.equal((await context.first.getSnapshot(
      'tenant-1', checkpoint.snapshotId, snapshotTransaction))?.state, 'failed')
    assert.equal((await context.second.getSnapshot(
      'tenant-1', checkpoint.snapshotId))?.state, 'available')
    await snapshotTransaction.query('ROLLBACK')
  } finally { snapshotTransaction.release() }
  await context.first.addSnapshotReference({ tenantId: 'tenant-1', snapshotId: checkpoint.snapshotId,
    referenceKind: 'codex_thread', referenceId: 'thread-1' })
  await context.second.beginRelease('tenant-1', created.lease.leaseId)
  const released = await context.second.releaseLease('tenant-1', created.lease.leaseId)
  assert.equal(released.state, 'released')
  assert.equal(await context.first.activeLeaseTarget(created.lease.leaseId), undefined)
  assert.equal((await context.first.getLease('tenant-1', created.lease.leaseId))?.latestSnapshotId, checkpoint.snapshotId)
  assert.equal((await context.first.getSnapshot('tenant-1', checkpoint.snapshotId))?.state, 'available')
  const retained = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_snapshot_references
    WHERE snapshot_id = $1 AND reference_kind = 'codex_thread' AND reference_id = 'thread-1'
  `, [checkpoint.snapshotId])
  assert.equal(retained.rows[0]!.count, '1')
  const contentReference = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_object_references
    WHERE object_id = $1 AND reference_kind = 'snapshot' AND reference_id = $2 AND purpose = 'content_blob'
  `, [checkpointContent.objectId, checkpoint.snapshotId])
  assert.equal(contentReference.rows[0]!.count, '1')
})

live('Codex reference sync is exact, authorized, idempotent, and release-safe', async context => {
  const ids = await objects(context)
  const created = await context.first.createLeaseWithBaseSnapshot(leaseInput(ids))
  const checkpointIds = await objects(context, 'tenant-1', '-retained')
  const checkpoint = await context.first.appendCheckpoint('tenant-1', created.lease.leaseId, {
    snapshotId: 'snapshot-retained', providerSnapshotId: 'provider-retained',
    workspaceArchiveObjectId: checkpointIds.archive.objectId,
    manifestObjectId: checkpointIds.manifest.objectId,
    manifestChecksum: checkpointIds.manifest.checksum,
  })
  const retention = new PostgresReferenceRetention(context.firstPool, 'tenant-1')
  const request = { agentId: 'agent-1', leaseId: created.lease.leaseId,
    baseSnapshotId: created.snapshot.snapshotId, latestSnapshotId: checkpoint.snapshotId,
    artifactId: null }
  await Promise.all([retention.retain(request), retention.retain(request)])
  await assert.rejects(retention.retain({ ...request, agentId: 'agent-other' }))
  await assert.rejects(new PostgresReferenceRetention(context.firstPool, 'tenant-2').retain(request))
  const client = await context.firstPool.connect()
  try {
    await client.query('BEGIN')
    await retention.assertSynchronized(client, created.lease.leaseId)
    await client.query('ROLLBACK')
  } finally { client.release() }
  await context.first.beginRelease('tenant-1', created.lease.leaseId)
  await context.first.releaseLease('tenant-1', created.lease.leaseId)
  await retention.retain(request)
  const references = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_snapshot_references
    WHERE reference_kind = 'codex_thread' AND reference_id = $1
  `, [request.agentId])
  assert.equal(references.rows[0]!.count, '2')
  const objectReferences = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_object_references
    WHERE reference_kind = 'codex_thread' AND reference_id = $1
  `, [request.agentId])
  assert.equal(objectReferences.rows[0]!.count, '4')
  await context.firstPool.query(`DELETE FROM hosted_agent_object_references
    WHERE ctid IN (SELECT ctid FROM hosted_agent_object_references
      WHERE reference_kind = 'codex_thread' AND reference_id = $1 LIMIT 1)`, [request.agentId])
  const broken = await context.firstPool.connect()
  try {
    await broken.query('BEGIN')
    await assert.rejects(retention.assertSynchronized(broken, request.leaseId))
    await broken.query('ROLLBACK')
  } finally { broken.release() }
  await retention.retain(request)
  const cleanup = await context.firstPool.connect()
  try {
    await cleanup.query('BEGIN')
    await retention.removeReleasedLeaseRoots(cleanup, request.leaseId)
    await cleanup.query('COMMIT')
  } finally { cleanup.release() }
  const leaseReferences = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_snapshot_references
    WHERE reference_id = $1 AND reference_kind IN ('lease_base', 'lease_latest')
  `, [request.leaseId])
  assert.equal(leaseReferences.rows[0]!.count, '0')
})

live('snapshot transactions reject content objects that are no longer available', async context => {
  const ids = await objects(context)
  const content = object('tenant-1', 'content-unavailable', 'content_blob', 'f')
  await context.first.registerObject(content)
  await context.firstPool.query(`UPDATE hosted_agent_objects SET state = 'deleting' WHERE object_id = $1`, [content.objectId])
  await assert.rejects(context.first.createLeaseWithBaseSnapshot(leaseInput(ids, {
    leaseId: 'lease-unavailable', environmentId: 'env-unavailable', providerSandboxId: 'sandbox-unavailable',
    baseSnapshot: { ...leaseInput(ids).baseSnapshot, snapshotId: 'snapshot-unavailable',
      providerSnapshotId: 'provider-unavailable', contentObjectIds: [content.objectId] },
  })))
  assert.equal(await context.first.getLease('tenant-1', 'lease-unavailable'), null)
  const references = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_object_references WHERE object_id = $1
  `, [content.objectId])
  assert.equal(references.rows[0]!.count, '0')
})

live('ticket hashes rotate, consume once, expire, revoke, and clean up across pools', async context => {
  const ids = await objects(context); const created = await context.first.createLeaseWithBaseSnapshot(leaseInput(ids))
  const firstIssuer = new PostgresTicketIssuer(context.first, 'tenant-1', 'wss://gateway.example')
  const secondIssuer = new PostgresTicketIssuer(context.second, 'tenant-1', 'wss://gateway.example')
  const issued = new URL(await firstIssuer.issue(created.lease.leaseId))
  const rawTicket = issued.searchParams.get('ticket')!
  assert.deepEqual(await secondIssuer.validate(created.lease.leaseId, rawTicket), { connectionGeneration: 0 })
  assert.equal(await firstIssuer.validate(created.lease.leaseId, rawTicket), null)
  const persistedTicket = await context.firstPool.query<{ ticket_hash: Buffer }>('SELECT ticket_hash FROM hosted_agent_tickets')
  assert.equal(persistedTicket.rows.some(row => row.ticket_hash.includes(Buffer.from(rawTicket))), false)
  const firstHash = randomBytes(32); const secondHash = randomBytes(32); const expiredHash = randomBytes(32)
  await context.first.issueTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId,
    ticketHash: firstHash, purpose: 'exec_gateway_connect', expiresAt: new Date(Date.now() + 60_000) })
  assert.equal(await context.second.consumeTicketHash({ tenantId: 'tenant-2', leaseId: created.lease.leaseId, ticketHash: firstHash, purpose: 'exec_gateway_connect' }), null)
  assert.equal(await context.second.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: firstHash, purpose: 'exec_gateway_connect' }), 0)
  assert.equal(await context.first.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: firstHash, purpose: 'exec_gateway_connect' }), null)
  await context.second.issueTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId,
    ticketHash: secondHash, purpose: 'exec_gateway_probe', expiresAt: new Date(Date.now() + 60_000) })
  assert.equal(await context.first.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: firstHash, purpose: 'exec_gateway_connect' }), null)
  assert.equal(await context.first.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: secondHash, purpose: 'exec_gateway_connect' }), null)
  assert.equal(await context.first.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: secondHash, purpose: 'exec_gateway_probe' }), 0)
  await context.first.issueTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId,
    ticketHash: expiredHash, purpose: 'exec_gateway_connect', expiresAt: new Date(Date.now() + 60_000) })
  assert.equal(await context.second.consumeTicketHash({ tenantId: 'tenant-1', leaseId: created.lease.leaseId, ticketHash: expiredHash,
    purpose: 'exec_gateway_connect', at: new Date(Date.now() + 120_000) }), null)
  await context.second.revokeLeaseTickets('tenant-1', created.lease.leaseId)
  assert.ok(await context.first.cleanupTickets(new Date(Date.now() + 180_000)) >= 3)
  const remaining = await context.firstPool.query<{ count: string }>('SELECT count(*)::text AS count FROM hosted_agent_tickets')
  assert.equal(remaining.rows[0]!.count, '0')
})

live('reconnect and loss transitions rotate durable connection generations across replicas', async context => {
  const ids = await objects(context)
  const created = await context.first.createLeaseWithBaseSnapshot(leaseInput(ids))
  const firstIssuer = new PostgresTicketIssuer(context.first, 'tenant-1', 'wss://gateway.example')
  const secondIssuer = new PostgresTicketIssuer(context.second, 'tenant-1', 'wss://gateway.example')
  const stale = new URL(await firstIssuer.issue(created.lease.leaseId)).searchParams.get('ticket')!
  const client = await context.secondPool.connect()
  try {
    await client.query('BEGIN')
    const reconnected = await context.second.completeReconnect(
      'tenant-1', created.lease.leaseId, 'sandbox-1', client)
    assert.equal(reconnected.connectionGeneration, 1)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
  assert.deepEqual(await context.first.activeLeaseTarget(created.lease.leaseId),
    { sandboxId: 'sandbox-1', connectionGeneration: 1 })
  assert.equal(await secondIssuer.validate(created.lease.leaseId, stale), null)
  await assert.rejects(firstIssuer.issue(created.lease.leaseId, undefined, 0), DurableStateConflictError)
  const current = new URL(await secondIssuer.issue(
    created.lease.leaseId, undefined, 1)).searchParams.get('ticket')!
  assert.deepEqual(await firstIssuer.validate(created.lease.leaseId, current), { connectionGeneration: 1 })

  const lossClient = await context.firstPool.connect()
  try {
    await lossClient.query('BEGIN')
    const lost = await context.first.markLeaseLost(
      'tenant-1', created.lease.leaseId, 'sandbox-1', lossClient)
    assert.equal(lost.connectionGeneration, 2)
    await lossClient.query('COMMIT')
  } catch (error) {
    await lossClient.query('ROLLBACK')
    throw error
  } finally { lossClient.release() }
  assert.equal(await context.second.activeLeaseTarget(created.lease.leaseId), undefined)
})

live('restore commit atomically validates terminal lineage, creates its replacement, and retires loss', async context => {
  const sourceObjects = await objects(context)
  const source = await context.first.createLeaseWithBaseSnapshot(leaseInput(sourceObjects))
  const lossClient = await context.firstPool.connect()
  try {
    await lossClient.query('BEGIN')
    await context.first.markLeaseLost('tenant-1', source.lease.leaseId, 'sandbox-1', lossClient)
    await lossClient.query('COMMIT')
  } catch (error) {
    await lossClient.query('ROLLBACK')
    throw error
  } finally { lossClient.release() }

  const authorized = await context.second.lockAuthorizedRestoreSource({
    tenantId: 'tenant-1', sourceLeaseId: source.lease.leaseId,
    sourceSnapshotId: source.snapshot.snapshotId, agentId: source.lease.agentId,
    ownerAgentId: source.lease.ownerAgentId, ownerLeaseId: source.lease.ownerLeaseId,
    sandboxTemplate: source.lease.sandboxTemplate,
  })
  assert.equal(authorized.archiveObject.objectId, source.snapshot.workspaceArchiveObjectId)

  const replacementObjects = await objects(context, 'tenant-1', '-restored')
  const replacementInput: CreateRestoredLeaseInput = { ...leaseInput(replacementObjects, {
    leaseId: 'lease-restored', environmentId: 'env-restored', providerSandboxId: 'sandbox-restored',
    baseSnapshot: { ...leaseInput(replacementObjects).baseSnapshot,
      snapshotId: 'snapshot-restored', providerSnapshotId: 'provider-restored' },
  }), restoreSourceLeaseId: source.lease.leaseId, restoreSourceSnapshotId: source.snapshot.snapshotId }
  const restored = await context.second.createRestoredLeaseWithBaseSnapshot(replacementInput)
  assert.equal(restored.lease.restoreSourceLeaseId, source.lease.leaseId)
  assert.equal(restored.lease.restoreSourceSnapshotId, source.snapshot.snapshotId)
  assert.equal((await context.first.getLease('tenant-1', source.lease.leaseId))?.state, 'released')
  const reference = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_snapshot_references
    WHERE snapshot_id = $1 AND reference_kind = 'lease_restore_source' AND reference_id = $2
  `, [source.snapshot.snapshotId, restored.lease.leaseId])
  assert.equal(reference.rows[0]!.count, '1')

  await assert.rejects(context.first.createRestoredLeaseWithBaseSnapshot({
    ...replacementInput, leaseId: 'lease-invalid-restore', environmentId: 'env-invalid-restore',
    providerSandboxId: 'sandbox-invalid-restore',
    baseSnapshot: { ...replacementInput.baseSnapshot, snapshotId: 'snapshot-invalid-restore',
      providerSnapshotId: 'provider-invalid-restore' },
  }), DurableStateConflictError)
  assert.equal(await context.first.getLease('tenant-1', 'lease-invalid-restore'), null)
})
