import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { projectGitWorkspace } from '../src/git-workspace.js'
import { applyLocalRootPatch } from '../src/local-patch-apply.js'
import { serializePatchArtifact } from '../src/patch-artifact.js'
import { createWorkspaceManifest, type WorkspaceEntry } from '../src/workspace-manifest.js'

const exec = promisify(execFile)
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-local-apply-'))
  await exec('git', ['init', '-q', directory]); await exec('git', ['-C', directory, 'config', 'user.name', 'Test'])
  await exec('git', ['-C', directory, 'config', 'user.email', 'test@example.com'])
  await writeFile(join(directory, '.gitignore'), 'ignored.txt\n')
  await writeFile(join(directory, 'alpha.bin'), Buffer.from([0, 1, 2, 3])); await chmod(join(directory, 'alpha.bin'), 0o644)
  await writeFile(join(directory, 'delete.txt'), 'delete me\n')
  await exec('git', ['-C', directory, 'add', '.gitignore', 'alpha.bin', 'delete.txt'])
  await exec('git', ['-C', directory, 'commit', '-qm', 'base'])
  return directory
}

async function patch(directory: string, mutate: (entries: Map<string, WorkspaceEntry>, prefix: string) => {
  contents: Array<{ path: string; bytes: Uint8Array; objectId: string }>
}) {
  const projection = await projectGitWorkspace(directory)
  const base = createWorkspaceManifest('snapshot-base', projection.captured.manifest.entries)
  const entries = new Map(base.entries.map(entry => [entry.path, entry]))
  const prefix = `roots/0/${basename(directory)}`
  const mutation = mutate(entries, prefix)
  const current = createWorkspaceManifest('snapshot-current', [...entries.values()])
  const serialized = serializePatchArtifact({ agentId: 'root-agent', baseSnapshotId: 'snapshot-base',
    currentSnapshotId: 'snapshot-current', baseManifest: base, currentManifest: current,
    contentObjects: mutation.contents.map(item => ({ path: item.path, objectId: item.objectId })) })
  return { projection, serialized, resolved: { artifactId: 'artifact-root', serialized,
    contentObjects: mutation.contents.map(item => ({ objectId: item.objectId, checksum: sha(item.bytes),
      sizeBytes: item.bytes.byteLength, bytes: item.bytes })), expiresAt: new Date(Date.now() + 60_000) } }
}

test('local root apply changes only the selected files and leaves the Git index untouched', async () => {
  const directory = await repository()
  try {
    const proposed = Buffer.from([9, 8, 7, 6, 5])
    const material = await patch(directory, (entries, prefix) => {
      entries.set(`${prefix}/alpha.bin`, { path: `${prefix}/alpha.bin`, type: 'file', mode: 0o755,
        digest: sha(proposed), sizeBytes: proposed.byteLength })
      entries.delete(`${prefix}/delete.txt`)
      const added = Buffer.from('added\n')
      entries.set(`${prefix}/added.txt`, { path: `${prefix}/added.txt`, type: 'file', mode: 0o644,
        digest: sha(added), sizeBytes: added.byteLength })
      return { contents: [
        { path: `${prefix}/alpha.bin`, bytes: proposed, objectId: 'content-alpha' },
        { path: `${prefix}/added.txt`, bytes: added, objectId: 'content-added' },
      ] }
    })
    await writeFile(join(directory, 'unrelated.txt'), 'local-only\n')
    const result = await applyLocalRootPatch({ runId: '20260720120000-aaaaaaaaaaaa', selectedDirectory: directory,
      immutableBaseManifest: material.projection.captured.manifest, patch: material.resolved })
    assert.deepEqual(result, { type: 'applied', changedFiles: 3 })
    assert.deepEqual(await readFile(join(directory, 'alpha.bin')), proposed)
    assert.equal((await readFile(join(directory, 'added.txt'), 'utf8')), 'added\n')
    await assert.rejects(readFile(join(directory, 'delete.txt')))
    assert.equal(await readFile(join(directory, 'unrelated.txt'), 'utf8'), 'local-only\n')
    await exec('git', ['-C', directory, 'diff', '--cached', '--quiet'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('three-way conflicts and ignored additions leave the checkout unchanged', async () => {
  const directory = await repository()
  try {
    const proposed = Buffer.from('hosted\n')
    const material = await patch(directory, (entries, prefix) => {
      entries.set(`${prefix}/alpha.bin`, { path: `${prefix}/alpha.bin`, type: 'file', mode: 0o644,
        digest: sha(proposed), sizeBytes: proposed.byteLength })
      return { contents: [{ path: `${prefix}/alpha.bin`, bytes: proposed, objectId: 'content-hosted' }] }
    })
    await writeFile(join(directory, 'alpha.bin'), 'local\n')
    const before = await readFile(join(directory, 'alpha.bin'))
    const conflict = await applyLocalRootPatch({ runId: '20260720120000-bbbbbbbbbbbb', selectedDirectory: directory,
      immutableBaseManifest: material.projection.captured.manifest, patch: material.resolved })
    assert.equal(conflict.type, 'conflict'); assert.deepEqual(await readFile(join(directory, 'alpha.bin')), before)

    await writeFile(join(directory, 'alpha.bin'), Buffer.from([0, 1, 2, 3]))
    const ignoredBytes = Buffer.from('ignored\n')
    const ignored = await patch(directory, (entries, prefix) => {
      entries.set(`${prefix}/ignored.txt`, { path: `${prefix}/ignored.txt`, type: 'file', mode: 0o644,
        digest: sha(ignoredBytes), sizeBytes: ignoredBytes.byteLength })
      return { contents: [{ path: `${prefix}/ignored.txt`, bytes: ignoredBytes, objectId: 'content-ignored' }] }
    })
    const rejected = await applyLocalRootPatch({ runId: '20260720120000-cccccccccccc', selectedDirectory: directory,
      immutableBaseManifest: ignored.projection.captured.manifest, patch: ignored.resolved })
    assert.deepEqual(rejected, { type: 'failed', reason: 'hosted patch contains an ignored local addition' })
    await assert.rejects(readFile(join(directory, 'ignored.txt')))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('an injected apply failure rolls every mutation back and removes its journal', async () => {
  const directory = await repository()
  try {
    const proposed = Buffer.from('replacement\n')
    const material = await patch(directory, (entries, prefix) => {
      entries.set(`${prefix}/alpha.bin`, { path: `${prefix}/alpha.bin`, type: 'file', mode: 0o644,
        digest: sha(proposed), sizeBytes: proposed.byteLength })
      return { contents: [{ path: `${prefix}/alpha.bin`, bytes: proposed, objectId: 'content-replacement' }] }
    })
    const before = await readFile(join(directory, 'alpha.bin'))
    const result = await applyLocalRootPatch({ runId: '20260720120000-dddddddddddd', selectedDirectory: directory,
      immutableBaseManifest: material.projection.captured.manifest, patch: material.resolved,
      fault(action) { if (action === 'remove') throw new Error('injected apply fault') } })
    assert.deepEqual(result, { type: 'failed', reason: 'injected apply fault' })
    assert.deepEqual(await readFile(join(directory, 'alpha.bin')), before)
    await assert.rejects(lstat(join(dirname(directory), `.${basename(directory)}.cudex-journal-20260720120000-dddddddddddd`)))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a destructive directory change cannot consume ignored descendants', async () => {
  const directory = await repository()
  try {
    await mkdir(join(directory, 'generated'))
    await writeFile(join(directory, 'generated', 'tracked.txt'), 'tracked\n')
    await writeFile(join(directory, '.gitignore'), 'ignored.txt\ngenerated/secret.txt\n')
    await exec('git', ['-C', directory, 'add', '.gitignore', 'generated/tracked.txt'])
    await exec('git', ['-C', directory, 'commit', '-qm', 'directory base'])
    const material = await patch(directory, (entries, prefix) => {
      entries.delete(`${prefix}/generated/tracked.txt`)
      entries.delete(`${prefix}/generated`)
      return { contents: [] }
    })
    await writeFile(join(directory, 'generated', 'secret.txt'), 'keep me\n')
    const result = await applyLocalRootPatch({ runId: '20260720120000-eeeeeeeeeeee', selectedDirectory: directory,
      immutableBaseManifest: material.projection.captured.manifest, patch: material.resolved })
    assert.equal(result.type, 'failed')
    assert.equal(await readFile(join(directory, 'generated', 'tracked.txt'), 'utf8'), 'tracked\n')
    assert.equal(await readFile(join(directory, 'generated', 'secret.txt'), 'utf8'), 'keep me\n')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('post-image corruption retains a mode-0700 manual recovery journal', async () => {
  const directory = await repository()
  const runId = '20260720120000-ffffffffffff'
  const journal = join(dirname(directory), `.${basename(directory)}.cudex-journal-${runId}`)
  try {
    const proposed = Buffer.from('replacement\n')
    const material = await patch(directory, (entries, prefix) => {
      entries.set(`${prefix}/alpha.bin`, { path: `${prefix}/alpha.bin`, type: 'file', mode: 0o644,
        digest: sha(proposed), sizeBytes: proposed.byteLength })
      return { contents: [{ path: `${prefix}/alpha.bin`, bytes: proposed, objectId: 'content-manual' }] }
    })
    const result = await applyLocalRootPatch({ runId, selectedDirectory: directory,
      immutableBaseManifest: material.projection.captured.manifest, patch: material.resolved,
      async fault(action) {
        if (action === 'construct') {
          await writeFile(join(directory, 'alpha.bin'), 'concurrent post-image\n')
          throw new Error('injected post-image corruption')
        }
      } })
    assert.equal(result.type, 'manual-recovery')
    assert.equal((await lstat(journal)).mode & 0o077, 0)
    assert.equal((await lstat(join(journal, 'journal.json'))).mode & 0o077, 0)
  } finally {
    await rm(journal, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('zero-change root artifacts succeed without touching the checkout', async () => {
  const directory = await repository()
  try {
    const material = await patch(directory, () => ({ contents: [] }))
    const before = await readFile(join(directory, 'alpha.bin'))
    const result = await applyLocalRootPatch({ runId: '20260720120001-aaaaaaaaaaaa',
      selectedDirectory: directory, immutableBaseManifest: material.projection.captured.manifest,
      patch: material.resolved })
    assert.deepEqual(result, { type: 'no-change' })
    assert.deepEqual(await readFile(join(directory, 'alpha.bin')), before)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a concurrent touched-path mutation aborts and preserves both local state and rollback', async () => {
  const directory = await repository()
  try {
    const alpha = Buffer.from('hosted alpha\n'); const deleted = Buffer.from('hosted delete\n')
    const material = await patch(directory, (entries, prefix) => {
      entries.set(`${prefix}/alpha.bin`, { path: `${prefix}/alpha.bin`, type: 'file', mode: 0o644,
        digest: sha(alpha), sizeBytes: alpha.byteLength })
      entries.set(`${prefix}/delete.txt`, { path: `${prefix}/delete.txt`, type: 'file', mode: 0o644,
        digest: sha(deleted), sizeBytes: deleted.byteLength })
      return { contents: [
        { path: `${prefix}/alpha.bin`, bytes: alpha, objectId: 'content-concurrent-alpha' },
        { path: `${prefix}/delete.txt`, bytes: deleted, objectId: 'content-concurrent-delete' },
      ] }
    })
    const originalAlpha = await readFile(join(directory, 'alpha.bin'))
    let injected = false; let concurrentPath = ''
    const result = await applyLocalRootPatch({ runId: '20260720120001-bbbbbbbbbbbb',
      selectedDirectory: directory, immutableBaseManifest: material.projection.captured.manifest,
      patch: material.resolved,
      async fault(action, path) {
        if (action === 'remove' && !injected) {
          injected = true; concurrentPath = path === 'alpha.bin' ? 'delete.txt' : 'alpha.bin'
          await writeFile(join(directory, concurrentPath), 'concurrent coworker edit\n')
        }
      } })
    assert.equal(result.type, 'failed')
    assert.equal(await readFile(join(directory, concurrentPath), 'utf8'), 'concurrent coworker edit\n')
    const untouchedPath = concurrentPath === 'alpha.bin' ? 'delete.txt' : 'alpha.bin'
    if (untouchedPath === 'alpha.bin') assert.deepEqual(await readFile(join(directory, untouchedPath)), originalAlpha)
    else assert.equal(await readFile(join(directory, untouchedPath), 'utf8'), 'delete me\n')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
