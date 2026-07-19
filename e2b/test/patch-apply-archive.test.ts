import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { captureArchiveManifest, defaultArchiveManifestLimits } from '../src/archive-manifest.js'
import type { ObjectStore } from '../src/blob-store.js'
import {
  buildPatchApplyArchive,
  type PatchApplyArchiveContent,
} from '../src/patch-apply-archive.js'
import { createWorkspaceManifest, type WorkspaceEntry } from '../src/workspace-manifest.js'

const checksum = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const file = (path: string, bytes: Uint8Array, mode = 0o644): WorkspaceEntry => ({
  path, type: 'file', mode, digest: checksum(bytes), sizeBytes: bytes.byteLength,
})
const content = (path: string, objectId: string, bytes: Uint8Array): PatchApplyArchiveContent => ({
  path, objectId, checksum: checksum(bytes), sizeBytes: bytes.byteLength, bytes,
})

class MemoryObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>()
  async put(bytes: Uint8Array): Promise<string> {
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
    return { storageBucket: 'memory', storageKey: id }
  }
}

test('builds a deterministic Linux tar that exactly round-trips modes, binary, links, and PAX paths', async () => {
  const binary = Uint8Array.from([0, 255, 1, 128, 10])
  const empty = new Uint8Array()
  const longName = `file-${'é'.repeat(140)}`
  const longPath = `roots/0/${longName}`
  const manifest = createWorkspaceManifest('snapshot-result', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/0', type: 'directory', mode: 0o700 },
    file('roots/0/tool', binary, 0o755), file(longPath, empty),
    { path: 'roots/0/link', type: 'symlink', mode: 0o777, linkTarget: longName },
  ])
  const values = [content('roots/0/tool', 'object-binary', binary),
    content(longPath, 'object-empty', empty)]
  const first = await buildPatchApplyArchive(manifest, values)
  const second = await buildPatchApplyArchive(manifest, values)
  assert.deepEqual(first, second)
  assert.equal(first.byteLength % 512, 0)

  const objects = new MemoryObjects()
  const captured = await captureArchiveManifest(first, manifest.identity, objects)
  assert.deepEqual(captured.manifest, manifest)
  assert.deepEqual(await objects.get(checksum(binary).slice('sha256:'.length)), binary)
  assert.deepEqual(await objects.get(checksum(empty).slice('sha256:'.length)), empty)
})

test('requires one exact verified body for every and only manifest file', async () => {
  const bytes = new TextEncoder().encode('content')
  const manifest = createWorkspaceManifest('snapshot-result', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/0', type: 'directory', mode: 0o755 },
    file('roots/0/file', bytes),
  ])
  const valid = content('roots/0/file', 'object-file', bytes)
  await assert.rejects(buildPatchApplyArchive(manifest, []), /incomplete/)
  await assert.rejects(buildPatchApplyArchive(manifest, [valid, valid]), /duplicated/)
  await assert.rejects(buildPatchApplyArchive(manifest, [
    valid, content('roots/0/extra', 'object-extra', bytes),
  ]), /incomplete/)
  await assert.rejects(buildPatchApplyArchive(manifest, [{ ...valid, sizeBytes: bytes.byteLength + 1 }]),
    /bytes do not match/)
  await assert.rejects(buildPatchApplyArchive(manifest, [{ ...valid, checksum: `sha256:${'0'.repeat(64)}` }]),
    /bytes do not match/)
  await assert.rejects(buildPatchApplyArchive(manifest, [{ ...valid, path: 'roots/0/other' }]),
    /incomplete/)
})

test('rejects inconsistent reused object identities and archive quota overflow', async () => {
  const first = new TextEncoder().encode('first')
  const second = new TextEncoder().encode('second')
  const manifest = createWorkspaceManifest('snapshot-result', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/0', type: 'directory', mode: 0o755 },
    file('roots/0/first', first), file('roots/0/second', second),
  ])
  await assert.rejects(buildPatchApplyArchive(manifest, [
    content('roots/0/first', 'same-object', first),
    content('roots/0/second', 'same-object', second),
  ]), /object identity is inconsistent/)
  await assert.rejects(buildPatchApplyArchive(manifest, [
    content('roots/0/first', 'first-object', first),
    content('roots/0/second', 'second-object', second),
  ], { ...defaultArchiveManifestLimits, maxArchiveBytes: 1024 }), /archive byte limit/)
})
