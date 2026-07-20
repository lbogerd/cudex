import { createHash } from 'node:crypto'

const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

export interface WorkspaceManifestLimits {
  maxEntries: number
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
  maxPathBytes: number
  maxPathDepth: number
  maxLinkTargetBytes: number
  maxManifestBytes: number
  maxChanges: number
}

export const defaultWorkspaceManifestLimits: WorkspaceManifestLimits = {
  maxEntries: 100_000,
  maxFiles: 100_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxPathBytes: 4_096,
  maxPathDepth: 128,
  maxLinkTargetBytes: 4_096,
  maxManifestBytes: 64 * 1024 * 1024,
  maxChanges: 100_000,
}

interface EntryBase {
  path: string
  mode: number
}

export interface DirectoryEntry extends EntryBase {
  type: 'directory'
}

export interface FileEntry extends EntryBase {
  type: 'file'
  digest: string
  sizeBytes: number
}

export interface SymlinkEntry extends EntryBase {
  type: 'symlink'
  linkTarget: string
}

export type WorkspaceEntry = DirectoryEntry | FileEntry | SymlinkEntry

export interface WorkspaceManifest {
  version: 1
  identity: string
  entries: WorkspaceEntry[]
}

export interface WorkspaceChange {
  path: string
  base: WorkspaceEntry | null
  current: WorkspaceEntry | null
}

export interface ConflictCollection {
  paths: string[]
  total: number
  truncated: boolean
}

export class WorkspaceManifestError extends Error {
  constructor(public readonly kind: 'invalid' | 'quota', message: string) {
    super(message)
    this.name = 'WorkspaceManifestError'
  }
}

function invalid(message: string): never {
  throw new WorkspaceManifestError('invalid', message)
}

function quota(message: string): never {
  throw new WorkspaceManifestError('quota', message)
}

function bytes(value: string): number {
  return utf8.encode(value).byteLength
}

function assertLimit(name: keyof WorkspaceManifestLimits, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a non-negative safe integer`)
}

function validateLimits(limits: WorkspaceManifestLimits): void {
  for (const [name, value] of Object.entries(limits) as Array<[keyof WorkspaceManifestLimits, number]>) assertLimit(name, value)
}

/** Validates a canonical POSIX path relative to the workspace archive root. */
export function validateWorkspacePath(path: string, limits: WorkspaceManifestLimits = defaultWorkspaceManifestLimits): string {
  validateLimits(limits)
  if (path.length === 0 || path.startsWith('/') || path.endsWith('/')) invalid('workspace path must be a non-empty relative path')
  if (path.includes('\0') || path.includes('\\')) invalid('workspace path contains a forbidden character')
  if (path !== path.normalize('NFC')) invalid('workspace path must use NFC Unicode normalization')
  const segments = path.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) invalid('workspace path is not canonical')
  // LF is valid in POSIX/Git filenames and remains unambiguous because all workspace
  // transports are NUL-delimited, JSON-escaped, URI-encoded, or tar-header based.
  if (segments.some(segment => /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(segment))) invalid('workspace path contains a control character')
  if (bytes(path) > limits.maxPathBytes) quota('workspace path byte limit exceeded')
  if (segments.length > limits.maxPathDepth) quota('workspace path depth limit exceeded')
  return path
}

/**
 * Validates a relative POSIX symlink target and proves resolving it from the
 * link's parent cannot escape the workspace archive root.
 */
export function validateSymlinkTarget(path: string, target: string, limits: WorkspaceManifestLimits = defaultWorkspaceManifestLimits): string {
  validateWorkspacePath(path, limits)
  if (target.length === 0 || target.startsWith('/') || target.includes('\0') || target.includes('\\')) invalid('symlink target must be a non-empty relative POSIX path')
  if (target !== target.normalize('NFC')) invalid('symlink target must use NFC Unicode normalization')
  if (bytes(target) > limits.maxLinkTargetBytes) quota('symlink target byte limit exceeded')
  const targetSegments = target.split('/')
  if (targetSegments.some(segment => segment.length === 0 || segment === '.')) invalid('symlink target is not canonical')
  if (targetSegments.some(segment => /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(segment))) invalid('symlink target contains a control character')

  const resolved = path.split('/').slice(0, -1)
  for (const segment of targetSegments) {
    if (segment === '..') {
      if (resolved.length === 0) invalid('symlink target escapes the workspace')
      resolved.pop()
    } else {
      resolved.push(segment)
    }
  }
  return target
}

function validateMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) invalid('entry mode must be a POSIX permission mode')
}

function validateDigest(digest: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) invalid('file digest must be a lowercase sha256 digest')
}

function validateIdentity(identity: string): void {
  if (identity.trim().length === 0 || bytes(identity) > 512 || /[\u0000-\u001f\u007f]/u.test(identity)) invalid('manifest identity is invalid')
}

function canonicalEntry(entry: WorkspaceEntry, limits: WorkspaceManifestLimits): WorkspaceEntry {
  validateWorkspacePath(entry.path, limits)
  validateMode(entry.mode)
  switch (entry.type) {
    case 'directory':
      return { path: entry.path, type: entry.type, mode: entry.mode }
    case 'file':
      validateDigest(entry.digest)
      if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) invalid('file size must be a non-negative safe integer')
      if (entry.sizeBytes > limits.maxFileBytes) quota('per-file byte limit exceeded')
      return { path: entry.path, type: entry.type, mode: entry.mode, digest: entry.digest, sizeBytes: entry.sizeBytes }
    case 'symlink':
      validateSymlinkTarget(entry.path, entry.linkTarget, limits)
      return { path: entry.path, type: entry.type, mode: entry.mode, linkTarget: entry.linkTarget }
    default:
      return invalid('unsupported workspace entry type')
  }
}

/** Recursively sorts object keys while preserving array order. */
export function canonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit)
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => compareText(left, right)).map(([key, child]) => [key, visit(child)]))
    }
    if (typeof item === 'number' && !Number.isFinite(item)) invalid('canonical JSON cannot contain a non-finite number')
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'undefined') invalid('canonical JSON contains an unsupported value')
    return item
  }
  return JSON.stringify(visit(value))
}

export function createWorkspaceManifest(
  identity: string,
  entries: readonly WorkspaceEntry[],
  limits: WorkspaceManifestLimits = defaultWorkspaceManifestLimits,
): WorkspaceManifest {
  validateLimits(limits)
  validateIdentity(identity)
  if (entries.length > limits.maxEntries) quota('workspace entry limit exceeded')
  const canonicalEntries = entries.map(entry => canonicalEntry(entry, limits)).sort((left, right) => compareText(left.path, right.path))
  const entriesByPath = new Map(canonicalEntries.map(entry => [entry.path, entry]))
  let files = 0
  let totalBytes = 0
  let previous: string | undefined
  for (const entry of canonicalEntries) {
    if (entry.path === previous) invalid('workspace manifest contains a duplicate path')
    previous = entry.path
    const segments = entry.path.split('/')
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = entriesByPath.get(segments.slice(0, length).join('/'))
      if (ancestor && ancestor.type !== 'directory') {
        invalid('workspace manifest contains a non-directory ancestor')
      }
    }
    if (entry.type === 'file') {
      files += 1
      totalBytes += entry.sizeBytes
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) quota('workspace total byte limit exceeded')
    }
  }
  if (files > limits.maxFiles) quota('workspace file limit exceeded')
  const manifest: WorkspaceManifest = { version: 1, identity, entries: canonicalEntries }
  if (bytes(canonicalJson(manifest)) > limits.maxManifestBytes) quota('workspace manifest byte limit exceeded')
  return manifest
}

export function workspaceManifestChecksum(manifest: WorkspaceManifest): string {
  return `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`
}

/** Parses exact canonical manifest bytes and reapplies every structural and quota check. */
export function parseWorkspaceManifest(
  value: Uint8Array,
  expectedIdentity: string,
  expectedChecksum: string,
  limits: WorkspaceManifestLimits = defaultWorkspaceManifestLimits,
): WorkspaceManifest {
  validateLimits(limits)
  validateIdentity(expectedIdentity)
  if (!(value instanceof Uint8Array)) invalid('workspace manifest must be bytes')
  if (value.byteLength > limits.maxManifestBytes) quota('workspace manifest byte limit exceeded')
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedChecksum)) invalid('workspace manifest checksum is invalid')
  const actualChecksum = `sha256:${createHash('sha256').update(value).digest('hex')}`
  if (actualChecksum !== expectedChecksum) invalid('workspace manifest checksum mismatch')
  let text: string
  try { text = utf8Decoder.decode(value) }
  catch { return invalid('workspace manifest is not valid UTF-8') }
  let decoded: unknown
  try { decoded = JSON.parse(text) }
  catch { return invalid('workspace manifest is not valid JSON') }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return invalid('workspace manifest must be an object')
  }
  const record = decoded as Record<string, unknown>
  const keys = Object.keys(record).sort(compareText)
  if (keys.length !== 3 || keys[0] !== 'entries' || keys[1] !== 'identity' || keys[2] !== 'version'
    || record.version !== 1 || record.identity !== expectedIdentity || !Array.isArray(record.entries)) {
    return invalid('workspace manifest has an invalid shape')
  }
  let canonical: string
  try { canonical = canonicalJson(decoded) }
  catch { return invalid('workspace manifest is not canonical JSON') }
  if (canonical !== text) invalid('workspace manifest bytes are not canonical JSON')
  const manifest = createWorkspaceManifest(
    expectedIdentity, record.entries as WorkspaceEntry[], limits)
  if (canonicalJson(manifest) !== canonical) invalid('workspace manifest is not canonical or exact-shape')
  return manifest
}

function sameEntry(left: WorkspaceEntry | null, right: WorkspaceEntry | null): boolean {
  if (left === null || right === null) return left === right
  return canonicalJson(left) === canonicalJson(right)
}

function entryMap(manifest: WorkspaceManifest): Map<string, WorkspaceEntry> {
  return new Map(manifest.entries.map(entry => [entry.path, entry]))
}

export function diffWorkspaceManifests(
  base: WorkspaceManifest,
  current: WorkspaceManifest,
  limits: WorkspaceManifestLimits = defaultWorkspaceManifestLimits,
): WorkspaceChange[] {
  validateLimits(limits)
  const baseEntries = entryMap(base)
  const currentEntries = entryMap(current)
  const paths = [...new Set([...baseEntries.keys(), ...currentEntries.keys()])].sort(compareText)
  const changes: WorkspaceChange[] = []
  for (const path of paths) {
    const before = baseEntries.get(path) ?? null
    const after = currentEntries.get(path) ?? null
    if (!sameEntry(before, after)) changes.push({ path, base: before, current: after })
  }
  if (changes.length > limits.maxChanges) quota('workspace change limit exceeded')
  return changes
}

export function canonicalWorkspaceFileUri(path: string): string {
  validateWorkspacePath(path)
  return `file:///workspace/${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
}

/**
 * Finds all three-way conflicts before applying the response cap. A path is a
 * conflict exactly when target differs from both the base and proposed entry.
 */
export function collectThreeWayConflicts(
  changes: readonly WorkspaceChange[],
  target: WorkspaceManifest,
  maxPaths = 256,
): ConflictCollection {
  if (!Number.isSafeInteger(maxPaths) || maxPaths < 0 || maxPaths > 256) invalid('conflict path cap must be between zero and 256')
  const targetEntries = entryMap(target)
  const conflicts = changes
    .filter(change => {
      const targetEntry = targetEntries.get(change.path) ?? null
      return !sameEntry(targetEntry, change.base) && !sameEntry(targetEntry, change.current)
    })
    .map(change => canonicalWorkspaceFileUri(change.path))
    .sort(compareText)
  return { paths: conflicts.slice(0, maxPaths), total: conflicts.length, truncated: conflicts.length > maxPaths }
}

/** Truncates without splitting a Unicode code point. */
export function boundedRejectionReason(reason: string, maxBytes = 4_096): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) invalid('rejection byte cap must be a non-negative safe integer')
  if (bytes(reason) <= maxBytes) return reason
  let result = ''
  let used = 0
  for (const character of reason) {
    const characterBytes = bytes(character)
    if (used + characterBytes > maxBytes) break
    result += character
    used += characterBytes
  }
  return result
}
