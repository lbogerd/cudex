import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { captureArchiveManifest, defaultArchiveManifestLimits, type ArchiveManifestLimits, type CapturedArchiveManifest } from './archive-manifest.js'
import type { ObjectStore } from './blob-store.js'
import type { PostgresDurableState, SourceSnapshot, StoredObject } from './postgres-state.js'
import { ServiceError } from './types.js'
import { WorkspaceManifestError } from './workspace-manifest.js'

const checksumPattern = /^sha256:[0-9a-f]{64}$/
const sourceIdPattern = /^source_[0-9a-f]{32}$/

export interface AuthenticatedTenant {
  /** Supplied by trusted authentication middleware, never by an upload body. */
  tenantId: string
}

export interface CreateSourceSnapshotInput {
  archive: Uint8Array
  checksum: string
  cwdUri: string
  workspaceRootUris: string[]
  expiresAt: Date
}

export interface SourceSnapshotReference {
  sourceSnapshotId: string
  checksum: string
  expiresAt: Date
  manifestChecksum: string
  sizeBytes: number
}

export interface ResolvedSourceSnapshot extends SourceSnapshotReference {
  archive: Uint8Array
  cwdUri: string
  workspaceRootUris: string[]
  manifest: CapturedArchiveManifest['manifest']
}

export interface SourceSnapshotReclaimer {
  /** Must verify no durable object references the physical content before deleting storage. */
  reclaimUnreferencedSourceArchive(tenantId: string, objectId: string, storageId: string): Promise<void>
}

export interface SourceSnapshotLifecycleOptions {
  maxRoots?: number
  maxTtlMs?: number
  archiveLimits?: ArchiveManifestLimits
  now?: () => Date
  reclaimer: SourceSnapshotReclaimer
}

type DurableSourceState = Pick<PostgresDurableState,
  'withObjectLocationLock' | 'registerObject' | 'registerSourceSnapshot' |
  'findAuthorizedSourceSnapshot' | 'findAuthorizedSourceSnapshotByChecksum'>

class StagingObjectStore implements ObjectStore {
  private readonly values = new Map<string, Uint8Array>()
  async put(bytes: Uint8Array): Promise<string> {
    const id = createHash('sha256').update(bytes).digest('hex')
    this.values.set(id, Uint8Array.from(bytes)); return id
  }
  async get(id: string): Promise<Uint8Array> {
    const value = this.values.get(id); if (!value) throw new Error('staged object missing')
    return Uint8Array.from(value)
  }
  async delete(id: string): Promise<void> { this.values.delete(id) }
  location(id: string): { storageBucket: string; storageKey: string } {
    return { storageBucket: 'staging', storageKey: id }
  }
  clear(): void { this.values.clear() }
}

function opaque(label: string, value: string, maxBytes = 512): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes
    || Buffer.from(value, 'utf8').toString('utf8') !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ServiceError(400, `invalid ${label}`)
  }
  return value
}

function canonicalFileUri(label: string, value: string): { uri: string; path: string } {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096
    || Buffer.from(value, 'utf8').toString('utf8') !== value) throw new ServiceError(400, `invalid ${label}`)
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new ServiceError(400, `invalid ${label}`) }
  if (parsed.protocol !== 'file:' || parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.href !== value) {
    throw new ServiceError(400, `invalid ${label}`)
  }
  let path: string
  try { path = fileURLToPath(parsed) } catch { throw new ServiceError(400, `invalid ${label}`) }
  if (!isAbsolute(path) || pathToFileURL(path).href !== value) throw new ServiceError(400, `invalid ${label}`)
  return { uri: value, path }
}

function below(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function validateWorkspace(cwdUri: string, workspaceRootUris: string[], maxRoots: number): {
  cwdUri: string
  cwdPath: string
  workspaceRootUris: string[]
  rootPaths: string[]
} {
  if (!Array.isArray(workspaceRootUris) || workspaceRootUris.length === 0 || workspaceRootUris.length > maxRoots) {
    throw new ServiceError(400, 'invalid workspace roots')
  }
  const cwd = canonicalFileUri('workspace cwd', cwdUri)
  const roots = workspaceRootUris.map((root, index) => canonicalFileUri(`workspace root ${index}`, root))
  if (new Set(roots.map(root => root.uri)).size !== roots.length) throw new ServiceError(400, 'workspace roots must be unique')
  for (const [index, root] of roots.entries()) {
    if (roots.some((candidate, candidateIndex) => candidateIndex !== index
      && (below(root.path, candidate.path) || below(candidate.path, root.path)))) {
      throw new ServiceError(400, 'workspace roots must not overlap')
    }
    const expectedPrefix = `/workspace/roots/${index}/`
    if (!root.path.startsWith(expectedPrefix) || root.path.length === expectedPrefix.length) {
      throw new ServiceError(400, 'workspace root does not match its archive index')
    }
  }
  if (!roots.some(root => below(cwd.path, root.path))) throw new ServiceError(400, 'workspace cwd is outside its roots')
  return { cwdUri: cwd.uri, cwdPath: cwd.path, workspaceRootUris: roots.map(root => root.uri), rootPaths: roots.map(root => root.path) }
}

function archivePath(workspacePath: string): string {
  if (!workspacePath.startsWith('/workspace/')) throw new ServiceError(400, 'workspace path is outside the archive')
  return workspacePath.slice('/workspace/'.length)
}

function verifyArchiveLayout(captured: CapturedArchiveManifest, cwdPath: string, rootPaths: string[]): void {
  const entries = new Map(captured.manifest.entries.map(entry => [entry.path, entry]))
  const archiveRoots = rootPaths.map(archivePath)
  for (const root of archiveRoots) {
    const entry = entries.get(root)
    if (!entry || entry.type !== 'directory') throw new ServiceError(400, 'source archive does not contain every workspace root')
  }
  const cwd = entries.get(archivePath(cwdPath))
  if (!cwd || cwd.type !== 'directory') throw new ServiceError(400, 'source archive does not contain the workspace cwd')
  for (const entry of captured.manifest.entries) {
    if (entry.path === 'roots') continue
    const match = /^roots\/(0|[1-9]\d*)(?:\/|$)/.exec(entry.path)
    if (!match || Number(match[1]) >= rootPaths.length) throw new ServiceError(400, 'source archive contains an undeclared workspace root')
    const index = Number(match[1]); const indexDirectory = `roots/${index}`; const declaredRoot = archiveRoots[index]!
    if (entry.path === indexDirectory) {
      if (entry.type !== 'directory') throw new ServiceError(400, 'source archive has an invalid root index')
    } else if (entry.path !== declaredRoot && !entry.path.startsWith(`${declaredRoot}/`)) {
      throw new ServiceError(400, 'source archive contains content outside a declared workspace root')
    }
  }
}

function archiveChecksum(archive: Uint8Array): string {
  return `sha256:${createHash('sha256').update(archive).digest('hex')}`
}

function tenantObjectId(tenantId: string, checksum: string): string {
  return `source_object_${createHash('sha256').update(tenantId).update('\0').update(checksum).digest('hex')}`
}

function mapValidationError(error: unknown): never {
  if (error instanceof ServiceError) throw error
  if (error instanceof WorkspaceManifestError) {
    throw new ServiceError(error.kind === 'quota' ? 429 : 400,
      error.kind === 'quota' ? 'source snapshot quota exceeded' : 'invalid source snapshot archive')
  }
  throw new ServiceError(503, 'source snapshot service unavailable')
}

export class SourceSnapshotLifecycle {
  private readonly maxRoots: number
  private readonly maxTtlMs: number
  private readonly limits: ArchiveManifestLimits
  private readonly now: () => Date

  constructor(
    private readonly state: DurableSourceState,
    private readonly objects: ObjectStore,
    private readonly options: SourceSnapshotLifecycleOptions,
  ) {
    this.maxRoots = options.maxRoots ?? 8
    this.maxTtlMs = options.maxTtlMs ?? 24 * 60 * 60_000
    if (!Number.isSafeInteger(this.maxRoots) || this.maxRoots <= 0 || this.maxRoots > 64
      || !Number.isSafeInteger(this.maxTtlMs) || this.maxTtlMs <= 0) throw new Error('invalid source snapshot limits')
    this.limits = options.archiveLimits ?? defaultArchiveManifestLimits
    this.now = options.now ?? (() => new Date())
  }

  async create(principal: AuthenticatedTenant, input: CreateSourceSnapshotInput): Promise<SourceSnapshotReference> {
    const tenantId = opaque('tenant ID', principal.tenantId)
    if (!(input.archive instanceof Uint8Array)) throw new ServiceError(400, 'invalid source snapshot archive')
    if (!checksumPattern.test(input.checksum) || archiveChecksum(input.archive) !== input.checksum) {
      throw new ServiceError(400, 'source snapshot checksum mismatch')
    }
    const now = this.now(); const expiry = input.expiresAt
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !(expiry instanceof Date) || !Number.isFinite(expiry.getTime())
      || expiry.getTime() <= now.getTime() || expiry.getTime() - now.getTime() > this.maxTtlMs) {
      throw new ServiceError(400, 'invalid source snapshot expiry')
    }
    const workspace = validateWorkspace(input.cwdUri, input.workspaceRootUris, this.maxRoots)
    let existing: SourceSnapshot | null
    try { existing = await this.state.findAuthorizedSourceSnapshotByChecksum(tenantId, input.checksum, now) }
    catch { throw new ServiceError(503, 'source snapshot service unavailable') }
    const sourceSnapshotId = existing?.sourceSnapshotId ?? `source_${randomUUID().replaceAll('-', '')}`
    const staging = new StagingObjectStore()
    let captured: CapturedArchiveManifest
    try {
      captured = await captureArchiveManifest(input.archive, sourceSnapshotId, staging, this.limits)
      verifyArchiveLayout(captured, workspace.cwdPath, workspace.rootPaths)
    } catch (error) { return mapValidationError(error) }
    finally { staging.clear() }

    if (existing) {
      if (existing.cwdUri !== workspace.cwdUri
        || JSON.stringify(existing.workspaceRootUris) !== JSON.stringify(workspace.workspaceRootUris)
        || existing.expiresAt.getTime() !== expiry.getTime()) {
        throw new ServiceError(409, 'source snapshot checksum already has different metadata')
      }
      return { sourceSnapshotId: existing.sourceSnapshotId, checksum: input.checksum,
        expiresAt: new Date(existing.expiresAt), manifestChecksum: captured.manifestChecksum,
        sizeBytes: input.archive.byteLength }
    }

    const physicalObjectId = input.checksum.slice('sha256:'.length)
    const durableObjectId = tenantObjectId(tenantId, input.checksum)
    let publicationStarted = false
    try {
      const expected = this.objects.location(physicalObjectId)
      const storageBucket = opaque('storage bucket', expected.storageBucket)
      const storageKey = opaque('storage key', expected.storageKey, 2048)
      let registeredObject: StoredObject | undefined
      const object: StoredObject = { objectId: durableObjectId, tenantId, kind: 'source_archive', storageBucket, storageKey,
        checksum: input.checksum, sizeBytes: input.archive.byteLength, state: 'available', expiresAt: expiry }
      await this.state.withObjectLocationLock(storageBucket, storageKey, async client => {
        publicationStarted = true
        const storedId = await this.objects.put(input.archive)
        if (storedId !== physicalObjectId) throw new Error('object store returned a non-content-addressed identifier')
        const location = this.objects.location(storedId)
        if (location.storageBucket !== storageBucket || location.storageKey !== storageKey) {
          throw new Error('object store location changed during publication')
        }
        registeredObject = await this.state.registerObject(object, client)
      })
      if (!registeredObject) throw new Error('durable object registration missing')
      if (registeredObject.objectId !== object.objectId || registeredObject.tenantId !== tenantId
        || registeredObject.kind !== 'source_archive' || registeredObject.checksum !== input.checksum
        || registeredObject.sizeBytes !== input.archive.byteLength || registeredObject.state !== 'available') {
        throw new Error('durable object registration mismatch')
      }
      const snapshot = await this.state.registerSourceSnapshot({
        sourceSnapshotId, tenantId, archiveObjectId: durableObjectId, checksum: input.checksum,
        cwdUri: workspace.cwdUri, workspaceRootUris: workspace.workspaceRootUris,
        state: 'available', expiresAt: expiry,
      })
      if (!sourceIdPattern.test(snapshot.sourceSnapshotId) || snapshot.tenantId !== tenantId
        || snapshot.archiveObjectId !== durableObjectId || snapshot.checksum !== input.checksum
        || snapshot.state !== 'available' || snapshot.expiresAt.getTime() !== expiry.getTime()) {
        throw new Error('durable source snapshot registration mismatch')
      }
      return { sourceSnapshotId: snapshot.sourceSnapshotId, checksum: input.checksum, expiresAt: new Date(expiry),
        manifestChecksum: captured.manifestChecksum, sizeBytes: input.archive.byteLength }
    } catch {
      if (publicationStarted) {
        try { await this.options.reclaimer.reclaimUnreferencedSourceArchive(tenantId, durableObjectId, physicalObjectId) }
        catch { throw new ServiceError(503, 'source snapshot cleanup pending') }
      }
      throw new ServiceError(503, 'source snapshot service unavailable')
    }
  }

  async resolve(principal: AuthenticatedTenant, sourceSnapshotId: string, expectedChecksum: string): Promise<ResolvedSourceSnapshot> {
    const tenantId = opaque('tenant ID', principal.tenantId)
    if (!sourceIdPattern.test(sourceSnapshotId)) throw new ServiceError(400, 'invalid source snapshot ID')
    if (!checksumPattern.test(expectedChecksum)) throw new ServiceError(400, 'invalid source snapshot checksum')
    const now = this.now()
    let snapshot: SourceSnapshot | null
    try { snapshot = await this.state.findAuthorizedSourceSnapshot(tenantId, sourceSnapshotId, now) }
    catch { throw new ServiceError(503, 'source snapshot service unavailable') }
    if (!snapshot) throw new ServiceError(404, 'source snapshot unavailable')
    if (snapshot.tenantId !== tenantId || snapshot.sourceSnapshotId !== sourceSnapshotId
      || snapshot.state !== 'available' || snapshot.expiresAt.getTime() <= now.getTime()) {
      throw new ServiceError(404, 'source snapshot unavailable')
    }
    if (snapshot.checksum !== expectedChecksum || snapshot.archiveObjectId !== tenantObjectId(tenantId, expectedChecksum)) {
      throw new ServiceError(403, 'source snapshot unavailable')
    }
    const workspace = validateWorkspace(snapshot.cwdUri, snapshot.workspaceRootUris, this.maxRoots)
    let archive: Uint8Array
    try { archive = await this.objects.get(expectedChecksum.slice('sha256:'.length)) }
    catch { throw new ServiceError(503, 'source snapshot archive unavailable') }
    if (archive.byteLength > this.limits.maxArchiveBytes || archiveChecksum(archive) !== expectedChecksum) {
      throw new ServiceError(503, 'source snapshot archive failed integrity verification')
    }
    const staging = new StagingObjectStore()
    try {
      const captured = await captureArchiveManifest(archive, sourceSnapshotId, staging, this.limits)
      verifyArchiveLayout(captured, workspace.cwdPath, workspace.rootPaths)
      return {
        sourceSnapshotId, checksum: expectedChecksum, expiresAt: new Date(snapshot.expiresAt),
        manifestChecksum: captured.manifestChecksum, sizeBytes: archive.byteLength,
        archive: Uint8Array.from(archive), cwdUri: workspace.cwdUri,
        workspaceRootUris: [...workspace.workspaceRootUris], manifest: captured.manifest,
      }
    } catch (error) {
      if (error instanceof ServiceError || error instanceof WorkspaceManifestError) {
        throw new ServiceError(503, 'source snapshot archive failed validation')
      }
      throw new ServiceError(503, 'source snapshot service unavailable')
    } finally { staging.clear() }
  }
}
