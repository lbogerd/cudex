import { createHash } from 'node:crypto'
import { Parser, type ReadEntry } from 'tar'
import type { ObjectStore } from './blob-store.js'
import {
  WorkspaceManifestError,
  canonicalJson,
  createWorkspaceManifest,
  defaultWorkspaceManifestLimits,
  validateSymlinkTarget,
  validateWorkspacePath,
  workspaceManifestChecksum,
  type WorkspaceEntry,
  type WorkspaceManifest,
  type WorkspaceManifestLimits,
} from './workspace-manifest.js'

const utf8 = new TextEncoder()

export interface ArchiveManifestLimits extends WorkspaceManifestLimits {
  maxArchiveBytes: number
  maxExtractionRatio: number
  maxMetaEntryBytes: number
}

export const defaultArchiveManifestLimits: ArchiveManifestLimits = {
  ...defaultWorkspaceManifestLimits,
  maxArchiveBytes: 512 * 1024 * 1024,
  maxExtractionRatio: 200,
  maxMetaEntryBytes: 1024 * 1024,
}

export interface ContentObject {
  path: string
  objectId: string
}

export interface CapturedArchiveManifest {
  manifest: WorkspaceManifest
  manifestBytes: Uint8Array
  manifestChecksum: string
  contentObjects: ContentObject[]
  totalSizeBytes: number
}

class ValidationObjectStore implements ObjectStore {
  async put(bytes: Uint8Array): Promise<string> { return createHash('sha256').update(bytes).digest('hex') }
  async get(): Promise<Uint8Array> { throw new Error('validation object store is write-only') }
  async delete(): Promise<void> {}
  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'validation', storageKey: id }
  }
}

const invalid = (message: string): WorkspaceManifestError => new WorkspaceManifestError('invalid', message)
const quota = (message: string): WorkspaceManifestError => new WorkspaceManifestError('quota', message)

function validateArchiveLimits(limits: ArchiveManifestLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (name === 'maxExtractionRatio') continue
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${name} must be a non-negative safe integer`)
  }
  if (!Number.isFinite(limits.maxExtractionRatio) || limits.maxExtractionRatio <= 0) throw invalid('maxExtractionRatio must be positive')
  if (limits.maxMetaEntryBytes === 0) throw invalid('maxMetaEntryBytes must be positive')
}

function workspaceLimits(limits: ArchiveManifestLimits): WorkspaceManifestLimits {
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

function canonicalTarPath(entry: ReadEntry, limits: ArchiveManifestLimits): string {
  let path = entry.path
  if (entry.type === 'Directory' && path.endsWith('/')) path = path.slice(0, -1)
  validateWorkspacePath(path, workspaceLimits(limits))
  if (path !== 'roots' && !path.startsWith('roots/')) throw invalid('archive entry is outside the roots tree')
  if (path === 'roots' && entry.type !== 'Directory') throw invalid('archive roots entry must be a directory')
  return path
}

function validatedMode(entry: ReadEntry): number {
  if (!Number.isInteger(entry.mode) || entry.mode === undefined || entry.mode < 0 || entry.mode > 0o7777) throw invalid('archive entry has an invalid POSIX mode')
  return entry.mode
}

function assertNoPathConflicts(entries: readonly WorkspaceEntry[]): void {
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  for (const entry of entries) {
    const segments = entry.path.split('/')
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = byPath.get(segments.slice(0, length).join('/'))
      if (ancestor && ancestor.type !== 'directory') throw invalid('archive contains conflicting ancestor entries')
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : invalid('archive processing failed')
}

/** Parses a provider workspace tar without extracting it. */
export async function captureArchiveManifest(
  archive: Uint8Array,
  identity: string,
  objects: ObjectStore,
  limits: ArchiveManifestLimits = defaultArchiveManifestLimits,
): Promise<CapturedArchiveManifest> {
  validateArchiveLimits(limits)
  if (archive.byteLength === 0) throw invalid('workspace archive is empty')
  if (archive.byteLength > limits.maxArchiveBytes) throw quota('workspace archive byte limit exceeded')

  const entries: WorkspaceEntry[] = []
  const seen = new Set<string>()
  const contentObjects: ContentObject[] = []
  const pending: Promise<void>[] = []
  let fileCount = 0
  let totalSizeBytes = 0
  let failure: Error | undefined
  const fail = (error: unknown): void => { failure ??= asError(error) }

  const parser = new Parser({
    strict: true,
    maxMetaEntrySize: limits.maxMetaEntryBytes,
    maxDecompressionRatio: limits.maxExtractionRatio,
  })
  parser.on('warn', (code, message) => fail(invalid(`archive warning ${code}: ${String(message)}`)))
  parser.on('error', error => fail(invalid(`invalid workspace archive: ${error.message}`)))
  parser.on('ignoredEntry', () => fail(invalid('archive contains an unknown entry type')))
  parser.on('entry', (entry: ReadEntry) => {
    try {
      const path = canonicalTarPath(entry, limits)
      if (seen.has(path)) throw invalid('archive contains a duplicate path')
      if (seen.size >= limits.maxEntries) throw quota('workspace entry limit exceeded')
      seen.add(path)
      const mode = validatedMode(entry)

      switch (entry.type) {
        case 'Directory':
          if (entry.size !== 0) throw invalid('directory entry has non-zero content size')
          entries.push({ path, type: 'directory', mode })
          entry.resume()
          break
        case 'SymbolicLink': {
          if (entry.size !== 0) throw invalid('symlink entry has non-zero content size')
          if (entry.linkpath === undefined) throw invalid('symlink entry has no target')
          const linkTarget = validateSymlinkTarget(path, entry.linkpath, workspaceLimits(limits))
          entries.push({ path, type: 'symlink', mode, linkTarget })
          entry.resume()
          break
        }
        case 'File':
        case 'OldFile': {
          if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw invalid('file entry has an invalid declared size')
          if (entry.size > limits.maxFileBytes) throw quota('per-file byte limit exceeded')
          fileCount += 1
          if (fileCount > limits.maxFiles) throw quota('workspace file limit exceeded')
          totalSizeBytes += entry.size
          if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes > limits.maxTotalBytes) throw quota('workspace total byte limit exceeded')
          if (totalSizeBytes / archive.byteLength > limits.maxExtractionRatio) throw quota('workspace extraction ratio exceeded')

          const declaredSize = entry.size
          const chunks: Buffer[] = []
          const contentHash = createHash('sha256')
          let received = 0
          entry.on('data', (chunk: Buffer) => {
            received += chunk.byteLength
            if (received > declaredSize || received > limits.maxFileBytes) {
              fail(invalid('file content exceeds its declared size'))
              return
            }
            contentHash.update(chunk)
            chunks.push(Buffer.from(chunk))
          })
          const stored = new Promise<void>(resolve => {
            entry.once('end', () => {
              const work = async (): Promise<void> => {
                if (received !== declaredSize) throw invalid('file content does not match its declared size')
                const body = Buffer.concat(chunks, received)
                const digestHex = contentHash.digest('hex')
                const objectId = await objects.put(body)
                if (objectId !== digestHex) throw invalid('object store returned a non-content-addressed identifier')
                entries.push({ path, type: 'file', mode, digest: `sha256:${digestHex}`, sizeBytes: received })
                contentObjects.push({ path, objectId })
              }
              pending.push(work().catch(fail))
              resolve()
            })
          })
          pending.push(stored)
          entry.resume()
          break
        }
        case 'Link':
          throw invalid('archive hardlinks are forbidden')
        case 'CharacterDevice':
        case 'BlockDevice':
        case 'FIFO':
          throw invalid('archive special files are forbidden')
        default:
          throw invalid('archive contains an unsupported entry type')
      }
    } catch (error) {
      fail(error)
      entry.resume()
    }
  })

  await new Promise<void>(resolve => {
    parser.once('end', resolve)
    parser.once('abort', resolve)
    try {
      parser.end(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength))
    } catch (error) {
      fail(error)
      resolve()
    }
  })
  await Promise.all(pending)
  if (failure) throw failure
  if (!seen.has('roots')) throw invalid('archive is missing its roots directory')
  assertNoPathConflicts(entries)

  const manifest = createWorkspaceManifest(identity, entries, workspaceLimits(limits))
  const manifestBytes = utf8.encode(canonicalJson(manifest))
  contentObjects.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    manifest,
    manifestBytes,
    manifestChecksum: workspaceManifestChecksum(manifest),
    contentObjects,
    totalSizeBytes,
  }
}

/** Fully validates a provider workspace tar without persisting its file bodies. */
export async function validateWorkspaceArchive(
  archive: Uint8Array,
  limits: ArchiveManifestLimits = defaultArchiveManifestLimits,
): Promise<void> {
  await captureArchiveManifest(archive, 'workspace-transfer', new ValidationObjectStore(), limits)
}
