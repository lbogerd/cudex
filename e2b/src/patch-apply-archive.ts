import { createHash } from 'node:crypto'
import { Header, Pax, type HeaderData } from 'tar'
import {
  captureArchiveManifest,
  defaultArchiveManifestLimits,
  type ArchiveManifestLimits,
} from './archive-manifest.js'
import type { ObjectStore } from './blob-store.js'
import {
  WorkspaceManifestError,
  canonicalJson,
  createWorkspaceManifest,
  type WorkspaceManifest,
} from './workspace-manifest.js'

export interface PatchApplyArchiveContent {
  path: string
  objectId: string
  checksum: string
  sizeBytes: number
  bytes: Uint8Array
}

const invalid = (message: string): WorkspaceManifestError =>
  new WorkspaceManifestError('invalid', message)
const quota = (message: string): WorkspaceManifestError =>
  new WorkspaceManifestError('quota', message)

class ValidationObjects implements ObjectStore {
  async put(bytes: Uint8Array): Promise<string> {
    return createHash('sha256').update(bytes).digest('hex')
  }
  async get(): Promise<Uint8Array> { throw new Error('validation store is write-only') }
  async delete(): Promise<void> {}
  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'validation', storageKey: id }
  }
}

function workspaceLimits(limits: ArchiveManifestLimits) {
  return {
    maxEntries: limits.maxEntries,
    maxFiles: limits.maxFiles,
    maxTotalBytes: limits.maxTotalBytes,
    maxFileBytes: limits.maxFileBytes,
    maxPathBytes: limits.maxPathBytes,
    maxPathDepth: limits.maxPathDepth,
    maxLinkTargetBytes: limits.maxLinkTargetBytes,
    maxManifestBytes: limits.maxManifestBytes,
    maxChanges: limits.maxChanges,
  }
}

function checkedContent(values: PatchApplyArchiveContent[]): Map<string, PatchApplyArchiveContent> {
  if (!Array.isArray(values) || values.length > 100_000) {
    throw quota('patch archive content limit exceeded')
  }
  const byPath = new Map<string, PatchApplyArchiveContent>()
  const byObject = new Map<string, { checksum: string; sizeBytes: number; bytes: Uint8Array }>()
  for (const value of values) {
    if (!value || typeof value.path !== 'string' || typeof value.objectId !== 'string'
      || !value.objectId.trim() || Buffer.byteLength(value.objectId) > 512
      || !/^sha256:[0-9a-f]{64}$/u.test(value.checksum)
      || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
      || !(value.bytes instanceof Uint8Array)) {
      throw invalid('patch archive content metadata is invalid')
    }
    if (byPath.has(value.path)) throw invalid('patch archive content path is duplicated')
    const actual = `sha256:${createHash('sha256').update(value.bytes).digest('hex')}`
    if (value.bytes.byteLength !== value.sizeBytes || actual !== value.checksum) {
      throw invalid('patch archive content bytes do not match their identity')
    }
    const prior = byObject.get(value.objectId)
    if (prior && (prior.checksum !== value.checksum || prior.sizeBytes !== value.sizeBytes
      || !Buffer.from(prior.bytes).equals(Buffer.from(value.bytes)))) {
      throw invalid('patch archive object identity is inconsistent')
    }
    byPath.set(value.path, { ...value, bytes: Uint8Array.from(value.bytes) })
    byObject.set(value.objectId, {
      checksum: value.checksum, sizeBytes: value.sizeBytes, bytes: value.bytes,
    })
  }
  return byPath
}

function append(chunks: Buffer[], chunk: Buffer, size: { value: number }, limit: number): void {
  size.value += chunk.byteLength
  if (!Number.isSafeInteger(size.value) || size.value > limit) {
    throw quota('workspace archive byte limit exceeded')
  }
  chunks.push(chunk)
}

function encodedEntry(data: HeaderData): { prefix?: Buffer; header: Buffer } {
  const header = Buffer.alloc(512)
  const needsPax = new Header(data).encode(header)
  return needsPax ? { prefix: new Pax(data).encode(), header } : { header }
}

/** Builds a deterministic Linux workspace tar and round-trips its complete logical manifest. */
export async function buildPatchApplyArchive(
  manifestValue: WorkspaceManifest,
  contentValues: PatchApplyArchiveContent[],
  limits: ArchiveManifestLimits = defaultArchiveManifestLimits,
): Promise<Uint8Array> {
  const manifest = createWorkspaceManifest(
    manifestValue.identity, manifestValue.entries, workspaceLimits(limits))
  if (canonicalJson(manifest) !== canonicalJson(manifestValue)) {
    throw invalid('patch apply manifest is not canonical or exact-shape')
  }
  const contents = checkedContent(contentValues)
  const files = manifest.entries.filter(entry => entry.type === 'file')
  if (files.length !== contents.size || files.some(entry => !contents.has(entry.path))) {
    throw invalid('patch apply archive content set is incomplete')
  }

  const chunks: Buffer[] = []
  const size = { value: 0 }
  for (const entry of manifest.entries) {
    const content = entry.type === 'file' ? contents.get(entry.path) : undefined
    if (entry.type === 'file' && (!content || content.checksum !== entry.digest
      || content.sizeBytes !== entry.sizeBytes)) {
      throw invalid('patch apply archive content does not match its manifest')
    }
    const body = content ? Buffer.from(content.bytes) : Buffer.alloc(0)
    const data: HeaderData = {
      path: entry.path,
      type: entry.type === 'directory' ? 'Directory'
        : entry.type === 'symlink' ? 'SymbolicLink' : 'File',
      mode: entry.mode, uid: 0, gid: 0, size: body.byteLength,
      mtime: new Date(0), uname: '', gname: '',
      ...(entry.type === 'symlink' ? { linkpath: entry.linkTarget } : {}),
    }
    const encoded = encodedEntry(data)
    if (encoded.prefix) append(chunks, encoded.prefix, size, limits.maxArchiveBytes)
    append(chunks, encoded.header, size, limits.maxArchiveBytes)
    if (body.byteLength > 0) append(chunks, body, size, limits.maxArchiveBytes)
    const padding = (512 - body.byteLength % 512) % 512
    if (padding > 0) append(chunks, Buffer.alloc(padding), size, limits.maxArchiveBytes)
  }
  append(chunks, Buffer.alloc(1024), size, limits.maxArchiveBytes)
  const archive = Buffer.concat(chunks, size.value)
  const captured = await captureArchiveManifest(
    archive, manifest.identity, new ValidationObjects(), limits)
  if (canonicalJson(captured.manifest) !== canonicalJson(manifest)) {
    throw invalid('patch apply archive did not round-trip its manifest')
  }
  return Uint8Array.from(archive)
}
