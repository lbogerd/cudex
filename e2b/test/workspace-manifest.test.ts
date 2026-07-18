import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkspaceManifestError,
  boundedRejectionReason,
  canonicalJson,
  collectThreeWayConflicts,
  createWorkspaceManifest,
  defaultWorkspaceManifestLimits,
  diffWorkspaceManifests,
  validateSymlinkTarget,
  validateWorkspacePath,
  workspaceManifestChecksum,
  type WorkspaceEntry,
  type WorkspaceManifestLimits,
} from '../src/workspace-manifest.js'

const digest = (hex: string) => `sha256:${hex.repeat(64)}`
const file = (path: string, contentDigest = digest('a'), mode = 0o644, sizeBytes = 1): WorkspaceEntry => ({ path, type: 'file', mode, digest: contentDigest, sizeBytes })
const manifest = (identity: string, entries: WorkspaceEntry[]) => createWorkspaceManifest(identity, entries)
const limits = (override: Partial<WorkspaceManifestLimits>): WorkspaceManifestLimits => ({ ...defaultWorkspaceManifestLimits, ...override })

test('manifest is sorted and canonical checksum is independent of input and object key order', () => {
  const first = manifest('snapshot-1', [
    { path: 'roots/0/project/link', type: 'symlink', mode: 0o777, linkTarget: 'bin/tool' },
    file('roots/0/project/bin/tool', digest('b'), 0o755, 3),
    { path: 'roots/0/project/bin', type: 'directory', mode: 0o755 },
  ])
  const second = manifest('snapshot-1', [...first.entries].reverse())
  assert.deepEqual(first.entries.map(entry => entry.path), ['roots/0/project/bin', 'roots/0/project/bin/tool', 'roots/0/project/link'])
  assert.equal(workspaceManifestChecksum(first), workspaceManifestChecksum(second))
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}')
})

test('diff covers binary digest, executable mode, directory, symlink, addition, and deletion changes', () => {
  const base = manifest('base', [
    { path: 'roots/0/project/dir', type: 'directory', mode: 0o755 },
    file('roots/0/project/binary', digest('a'), 0o644, 4),
    file('roots/0/project/deleted', digest('b')),
    { path: 'roots/0/project/link', type: 'symlink', mode: 0o777, linkTarget: 'binary' },
  ])
  const current = manifest('current', [
    { path: 'roots/0/project/dir', type: 'directory', mode: 0o700 },
    file('roots/0/project/binary', digest('c'), 0o755, 4),
    file('roots/0/project/added', digest('d')),
    { path: 'roots/0/project/link', type: 'symlink', mode: 0o777, linkTarget: 'added' },
  ])
  const changes = diffWorkspaceManifests(base, current)
  assert.deepEqual(changes.map(change => change.path), [
    'roots/0/project/added', 'roots/0/project/binary', 'roots/0/project/deleted', 'roots/0/project/dir', 'roots/0/project/link',
  ])
  assert.equal(changes.find(change => change.path.endsWith('/added'))!.base, null)
  assert.equal(changes.find(change => change.path.endsWith('/deleted'))!.current, null)
})

test('three-way conflicts use exact base/current rule and do not conflict when target already equals current', () => {
  const base = manifest('base', [file('roots/0/a', digest('a')), file('roots/0/b', digest('a')), file('roots/0/c', digest('a'))])
  const current = manifest('current', [file('roots/0/a', digest('b')), file('roots/0/b', digest('b')), file('roots/0/c', digest('b'))])
  const target = manifest('target', [
    file('roots/0/a', digest('a')),
    file('roots/0/b', digest('b')),
    file('roots/0/c', digest('c')),
  ])
  assert.deepEqual(collectThreeWayConflicts(diffWorkspaceManifests(base, current), target), {
    paths: ['file:///workspace/roots/0/c'], total: 1, truncated: false,
  })
})

test('conflicts are sorted, URI encoded, and capped only after all are counted', () => {
  const baseEntries: WorkspaceEntry[] = []
  const currentEntries: WorkspaceEntry[] = []
  const targetEntries: WorkspaceEntry[] = []
  for (let index = 0; index < 300; index += 1) {
    const path = `roots/0/conflict ${String(index).padStart(3, '0')}`
    baseEntries.push(file(path, digest('a')))
    currentEntries.push(file(path, digest('b')))
    targetEntries.push(file(path, digest('c')))
  }
  const result = collectThreeWayConflicts(diffWorkspaceManifests(manifest('base', baseEntries), manifest('current', currentEntries)), manifest('target', targetEntries))
  assert.equal(result.paths.length, 256)
  assert.equal(result.total, 300)
  assert.equal(result.truncated, true)
  assert.equal(result.paths[0], 'file:///workspace/roots/0/conflict%20000')
})

test('canonical paths and safe relative symlinks reject traversal and ambiguity', () => {
  assert.equal(validateWorkspacePath('roots/0/project/file'), 'roots/0/project/file')
  assert.equal(validateSymlinkTarget('roots/0/project/dir/link', '../file'), '../file')
  for (const path of ['', '/absolute', 'roots//file', 'roots/./file', 'roots/../file', 'roots\\file', 'roots/file/']) {
    assert.throws(() => validateWorkspacePath(path), WorkspaceManifestError)
  }
  for (const target of ['', '/etc/passwd', '../../../escape', './ambiguous', 'dir//file', 'dir\\file']) {
    assert.throws(() => validateSymlinkTarget('roots/link', target), WorkspaceManifestError)
  }
})

test('entry, file, byte, path, depth, link, manifest, and change quotas are enforced', () => {
  assert.throws(() => createWorkspaceManifest('id', [file('a'), file('b')], limits({ maxEntries: 1 })), /entry limit/)
  assert.throws(() => createWorkspaceManifest('id', [file('a')], limits({ maxFiles: 0 })), /file limit/)
  assert.throws(() => createWorkspaceManifest('id', [file('a', digest('a'), 0o644, 2)], limits({ maxFileBytes: 1 })), /per-file/)
  assert.throws(() => createWorkspaceManifest('id', [file('a'), file('b')], limits({ maxTotalBytes: 1 })), /total byte/)
  assert.throws(() => createWorkspaceManifest('id', [file('long')], limits({ maxPathBytes: 3 })), /path byte/)
  assert.throws(() => createWorkspaceManifest('id', [file('a/b')], limits({ maxPathDepth: 1 })), /path depth/)
  assert.throws(() => createWorkspaceManifest('id', [{ path: 'a/link', type: 'symlink', mode: 0o777, linkTarget: 'long' }], limits({ maxLinkTargetBytes: 3 })), /link target byte/)
  assert.throws(() => createWorkspaceManifest('id', [file('a')], limits({ maxManifestBytes: 1 })), /manifest byte/)
  assert.throws(() => diffWorkspaceManifests(manifest('base', []), manifest('current', [file('a')]), limits({ maxChanges: 0 })), /change limit/)
})

test('invalid modes, digests, duplicate paths, and unsupported file sizes are rejected', () => {
  assert.throws(() => manifest('id', [file('a', 'sha256:nope')]), /digest/)
  assert.throws(() => manifest('id', [file('a', digest('a'), 0o10000)]), /mode/)
  assert.throws(() => manifest('id', [file('a'), file('a')]), /duplicate/)
  assert.throws(() => manifest('id', [file('a', digest('a'), 0o644, -1)]), /file size/)
})

test('bounded rejection reason respects UTF-8 bytes without splitting code points', () => {
  assert.equal(boundedRejectionReason('plain', 5), 'plain')
  assert.equal(boundedRejectionReason('a🙂b', 5), 'a🙂')
  assert.ok(Buffer.byteLength(boundedRejectionReason('🙂'.repeat(2_000))) <= 4_096)
})
