import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { Pool } from 'pg'
import type { ObjectStore } from '../src/blob-store.js'
import { runMigrations } from '../src/migrate.js'
import { parsePatchArtifact } from '../src/patch-artifact.js'
import { PostgresPatchArtifactRepository } from '../src/postgres-artifacts.js'
import {
  deterministicPatchExportId,
  PostgresPatchExportCoordinator,
} from '../src/postgres-patch-export.js'
import { PostgresPatchExportSourceResolver } from '../src/postgres-patch-export-source.js'
import { PostgresObjectReclaimer } from '../src/postgres-object-reclaimer.js'
import { PostgresReconciler } from '../src/postgres-reconciler.js'
import { PostgresDurableState, type StoredObject } from '../src/postgres-state.js'
import {
  type OperationClaim,
  type OperationClaimInput,
  canonicalRequestHash,
  PostgresJournal,
} from '../src/postgres-store.js'
import { ServiceError, type PatchExportRequest } from '../src/types.js'
import {
  canonicalJson,
  createWorkspaceManifest,
  type WorkspaceEntry,
  type WorkspaceManifest,
} from '../src/workspace-manifest.js'
import { FakeProvider } from './fake-provider.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const tenantId = 'tenant-1'
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const checksum = (bytes: Uint8Array): string => `sha256:${sha256(bytes)}`
const encoded = (value: string): Uint8Array => new TextEncoder().encode(value)

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve }
}

class TrackingObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  puts = 0
  deletes = 0
  failNextPut = false
  private nextGate: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined

  gateNextPut(): { entered: Promise<void>; release(): void } {
    const gate = { entered: deferred(), released: deferred() }
    this.nextGate = gate
    return { entered: gate.entered.promise, release: () => gate.released.resolve() }
  }

  async put(bytes: Uint8Array): Promise<string> {
    this.puts++
    if (this.failNextPut) { this.failNextPut = false; throw new Error('injected object put failure') }
    const gate = this.nextGate
    if (gate) { this.nextGate = undefined; gate.entered.resolve(); await gate.released.promise }
    const id = sha256(bytes)
    this.values.set(id, Uint8Array.from(bytes))
    return id
  }

  async get(id: string): Promise<Uint8Array> {
    const value = this.values.get(id)
    if (!value) throw new Error('missing object')
    return Uint8Array.from(value)
  }

  async delete(id: string): Promise<void> { this.deletes++; this.values.delete(id) }

  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'patch-export-test', storageKey: `v1/sha256/${id.slice(0, 2)}/${id}` }
  }
}

class ObservedJournal extends PostgresJournal {
  private readonly observed = deferred()
  private failRecoveryClaim = false
  readonly inProgressObserved = this.observed.promise
  throwAfterLeaseCommit = false
  failClaimAfterAmbiguousCommit = false

  override async claimOperation(input: OperationClaimInput): Promise<OperationClaim> {
    if (this.failRecoveryClaim) { this.failRecoveryClaim = false; throw new Error('injected recovery read outage') }
    const claim = await super.claimOperation(input)
    if (claim.kind === 'in_progress') this.observed.resolve()
    return claim
  }

  override async withLeaseLocks<T>(tenant: string, leaseIds: string[],
    fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const result = await super.withLeaseLocks(tenant, leaseIds, fn)
    if (this.throwAfterLeaseCommit) {
      this.throwAfterLeaseCommit = false
      this.failRecoveryClaim = this.failClaimAfterAmbiguousCommit
      throw new Error('injected ambiguous commit acknowledgement')
    }
    return result
  }
}

interface Fixture {
  admin: Pool
  pools: [Pool, Pool]
  states: [PostgresDurableState, PostgresDurableState]
  journals: [ObservedJournal, ObservedJournal]
  artifacts: [PostgresPatchArtifactRepository, PostgresPatchArtifactRepository]
  coordinators: [PostgresPatchExportCoordinator, PostgresPatchExportCoordinator]
  objects: TrackingObjects
  schema: string
  request: PatchExportRequest
  baseManifest: WorkspaceManifest
  currentManifest: WorkspaceManifest
  currentContent: StoredObject
  addedContent: StoredObject
}

const file = (path: string, bytes: Uint8Array, mode = 0o644): WorkspaceEntry => ({
  path, type: 'file', mode, digest: checksum(bytes), sizeBytes: bytes.byteLength,
})

async function register(state: PostgresDurableState, objects: TrackingObjects, objectId: string,
  kind: StoredObject['kind'], bytes: Uint8Array): Promise<StoredObject> {
  const physicalId = await objects.put(bytes)
  const object: StoredObject = {
    objectId, tenantId, kind, ...objects.location(physicalId), checksum: checksum(bytes),
    sizeBytes: bytes.byteLength, state: 'available', expiresAt: null,
  }
  await state.registerObject(object)
  return object
}

async function fixture(): Promise<Fixture> {
  const schema = `hosted_agent_patch_export_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pools = [0, 1].map(() => new Pool({
    connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6,
  })) as [Pool, Pool]
  await runMigrations(pools[0])
  const states = pools.map(pool => new PostgresDurableState(pool)) as [PostgresDurableState, PostgresDurableState]
  const journals = pools.map(pool => new ObservedJournal(pool)) as [ObservedJournal, ObservedJournal]
  const artifacts = pools.map(pool => new PostgresPatchArtifactRepository(pool)) as
    [PostgresPatchArtifactRepository, PostgresPatchArtifactRepository]
  const objects = new TrackingObjects()

  const baseBytes = encoded('base body')
  const currentBytes = encoded('current body')
  const deletedBytes = encoded('deleted body')
  const addedBytes = Uint8Array.from([0, 255, 1, 2])
  const baseManifest = createWorkspaceManifest('snapshot-base', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    file('roots/modified', baseBytes), file('roots/deleted', deletedBytes),
  ])
  const currentManifest = createWorkspaceManifest('snapshot-current', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    file('roots/modified', currentBytes, 0o755), file('roots/added.bin', addedBytes),
  ])
  const archiveBase = await register(states[0], objects, 'archive-base', 'workspace_archive', encoded('archive base'))
  const manifestBase = await register(states[0], objects, 'manifest-base', 'manifest', encoded(canonicalJson(baseManifest)))
  const contentBase = await register(states[0], objects, 'content-base', 'content_blob', baseBytes)
  const contentDeleted = await register(states[0], objects, 'content-deleted', 'content_blob', deletedBytes)
  const archiveCurrent = await register(states[0], objects, 'archive-current', 'workspace_archive', encoded('archive current'))
  const manifestCurrent = await register(states[0], objects, 'manifest-current', 'manifest', encoded(canonicalJson(currentManifest)))
  const currentContent = await register(states[0], objects, 'content-current', 'content_blob', currentBytes)
  const addedContent = await register(states[0], objects, 'content-added', 'content_blob', addedBytes)

  await states[0].createLeaseWithBaseSnapshot({
    leaseId: 'lease-child', environmentId: 'environment-child', tenantId,
    agentId: 'agent-child', ownerAgentId: 'agent-owner', providerSandboxId: 'sandbox-child',
    sandboxTemplate: 'general-v1', cwdUri: 'file:///workspace/roots',
    workspaceRootUris: ['file:///workspace/roots'], toolPolicy: {}, policyVersion: 1,
    baseSnapshot: {
      snapshotId: baseManifest.identity, providerSnapshotId: 'provider-base',
      workspaceArchiveObjectId: archiveBase.objectId, manifestObjectId: manifestBase.objectId,
      manifestChecksum: manifestBase.checksum,
      contentObjectIds: [contentBase.objectId, contentDeleted.objectId],
    },
  })
  await states[0].appendCheckpoint(tenantId, 'lease-child', {
    snapshotId: currentManifest.identity, providerSnapshotId: 'provider-current',
    workspaceArchiveObjectId: archiveCurrent.objectId, manifestObjectId: manifestCurrent.objectId,
    manifestChecksum: manifestCurrent.checksum,
    contentObjectIds: [currentContent.objectId, addedContent.objectId],
  })

  const coordinators = journals.map((journal, index) => new PostgresPatchExportCoordinator(
    journal, states[index]!, new PostgresPatchExportSourceResolver(pools[index]!, objects), artifacts[index]!,
    objects, new PostgresObjectReclaimer(pools[index]!, objects), {
      tenantId, workerId: `patch-export-worker-${index}`, waitTimeoutMs: 5_000,
      heartbeatIntervalMs: 10,
    })) as [PostgresPatchExportCoordinator, PostgresPatchExportCoordinator]
  const request: PatchExportRequest = {
    leaseId: 'lease-child', agentId: 'agent-child', baseSnapshotId: baseManifest.identity,
    idempotencyKey: 'patch-export',
  }
  return { admin, pools, states, journals, artifacts, coordinators, objects, schema, request,
    baseManifest, currentManifest, currentContent, addedContent }
}

async function close(context: Fixture): Promise<void> {
  await Promise.all(context.pools.map(pool => pool.end()))
  await context.admin.query(`DROP SCHEMA ${context.schema} CASCADE`)
  await context.admin.end()
}

const live = (name: string, fn: (context: Fixture) => Promise<void>) => test(name, {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const context = await fixture()
  try { await fn(context) } finally { await close(context) }
})

const serviceFailure = (status: number, message: string) => (error: unknown): boolean =>
  error instanceof ServiceError && error.status === status && error.message === message

live('two replicas export one exact artifact and replay without another put', async context => {
  const baselinePuts = context.objects.puts
  const gate = context.objects.gateNextPut()
  const first = context.coordinators[0].exportPatch(context.request)
  await gate.entered
  const second = context.coordinators[1].exportPatch(context.request)
  await context.journals[1].inProgressObserved
  assert.equal(context.objects.puts, baselinePuts + 1)
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.deepEqual(await context.journals[1].claimStaleOperations(
    new Date(Date.now() - 20), 10, 'premature-patch-export-reconciler',
    tenantId, 'patch_export', 'none'), [])
  gate.release()
  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(left, right)
  assert.equal(left.changedFiles, 3)
  assert.equal(left.sizeBytes, context.currentContent.sizeBytes + context.addedContent.sizeBytes)
  assert.equal(context.objects.puts, baselinePuts + 1)

  const artifactBytes = context.objects.values.get(left.checksum.slice('sha256:'.length))!
  const parsed = parsePatchArtifact(artifactBytes, left.checksum)
  assert.deepEqual(parsed.artifact.changes, [
    { path: 'roots/added.bin', contentObjectId: context.addedContent.objectId },
    { path: 'roots/deleted', contentObjectId: null },
    { path: 'roots/modified', contentObjectId: context.currentContent.objectId },
  ])
  assert.deepEqual(parsed.artifact.baseManifest, context.baseManifest)
  assert.deepEqual(parsed.artifact.currentManifest, context.currentManifest)

  assert.deepEqual(await context.coordinators[1].exportPatch(context.request), left)
  assert.equal(context.objects.puts, baselinePuts + 1)
  const durable = await context.pools[0].query<{
    operation_state: string; artifacts: string; allocations: string; adopted: string; references: string
  }>(`
    SELECT operation.state AS operation_state,
      (SELECT count(*)::text FROM hosted_agent_artifacts) AS artifacts,
      (SELECT count(*)::text FROM hosted_agent_operation_allocations
        WHERE operation = 'patch_export') AS allocations,
      (SELECT count(*)::text FROM hosted_agent_operation_allocations
        WHERE operation = 'patch_export' AND state = 'adopted' AND lease_id = $1) AS adopted,
      (SELECT count(*)::text FROM hosted_agent_object_references
        WHERE reference_kind = 'artifact' AND reference_id = $2) AS references
    FROM hosted_agent_operations AS operation
    WHERE operation.operation = 'patch_export' AND operation.idempotency_key = $3
  `, [context.request.leaseId, left.artifactId, context.request.idempotencyKey])
  assert.deepEqual(durable.rows[0], {
    operation_state: 'succeeded', artifacts: '1', allocations: '1', adopted: '1', references: '5',
  })
})

live('internal root export requires exact source lineage and retains the artifact for its thread', async context => {
  const sourceArchive = await register(context.states[0], context.objects,
    'source-archive-root', 'source_archive', encoded('root source archive'))
  await context.states[0].registerSourceSnapshot({ sourceSnapshotId: 'source-root', tenantId,
    archiveObjectId: sourceArchive.objectId, checksum: sourceArchive.checksum,
    cwdUri: 'file:///workspace/roots', workspaceRootUris: ['file:///workspace/roots'],
    state: 'available', expiresAt: new Date(Date.now() + 60_000) })
  await context.pools[0].query(`UPDATE hosted_agent_leases
    SET owner_agent_id = NULL, owner_lease_id = NULL, source_snapshot_id = $2
    WHERE tenant_id = $1 AND lease_id = 'lease-child'`, [tenantId, 'source-root'])
  const publicRequest = { ...context.request, idempotencyKey: 'root-public-rejected' }
  await assert.rejects(context.coordinators[0].exportPatch(publicRequest),
    serviceFailure(409, 'lease cannot export a patch'))
  await assert.rejects(context.coordinators[0].exportRootPatch(
    { ...context.request, idempotencyKey: 'root-wrong-source' }, 'wrong-source'),
    serviceFailure(409, 'lease cannot export a patch'))
  const rootRequest = { ...context.request, idempotencyKey: 'root-internal-export' }
  const exported = await context.coordinators[0].exportRootPatch(rootRequest, 'source-root')
  assert.equal(exported.agentId, rootRequest.agentId)
  const references = await context.pools[0].query<{ reference_kind: string; reference_id: string }>(`
    SELECT reference_kind, reference_id FROM hosted_agent_artifact_references
    WHERE artifact_id = $1 ORDER BY reference_kind, reference_id
  `, [exported.artifactId])
  assert.deepEqual(references.rows, [{ reference_kind: 'codex_thread', reference_id: rootRequest.agentId }])
  assert.equal((await context.artifacts[1].getAuthorized(
    tenantId, exported.artifactId, rootRequest.agentId))?.ownerAgentId, null)
})

live('stale reconciliation reconstructs an adopted patch artifact logical response exactly', async context => {
  const expected = await context.coordinators[0].exportPatch(context.request)
  const deletes = context.objects.deletes
  await context.pools[0].query(`
    UPDATE hosted_agent_operations SET state = 'in_progress', logical_response = NULL,
        completed_at = NULL, worker_id = 'dead-worker', heartbeat_at = now() - interval '1 hour'
    WHERE operation = 'patch_export' AND idempotency_key = $1 AND tenant_id = $2
  `, [context.request.idempotencyKey, tenantId])
  const result = await new PostgresReconciler(
    context.journals[1], context.states[1], new FakeProvider(), {
      managedBy: 'cudex', tenantId, workerId: 'patch-export-reconciler', staleAfterMs: 1,
      patchExportRecovery: {
        artifacts: context.artifacts[1],
        reclaimer: new PostgresObjectReclaimer(context.pools[1], context.objects),
      },
    },
  ).runOnce()
  assert.equal(result.operationsClaimed, 1)
  assert.equal(result.allocationsPending, 0)
  assert.equal(context.objects.deletes, deletes)
  const replay = await context.journals[0].claimOperation({
    operation: 'patch_export', idempotencyKey: context.request.idempotencyKey, tenantId,
    requestHash: canonicalRequestHash(context.request), workerId: 'observer',
    primaryLeaseId: context.request.leaseId,
  })
  assert.equal(replay.kind, 'succeeded')
  if (replay.kind === 'succeeded') assert.deepEqual(replay.response, expected)
})

live('stale reconciliation reclaims an unadopted patch object before terminal failure', async context => {
  const request = { ...context.request, idempotencyKey: 'abandoned-patch-export' }
  const identity = { operation: 'patch_export', idempotencyKey: request.idempotencyKey, tenantId }
  const claim = await context.journals[0].claimOperation({
    ...identity, requestHash: canonicalRequestHash(request), workerId: 'dead-worker',
    primaryLeaseId: request.leaseId,
  })
  assert.equal(claim.kind, 'claimed')
  if (claim.kind !== 'claimed') return
  const bytes = encoded('abandoned patch artifact')
  const physicalId = await context.objects.put(bytes)
  const objectId = deterministicPatchExportId('object', identity, checksum(bytes))
  await context.states[0].registerObject({
    objectId, tenantId, kind: 'patch_artifact', ...context.objects.location(physicalId),
    checksum: checksum(bytes), sizeBytes: bytes.byteLength, state: 'available', expiresAt: null,
  })
  await context.journals[0].recordAllocation(identity, claim.generation, 'dead-worker', {
    kind: 'object', resourceId: objectId,
    metadata: {
      artifactId: deterministicPatchExportId('artifact', identity), checksum: checksum(bytes),
    },
  })
  await context.pools[0].query(`
    UPDATE hosted_agent_operations SET heartbeat_at = now() - interval '1 hour'
    WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
  `, [identity.operation, identity.idempotencyKey, identity.tenantId])
  const deletes = context.objects.deletes
  const result = await new PostgresReconciler(
    context.journals[1], context.states[1], new FakeProvider(), {
      managedBy: 'cudex', tenantId, workerId: 'patch-export-reconciler', staleAfterMs: 1,
      patchExportRecovery: {
        artifacts: context.artifacts[1],
        reclaimer: new PostgresObjectReclaimer(context.pools[1], context.objects),
      },
    },
  ).runOnce()
  assert.equal(result.operationsClaimed, 1)
  assert.equal(result.allocationsReclaimed, 1)
  assert.equal(result.allocationsPending, 0)
  assert.equal(context.objects.deletes, deletes + 1)
  assert.equal(context.objects.values.has(physicalId), false)
  const allocations = await context.journals[0].listAllocations(identity)
  assert.equal(allocations[0]!.state, 'reclaimed')
  const replay = await context.journals[0].claimOperation({
    ...identity, requestHash: canonicalRequestHash(request), workerId: 'observer',
  })
  assert.equal(replay.kind, 'failed_terminal')
  if (replay.kind === 'failed_terminal') {
    assert.equal(replay.errorCode, 'reconciled_abandoned')
  }
  assert.equal(await context.journals[0].heartbeatOperation(
    identity, claim.generation, 'dead-worker'), false)
})

live('stale reconciliation never deletes an adopted patch object without its exact artifact', async context => {
  const request = { ...context.request, idempotencyKey: 'incomplete-adopted-patch-export' }
  const identity = { operation: 'patch_export', idempotencyKey: request.idempotencyKey, tenantId }
  const claim = await context.journals[0].claimOperation({
    ...identity, requestHash: canonicalRequestHash(request), workerId: 'dead-worker',
    primaryLeaseId: request.leaseId,
  })
  assert.equal(claim.kind, 'claimed')
  if (claim.kind !== 'claimed') return
  const bytes = encoded('adopted patch object without artifact')
  const physicalId = await context.objects.put(bytes)
  const objectId = deterministicPatchExportId('object', identity, checksum(bytes))
  await context.states[0].registerObject({
    objectId, tenantId, kind: 'patch_artifact', ...context.objects.location(physicalId),
    checksum: checksum(bytes), sizeBytes: bytes.byteLength, state: 'available', expiresAt: null,
  })
  const allocation = await context.journals[0].recordAllocation(
    identity, claim.generation, 'dead-worker', {
      kind: 'object', resourceId: objectId,
      metadata: {
        artifactId: deterministicPatchExportId('artifact', identity), checksum: checksum(bytes),
      },
    })
  await context.journals[0].bindLeaseAndAdoptAllocations(
    identity, claim.generation, 'dead-worker', request.leaseId, [allocation.allocationId])
  await context.pools[0].query(`
    UPDATE hosted_agent_operations SET heartbeat_at = now() - interval '1 hour'
    WHERE operation = $1 AND idempotency_key = $2 AND tenant_id = $3
  `, [identity.operation, identity.idempotencyKey, identity.tenantId])
  const deletes = context.objects.deletes
  const result = await new PostgresReconciler(
    context.journals[1], context.states[1], new FakeProvider(), {
      managedBy: 'cudex', tenantId, workerId: 'patch-export-reconciler', staleAfterMs: 1,
      patchExportRecovery: {
        artifacts: context.artifacts[1],
        reclaimer: new PostgresObjectReclaimer(context.pools[1], context.objects),
      },
    },
  ).runOnce()
  assert.equal(result.operationsClaimed, 1)
  assert.equal(result.allocationsPending, 1)
  assert.equal(context.objects.deletes, deletes)
  assert.equal(context.objects.values.has(physicalId), true)
  const allocations = await context.journals[0].listAllocations(identity)
  assert.equal(allocations[0]!.state, 'adopted')
})

live('authorization and base mismatch fail before artifact publication', async context => {
  const baselinePuts = context.objects.puts
  await assert.rejects(context.coordinators[0].exportPatch({
    ...context.request, agentId: 'agent-other', idempotencyKey: 'patch-export-agent-denied',
  }), serviceFailure(409, 'lease cannot export a patch'))
  await assert.rejects(context.coordinators[0].exportPatch({
    ...context.request, baseSnapshotId: 'snapshot-current', idempotencyKey: 'patch-export-base-denied',
  }), serviceFailure(409, 'lease cannot export a patch'))
  assert.equal(context.objects.puts, baselinePuts)
  const count = await context.pools[0].query<{ artifacts: string; allocations: string }>(`
    SELECT (SELECT count(*)::text FROM hosted_agent_artifacts) AS artifacts,
      (SELECT count(*)::text FROM hosted_agent_operation_allocations) AS allocations
  `)
  assert.deepEqual(count.rows[0], { artifacts: '0', allocations: '0' })
})

live('object-store failure terminalizes without leaking an artifact graph', async context => {
  const baselinePuts = context.objects.puts
  const baselineObjects = context.objects.values.size
  context.objects.failNextPut = true
  await assert.rejects(context.coordinators[0].exportPatch(context.request),
    serviceFailure(503, 'durable patch export failed'))
  assert.equal(context.objects.puts, baselinePuts + 1)
  assert.equal(context.objects.values.size, baselineObjects)
  const graph = await context.pools[0].query<{
    operation_state: string; artifacts: string; allocations: string; patch_objects: string
  }>(`
    SELECT operation.state AS operation_state,
      (SELECT count(*)::text FROM hosted_agent_artifacts) AS artifacts,
      (SELECT count(*)::text FROM hosted_agent_operation_allocations
        WHERE operation = 'patch_export') AS allocations,
      (SELECT count(*)::text FROM hosted_agent_objects WHERE kind = 'patch_artifact') AS patch_objects
    FROM hosted_agent_operations AS operation
    WHERE operation.operation = 'patch_export' AND operation.idempotency_key = $1
  `, [context.request.idempotencyKey])
  assert.deepEqual(graph.rows[0], {
    operation_state: 'failed_terminal', artifacts: '0', allocations: '0', patch_objects: '0',
  })
  await assert.rejects(context.coordinators[1].exportPatch(context.request),
    serviceFailure(503, 'durable patch export failed'))
  assert.equal(context.objects.puts, baselinePuts + 1)
})

live('a final source conflict reclaims its published artifact object before terminal replay', async context => {
  const nextBytes = encoded('next body')
  const nextManifest = createWorkspaceManifest('snapshot-next', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/next', nextBytes),
  ])
  const nextArchive = await register(context.states[0], context.objects,
    'archive-next', 'workspace_archive', encoded('archive next'))
  const nextManifestObject = await register(context.states[0], context.objects,
    'manifest-next', 'manifest', encoded(canonicalJson(nextManifest)))
  const nextContent = await register(context.states[0], context.objects,
    'content-next', 'content_blob', nextBytes)
  const baselineObjects = context.objects.values.size
  const gate = context.objects.gateNextPut()
  const exporting = context.coordinators[0].exportPatch(context.request)
  await gate.entered
  await context.states[1].appendCheckpoint(tenantId, context.request.leaseId, {
    snapshotId: nextManifest.identity, providerSnapshotId: 'provider-next',
    workspaceArchiveObjectId: nextArchive.objectId, manifestObjectId: nextManifestObject.objectId,
    manifestChecksum: nextManifestObject.checksum, contentObjectIds: [nextContent.objectId],
  })
  gate.release()
  await assert.rejects(exporting, serviceFailure(409, 'patch export source changed'))
  assert.equal(context.objects.values.size, baselineObjects)
  assert.equal(context.objects.deletes, 1)
  const graph = await context.pools[0].query<{
    operation_state: string; artifacts: string; allocation_state: string; object_state: string
  }>(`
    SELECT operation.state AS operation_state,
      (SELECT count(*)::text FROM hosted_agent_artifacts) AS artifacts,
      (SELECT state FROM hosted_agent_operation_allocations
        WHERE operation = 'patch_export' AND idempotency_key = operation.idempotency_key) AS allocation_state,
      (SELECT state FROM hosted_agent_objects WHERE kind = 'patch_artifact') AS object_state
    FROM hosted_agent_operations AS operation
    WHERE operation.operation = 'patch_export' AND operation.idempotency_key = $1
  `, [context.request.idempotencyKey])
  assert.equal(graph.rows[0]?.operation_state, 'failed_terminal')
  assert.equal(graph.rows[0]?.artifacts, '0')
  assert.equal(graph.rows[0]?.allocation_state, 'reclaimed')
  assert.equal(graph.rows[0]?.object_state, 'deleted')
})

live('ambiguous final commit preserves durable success for replay without cleanup', async context => {
  const baselinePuts = context.objects.puts
  context.journals[0].throwAfterLeaseCommit = true
  context.journals[0].failClaimAfterAmbiguousCommit = true
  await assert.rejects(context.coordinators[0].exportPatch(context.request),
    serviceFailure(503, 'durable patch export cleanup pending'))
  assert.equal(context.objects.deletes, 0)
  const replay = await context.coordinators[1].exportPatch(context.request)
  assert.equal(replay.artifactId, deterministicPatchExportId('artifact', {
    operation: 'patch_export', idempotencyKey: context.request.idempotencyKey, tenantId,
  }))
  assert.equal(context.objects.puts, baselinePuts + 1)
  const durable = await context.pools[0].query<{ state: string; allocation_state: string }>(`
    SELECT operation.state,
      (SELECT state FROM hosted_agent_operation_allocations
        WHERE operation = 'patch_export' AND idempotency_key = operation.idempotency_key) AS allocation_state
    FROM hosted_agent_operations AS operation
    WHERE operation.operation = 'patch_export' AND operation.idempotency_key = $1
  `, [context.request.idempotencyKey])
  assert.deepEqual(durable.rows[0], { state: 'succeeded', allocation_state: 'adopted' })
})
