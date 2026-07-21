import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import type { ObjectStore } from '../src/blob-store.js'
import { projectGitWorkspace } from '../src/git-workspace.js'
import { applyLocalRootPatch } from '../src/local-patch-apply.js'
import { resolveRootPatchFromStores, type ResolveRootPatchInput } from '../src/local-patch-source.js'
import { runMigrations } from '../src/migrate.js'
import { PostgresDurableState, type StoredObject } from '../src/postgres-state.js'
import { canonicalJson, createWorkspaceManifest, workspaceManifestChecksum,
  type WorkspaceEntry } from '../src/workspace-manifest.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
const exec = promisify(execFile)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const checksum = (bytes: Uint8Array) => `sha256:${hash(bytes)}`

class MemoryObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  async put(bytes: Uint8Array): Promise<string> {
    const id = hash(bytes); this.values.set(id, Uint8Array.from(bytes)); return id
  }
  async get(id: string): Promise<Uint8Array> {
    const value = this.values.get(id); if (!value) throw new Error('missing fake object')
    return Uint8Array.from(value)
  }
  async delete(id: string): Promise<void> { this.values.delete(id) }
  location(id: string) { return { storageBucket: 'fake-provider', storageKey: `sha256/${id}` } }
}

async function stored(state: PostgresDurableState, objects: MemoryObjects, tenantId: string,
  objectId: string, kind: StoredObject['kind'], bytes: Uint8Array): Promise<StoredObject> {
  const physicalId = await objects.put(bytes)
  const value: StoredObject = { objectId, tenantId, kind, ...objects.location(physicalId),
    checksum: checksum(bytes), sizeBytes: bytes.byteLength, state: 'available', expiresAt: null }
  await state.registerObject(value); return value
}

test('fake-provider/fake-TUI acceptance returns an exact root change into git diff', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  const schema = `cudex_feature_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  const directory = await mkdtemp(join(tmpdir(), 'cudex-feature-'))
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
    await runMigrations(pool)
    await exec('git', ['init', '-q', directory]); await exec('git', ['-C', directory, 'config', 'user.name', 'Test'])
    await exec('git', ['-C', directory, 'config', 'user.email', 'test@example.com'])
    const baseBytes = Buffer.from('base from coworker\n'); const proposedBytes = Buffer.from('hosted fake TUI result\n')
    await writeFile(join(directory, 'app.txt'), baseBytes)
    await exec('git', ['-C', directory, 'add', 'app.txt']); await exec('git', ['-C', directory, 'commit', '-qm', 'base'])
    const projection = await projectGitWorkspace(directory)
    const prefix = `roots/0/${basename(directory)}`
    const base = createWorkspaceManifest('root-base', projection.captured.manifest.entries)
    const currentEntries = new Map<string, WorkspaceEntry>(base.entries.map(entry => [entry.path, entry]))
    currentEntries.set(`${prefix}/app.txt`, { path: `${prefix}/app.txt`, type: 'file', mode: 0o644,
      digest: checksum(proposedBytes), sizeBytes: proposedBytes.byteLength })
    const current = createWorkspaceManifest('root-current', [...currentEntries.values()])

    const runId = '20260720130000-123456789abc'; const tenantId = `poc-${runId}`
    const objects = new MemoryObjects(); const state = new PostgresDurableState(pool)
    const sourceArchive = await stored(state, objects, tenantId, 'source-archive', 'source_archive', projection.bytes)
    await state.registerSourceSnapshot({ sourceSnapshotId: 'source-root', tenantId,
      archiveObjectId: sourceArchive.objectId, checksum: sourceArchive.checksum,
      cwdUri: projection.cwd, workspaceRootUris: projection.roots, state: 'available',
      expiresAt: new Date(Date.now() + 60_000) })
    const baseArchive = await stored(state, objects, tenantId, 'archive-base', 'workspace_archive', Buffer.from('base archive'))
    const baseManifest = await stored(state, objects, tenantId, 'manifest-base', 'manifest',
      Buffer.from(canonicalJson(base)))
    const baseContent = await stored(state, objects, tenantId, 'content-base', 'content_blob', baseBytes)
    const currentArchive = await stored(state, objects, tenantId, 'archive-current', 'workspace_archive', Buffer.from('current archive'))
    const currentManifest = await stored(state, objects, tenantId, 'manifest-current', 'manifest',
      Buffer.from(canonicalJson(current)))
    const currentContent = await stored(state, objects, tenantId, 'content-current', 'content_blob', proposedBytes)
    await state.createLeaseWithBaseSnapshot({ leaseId: 'lease-root', environmentId: 'environment-root',
      tenantId, agentId: 'agent-root', ownerAgentId: null, ownerLeaseId: null,
      sourceSnapshotId: 'source-root', providerSandboxId: 'sandbox-root', sandboxTemplate: 'template-pilot',
      cwdUri: projection.cwd, workspaceRootUris: projection.roots, toolPolicy: {}, policyVersion: 1,
      baseSnapshot: { snapshotId: base.identity, providerSnapshotId: 'provider-base',
        workspaceArchiveObjectId: baseArchive.objectId, manifestObjectId: baseManifest.objectId,
        manifestChecksum: workspaceManifestChecksum(base), contentObjectIds: [baseContent.objectId] } })
    await state.appendCheckpoint(tenantId, 'lease-root', { snapshotId: current.identity,
      providerSnapshotId: 'provider-current', workspaceArchiveObjectId: currentArchive.objectId,
      manifestObjectId: currentManifest.objectId, manifestChecksum: workspaceManifestChecksum(current),
      contentObjectIds: [currentContent.objectId] })
    const root = { leaseId: 'lease-root', environmentId: 'environment-root', agentId: 'agent-root',
      ownerAgentId: null, ownerLeaseId: null, providerSandboxId: 'sandbox-root',
      baseSnapshotId: base.identity, latestSnapshotId: current.identity, state: 'active' }
    const resolverInput: ResolveRootPatchInput = { runId, databaseUrl: databaseUrl!,
      sourceSnapshotId: 'source-root', root,
      provider: { apiKey: 'fake', apiUrl: 'https://cube.test', domain: 'cube.test' },
      objectStore: { bucket: 'unused', endpoint: 'http://unused', accessKeyId: 'unused', secretAccessKey: 'unused' } }
    const patch = await resolveRootPatchFromStores(resolverInput, pool, objects, async database => {
      assert.equal(database.leases.filter(lease => lease.ownerLeaseId === null).length, 1)
      return database.leases.some(lease => lease.providerSandboxId === 'sandbox-root')
    })
    const applied = await applyLocalRootPatch({ runId, selectedDirectory: directory,
      immutableBaseManifest: projection.captured.manifest, patch })
    assert.deepEqual(applied, { type: 'applied', changedFiles: 1 })
    assert.equal(await readFile(join(directory, 'app.txt'), 'utf8'), proposedBytes.toString())
    const diff = await exec('git', ['-C', directory, 'diff', '--', 'app.txt'])
    assert.match(diff.stdout, /hosted fake TUI result/u)
    await state.beginRelease(tenantId, 'lease-root'); await state.releaseLease(tenantId, 'lease-root')
    const leases = await pool.query<{ state: string }>('SELECT state FROM hosted_agent_leases WHERE tenant_id = $1', [tenantId])
    assert.deepEqual(leases.rows, [{ state: 'released' }])
  } finally {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
})
