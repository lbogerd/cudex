import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import { buildPatchApplyArchive } from '../src/patch-apply-archive.js'
import { PostgresPatchApplySourceResolver } from '../src/postgres-patch-apply-source.js'
import { PostgresPatchApplyCoordinator } from '../src/postgres-patch-apply.js'
import { serializePatchArtifact } from '../src/patch-artifact.js'
import { PostgresPatchArtifactRepository } from '../src/postgres-artifacts.js'
import { PostgresPatchApplicationRepository } from '../src/postgres-patch-applications.js'
import { PostgresObjectReclaimer } from '../src/postgres-object-reclaimer.js'
import { PostgresDurableState, type StoredObject } from '../src/postgres-state.js'
import { PostgresJournal } from '../src/postgres-store.js'
import { PostgresWorkspacePreparations } from '../src/postgres-workspace-preparations.js'
import { ServiceError } from '../src/types.js'
import {
  createWorkspaceManifest,
  type WorkspaceEntry,
  type WorkspaceManifest,
} from '../src/workspace-manifest.js'
import { WorkspaceSnapshotPublisher, type PublishedWorkspaceSnapshot } from '../src/workspace-snapshots.js'
import { FakeProvider } from './fake-provider.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const tenantId = 'tenant-patch-apply'
const encoded = (value: string): Uint8Array => new TextEncoder().encode(value)
const checksum = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const file = (path: string, bytes: Uint8Array): WorkspaceEntry => ({
  path, type: 'file', mode: 0o644, digest: checksum(bytes), sizeBytes: bytes.byteLength,
})

class TrackingObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  puts = 0
  async put(bytes: Uint8Array): Promise<string> {
    this.puts += 1
    const id = checksum(bytes).slice('sha256:'.length)
    this.values.set(id, Uint8Array.from(bytes))
    return id
  }
  async get(id: string): Promise<Uint8Array> {
    const value = this.values.get(id)
    if (!value) throw new Error('missing object')
    return Uint8Array.from(value)
  }
  async delete(id: string): Promise<void> { this.values.delete(id) }
  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'patch-apply-test', storageKey: `v1/sha256/${id.slice(0, 2)}/${id}` }
  }
}

class FailOnceExportProvider extends FakeProvider {
  failNextExport = false
  override async exportWorkspace(sandboxId: string): Promise<Uint8Array> {
    if (this.failNextExport) {
      this.failNextExport = false
      throw new Error('injected one-time export failure')
    }
    return super.exportWorkspace(sandboxId)
  }
}

interface Fixture {
  admin: Pool
  pools: [Pool, Pool]
  states: [PostgresDurableState, PostgresDurableState]
  provider: FailOnceExportProvider
  objects: TrackingObjects
  coordinators: [PostgresPatchApplyCoordinator, PostgresPatchApplyCoordinator]
  targetArchive: Uint8Array
  targetManifest: WorkspaceManifest
  expectedManifest: WorkspaceManifest
  targetLeaseId: string
  targetSandboxId: string
  artifactId: string
  schema: string
}

async function archive(manifest: WorkspaceManifest,
  bodies: Array<{ path: string; objectId: string; bytes: Uint8Array }>): Promise<Uint8Array> {
  return buildPatchApplyArchive(manifest, bodies.map(value => ({
    ...value, checksum: checksum(value.bytes), sizeBytes: value.bytes.byteLength,
  })))
}

async function fixture(conflictingTarget = false): Promise<Fixture> {
  const schema = `hosted_agent_patch_apply_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const config = { connectionString: databaseUrl, options: `-c search_path=${schema}` }
  const pools = [new Pool(config), new Pool(config)] as [Pool, Pool]
  await runMigrations(pools[0])
  const states = pools.map(pool => new PostgresDurableState(pool)) as
    [PostgresDurableState, PostgresDurableState]
  const journals = pools.map(pool => new PostgresJournal(pool)) as [PostgresJournal, PostgresJournal]
  const objects = new TrackingObjects()
  const provider = new FailOnceExportProvider()
  const reclaimers = pools.map(pool => new PostgresObjectReclaimer(pool, objects))
  const publishers = pools.map((pool, index) => new WorkspaceSnapshotPublisher(
    states[index]!, objects, {
      reclaimer: { async reclaimUnreferencedWorkspaceObject() {
        assert.fail('test fixture publication must not require legacy cleanup')
      } },
      durablePreparation: {
        journal: journals[index]!, preparations: new PostgresWorkspacePreparations(pool),
        reclaimer: reclaimers[index]!,
      },
    })) as [WorkspaceSnapshotPublisher, WorkspaceSnapshotPublisher]

  const baseBytes = encoded('base')
  const changedBytes = encoded('agent change')
  const ownerBytes = encoded('owner only')
  const conflictBytes = encoded('owner conflict')
  const targetFile = conflictingTarget ? conflictBytes : baseBytes
  const targetManifest = createWorkspaceManifest('snapshot-target', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/0', type: 'directory', mode: 0o755 },
    file('roots/0/file', targetFile), file('roots/0/owner', ownerBytes),
  ])
  const targetArchive = await archive(targetManifest, [
    { path: 'roots/0/file', objectId: 'target-file', bytes: targetFile },
    { path: 'roots/0/owner', objectId: 'target-owner', bytes: ownerBytes },
  ])
  const targetSandbox = await provider.create('general-v1', {
    managedBy: 'cudex', tenantId, leaseId: 'lease-target',
  })
  await provider.uploadArchive(targetSandbox.sandboxId, targetArchive)
  const targetProviderSnapshot = await provider.snapshot(targetSandbox.sandboxId)
  await publishers[0].createBase({
    leaseId: 'lease-target', environmentId: 'environment-target', tenantId,
    agentId: 'agent-owner', providerSandboxId: targetSandbox.sandboxId,
    sandboxTemplate: 'general-v1', cwdUri: 'file:///workspace/roots/0',
    workspaceRootUris: ['file:///workspace/roots/0'],
    toolPolicy: { allowedDomains: [], allowedTools: [] }, policyVersion: 1,
    snapshot: {
      snapshotId: targetManifest.identity, providerSnapshotId: targetProviderSnapshot,
      archive: targetArchive,
    },
  })

  const childBaseManifest = createWorkspaceManifest('snapshot-child-base', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/0', type: 'directory', mode: 0o755 }, file('roots/0/file', baseBytes),
  ])
  const childCurrentManifest = createWorkspaceManifest('snapshot-child-current', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/0', type: 'directory', mode: 0o755 }, file('roots/0/file', changedBytes),
    { path: 'roots/0/link', type: 'symlink', mode: 0o777, linkTarget: 'file' },
  ])
  const childBaseArchive = await archive(childBaseManifest, [
    { path: 'roots/0/file', objectId: 'child-base-file', bytes: baseBytes },
  ])
  const childCurrentArchive = await archive(childCurrentManifest, [
    { path: 'roots/0/file', objectId: 'child-current-file', bytes: changedBytes },
  ])
  const childSandbox = await provider.create('general-v1', {
    managedBy: 'cudex', tenantId, leaseId: 'lease-child',
  })
  await provider.uploadArchive(childSandbox.sandboxId, childBaseArchive)
  const childBaseProviderSnapshot = await provider.snapshot(childSandbox.sandboxId)
  const childBase = await publishers[0].createBase({
    leaseId: 'lease-child', environmentId: 'environment-child', tenantId,
    agentId: 'agent-child', ownerAgentId: 'agent-owner', ownerLeaseId: 'lease-target',
    providerSandboxId: childSandbox.sandboxId, sandboxTemplate: 'general-v1',
    cwdUri: 'file:///workspace/roots/0', workspaceRootUris: ['file:///workspace/roots/0'],
    toolPolicy: { allowedDomains: [], allowedTools: [] }, policyVersion: 1,
    snapshot: {
      snapshotId: childBaseManifest.identity, providerSnapshotId: childBaseProviderSnapshot,
      archive: childBaseArchive,
    },
  })
  await provider.uploadArchive(childSandbox.sandboxId, childCurrentArchive)
  const childCurrentProviderSnapshot = await provider.snapshot(childSandbox.sandboxId)
  const childCurrent: PublishedWorkspaceSnapshot = await publishers[0].appendCheckpoint({
    tenantId, leaseId: 'lease-child', snapshot: {
      snapshotId: childCurrentManifest.identity,
      providerSnapshotId: childCurrentProviderSnapshot, archive: childCurrentArchive,
    },
  })

  const changedContent = childCurrent.contentObjects.find(value => value.path === 'roots/0/file')!
  const serialized = serializePatchArtifact({
    agentId: 'agent-child', baseSnapshotId: childBaseManifest.identity,
    currentSnapshotId: childCurrentManifest.identity,
    baseManifest: childBaseManifest, currentManifest: childCurrentManifest,
    contentObjects: [{ path: changedContent.path, objectId: changedContent.objectId }],
  })
  const physicalId = await objects.put(serialized.bytes)
  const location = objects.location(physicalId)
  const artifactObject: StoredObject = {
    objectId: 'artifact-object', tenantId, kind: 'patch_artifact', ...location,
    checksum: serialized.checksum, sizeBytes: serialized.bytes.byteLength,
    state: 'available', expiresAt: null,
  }
  await states[0].registerObject(artifactObject)
  await new PostgresPatchArtifactRepository(pools[0]).create({
    artifactId: 'artifact-1', tenantId, agentId: 'agent-child', ownerAgentId: 'agent-owner',
    sourceLeaseId: 'lease-child', baseSnapshotId: childBaseManifest.identity,
    currentSnapshotId: childCurrentManifest.identity,
    baseManifestObjectId: childBase.snapshot.manifestObjectId,
    currentManifestObjectId: childCurrent.snapshot.manifestObjectId,
    artifactObjectId: artifactObject.objectId,
    contentObjects: [{ path: changedContent.path, objectId: changedContent.objectId }],
    checksum: serialized.checksum, changedFiles: serialized.changedFiles,
    sizeBytes: serialized.sizeBytes, state: 'available',
    expiresAt: new Date(Date.now() + 60_000),
    baseManifest: childBaseManifest, currentManifest: childCurrentManifest,
  })

  const coordinators = pools.map((pool, index) => new PostgresPatchApplyCoordinator(
    journals[index]!, states[index]!, new PostgresPatchApplySourceResolver(pool, objects),
    new PostgresPatchApplicationRepository(pool), publishers[index]!, provider,
    { tenantId, workerId: `apply-worker-${index}`, heartbeatIntervalMs: 100 },
  )) as [PostgresPatchApplyCoordinator, PostgresPatchApplyCoordinator]
  const expectedManifest = createWorkspaceManifest('expected-result', [
    ...childCurrentManifest.entries, file('roots/0/owner', ownerBytes),
  ])
  return {
    admin, pools, states, provider, objects, coordinators, targetArchive, targetManifest,
    expectedManifest, targetLeaseId: 'lease-target', targetSandboxId: targetSandbox.sandboxId,
    artifactId: 'artifact-1', schema,
  }
}

async function cleanup(context: Fixture): Promise<void> {
  await Promise.all(context.pools.map(pool => pool.end()))
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

const live = (name: string, conflict: boolean,
  fn: (context: Fixture) => Promise<void>) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture(conflict)
  try { await fn(context) } finally { await cleanup(context) }
})

live('atomically applies, checkpoints, cleans rollback, and replays without mutation', false,
  async context => {
    const baselineSnapshots = context.provider.snapshots.size
    const baselinePuts = context.objects.puts
    const request = {
      targetLeaseId: context.targetLeaseId, artifactId: context.artifactId,
      idempotencyKey: 'apply-clean',
    }
    const result = await context.coordinators[0].applyPatch(request)
    assert.equal(result.type, 'applied')
    if (result.type !== 'applied') return
    const durable = await context.states[1].getLease(tenantId, context.targetLeaseId)
    assert.equal(durable?.latestSnapshotId, result.checkpoint.snapshotId)
    assert.equal(context.provider.snapshots.size, baselineSnapshots + 1)
    assert.equal(context.provider.snapshotDeletes, 1)
    const captured = await import('../src/archive-manifest.js').then(module =>
      module.captureArchiveManifest(
        context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
        'observed-result', context.objects))
    assert.deepEqual(captured.manifest.entries, context.expectedManifest.entries)
    const graph = await context.pools[0].query<{
      phase: string; operation_state: string; rollback_state: string; adopted: string
    }>(`
      SELECT application.phase, operation.state AS operation_state,
        rollback.state AS rollback_state,
        (SELECT count(*)::text FROM hosted_agent_operation_allocations
          WHERE operation = 'patch_apply' AND idempotency_key = $1 AND state = 'adopted') AS adopted
      FROM hosted_agent_patch_applications AS application
      JOIN hosted_agent_operations AS operation USING (operation, idempotency_key, tenant_id)
      JOIN hosted_agent_operation_allocations AS rollback
        ON rollback.allocation_id = application.rollback_allocation_id
      WHERE application.idempotency_key = $1
    `, [request.idempotencyKey])
    assert.deepEqual(graph.rows[0], {
      phase: 'checkpointed', operation_state: 'succeeded', rollback_state: 'reclaimed',
      adopted: '5',
    })
    const mutations = { snapshots: context.provider.snapshots.size,
      deletes: context.provider.snapshotDeletes, puts: context.objects.puts }
    assert.deepEqual(await context.coordinators[1].applyPatch(request), result)
    assert.deepEqual({ snapshots: context.provider.snapshots.size,
      deletes: context.provider.snapshotDeletes, puts: context.objects.puts }, mutations)
    assert.ok(context.objects.puts > baselinePuts)
  })

live('returns a normal conflict without provider, ledger, object, or workspace mutation', true,
  async context => {
    const baseline = {
      snapshots: context.provider.snapshots.size, deletes: context.provider.snapshotDeletes,
      puts: context.objects.puts,
      bytes: Uint8Array.from(context.provider.sandboxes.get(context.targetSandboxId)!.bytes),
    }
    const request = {
      targetLeaseId: context.targetLeaseId, artifactId: context.artifactId,
      idempotencyKey: 'apply-conflict',
    }
    const result = await context.coordinators[0].applyPatch(request)
    assert.deepEqual(result, { type: 'conflict', paths: ['file:///workspace/roots/0/file'] })
    assert.deepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes, baseline.bytes)
    assert.deepEqual({ snapshots: context.provider.snapshots.size,
      deletes: context.provider.snapshotDeletes, puts: context.objects.puts }, {
      snapshots: baseline.snapshots, deletes: baseline.deletes, puts: baseline.puts,
    })
    assert.equal((await context.pools[0].query(
      `SELECT 1 FROM hosted_agent_patch_applications WHERE idempotency_key = $1`,
      [request.idempotencyKey])).rowCount, 0)
    assert.deepEqual(await context.coordinators[1].applyPatch(request), result)
  })

live('restores the exact pre-apply archive and terminalizes after a post-swap failure', false,
  async context => {
    const baselineSnapshots = context.provider.snapshots.size
    const before = await context.states[0].getLease(tenantId, context.targetLeaseId)
    context.provider.failNextExport = true
    const request = {
      targetLeaseId: context.targetLeaseId, artifactId: context.artifactId,
      idempotencyKey: 'apply-rollback',
    }
    await assert.rejects(context.coordinators[0].applyPatch(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503
        && error.message === 'durable patch apply failed')
    assert.deepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
      context.targetArchive)
    assert.equal(context.provider.snapshots.size, baselineSnapshots)
    assert.equal(context.provider.snapshotDeletes, 1)
    assert.equal((await context.states[1].getLease(
      tenantId, context.targetLeaseId))?.latestSnapshotId, before?.latestSnapshotId)
    const graph = await context.pools[0].query<{
      phase: string; operation_state: string; allocation_state: string
    }>(`
      SELECT application.phase, operation.state AS operation_state,
             allocation.state AS allocation_state
      FROM hosted_agent_patch_applications AS application
      JOIN hosted_agent_operations AS operation USING (operation, idempotency_key, tenant_id)
      JOIN hosted_agent_operation_allocations AS allocation
        ON allocation.allocation_id = application.rollback_allocation_id
      WHERE application.idempotency_key = $1
    `, [request.idempotencyKey])
    assert.deepEqual(graph.rows[0], {
      phase: 'rolled_back', operation_state: 'failed_terminal', allocation_state: 'reclaimed',
    })
    await assert.rejects(context.coordinators[1].applyPatch(request),
      (error: unknown) => error instanceof ServiceError && error.status === 503)
  })
