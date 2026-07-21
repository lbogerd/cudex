import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { runMigrations } from '../src/migrate.js'
import {
  PatchArtifactConflictError,
  PostgresPatchArtifactRepository,
  type CreatePatchArtifactInput,
} from '../src/postgres-artifacts.js'
import { PostgresDurableState, type CreateLeaseInput, type StoredObject } from '../src/postgres-state.js'
import { PostgresReferenceRetention } from '../src/postgres-reference-retention.js'
import { createWorkspaceManifest, workspaceManifestChecksum, type WorkspaceEntry } from '../src/workspace-manifest.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL

interface Fixture {
  admin: Pool
  firstPool: Pool
  secondPool: Pool
  first: PostgresPatchArtifactRepository
  second: PostgresPatchArtifactRepository
  state: PostgresDurableState
  schema: string
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_artifacts_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`)
  const config = { connectionString: databaseUrl, options: `-c search_path=${schema}` }
  const firstPool = new Pool(config); const secondPool = new Pool(config); await runMigrations(firstPool)
  return {
    admin, firstPool, secondPool, first: new PostgresPatchArtifactRepository(firstPool),
    second: new PostgresPatchArtifactRepository(secondPool), state: new PostgresDurableState(firstPool), schema,
  }
}

async function cleanup(context: Fixture): Promise<void> {
  await context.firstPool.end(); await context.secondPool.end()
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`); await context.admin.end()
}

const live = (name: string, fn: (context: Fixture) => Promise<void>) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => { const context = await fixture(); try { await fn(context) } finally { await cleanup(context) } })

const digest = (character: string) => `sha256:${character.repeat(64)}`
const file = (path: string, character: string, sizeBytes: number): WorkspaceEntry => ({
  path, type: 'file', mode: 0o644, digest: digest(character), sizeBytes,
})
const storedObject = (tenantId: string, objectId: string, kind: StoredObject['kind'], checksum: string, sizeBytes = 10): StoredObject => ({
  objectId, tenantId, kind, checksum, sizeBytes, state: 'available', expiresAt: null,
  storageBucket: 'hosted-agent-test', storageKey: `${tenantId}/${objectId}`,
})

async function prepared(context: Fixture): Promise<CreatePatchArtifactInput> {
  const baseManifest = createWorkspaceManifest('snapshot-base', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    file('roots/modified', 'a', 3), file('roots/deleted', 'b', 6),
  ])
  const currentManifest = createWorkspaceManifest('snapshot-current', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    file('roots/modified', 'c', 3), file('roots/added', 'd', 5),
  ])
  const objects = [
    storedObject('tenant-1', 'archive-base', 'workspace_archive', digest('1')),
    storedObject('tenant-1', 'manifest-base', 'manifest', workspaceManifestChecksum(baseManifest)),
    storedObject('tenant-1', 'archive-current', 'workspace_archive', digest('2')),
    storedObject('tenant-1', 'manifest-current', 'manifest', workspaceManifestChecksum(currentManifest)),
    storedObject('tenant-1', 'artifact-object', 'patch_artifact', digest('e'), 100),
    storedObject('tenant-1', 'artifact-object-other', 'patch_artifact', digest('f'), 101),
    storedObject('tenant-1', 'workspace-object-modified', 'content_blob', digest('c'), 3),
    storedObject('tenant-1', 'workspace-object-added', 'content_blob', digest('d'), 5),
  ]
  for (const object of objects) await context.state.registerObject(object)
  const lease: CreateLeaseInput = {
    leaseId: 'lease-child', environmentId: 'env-child', tenantId: 'tenant-1',
    agentId: 'agent-child', ownerAgentId: 'agent-owner', providerSandboxId: 'sandbox-child',
    sandboxTemplate: 'general-v1', cwdUri: 'file:///workspace/roots',
    workspaceRootUris: ['file:///workspace/roots'], toolPolicy: {}, policyVersion: 1,
    baseSnapshot: {
      snapshotId: 'snapshot-base', providerSnapshotId: 'provider-base',
      workspaceArchiveObjectId: 'archive-base', manifestObjectId: 'manifest-base',
      manifestChecksum: workspaceManifestChecksum(baseManifest),
    },
  }
  await context.state.createLeaseWithBaseSnapshot(lease)
  await context.state.appendCheckpoint('tenant-1', 'lease-child', {
    snapshotId: 'snapshot-current', providerSnapshotId: 'provider-current',
    workspaceArchiveObjectId: 'archive-current', manifestObjectId: 'manifest-current',
    manifestChecksum: workspaceManifestChecksum(currentManifest),
  })
  return {
    artifactId: 'artifact-1', tenantId: 'tenant-1', agentId: 'agent-child',
    ownerAgentId: 'agent-owner', sourceLeaseId: 'lease-child', baseSnapshotId: 'snapshot-base',
    currentSnapshotId: 'snapshot-current', baseManifestObjectId: 'manifest-base',
    currentManifestObjectId: 'manifest-current', artifactObjectId: 'artifact-object',
    contentObjects: [
      { path: 'roots/modified', objectId: 'workspace-object-modified' },
      { path: 'roots/added', objectId: 'workspace-object-added' },
    ],
    checksum: digest('e'), changedFiles: 3, sizeBytes: 8, state: 'available',
    expiresAt: new Date(Date.now() + 60_000), baseManifest, currentManifest,
  }
}

live('artifact creation is durable, referenced, tenant isolated, and replayable after lease release', async context => {
  const input = await prepared(context)
  const created = await context.first.create(input)
  assert.equal(created.changedFiles, 3); assert.equal(created.sizeBytes, 8)
  assert.equal((await context.second.getAuthorized('tenant-1', input.artifactId, input.agentId))?.artifactId, input.artifactId)
  assert.ok(input.ownerAgentId)
  assert.equal((await context.second.getAuthorizedForOwner('tenant-1', input.artifactId, input.ownerAgentId))?.artifactId, input.artifactId)
  assert.equal(await context.second.getAuthorized('tenant-2', input.artifactId, input.agentId), null)
  assert.equal(await context.second.getAuthorized('tenant-1', input.artifactId, 'other-agent'), null)
  assert.equal(await context.second.getAuthorizedForOwner('tenant-1', input.artifactId, 'other-owner'), null)

  const references = await context.firstPool.query<{ objects: string; snapshots: string; artifacts: string }>(`
    SELECT
      (SELECT count(*)::text FROM hosted_agent_object_references WHERE reference_kind = 'artifact' AND reference_id = $1) AS objects,
      (SELECT count(*)::text FROM hosted_agent_snapshot_references WHERE reference_id = $1) AS snapshots,
      (SELECT count(*)::text FROM hosted_agent_artifact_references WHERE artifact_id = $1) AS artifacts
  `, [input.artifactId])
  assert.deepEqual(references.rows[0], { objects: '5', snapshots: '2', artifacts: '1' })
  await context.state.beginRelease('tenant-1', input.sourceLeaseId)
  await context.state.releaseLease('tenant-1', input.sourceLeaseId)
  assert.deepEqual(await context.second.create(input), created)
  await context.second.addReference({ tenantId: 'tenant-1', artifactId: input.artifactId,
    referenceKind: 'codex_thread', referenceId: 'thread-1' })
  await assert.rejects(context.second.addReference({ tenantId: 'tenant-2', artifactId: input.artifactId,
    referenceKind: 'codex_thread', referenceId: 'thread-cross-tenant' }))
})

live('artifact identity is immutable across replicas and conflicting replay rolls back references', async context => {
  const input = await prepared(context)
  const attempts = await Promise.all([context.first.create(input), context.second.create(input)])
  assert.equal(attempts[0].artifactId, attempts[1].artifactId)
  await assert.rejects(context.second.create({
    ...input, artifactObjectId: 'artifact-object-other', checksum: digest('f'),
  }), PatchArtifactConflictError)
  await assert.rejects(context.second.create({ ...input, artifactId: 'artifact-wrong-agent', agentId: 'other-agent' }), PatchArtifactConflictError)
  await assert.rejects(context.second.create({ ...input, artifactId: 'artifact-wrong-base',
    baseSnapshotId: 'snapshot-current', baseManifest: input.currentManifest }), /unused content object|count or size/)
  await assert.rejects(context.firstPool.query(`
    UPDATE hosted_agent_artifacts SET checksum = $2 WHERE artifact_id = $1
  `, [input.artifactId, digest('f')]))
  const count = await context.firstPool.query<{ count: string }>('SELECT count(*)::text AS count FROM hosted_agent_artifacts')
  assert.equal(count.rows[0]!.count, '1')
})

live('caller-owned artifact transactions compose and preserve rollback', async context => {
  const input = await prepared(context)
  const rollback = await context.firstPool.connect()
  try {
    await rollback.query('BEGIN')
    assert.equal((await context.first.create(input, rollback)).artifactId, input.artifactId)
    assert.equal(await context.second.getAuthorized(
      input.tenantId, input.artifactId, input.agentId), null)
    await rollback.query('ROLLBACK')
  } finally { rollback.release() }
  const rolledBack = await context.firstPool.query<{ artifacts: string; references: string }>(`
    SELECT
      (SELECT count(*)::text FROM hosted_agent_artifacts WHERE artifact_id = $1) AS artifacts,
      (SELECT count(*)::text FROM hosted_agent_object_references
        WHERE reference_kind = 'artifact' AND reference_id = $1) AS references
  `, [input.artifactId])
  assert.deepEqual(rolledBack.rows[0], { artifacts: '0', references: '0' })

  const commit = await context.firstPool.connect()
  try {
    await commit.query('BEGIN')
    await context.first.create(input, commit)
    await commit.query('COMMIT')
  } catch (error) {
    await commit.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { commit.release() }
  assert.equal((await context.second.getAuthorized(
    input.tenantId, input.artifactId, input.agentId))?.artifactId, input.artifactId)
})

live('artifact creation rejects unavailable and expired snapshots', async context => {
  const input = await prepared(context)
  await context.firstPool.query(`
    UPDATE hosted_agent_snapshots SET expires_at = now() - interval '1 second'
    WHERE snapshot_id = $1
  `, [input.baseSnapshotId])
  await assert.rejects(context.first.create(input), PatchArtifactConflictError)
  await context.firstPool.query(`
    UPDATE hosted_agent_snapshots SET expires_at = NULL, state = 'failed'
    WHERE snapshot_id = $1
  `, [input.baseSnapshotId])
  await assert.rejects(context.first.create(input), PatchArtifactConflictError)
  const count = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_artifacts WHERE artifact_id = $1
  `, [input.artifactId])
  assert.equal(count.rows[0]!.count, '0')
})

live('expiry changes authorization state without removing durable references', async context => {
  const input = await prepared(context); await context.first.create(input)
  const afterExpiry = new Date(input.expiresAt.getTime() + 1)
  assert.equal(await context.second.getAuthorized(input.tenantId, input.artifactId, input.agentId, afterExpiry), null)
  assert.equal(await context.second.expireAvailable(input.tenantId, afterExpiry), 1)
  const row = await context.firstPool.query<{ state: string; references: string }>(`
    SELECT a.state,
      (SELECT count(*)::text FROM hosted_agent_artifact_references r WHERE r.artifact_id = a.artifact_id) AS references
    FROM hosted_agent_artifacts a WHERE a.artifact_id = $1
  `, [input.artifactId])
  assert.deepEqual(row.rows[0], { state: 'expired', references: '1' })
})

live('Codex retention keeps artifact authorization and objects beyond ordinary TTL', async context => {
  const input = await prepared(context)
  await context.first.create(input)
  const retention = new PostgresReferenceRetention(context.firstPool, input.tenantId)
  await retention.retain({
    agentId: input.agentId, leaseId: input.sourceLeaseId,
    baseSnapshotId: input.baseSnapshotId, latestSnapshotId: input.currentSnapshotId,
    artifactId: input.artifactId, expectedRevision: null,
  })
  const future = new Date(Date.now() + 120_000)
  assert.equal(await context.first.expireAvailable(input.tenantId, future), 0)
  assert.equal((await context.second.getAuthorized(
    input.tenantId, input.artifactId, input.agentId, future))?.artifactId, input.artifactId)
  const roots = await context.firstPool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM hosted_agent_object_references
    WHERE reference_kind = 'codex_thread' AND reference_id = $1
  `, [input.agentId])
  assert.equal(Number(roots.rows[0]!.count) > 0, true)
})

test('repository validates canonical identity, checksums, count, size, expiry, and state before SQL', async () => {
  const manifest = createWorkspaceManifest('base', [{ path: 'roots', type: 'directory', mode: 0o755 }])
  const repository = new PostgresPatchArtifactRepository({ connect: async () => { throw new Error('SQL should not be reached') } } as unknown as Pool)
  const input = {
    artifactId: 'artifact', tenantId: 'tenant', agentId: 'agent', ownerAgentId: 'owner', sourceLeaseId: 'lease',
    baseSnapshotId: 'base', currentSnapshotId: 'base', baseManifestObjectId: 'manifest-base',
    currentManifestObjectId: 'manifest-current', artifactObjectId: 'artifact-object', checksum: digest('a'),
    contentObjects: [],
    changedFiles: 0, sizeBytes: 0, state: 'available' as const,
    expiresAt: new Date(Date.now() + 60_000), baseManifest: manifest, currentManifest: manifest,
  }
  await assert.rejects(repository.create({ ...input, checksum: 'bad' }), /checksum/)
  await assert.rejects(repository.create({ ...input, changedFiles: 1 }), /count or size/)
  await assert.rejects(repository.create({ ...input, sizeBytes: 1 }), /count or size/)
  await assert.rejects(repository.create({ ...input, expiresAt: new Date(0) }), /future/)
  await assert.rejects(repository.create({ ...input, baseSnapshotId: 'other' }), /identity/)
  await assert.rejects(repository.create({ ...input, state: 'creating' as 'available' }), /available/)
})
