import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  canonicalJson,
  createWorkspaceManifest,
  defaultWorkspaceManifestLimits,
  diffWorkspaceManifests,
  WorkspaceManifestError,
  type WorkspaceManifest,
  type WorkspaceManifestLimits,
} from './workspace-manifest.js'

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const checksumPattern = /^sha256:[0-9a-f]{64}$/

export interface PatchArtifactLimits {
  maxArtifactBytes: number
  maxAgentIdBytes: number
  workspace: WorkspaceManifestLimits
}

export const defaultPatchArtifactLimits: PatchArtifactLimits = {
  maxArtifactBytes: 64 * 1024 * 1024,
  maxAgentIdBytes: 512,
  workspace: defaultWorkspaceManifestLimits,
}

export interface PatchContentObject {
  path: string
  objectId: string
}

export interface PatchChangeReference {
  path: string
  contentObjectId: string | null
}

export interface CanonicalPatchArtifact {
  version: 1
  agentId: string
  baseSnapshotId: string
  currentSnapshotId: string
  baseManifest: WorkspaceManifest
  currentManifest: WorkspaceManifest
  changes: PatchChangeReference[]
  changedFiles: number
  sizeBytes: number
}

export interface CreatePatchArtifactInput {
  agentId: string
  baseSnapshotId: string
  currentSnapshotId: string
  baseManifest: WorkspaceManifest
  currentManifest: WorkspaceManifest
  contentObjects: readonly PatchContentObject[]
}

export interface SerializedPatchArtifact {
  artifact: CanonicalPatchArtifact
  bytes: Uint8Array
  checksum: string
  contentObjectIds: string[]
  changedFiles: number
  sizeBytes: number
}

export class PatchArtifactFormatError extends Error {
  constructor(public readonly kind: 'invalid' | 'quota', message: string) {
    super(message)
    this.name = 'PatchArtifactFormatError'
  }
}

const invalid = (message: string): PatchArtifactFormatError => new PatchArtifactFormatError('invalid', message)
const quota = (message: string): PatchArtifactFormatError => new PatchArtifactFormatError('quota', message)
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function validateLimits(limits: PatchArtifactLimits): void {
  if (!Number.isSafeInteger(limits.maxArtifactBytes) || limits.maxArtifactBytes < 0) throw invalid('invalid artifact byte limit')
  if (!Number.isSafeInteger(limits.maxAgentIdBytes) || limits.maxAgentIdBytes < 1) throw invalid('invalid agent ID byte limit')
}

function validateId(label: string, value: string, maxBytes = 512): void {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || Buffer.from(value, 'utf8').toString('utf8') !== value || Buffer.byteLength(value) > maxBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid(`invalid ${label}`)
}

function canonicalManifest(manifest: WorkspaceManifest, snapshotId: string, limits: WorkspaceManifestLimits): WorkspaceManifest {
  if (manifest.identity !== snapshotId) throw invalid('manifest identity does not match snapshot identity')
  let canonical: WorkspaceManifest
  try { canonical = createWorkspaceManifest(manifest.identity, manifest.entries, limits) }
  catch (error) {
    if (error instanceof WorkspaceManifestError) {
      throw error.kind === 'quota' ? quota(error.message) : invalid(error.message)
    }
    throw invalid('invalid workspace manifest')
  }
  if (canonicalJson(canonical) !== canonicalJson(manifest)) throw invalid('workspace manifest is not canonical or exact-shape')
  return canonical
}

function artifactChecksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function serializePatchArtifact(
  input: CreatePatchArtifactInput,
  limits: PatchArtifactLimits = defaultPatchArtifactLimits,
): SerializedPatchArtifact {
  validateLimits(limits)
  validateId('agent ID', input.agentId, limits.maxAgentIdBytes)
  validateId('base snapshot ID', input.baseSnapshotId)
  validateId('current snapshot ID', input.currentSnapshotId)
  const baseManifest = canonicalManifest(input.baseManifest, input.baseSnapshotId, limits.workspace)
  const currentManifest = canonicalManifest(input.currentManifest, input.currentSnapshotId, limits.workspace)
  const diff = diffWorkspaceManifests(baseManifest, currentManifest, limits.workspace)

  if (!Array.isArray(input.contentObjects) || input.contentObjects.length > limits.workspace.maxChanges) throw quota('patch content reference limit exceeded')
  const contentByPath = new Map<string, string>()
  for (const reference of input.contentObjects) {
    if (!reference || typeof reference.path !== 'string') throw invalid('invalid patch content reference')
    validateId('patch content object ID', reference.objectId)
    if (contentByPath.has(reference.path)) throw invalid('duplicate patch content path')
    contentByPath.set(reference.path, reference.objectId)
  }

  let sizeBytes = 0
  const usedContentPaths = new Set<string>()
  const changes = diff.map(change => {
    let contentObjectId: string | null = null
    if (change.current?.type === 'file') {
      contentObjectId = contentByPath.get(change.path) ?? null
      if (contentObjectId === null) throw invalid('changed file does not have a content object')
      usedContentPaths.add(change.path)
      sizeBytes += change.current.sizeBytes
      if (!Number.isSafeInteger(sizeBytes)) throw quota('patch size exceeds safe integer range')
    } else if (contentByPath.has(change.path)) {
      throw invalid('non-file change cannot reference a content object')
    }
    return { path: change.path, contentObjectId }
  })
  if (usedContentPaths.size !== contentByPath.size) throw invalid('patch contains an unused content object reference')

  const artifact: CanonicalPatchArtifact = {
    version: 1,
    agentId: input.agentId,
    baseSnapshotId: input.baseSnapshotId,
    currentSnapshotId: input.currentSnapshotId,
    baseManifest,
    currentManifest,
    changes,
    changedFiles: changes.length,
    sizeBytes,
  }
  const bytes = utf8Encoder.encode(canonicalJson(artifact))
  if (bytes.byteLength > limits.maxArtifactBytes) throw quota('patch artifact byte limit exceeded')
  return {
    artifact,
    bytes,
    checksum: artifactChecksum(bytes),
    contentObjectIds: [...new Set(changes.flatMap(change => change.contentObjectId ? [change.contentObjectId] : []))].sort(compareText),
    changedFiles: changes.length,
    sizeBytes,
  }
}

const embeddedManifestSchema = z.strictObject({ version: z.literal(1), identity: z.string(), entries: z.array(z.unknown()) })
const patchChangeSchema = z.strictObject({ path: z.string(), contentObjectId: z.string().nullable() })
export const PatchArtifactSchema = z.strictObject({ version: z.literal(1), agentId: z.string(),
  baseSnapshotId: z.string(), currentSnapshotId: z.string(), baseManifest: embeddedManifestSchema,
  currentManifest: embeddedManifestSchema, changes: z.array(patchChangeSchema),
  changedFiles: z.number().int().safe(), sizeBytes: z.number().int().safe() })

export function parsePatchArtifact(
  bytes: Uint8Array,
  expectedChecksum: string,
  limits: PatchArtifactLimits = defaultPatchArtifactLimits,
): SerializedPatchArtifact {
  validateLimits(limits)
  if (!(bytes instanceof Uint8Array)) throw invalid('patch artifact must be bytes')
  if (bytes.byteLength > limits.maxArtifactBytes) throw quota('patch artifact byte limit exceeded')
  if (!checksumPattern.test(expectedChecksum) || artifactChecksum(bytes) !== expectedChecksum) throw invalid('patch artifact checksum mismatch')

  let text: string
  try { text = utf8Decoder.decode(bytes) } catch { throw invalid('patch artifact is not valid UTF-8') }
  let decoded: unknown
  try { decoded = JSON.parse(text) } catch { throw invalid('patch artifact is not valid JSON') }
  let canonical: string
  try { canonical = canonicalJson(decoded) } catch { throw invalid('patch artifact is not canonical JSON') }
  if (text !== canonical) throw invalid('patch artifact bytes are not canonical JSON')

  const parsed = PatchArtifactSchema.safeParse(decoded)
  if (!parsed.success) throw invalid(parsed.error.issues.some(issue => issue.code === 'unrecognized_keys')
    ? 'patch artifact has an invalid shape' : 'patch artifact fields are invalid')
  const artifact = parsed.data
  const baseManifest = artifact.baseManifest as WorkspaceManifest
  const currentManifest = artifact.currentManifest as WorkspaceManifest
  const contentObjects: PatchContentObject[] = artifact.changes.map(change => {
    return change.contentObjectId === null ? null : { path: change.path, objectId: change.contentObjectId }
  }).filter((value): value is PatchContentObject => value !== null)

  const rebuilt = serializePatchArtifact({
    agentId: artifact.agentId,
    baseSnapshotId: artifact.baseSnapshotId,
    currentSnapshotId: artifact.currentSnapshotId,
    baseManifest,
    currentManifest,
    contentObjects,
  }, limits)
  if (canonicalJson(rebuilt.artifact) !== canonical) throw invalid('patch artifact is inconsistent with its manifests')
  return rebuilt
}
