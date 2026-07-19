import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { runMigrations } from '../src/migrate.js'
import { serializePatchArtifact } from '../src/patch-artifact.js'
import { PostgresPatchArtifactRepository } from '../src/postgres-artifacts.js'
import {
  PatchApplicationConflictError,
  PostgresPatchApplicationRepository,
  type CreatePatchApplicationInput,
  type PatchApplicationFence,
} from '../src/postgres-patch-applications.js'
import { PostgresDurableState, type StoredObject } from '../src/postgres-state.js'
import {
  OperationOwnershipError,
  PostgresJournal,
  canonicalRequestHash,
} from '../src/postgres-store.js'
import {
  canonicalJson,
  createWorkspaceManifest,
  workspaceManifestChecksum,
  type WorkspaceManifest,
} from '../src/workspace-manifest.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const digest = (character: string): string => `sha256:${character.repeat(64)}`

interface Fixture {
  admin: Pool
  firstPool: Pool
  secondPool: Pool
  state: PostgresDurableState
  journal: PostgresJournal
  first: PostgresPatchApplicationRepository
  second: PostgresPatchApplicationRepository
  schema: string
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_patch_applications_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const config = { connectionString: databaseUrl, options: `-c search_path=${schema}` }
  const firstPool = new Pool(config); const secondPool = new Pool(config)
  await runMigrations(firstPool)
  return {
    admin, firstPool, secondPool, schema,
    state: new PostgresDurableState(firstPool), journal: new PostgresJournal(firstPool),
    first: new PostgresPatchApplicationRepository(firstPool),
    second: new PostgresPatchApplicationRepository(secondPool),
  }
}

async function cleanup(context: Fixture): Promise<void> {
  await context.firstPool.end(); await context.secondPool.end()
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

const live = (name: string, fn: (context: Fixture) => Promise<void>) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try { await fn(context) } finally { await cleanup(context) }
})

function object(objectId: string, kind: StoredObject['kind'], checksum: string,
  sizeBytes = 1): StoredObject {
  return {
    objectId, tenantId: 'tenant-1', kind, storageBucket: 'patch-application-test',
    storageKey: objectId, checksum, sizeBytes, state: 'available', expiresAt: null,
  }
}

async function register(context: Fixture, value: StoredObject): Promise<void> {
  await context.state.registerObject(value)
}

async function lease(context: Fixture, input: {
  leaseId: string
  environmentId: string
  agentId: string
  sandboxId: string
  manifest: WorkspaceManifest
  ownerAgentId?: string
  ownerLeaseId?: string
}): Promise<{ archiveId: string; manifestId: string }> {
  const archiveId = `${input.leaseId}-archive`
  const manifestId = `${input.leaseId}-manifest`
  await register(context, object(archiveId, 'workspace_archive', digest('a')))
  await register(context, object(manifestId, 'manifest', workspaceManifestChecksum(input.manifest),
    Buffer.byteLength(canonicalJson(input.manifest))))
  await context.state.createLeaseWithBaseSnapshot({
    leaseId: input.leaseId, environmentId: input.environmentId, tenantId: 'tenant-1',
    agentId: input.agentId, providerSandboxId: input.sandboxId,
    ...(input.ownerAgentId ? { ownerAgentId: input.ownerAgentId } : {}),
    ...(input.ownerLeaseId ? { ownerLeaseId: input.ownerLeaseId } : {}),
    sandboxTemplate: 'general-v1', cwdUri: 'file:///workspace/roots/0',
    workspaceRootUris: ['file:///workspace/roots/0'], toolPolicy: {}, policyVersion: 1,
    baseSnapshot: {
      snapshotId: input.manifest.identity, providerSnapshotId: `${input.leaseId}-provider-snapshot`,
      workspaceArchiveObjectId: archiveId, manifestObjectId: manifestId,
      manifestChecksum: workspaceManifestChecksum(input.manifest),
    },
  })
  return { archiveId, manifestId }
}

interface Prepared {
  input: CreatePatchApplicationInput
  fence: PatchApplicationFence
  resultManifest: WorkspaceManifest
}

async function prepared(context: Fixture): Promise<Prepared> {
  const targetManifest = createWorkspaceManifest('snapshot-target', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/0', type: 'directory', mode: 0o755 },
  ])
  const childManifest = createWorkspaceManifest('snapshot-child', targetManifest.entries)
  const resultManifest = createWorkspaceManifest('snapshot-result', targetManifest.entries)
  await lease(context, {
    leaseId: 'lease-target', environmentId: 'environment-target', agentId: 'agent-owner',
    sandboxId: 'sandbox-target', manifest: targetManifest,
  })
  const child = await lease(context, {
    leaseId: 'lease-child', environmentId: 'environment-child', agentId: 'agent-child',
    sandboxId: 'sandbox-child', manifest: childManifest,
    ownerAgentId: 'agent-owner', ownerLeaseId: 'lease-target',
  })
  const serialized = serializePatchArtifact({
    agentId: 'agent-child', baseSnapshotId: childManifest.identity,
    currentSnapshotId: childManifest.identity, baseManifest: childManifest,
    currentManifest: childManifest, contentObjects: [],
  })
  await register(context, object('artifact-object', 'patch_artifact',
    serialized.checksum, serialized.bytes.byteLength))
  await new PostgresPatchArtifactRepository(context.firstPool).create({
    artifactId: 'artifact-1', tenantId: 'tenant-1', agentId: 'agent-child',
    ownerAgentId: 'agent-owner', sourceLeaseId: 'lease-child',
    baseSnapshotId: childManifest.identity, currentSnapshotId: childManifest.identity,
    baseManifestObjectId: child.manifestId, currentManifestObjectId: child.manifestId,
    artifactObjectId: 'artifact-object', contentObjects: [], checksum: serialized.checksum,
    changedFiles: 0, sizeBytes: 0, state: 'available',
    expiresAt: new Date(Date.now() + 60_000),
    baseManifest: childManifest, currentManifest: childManifest,
  })

  const identity = { operation: 'patch_apply', idempotencyKey: 'apply-key', tenantId: 'tenant-1' }
  const claim = await context.journal.claimOperation({
    ...identity, requestHash: canonicalRequestHash({ targetLeaseId: 'lease-target',
      artifactId: 'artifact-1', idempotencyKey: 'apply-key' }),
    workerId: 'worker-first', primaryLeaseId: 'lease-target',
  })
  assert.equal(claim.kind, 'claimed')
  const generation = claim.generation
  const fence = { ...identity, generation, workerId: 'worker-first' }
  return {
    fence, resultManifest,
    input: {
      ...identity, applicationId: 'application-1', createdGeneration: generation,
      targetLeaseId: 'lease-target', artifactId: 'artifact-1',
      sourceTargetSnapshotId: targetManifest.identity,
      targetProviderSandboxId: 'sandbox-target', resultSnapshotId: resultManifest.identity,
      resultManifestChecksum: workspaceManifestChecksum(resultManifest),
      resultArchiveChecksum: digest('f'), resultArchiveSizeBytes: 4096,
    },
  }
}

async function rollback(context: Fixture, setup: Prepared) {
  const allocation = await context.journal.recordAllocation(
    setup.fence, setup.fence.generation, setup.fence.workerId, {
      kind: 'provider_snapshot', resourceId: 'provider-rollback', leaseId: 'lease-target',
      metadata: { purpose: 'patch_apply_rollback' },
    })
  return context.first.recordRollback(setup.fence, setup.input.applicationId, {
    allocationId: allocation.allocationId, providerSnapshotId: allocation.resourceId,
  })
}

live('creates one exact application across replicas and composes with caller rollback', async context => {
  const setup = await prepared(context)
  const client = await context.firstPool.connect()
  try {
    await client.query('BEGIN')
    assert.equal((await context.first.create(setup.input, setup.fence, client)).phase, 'planned')
    assert.equal(await context.second.getForOperation(setup.fence), null)
    await client.query('ROLLBACK')
  } finally { client.release() }

  const [first, second] = await Promise.all([
    context.first.create(setup.input, setup.fence),
    context.second.create(setup.input, setup.fence),
  ])
  assert.deepEqual(first, second)
  await assert.rejects(context.second.create({
    ...setup.input, resultArchiveChecksum: digest('e'),
  }, setup.fence), PatchApplicationConflictError)
  await assert.rejects(context.second.create({
    ...setup.input, applicationId: 'application-other',
  }, setup.fence), PatchApplicationConflictError)
})

live('ledgers rollback, swap, and only an exact durable latest checkpoint', async context => {
  const setup = await prepared(context)
  await context.first.create(setup.input, setup.fence)
  assert.equal((await rollback(context, setup)).phase, 'rollback_ready')
  assert.equal((await context.second.markSwapStarted(
    setup.fence, setup.input.applicationId)).phase, 'swap_started')
  assert.equal((await context.first.markSwapped(
    setup.fence, setup.input.applicationId)).phase, 'swapped')
  await assert.rejects(context.first.markCheckpointed(setup.fence, setup.input.applicationId),
    PatchApplicationConflictError)

  await register(context, object('result-archive', 'workspace_archive',
    setup.input.resultArchiveChecksum, setup.input.resultArchiveSizeBytes))
  await register(context, object('result-manifest', 'manifest',
    workspaceManifestChecksum(setup.resultManifest), Buffer.byteLength(canonicalJson(setup.resultManifest))))
  await context.state.appendCheckpoint('tenant-1', 'lease-target', {
    snapshotId: setup.resultManifest.identity, providerSnapshotId: 'provider-result',
    workspaceArchiveObjectId: 'result-archive', manifestObjectId: 'result-manifest',
    manifestChecksum: workspaceManifestChecksum(setup.resultManifest),
  })
  const checkpointed = await context.second.markCheckpointed(setup.fence, setup.input.applicationId)
  assert.equal(checkpointed.phase, 'checkpointed')
  assert.ok(checkpointed.checkpointedAt)
  assert.deepEqual(await context.first.markCheckpointed(setup.fence, setup.input.applicationId),
    checkpointed)
  await assert.rejects(context.first.beginRollback(
    setup.fence, setup.input.applicationId, 'too late'), PatchApplicationConflictError)
})

live('stale takeover fences the old worker and resumes an exact rollback', async context => {
  const setup = await prepared(context)
  await context.first.create(setup.input, setup.fence)
  await rollback(context, setup)
  await context.first.markSwapStarted(setup.fence, setup.input.applicationId)
  await context.firstPool.query(`
    UPDATE hosted_agent_operations
    SET generation = generation + 1, worker_id = 'worker-second'
    WHERE operation = $1 AND idempotency_key = $2
  `, [setup.fence.operation, setup.fence.idempotencyKey])
  const nextFence = { ...setup.fence, generation: setup.fence.generation + 1,
    workerId: 'worker-second' }
  await assert.rejects(context.first.markSwapped(
    setup.fence, setup.input.applicationId), OperationOwnershipError)
  const started = await context.second.beginRollback(
    nextFence, setup.input.applicationId, 'swap outcome was ambiguous')
  assert.equal(started.phase, 'rollback_started')
  assert.equal(started.errorMessage, 'swap outcome was ambiguous')
  const complete = await context.first.markRolledBack(nextFence, setup.input.applicationId)
  assert.equal(complete.phase, 'rolled_back')
  assert.deepEqual(await context.second.markRolledBack(nextFence, setup.input.applicationId), complete)
})

live('database guards reject invalid allocation, identity mutation, timestamp rewrite, and phase jumps', async context => {
  const setup = await prepared(context)
  await context.first.create(setup.input, setup.fence)
  const wrong = await context.journal.recordAllocation(
    setup.fence, setup.fence.generation, setup.fence.workerId, {
      kind: 'provider_snapshot', resourceId: 'wrong-purpose', leaseId: 'lease-target',
      metadata: { purpose: 'checkpoint' },
    })
  await assert.rejects(context.first.recordRollback(setup.fence, setup.input.applicationId, {
    allocationId: wrong.allocationId, providerSnapshotId: wrong.resourceId,
  }), PatchApplicationConflictError)
  await assert.rejects(context.firstPool.query(`
    UPDATE hosted_agent_patch_applications SET artifact_id = 'artifact-other'
    WHERE application_id = 'application-1'
  `))
  await assert.rejects(context.firstPool.query(`
    UPDATE hosted_agent_patch_applications SET phase = 'swapped', swapped_at = now()
    WHERE application_id = 'application-1'
  `))

  await rollback(context, setup)
  await context.first.markSwapStarted(setup.fence, setup.input.applicationId)
  await assert.rejects(context.firstPool.query(`
    UPDATE hosted_agent_patch_applications
    SET phase = 'swapped', swapped_at = now(), swap_started_at = now() + interval '1 second'
    WHERE application_id = 'application-1'
  `))
})
