import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import { buildPatchApplyArchive } from '../src/patch-apply-archive.js'
import { PostgresPatchApplySourceResolver } from '../src/postgres-patch-apply-source.js'
import {
  deterministicPatchApplyId,
  patchApplyProviderSnapshotName,
  PostgresPatchApplyCoordinator,
} from '../src/postgres-patch-apply.js'
import {
  type PatchApplyReconcileResult,
  PostgresPatchApplyReconciler,
} from '../src/postgres-patch-apply-reconciler.js'
import { serializePatchArtifact } from '../src/patch-artifact.js'
import { PostgresPatchArtifactRepository } from '../src/postgres-artifacts.js'
import {
  type PatchApplication,
  type PatchApplicationFence,
  PostgresPatchApplicationRepository,
} from '../src/postgres-patch-applications.js'
import { PostgresObjectReclaimer } from '../src/postgres-object-reclaimer.js'
import {
  type LeaseInteractionIdentity,
  PostgresLeaseInteractionGate,
} from '../src/postgres-lease-interactions.js'
import { PostgresDurableState, type StoredObject } from '../src/postgres-state.js'
import { canonicalRequestHash, PostgresJournal } from '../src/postgres-store.js'
import { PostgresWorkspacePreparations } from '../src/postgres-workspace-preparations.js'
import { ServiceError } from '../src/types.js'
import {
  createWorkspaceManifest,
  workspaceManifestChecksum,
  type WorkspaceEntry,
  type WorkspaceManifest,
} from '../src/workspace-manifest.js'
import {
  type PreparedDurableBaseWorkspaceSnapshot,
  type PublishedWorkspaceSnapshot,
  WorkspaceSnapshotPublisher,
} from '../src/workspace-snapshots.js'
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
  ambiguousSnapshotName: string | undefined
  override async exportWorkspace(sandboxId: string): Promise<Uint8Array> {
    if (this.failNextExport) {
      this.failNextExport = false
      throw new Error('injected one-time export failure')
    }
    return super.exportWorkspace(sandboxId)
  }
  override async snapshot(sandboxId: string, options: { name?: string } = {}): Promise<string> {
    const snapshotId = await super.snapshot(sandboxId, options)
    if (options.name && options.name === this.ambiguousSnapshotName) {
      this.ambiguousSnapshotName = undefined
      throw new Error('injected lost snapshot response')
    }
    return snapshotId
  }
}

interface Fixture {
  admin: Pool
  pools: [Pool, Pool]
  states: [PostgresDurableState, PostgresDurableState]
  journals: [PostgresJournal, PostgresJournal]
  interactionGates: [PostgresLeaseInteractionGate, PostgresLeaseInteractionGate]
  reclaimers: [PostgresObjectReclaimer, PostgresObjectReclaimer]
  preparations: [PostgresWorkspacePreparations, PostgresWorkspacePreparations]
  publishers: [WorkspaceSnapshotPublisher, WorkspaceSnapshotPublisher]
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

async function fixture(conflictingTarget = false, artifactTtlMs = 60_000): Promise<Fixture> {
  const schema = `hosted_agent_patch_apply_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const config = { connectionString: databaseUrl, options: `-c search_path=${schema}` }
  const pools = [new Pool(config), new Pool(config)] as [Pool, Pool]
  await runMigrations(pools[0])
  const states = pools.map(pool => new PostgresDurableState(pool)) as
    [PostgresDurableState, PostgresDurableState]
  const journals = pools.map(pool => new PostgresJournal(pool)) as [PostgresJournal, PostgresJournal]
  const interactionGates = journals.map((journal, index) =>
    new PostgresLeaseInteractionGate(journal, states[index]!)) as
    [PostgresLeaseInteractionGate, PostgresLeaseInteractionGate]
  const objects = new TrackingObjects()
  const provider = new FailOnceExportProvider()
  const reclaimers = pools.map(pool => new PostgresObjectReclaimer(pool, objects)) as
    [PostgresObjectReclaimer, PostgresObjectReclaimer]
  const preparations = pools.map(pool => new PostgresWorkspacePreparations(pool)) as
    [PostgresWorkspacePreparations, PostgresWorkspacePreparations]
  const publishers = pools.map((pool, index) => new WorkspaceSnapshotPublisher(
    states[index]!, objects, {
      reclaimer: { async reclaimUnreferencedWorkspaceObject() {
        assert.fail('test fixture publication must not require legacy cleanup')
      } },
      durablePreparation: {
        journal: journals[index]!, preparations: preparations[index]!,
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
    expiresAt: new Date(Date.now() + artifactTtlMs),
    baseManifest: childBaseManifest, currentManifest: childCurrentManifest,
  })

  const coordinators = pools.map((pool, index) => new PostgresPatchApplyCoordinator(
    journals[index]!, states[index]!, new PostgresPatchApplySourceResolver(pool, objects),
    new PostgresPatchApplicationRepository(pool), publishers[index]!, provider,
    { tenantId, workerId: `apply-worker-${index}`, heartbeatIntervalMs: 100,
      interactionGate: interactionGates[index]! },
  )) as [PostgresPatchApplyCoordinator, PostgresPatchApplyCoordinator]
  const expectedManifest = createWorkspaceManifest('expected-result', [
    ...childCurrentManifest.entries, file('roots/0/owner', ownerBytes),
  ])
  return {
    admin, pools, states, journals, interactionGates, reclaimers, preparations, publishers,
    provider, objects, coordinators, targetArchive, targetManifest,
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
  fn: (context: Fixture) => Promise<void>, artifactTtlMs = 60_000) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture(conflict, artifactTtlMs)
  try { await fn(context) } finally { await cleanup(context) }
})

interface SeededApplication {
  fence: PatchApplicationFence
  application: PatchApplication
  resultArchive: Uint8Array
  resultProviderSnapshotId?: string
  prepared?: PreparedDurableBaseWorkspaceSnapshot
}

async function seedInterruptedApplication(context: Fixture, idempotencyKey: string,
  phase: 'planned' | 'rollback_ready' | 'swap_started' | 'swapped' | 'checkpointed',
  options: { mutateAfterSwapStarted?: boolean; resultSnapshot?: 'none' | 'unledgered' | 'ledgered';
    prepareWorkspace?: boolean } = {}): Promise<SeededApplication> {
  const identity = { operation: 'patch_apply', idempotencyKey, tenantId }
  const request = { targetLeaseId: context.targetLeaseId, artifactId: context.artifactId,
    idempotencyKey }
  const claim = await context.journals[0].claimOperation({
    ...identity, requestHash: canonicalRequestHash(request), workerId: 'crashed-apply-worker',
    primaryLeaseId: context.targetLeaseId,
  })
  assert.equal(claim.kind, 'claimed')
  if (claim.kind !== 'claimed') throw new Error('test operation was not claimed')
  const fence = { ...identity, generation: claim.generation,
    workerId: 'crashed-apply-worker' } satisfies PatchApplicationFence
  const resultSnapshotId = deterministicPatchApplyId('snapshot', identity)
  const source = await new PostgresPatchApplySourceResolver(
    context.pools[0], context.objects).resolve({
      tenantId, targetLeaseId: context.targetLeaseId,
      artifactId: context.artifactId, resultSnapshotId,
    })
  assert.equal(source.plan.type, 'ready')
  if (source.plan.type !== 'ready') throw new Error('test patch plan was not ready')
  const content = new Map([...source.target.contentObjects, ...source.artifact.contentObjects]
    .map(value => [value.objectId, value]))
  const resultArchive = await archive(source.plan.manifest,
    source.plan.contentObjects.map(value => {
      const body = content.get(value.objectId)!
      return { path: value.path, objectId: value.objectId, bytes: body.bytes }
    }))
  const applications = new PostgresPatchApplicationRepository(context.pools[0])
  let application = await applications.create({
    ...identity, applicationId: deterministicPatchApplyId('application', identity),
    createdGeneration: claim.generation, targetLeaseId: context.targetLeaseId,
    artifactId: context.artifactId, sourceTargetSnapshotId: source.target.latestSnapshotId,
    targetProviderSandboxId: source.target.providerSandboxId, resultSnapshotId,
    resultManifestChecksum: workspaceManifestChecksum(source.plan.manifest),
    resultArchiveChecksum: checksum(resultArchive),
    resultArchiveSizeBytes: resultArchive.byteLength,
  }, fence)
  if (phase === 'planned') return { fence, application, resultArchive }

  const rollbackId = await context.provider.snapshot(context.targetSandboxId,
    { name: patchApplyProviderSnapshotName('rollback', identity) })
  const rollbackAllocation = await context.journals[0].recordAllocation(
    identity, fence.generation, fence.workerId, {
      kind: 'provider_snapshot', resourceId: rollbackId, leaseId: context.targetLeaseId,
      metadata: { purpose: 'patch_apply_rollback', applicationId: application.applicationId,
        name: patchApplyProviderSnapshotName('rollback', identity) },
    })
  application = await applications.recordRollback(fence, application.applicationId, {
    allocationId: rollbackAllocation.allocationId, providerSnapshotId: rollbackId,
  })
  if (phase === 'rollback_ready') return { fence, application, resultArchive }

  application = await applications.markSwapStarted(fence, application.applicationId)
  if (options.mutateAfterSwapStarted || phase !== 'swap_started') {
    await context.provider.uploadArchive(context.targetSandboxId, resultArchive)
  }
  if (phase === 'swap_started') return { fence, application, resultArchive }
  application = await applications.markSwapped(fence, application.applicationId)

  let resultProviderSnapshotId: string | undefined
  let resultAllocationId: string | undefined
  if ((options.resultSnapshot ?? (phase === 'checkpointed' ? 'ledgered' : 'none')) !== 'none') {
    resultProviderSnapshotId = await context.provider.snapshot(context.targetSandboxId,
      { name: patchApplyProviderSnapshotName('result', identity) })
    if ((options.resultSnapshot ?? 'ledgered') === 'ledgered' || phase === 'checkpointed') {
      const allocation = await context.journals[0].recordAllocation(
        identity, fence.generation, fence.workerId, {
          kind: 'provider_snapshot', resourceId: resultProviderSnapshotId,
          leaseId: context.targetLeaseId,
          metadata: { purpose: 'patch_apply_checkpoint', applicationId: application.applicationId,
            name: patchApplyProviderSnapshotName('result', identity) },
        })
      resultAllocationId = allocation.allocationId
    }
  }

  let prepared: PreparedDurableBaseWorkspaceSnapshot | undefined
  if (options.prepareWorkspace || phase === 'checkpointed') {
    const lease = (await context.states[0].getLease(tenantId, context.targetLeaseId))!
    assert.ok(resultProviderSnapshotId)
    prepared = await context.publishers[0].prepareDurableBase({
      fence, expectedSourceChecksum: null,
      expectedLatestSnapshotId: source.target.latestSnapshotId,
      leaseId: lease.leaseId, environmentId: lease.environmentId, tenantId: lease.tenantId,
      agentId: lease.agentId, ownerAgentId: lease.ownerAgentId,
      ownerLeaseId: lease.ownerLeaseId, sourceSnapshotId: null,
      providerSandboxId: lease.providerSandboxId!, sandboxTemplate: lease.sandboxTemplate,
      cwdUri: lease.cwdUri, workspaceRootUris: [...lease.workspaceRootUris],
      toolPolicy: structuredClone(lease.toolPolicy), policyVersion: lease.policyVersion,
      snapshot: { snapshotId: resultSnapshotId,
        providerSnapshotId: resultProviderSnapshotId!, archive: resultArchive, expiresAt: null },
    })
  }
  if (phase === 'checkpointed') {
    assert.ok(prepared); assert.ok(resultProviderSnapshotId); assert.ok(resultAllocationId)
    await context.journals[0].withProviderResourceLocks([
      { kind: 'provider_snapshot', resourceId: rollbackId },
      { kind: 'provider_snapshot', resourceId: resultProviderSnapshotId! },
    ], async client => {
      const durable = await context.publishers[0].commitDurableCheckpoint(fence, prepared!, client)
      await context.journals[0].bindLeaseAndAdoptAllocations(
        fence, fence.generation, fence.workerId, context.targetLeaseId,
        [resultAllocationId!, ...durable.objectAllocationIds], client)
      application = await applications.markCheckpointed(fence, application.applicationId, client)
    })
  }
  return { fence, application, resultArchive,
    ...(resultProviderSnapshotId ? { resultProviderSnapshotId } : {}),
    ...(prepared ? { prepared } : {}) }
}

async function reconcileInterrupted(context: Fixture): Promise<PatchApplyReconcileResult> {
  await context.pools[0].query(`UPDATE hosted_agent_operations
    SET heartbeat_at = now() - interval '1 hour'
    WHERE operation = 'patch_apply' AND state = 'in_progress'`)
  return new PostgresPatchApplyReconciler(
    context.journals[1], context.states[1],
    new PostgresPatchApplySourceResolver(context.pools[1], context.objects),
    new PostgresPatchApplicationRepository(context.pools[1]), context.provider,
    { preparations: context.preparations[1], reclaimer: context.reclaimers[1],
      interactionGate: context.interactionGates[1] },
    { tenantId, workerId: 'patch-apply-reconciler', staleAfterMs: 1_000,
      heartbeatIntervalMs: 100, pollIntervalMs: 1_000 },
  ).runOnce()
}

live('atomically applies, checkpoints, cleans rollback, and replays without mutation', false,
  async context => {
    const baselineSnapshots = context.provider.snapshots.size
    const baselinePuts = context.objects.puts
    const request = {
      targetLeaseId: context.targetLeaseId, artifactId: context.artifactId,
      idempotencyKey: 'apply-clean',
    }
    const [result, concurrent] = await Promise.all([
      context.coordinators[0].applyPatch(request),
      context.coordinators[1].applyPatch(request),
    ])
    assert.deepEqual(concurrent, result)
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

live('refuses to mutate a target with an unfinished command interaction', false,
  async context => {
    const interaction: LeaseInteractionIdentity = {
      tenantId, leaseId: context.targetLeaseId, interactionId: 'patch-target-command',
      connectionGeneration: 0, sessionId: 'target-session',
      kind: 'process', processId: 'target-process',
    }
    await context.interactionGates[0].begin(interaction)
    const baseline = {
      snapshots: context.provider.snapshots.size, deletes: context.provider.snapshotDeletes,
      puts: context.objects.puts,
      bytes: Uint8Array.from(context.provider.sandboxes.get(context.targetSandboxId)!.bytes),
    }
    await assert.rejects(context.coordinators[1].applyPatch({
      targetLeaseId: context.targetLeaseId, artifactId: context.artifactId,
      idempotencyKey: 'apply-active-target-command',
    }), (error: unknown) => error instanceof ServiceError && error.status === 503)
    assert.deepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
      baseline.bytes)
    assert.deepEqual({
      snapshots: context.provider.snapshots.size, deletes: context.provider.snapshotDeletes,
      puts: context.objects.puts,
    }, { snapshots: baseline.snapshots, deletes: baseline.deletes, puts: baseline.puts })

    await context.interactionGates[1].finish(interaction)
    const result = await context.coordinators[1].applyPatch({
      targetLeaseId: context.targetLeaseId, artifactId: context.artifactId,
      idempotencyKey: 'apply-after-target-command',
    })
    assert.equal(result.type, 'applied')
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

for (const kind of ['rollback', 'result'] as const) {
  live(`reclaims a ${kind} snapshot whose provider response was lost`, false,
    async context => {
      const idempotencyKey = `apply-ambiguous-${kind}`
      const identity = { operation: 'patch_apply', idempotencyKey, tenantId }
      context.provider.ambiguousSnapshotName = patchApplyProviderSnapshotName(kind, identity)
      await assert.rejects(context.coordinators[0].applyPatch({
        targetLeaseId: context.targetLeaseId, artifactId: context.artifactId, idempotencyKey,
      }), (error: unknown) => error instanceof ServiceError && error.status === 503)
      assert.equal((await context.provider.listSnapshots({
        name: patchApplyProviderSnapshotName(kind, identity),
      })).length, 0)
      assert.deepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
        context.targetArchive)
      const graph = await context.pools[0].query<{ phase: string; state: string }>(`
        SELECT application.phase, operation.state
        FROM hosted_agent_patch_applications AS application
        JOIN hosted_agent_operations AS operation USING (operation, idempotency_key, tenant_id)
        WHERE application.idempotency_key = $1
      `, [idempotencyKey])
      assert.deepEqual(graph.rows[0], {
        phase: kind === 'rollback' ? 'failed' : 'rolled_back', state: 'in_progress',
      })
      const recovered = await reconcileInterrupted(context)
      assert.deepEqual({ failed: recovered.operationsFailed,
        pending: recovered.allocationsPending }, { failed: 1, pending: 0 })
      assert.equal((await context.pools[0].query<{ state: string }>(`
        SELECT state FROM hosted_agent_operations
        WHERE operation = 'patch_apply' AND idempotency_key = $1
      `, [idempotencyKey])).rows[0]!.state, 'failed_terminal')
    })
}

live('reconciles rollback-ready interruption after artifact expiry without claiming other operations', false,
  async context => {
    const seeded = await seedInterruptedApplication(
      context, 'apply-stale-rollback-ready', 'rollback_ready')
    const checkpointIdentity = {
      operation: 'checkpoint', idempotencyKey: 'unrelated-stale-checkpoint', tenantId,
    }
    const checkpointClaim = await context.journals[0].claimOperation({
      ...checkpointIdentity, requestHash: canonicalRequestHash(checkpointIdentity),
      workerId: 'unrelated-worker', primaryLeaseId: context.targetLeaseId,
    })
    assert.equal(checkpointClaim.kind, 'claimed')
    const targetContent = await context.pools[0].query<{ checksum: string }>(`
      SELECT object_row.checksum
      FROM hosted_agent_object_references AS reference
      JOIN hosted_agent_objects AS object_row ON object_row.object_id = reference.object_id
      WHERE reference.reference_kind = 'snapshot' AND reference.reference_id = $1
        AND reference.purpose = 'content_blob'
      ORDER BY object_row.object_id LIMIT 1
    `, [context.targetManifest.identity])
    assert.equal(context.objects.values.delete(
      targetContent.rows[0]!.checksum.slice('sha256:'.length)), true)
    await new Promise(resolve => setTimeout(resolve, 550))
    const result = await reconcileInterrupted(context)
    assert.deepEqual({ claimed: result.operationsClaimed, failed: result.operationsFailed,
      pending: result.allocationsPending }, { claimed: 1, failed: 1, pending: 0 })
    assert.deepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
      context.targetArchive)
    const graph = await context.pools[0].query<{
      phase: string; operation_state: string; allocation_state: string
    }>(`
      SELECT application.phase, operation.state AS operation_state,
             allocation.state AS allocation_state
      FROM hosted_agent_patch_applications AS application
      JOIN hosted_agent_operations AS operation USING (operation, idempotency_key, tenant_id)
      JOIN hosted_agent_operation_allocations AS allocation
        ON allocation.allocation_id = application.rollback_allocation_id
      WHERE application.application_id = $1
    `, [seeded.application.applicationId])
    assert.deepEqual(graph.rows[0], {
      phase: 'rolled_back', operation_state: 'failed_terminal', allocation_state: 'reclaimed',
    })
    assert.equal((await context.provider.listSnapshots({
      name: patchApplyProviderSnapshotName('rollback', seeded.fence),
    })).length, 0)
    const unrelated = await context.pools[0].query<{ generation: string; worker_id: string }>(`
      SELECT generation::text, worker_id FROM hosted_agent_operations
      WHERE operation = 'checkpoint' AND idempotency_key = $1
    `, [checkpointIdentity.idempotencyKey])
    assert.deepEqual(unrelated.rows[0], { generation: '0', worker_id: 'unrelated-worker' })
  }, 500)

live('reclaims a rollback snapshot created before its allocation was journaled', false,
  async context => {
    const seeded = await seedInterruptedApplication(
      context, 'apply-stale-unledgered-rollback', 'planned')
    const orphan = await context.provider.snapshot(context.targetSandboxId,
      { name: patchApplyProviderSnapshotName('rollback', seeded.fence) })
    assert.equal(context.provider.snapshots.has(orphan), true)
    const result = await reconcileInterrupted(context)
    assert.deepEqual({ failed: result.operationsFailed, pending: result.allocationsPending },
      { failed: 1, pending: 0 })
    assert.equal(context.provider.snapshots.has(orphan), false)
    const graph = await context.pools[0].query<{ phase: string; state: string }>(`
      SELECT application.phase, operation.state
      FROM hosted_agent_patch_applications AS application
      JOIN hosted_agent_operations AS operation USING (operation, idempotency_key, tenant_id)
      WHERE application.application_id = $1
    `, [seeded.application.applicationId])
    assert.deepEqual(graph.rows[0], { phase: 'failed', state: 'failed_terminal' })
  })

live('retries cleanup after restoring an ambiguous swap-started provider outcome', false,
  async context => {
    const seeded = await seedInterruptedApplication(
      context, 'apply-stale-swap-started', 'swap_started', { mutateAfterSwapStarted: true })
    assert.notDeepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
      context.targetArchive)
    context.provider.failAt = 'deleteSnapshot'
    const first = await reconcileInterrupted(context)
    assert.deepEqual({ failed: first.operationsFailed, pending: first.allocationsPending },
      { failed: 0, pending: 1 })
    assert.deepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
      context.targetArchive)
    assert.equal((await new PostgresPatchApplicationRepository(
      context.pools[0]).getForOperation(seeded.fence))?.phase, 'rolled_back')
    context.provider.failAt = undefined
    const second = await reconcileInterrupted(context)
    assert.deepEqual({ failed: second.operationsFailed, pending: second.allocationsPending },
      { failed: 1, pending: 0 })
    const allocations = await context.journals[1].listAllocations(seeded.fence)
    assert.equal(allocations.every(value => value.state === 'reclaimed'), true)
  })

live('reconciles an ambiguous completed swap, staged objects, and unledgered result snapshot', false,
  async context => {
    const seeded = await seedInterruptedApplication(context, 'apply-stale-swapped', 'swapped', {
      resultSnapshot: 'unledgered', prepareWorkspace: true,
    })
    assert.notDeepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
      context.targetArchive)
    const beforePreparation = await context.preparations[0].getForOperation(seeded.fence)
    assert.equal(beforePreparation?.state, 'prepared')
    const result = await reconcileInterrupted(context)
    assert.equal(result.operationsFailed, 1)
    assert.equal(result.allocationsPending, 0)
    assert.ok(result.allocationsReclaimed >= 4)
    assert.deepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
      context.targetArchive)
    assert.equal((await context.preparations[1].getForOperation(seeded.fence))?.state,
      'reclaimed')
    assert.equal((await context.provider.listSnapshots({
      name: patchApplyProviderSnapshotName('result', seeded.fence),
    })).length, 0)
    const final = await context.journals[1].listAllocations(seeded.fence)
    assert.ok(final.length > 1)
    assert.equal(final.every(value => value.state === 'reclaimed'), true)
  })

live('reconciles checkpoint commit before response without rolling back the durable result', false,
  async context => {
    const prefixIdentity = {
      operation: 'patch_export', idempotencyKey: 'allocation-sequence-prefix', tenantId,
    }
    const prefix = await context.journals[0].claimOperation({
      ...prefixIdentity, requestHash: canonicalRequestHash(prefixIdentity), workerId: 'prefix-worker',
    })
    assert.equal(prefix.kind, 'claimed')
    if (prefix.kind !== 'claimed') return
    for (let index = 0; index < 5; index++) {
      const allocation = await context.journals[0].recordAllocation(
        prefixIdentity, prefix.generation, 'prefix-worker', {
          kind: 'object', resourceId: `prefix-object-${index}`,
        })
      await context.journals[0].updateAllocationState(
        prefixIdentity, prefix.generation, 'prefix-worker', allocation.allocationId, 'reclaimed')
    }
    await context.journals[0].failOperation(
      prefixIdentity, prefix.generation, 'prefix-worker', 'test_complete', 'test prefix complete')
    const seeded = await seedInterruptedApplication(
      context, 'apply-stale-checkpointed', 'checkpointed')
    assert.ok(seeded.resultProviderSnapshotId)
    const result = await reconcileInterrupted(context)
    assert.deepEqual({ claimed: result.operationsClaimed, completed: result.operationsCompleted,
      failed: result.operationsFailed, pending: result.allocationsPending },
    { claimed: 1, completed: 1, failed: 0, pending: 0 })
    assert.deepEqual(context.provider.sandboxes.get(context.targetSandboxId)!.bytes,
      seeded.resultArchive)
    const lease = await context.states[1].getLease(tenantId, context.targetLeaseId)
    assert.equal(lease?.latestSnapshotId, seeded.application.resultSnapshotId)
    assert.equal(context.provider.snapshots.has(seeded.resultProviderSnapshotId!), true)
    assert.equal((await context.provider.listSnapshots({
      name: patchApplyProviderSnapshotName('rollback', seeded.fence),
    })).length, 0)
    const replay = await context.coordinators[0].applyPatch({
      targetLeaseId: context.targetLeaseId, artifactId: context.artifactId,
      idempotencyKey: 'apply-stale-checkpointed',
    })
    assert.deepEqual(replay, { type: 'applied', checkpoint: {
      snapshotId: seeded.application.resultSnapshotId,
    } })
  })
