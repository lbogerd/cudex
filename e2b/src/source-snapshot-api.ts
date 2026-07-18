import { createHash } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  AuthenticatedTenant,
  CreateSourceSnapshotInput,
  ResolvedSourceSnapshot,
  SourceSnapshotLifecycle,
  SourceSnapshotReference,
} from './source-snapshots.js'
import { ServiceError } from './types.js'

const checksumPattern = /^sha256:[0-9a-f]{64}$/
const sourceSnapshotIdPattern = /^source_[0-9a-f]{32}$/
const defaultLimits: SourceSnapshotApiLimits = { maxRoots: 8, maxArchiveBytes: 512 * 1024 * 1024 }

export interface SourceSnapshotApiLimits {
  maxRoots: number
  maxArchiveBytes: number
}

export interface SourceSnapshotCreateBody {
  checksum: string
  cwdUri: string
  workspaceRootUris: string[]
  expiresAt: string
}

export interface SourceSnapshotResolveBody {
  sourceSnapshotId: string
  checksum: string
}

export interface SourceSnapshotReferenceBody {
  sourceSnapshotId: string
  checksum: string
  expiresAt: string
  manifestChecksum: string
  sizeBytes: number
}

export interface SourceSnapshotResolutionBody extends SourceSnapshotReferenceBody {
  cwdUri: string
  workspaceRootUris: string[]
}

export interface SourceSnapshotResolution {
  metadata: SourceSnapshotResolutionBody
  archive: Uint8Array
  manifest: ResolvedSourceSnapshot['manifest']
}

type Lifecycle = Pick<SourceSnapshotLifecycle, 'create' | 'resolve'>

function exactObject(value: unknown, keys: readonly string[], status: number, kind: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new ServiceError(status, `${kind} must be an object`)
  }
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some(key => typeof key !== 'string')) throw new ServiceError(status, `${kind} has invalid properties`)
  const actual = (ownKeys as string[]).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ServiceError(status, `${kind} has invalid properties`)
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new ServiceError(status, `${kind} is not JSON data`)
  }
  return value as Record<string, unknown>
}

function exactArray(value: unknown, status: number, kind: string, maxRoots: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxRoots) throw new ServiceError(status, `invalid ${kind}`)
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) {
    throw new ServiceError(status, `invalid ${kind}`)
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new ServiceError(status, `invalid ${kind}`)
  }
  return value
}

function checksum(value: unknown, status: number): string {
  if (typeof value !== 'string' || !checksumPattern.test(value)) throw new ServiceError(status, 'invalid source snapshot checksum')
  return value
}

function sourceSnapshotId(value: unknown, status: number): string {
  if (typeof value !== 'string' || !sourceSnapshotIdPattern.test(value)) throw new ServiceError(status, 'invalid source snapshot ID')
  return value
}

function canonicalTimestamp(value: unknown, status: number): string {
  if (typeof value !== 'string') throw new ServiceError(status, 'invalid source snapshot expiry')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ServiceError(status, 'invalid source snapshot expiry')
  return value
}

function canonicalFileUri(value: unknown, status: number, kind: string): { uri: string; path: string } {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096
    || Buffer.from(value, 'utf8').toString('utf8') !== value) throw new ServiceError(status, `invalid ${kind}`)
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new ServiceError(status, `invalid ${kind}`) }
  if (parsed.protocol !== 'file:' || parsed.hostname || parsed.username || parsed.password || parsed.search
    || parsed.hash || parsed.href !== value) throw new ServiceError(status, `invalid ${kind}`)
  let path: string
  try { path = fileURLToPath(parsed) } catch { throw new ServiceError(status, `invalid ${kind}`) }
  if (!isAbsolute(path) || pathToFileURL(path).href !== value) throw new ServiceError(status, `invalid ${kind}`)
  return { uri: value, path }
}

function below(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function workspace(cwdValue: unknown, rootsValue: unknown, status: number, maxRoots: number): { cwdUri: string; workspaceRootUris: string[] } {
  const rootValues = exactArray(rootsValue, status, 'workspace roots', maxRoots)
  const cwd = canonicalFileUri(cwdValue, status, 'workspace cwd')
  const roots = rootValues.map((root, index) => canonicalFileUri(root, status, `workspace root ${index}`))
  if (new Set(roots.map(root => root.uri)).size !== roots.length) throw new ServiceError(status, 'workspace roots must be unique')
  for (const [index, root] of roots.entries()) {
    if (!root.path.startsWith(`/workspace/roots/${index}/`)
      || roots.some((candidate, candidateIndex) => candidateIndex !== index
        && (below(root.path, candidate.path) || below(candidate.path, root.path)))) {
      throw new ServiceError(status, 'invalid workspace root mapping')
    }
  }
  if (!roots.some(root => below(cwd.path, root.path))) throw new ServiceError(status, 'workspace cwd is outside its roots')
  return { cwdUri: cwd.uri, workspaceRootUris: roots.map(root => root.uri) }
}

function positiveSize(value: unknown, status: number, maxArchiveBytes: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maxArchiveBytes) {
    throw new ServiceError(status, 'invalid source snapshot size')
  }
  return value as number
}

function validateLimits(limits: SourceSnapshotApiLimits): SourceSnapshotApiLimits {
  if (!Number.isSafeInteger(limits.maxRoots) || limits.maxRoots <= 0 || limits.maxRoots > 64
    || !Number.isSafeInteger(limits.maxArchiveBytes) || limits.maxArchiveBytes <= 0) {
    throw new Error('invalid source snapshot API limits')
  }
  return { ...limits }
}

export function validateSourceSnapshotCreateBody(
  value: unknown,
  limits: SourceSnapshotApiLimits = defaultLimits,
): SourceSnapshotCreateBody {
  limits = validateLimits(limits)
  const body = exactObject(value, ['checksum', 'cwdUri', 'workspaceRootUris', 'expiresAt'], 400, 'source snapshot create body')
  const paths = workspace(body.cwdUri, body.workspaceRootUris, 400, limits.maxRoots)
  return { checksum: checksum(body.checksum, 400), ...paths, expiresAt: canonicalTimestamp(body.expiresAt, 400) }
}

export function validateSourceSnapshotResolveBody(value: unknown): SourceSnapshotResolveBody {
  const body = exactObject(value, ['sourceSnapshotId', 'checksum'], 400, 'source snapshot resolve body')
  return { sourceSnapshotId: sourceSnapshotId(body.sourceSnapshotId, 400), checksum: checksum(body.checksum, 400) }
}

export function validateSourceSnapshotReferenceBody(value: unknown): SourceSnapshotReferenceBody {
  return validateSourceSnapshotReferenceBodyWithLimits(value, defaultLimits)
}

function validateSourceSnapshotReferenceBodyWithLimits(
  value: unknown,
  limits: SourceSnapshotApiLimits,
): SourceSnapshotReferenceBody {
  limits = validateLimits(limits)
  const body = exactObject(value, ['sourceSnapshotId', 'checksum', 'expiresAt', 'manifestChecksum', 'sizeBytes'], 503, 'source snapshot response')
  return {
    sourceSnapshotId: sourceSnapshotId(body.sourceSnapshotId, 503), checksum: checksum(body.checksum, 503),
    expiresAt: canonicalTimestamp(body.expiresAt, 503), manifestChecksum: checksum(body.manifestChecksum, 503),
    sizeBytes: positiveSize(body.sizeBytes, 503, limits.maxArchiveBytes),
  }
}

export function validateSourceSnapshotResolutionBody(value: unknown): SourceSnapshotResolutionBody {
  return validateSourceSnapshotResolutionBodyWithLimits(value, defaultLimits)
}

function validateSourceSnapshotResolutionBodyWithLimits(
  value: unknown,
  limits: SourceSnapshotApiLimits,
): SourceSnapshotResolutionBody {
  limits = validateLimits(limits)
  const body = exactObject(value, ['sourceSnapshotId', 'checksum', 'expiresAt', 'manifestChecksum', 'sizeBytes', 'cwdUri', 'workspaceRootUris'], 503, 'source snapshot resolution')
  const paths = workspace(body.cwdUri, body.workspaceRootUris, 503, limits.maxRoots)
  return {
    sourceSnapshotId: sourceSnapshotId(body.sourceSnapshotId, 503), checksum: checksum(body.checksum, 503),
    expiresAt: canonicalTimestamp(body.expiresAt, 503), manifestChecksum: checksum(body.manifestChecksum, 503),
    sizeBytes: positiveSize(body.sizeBytes, 503, limits.maxArchiveBytes), ...paths,
  }
}

function referenceBody(reference: SourceSnapshotReference): Record<string, unknown> {
  return {
    sourceSnapshotId: reference.sourceSnapshotId, checksum: reference.checksum,
    expiresAt: reference.expiresAt instanceof Date && Number.isFinite(reference.expiresAt.getTime())
      ? reference.expiresAt.toISOString() : reference.expiresAt,
    manifestChecksum: reference.manifestChecksum,
    sizeBytes: reference.sizeBytes,
  }
}

/** Adapter for an HTTP handler that authenticates the tenant and streams archive bytes separately from JSON. */
export class AuthenticatedSourceSnapshotApi {
  private readonly limits: SourceSnapshotApiLimits
  constructor(private readonly lifecycle: Lifecycle, limits: SourceSnapshotApiLimits = defaultLimits) {
    this.limits = validateLimits(limits)
  }

  async create(principal: AuthenticatedTenant, body: unknown, archive: Uint8Array): Promise<SourceSnapshotReferenceBody> {
    if (!(archive instanceof Uint8Array) || archive.byteLength === 0 || archive.byteLength > this.limits.maxArchiveBytes) {
      throw new ServiceError(400, 'invalid source snapshot archive')
    }
    const request = validateSourceSnapshotCreateBody(body, this.limits)
    const input: CreateSourceSnapshotInput = {
      archive, checksum: request.checksum, cwdUri: request.cwdUri,
      workspaceRootUris: request.workspaceRootUris, expiresAt: new Date(request.expiresAt),
    }
    const created = await this.lifecycle.create(principal, input)
    const response = validateSourceSnapshotReferenceBodyWithLimits(referenceBody(created), this.limits)
    if (response.checksum !== request.checksum) throw new ServiceError(503, 'source snapshot response does not match its request')
    return response
  }

  async resolve(principal: AuthenticatedTenant, body: unknown): Promise<SourceSnapshotResolution> {
    const request = validateSourceSnapshotResolveBody(body)
    const resolved = await this.lifecycle.resolve(principal, request.sourceSnapshotId, request.checksum)
    const metadata = validateSourceSnapshotResolutionBodyWithLimits({
      ...referenceBody(resolved), cwdUri: resolved.cwdUri, workspaceRootUris: resolved.workspaceRootUris,
    }, this.limits)
    if (metadata.sourceSnapshotId !== request.sourceSnapshotId || metadata.checksum !== request.checksum
      || !(resolved.archive instanceof Uint8Array) || resolved.archive.byteLength !== metadata.sizeBytes
      || `sha256:${createHash('sha256').update(resolved.archive).digest('hex')}` !== metadata.checksum) {
      throw new ServiceError(503, 'source snapshot resolution failed integrity verification')
    }
    return { metadata, archive: Uint8Array.from(resolved.archive), manifest: resolved.manifest }
  }
}
