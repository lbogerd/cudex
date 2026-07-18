import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Header, type HeaderData } from 'tar'
import { captureArchiveManifest, defaultArchiveManifestLimits, type ArchiveManifestLimits } from '../src/archive-manifest.js'
import type { ObjectStore } from '../src/blob-store.js'
import { canonicalJson } from '../src/workspace-manifest.js'

interface TarEntry {
  path: string
  type: NonNullable<HeaderData['type']>
  mode?: number
  body?: Uint8Array
  linkpath?: string
}

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>()
  async put(bytes: Uint8Array): Promise<string> {
    const id = createHash('sha256').update(bytes).digest('hex')
    this.objects.set(id, Uint8Array.from(bytes))
    return id
  }
  async get(id: string): Promise<Uint8Array> {
    const value = this.objects.get(id)
    if (!value) throw new Error('missing object')
    return Uint8Array.from(value)
  }
  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'memory', storageKey: id }
  }
}

function tar(entries: TarEntry[], end = true): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? [])
    const block = Buffer.alloc(512)
    new Header({
      path: entry.path,
      type: entry.type,
      mode: entry.mode ?? (entry.type === 'Directory' ? 0o755 : 0o644),
      size: body.byteLength,
      ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }),
    }).encode(block)
    chunks.push(block, body, Buffer.alloc((512 - body.byteLength % 512) % 512))
  }
  if (end) chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function limits(override: Partial<ArchiveManifestLimits>): ArchiveManifestLimits {
  return { ...defaultArchiveManifestLimits, ...override }
}

function recalculateChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156)
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
}

test('captures binary files, POSIX modes, directories, and safe symlinks without extraction', async () => {
  const binary = Uint8Array.from([0, 255, 1, 128, 10])
  const archive = tar([
    { path: 'roots/', type: 'Directory', mode: 0o755 },
    { path: 'roots/0/', type: 'Directory', mode: 0o700 },
    { path: 'roots/0/tool', type: 'File', mode: 0o755, body: binary },
    { path: 'roots/0/link', type: 'SymbolicLink', mode: 0o777, linkpath: 'tool' },
  ])
  const objects = new MemoryObjectStore()
  const captured = await captureArchiveManifest(archive, 'snapshot-immutable', objects)
  const file = captured.manifest.entries.find(entry => entry.path === 'roots/0/tool')

  assert.deepEqual(captured.manifest.entries.map(entry => [entry.path, entry.type, entry.mode]), [
    ['roots', 'directory', 0o755],
    ['roots/0', 'directory', 0o700],
    ['roots/0/link', 'symlink', 0o777],
    ['roots/0/tool', 'file', 0o755],
  ])
  assert.equal(file?.type, 'file')
  assert.equal(file?.type === 'file' ? file.digest : '', `sha256:${createHash('sha256').update(binary).digest('hex')}`)
  assert.equal(captured.totalSizeBytes, binary.byteLength)
  assert.equal(captured.contentObjects.length, 1)
  assert.deepEqual(await objects.get(captured.contentObjects[0]!.objectId), binary)
  assert.equal(Buffer.from(captured.manifestBytes).toString('utf8'), canonicalJson(captured.manifest))
  assert.match(captured.manifestChecksum, /^sha256:[0-9a-f]{64}$/)
})

test('rejects paths outside roots, absolute paths, traversal, duplicates, and conflicting ancestors', async () => {
  const cases = [
    tar([{ path: 'roots/', type: 'Directory' }, { path: 'other/file', type: 'File' }]),
    tar([{ path: 'roots/', type: 'Directory' }, { path: '/roots/file', type: 'File' }]),
    tar([{ path: 'roots/', type: 'Directory' }, { path: 'roots/../escape', type: 'File' }]),
    tar([{ path: 'roots/', type: 'Directory' }, { path: 'roots/file', type: 'File' }, { path: 'roots/file', type: 'File' }]),
    tar([{ path: 'roots/', type: 'Directory' }, { path: 'roots/link', type: 'SymbolicLink', linkpath: 'target' }, { path: 'roots/link/child', type: 'File' }]),
  ]
  for (const archive of cases) await assert.rejects(captureArchiveManifest(archive, 'snapshot', new MemoryObjectStore()))
})

test('rejects hardlinks, devices, FIFO, unknown/socket types, and unsafe symlinks', async () => {
  for (const type of ['Link', 'CharacterDevice', 'BlockDevice', 'FIFO'] as const) {
    const linkpath = type === 'Link' ? 'roots/target' : undefined
    await assert.rejects(captureArchiveManifest(tar([
      { path: 'roots/', type: 'Directory' },
      { path: 'roots/special', type, ...(linkpath ? { linkpath } : {}) },
    ]), 'snapshot', new MemoryObjectStore()), /forbidden/)
  }
  await assert.rejects(captureArchiveManifest(tar([
    { path: 'roots/', type: 'Directory' },
    { path: 'roots/link', type: 'SymbolicLink', linkpath: '../../escape' },
  ]), 'snapshot', new MemoryObjectStore()), /escape/)

  const unknown = tar([{ path: 'roots/', type: 'Directory' }, { path: 'roots/socket', type: 'File' }])
  unknown[512 + 156] = 's'.charCodeAt(0)
  recalculateChecksum(unknown.subarray(512, 1024))
  await assert.rejects(captureArchiveManifest(unknown, 'snapshot', new MemoryObjectStore()), /unknown|unsupported/)
})

test('rejects invalid modes, bad checksums, and truncated file bodies', async () => {
  const invalidMode = tar([{ path: 'roots/', type: 'Directory' }, { path: 'roots/file', type: 'File' }])
  invalidMode.fill('z'.charCodeAt(0), 512 + 100, 512 + 108)
  recalculateChecksum(invalidMode.subarray(512, 1024))
  await assert.rejects(captureArchiveManifest(invalidMode, 'snapshot', new MemoryObjectStore()), /mode/)

  const badChecksum = tar([{ path: 'roots/', type: 'Directory' }])
  badChecksum[0] = badChecksum[0]! ^ 1
  await assert.rejects(captureArchiveManifest(badChecksum, 'snapshot', new MemoryObjectStore()), /checksum|archive/i)

  const truncated = tar([{ path: 'roots/', type: 'Directory' }, { path: 'roots/file', type: 'File', body: Buffer.from('content') }], false)
  await assert.rejects(captureArchiveManifest(truncated.subarray(0, 512 + 512 + 3), 'snapshot', new MemoryObjectStore()), /truncated|declared/i)
})

test('enforces archive, entry, file, per-file, total, meta, and extraction-ratio quotas', async () => {
  const oneFile = tar([{ path: 'roots/', type: 'Directory' }, { path: 'roots/file', type: 'File', body: Buffer.from('1234') }])
  await assert.rejects(captureArchiveManifest(oneFile, 'snapshot', new MemoryObjectStore(), limits({ maxArchiveBytes: 1 })), /archive byte/)
  await assert.rejects(captureArchiveManifest(oneFile, 'snapshot', new MemoryObjectStore(), limits({ maxEntries: 1 })), /entry limit/)
  await assert.rejects(captureArchiveManifest(oneFile, 'snapshot', new MemoryObjectStore(), limits({ maxFiles: 0 })), /file limit/)
  await assert.rejects(captureArchiveManifest(oneFile, 'snapshot', new MemoryObjectStore(), limits({ maxFileBytes: 3 })), /per-file/)
  await assert.rejects(captureArchiveManifest(oneFile, 'snapshot', new MemoryObjectStore(), limits({ maxTotalBytes: 3 })), /total byte/)
  await assert.rejects(captureArchiveManifest(oneFile, 'snapshot', new MemoryObjectStore(), limits({ maxExtractionRatio: 0.001 })), /ratio/)

  const oversizedMeta = tar([
    { path: 'PaxHeader', type: 'ExtendedHeader', body: Buffer.alloc(17, 'x') },
    { path: 'roots/', type: 'Directory' },
  ])
  await assert.rejects(captureArchiveManifest(oversizedMeta, 'snapshot', new MemoryObjectStore(), limits({ maxMetaEntryBytes: 16 })), /unknown|meta|archive/i)
})

test('requires the explicit roots directory and verifies content-addressed object IDs', async () => {
  await assert.rejects(captureArchiveManifest(tar([{ path: 'roots/file', type: 'File' }]), 'snapshot', new MemoryObjectStore()), /roots directory/)
  const dishonest: ObjectStore = {
    put: async () => 'not-a-digest', get: async () => new Uint8Array(),
    location: id => ({ storageBucket: 'memory', storageKey: id }),
  }
  await assert.rejects(captureArchiveManifest(tar([
    { path: 'roots/', type: 'Directory' }, { path: 'roots/file', type: 'File', body: Buffer.from('x') },
  ]), 'snapshot', dishonest), /non-content-addressed/)
})
