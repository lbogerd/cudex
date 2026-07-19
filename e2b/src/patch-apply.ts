import {
  parsePatchArtifact,
  type SerializedPatchArtifact,
} from './patch-artifact.js'
import {
  WorkspaceManifestError,
  boundedRejectionReason,
  collectThreeWayConflicts,
  createWorkspaceManifest,
  diffWorkspaceManifests,
  type WorkspaceEntry,
  type WorkspaceManifest,
} from './workspace-manifest.js'

export interface PlannedContentObject {
  path: string
  objectId: string
  checksum: string
  sizeBytes: number
}

export interface PatchContentMaterial {
  objectId: string
  checksum: string
  sizeBytes: number
}

export type PatchApplicationPlan =
  | { type: 'ready'; manifest: WorkspaceManifest; contentObjects: PlannedContentObject[] }
  | { type: 'conflict'; paths: string[]; total: number; truncated: boolean }
  | { type: 'rejected'; reason: string }

export interface PlanPatchApplicationInput {
  artifact: SerializedPatchArtifact
  targetManifest: WorkspaceManifest
  resultSnapshotId: string
  targetContentObjects: PatchContentMaterial[]
  artifactContentObjects: PatchContentMaterial[]
}

class RejectedPlan extends Error {}

function rejected(reason: string): PatchApplicationPlan {
  return { type: 'rejected', reason: boundedRejectionReason(reason) }
}

function validateMaterial(value: PatchContentMaterial): void {
  if (!value || typeof value.objectId !== 'string' || !value.objectId.trim()
    || Buffer.byteLength(value.objectId) > 512
    || !/^sha256:[0-9a-f]{64}$/u.test(value.checksum)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) {
    throw new RejectedPlan('patch content metadata is invalid')
  }
}

function materialById(values: PatchContentMaterial[]): Map<string, PatchContentMaterial> {
  if (!Array.isArray(values) || values.length > 100_000) {
    throw new RejectedPlan('patch content metadata exceeds its limit')
  }
  const result = new Map<string, PatchContentMaterial>()
  for (const value of values) {
    validateMaterial(value)
    if (result.has(value.objectId)) throw new RejectedPlan('patch content metadata is duplicated')
    result.set(value.objectId, { ...value })
  }
  return result
}

function manifestContent(manifest: WorkspaceManifest,
  values: PatchContentMaterial[]): Map<string, PlannedContentObject> {
  const objects = materialById(values)
  const used = new Set<string>()
  const result = new Map<string, PlannedContentObject>()
  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue
    const matches = [...objects.values()].filter(object =>
      object.checksum === entry.digest && object.sizeBytes === entry.sizeBytes)
    if (matches.length !== 1) throw new RejectedPlan('workspace file content is unavailable')
    const object = matches[0]!
    used.add(object.objectId)
    result.set(entry.path, { path: entry.path, ...object })
  }
  if (used.size !== objects.size) throw new RejectedPlan('workspace content metadata is unused')
  return result
}

function artifactContent(artifact: SerializedPatchArtifact,
  values: PatchContentMaterial[]): Map<string, PatchContentMaterial> {
  const objects = materialById(values)
  const expected = new Set(artifact.contentObjectIds)
  if (expected.size !== objects.size || [...expected].some(objectId => !objects.has(objectId))) {
    throw new RejectedPlan('patch artifact content set is incomplete')
  }
  const currentByPath = new Map(artifact.artifact.currentManifest.entries.map(entry => [entry.path, entry]))
  const used = new Set<string>()
  for (const change of artifact.artifact.changes) {
    if (change.contentObjectId === null) continue
    const entry = currentByPath.get(change.path)
    const object = objects.get(change.contentObjectId)
    if (!entry || entry.type !== 'file' || !object
      || object.checksum !== entry.digest || object.sizeBytes !== entry.sizeBytes) {
      throw new RejectedPlan('patch artifact content does not match its manifest')
    }
    used.add(object.objectId)
  }
  if (used.size !== objects.size) throw new RejectedPlan('patch artifact content metadata is unused')
  return objects
}

/** Builds a complete mutation-free three-way plan from already resolved durable material. */
export function planPatchApplication(input: PlanPatchApplicationInput): PatchApplicationPlan {
  try {
    const artifact = parsePatchArtifact(input.artifact.bytes, input.artifact.checksum)
    const targetManifest = createWorkspaceManifest(
      input.targetManifest.identity, input.targetManifest.entries)
    const targetContent = manifestContent(targetManifest, input.targetContentObjects)
    const changedContent = artifactContent(artifact, input.artifactContentObjects)
    const changes = diffWorkspaceManifests(
      artifact.artifact.baseManifest, artifact.artifact.currentManifest)
    const conflicts = collectThreeWayConflicts(changes, targetManifest)
    if (conflicts.total > 0) return { type: 'conflict', ...conflicts }

    const entries = new Map<string, WorkspaceEntry>(
      targetManifest.entries.map(entry => [entry.path, entry]))
    const content = new Map(targetContent)
    const contentIdByPath = new Map(artifact.artifact.changes.map(change =>
      [change.path, change.contentObjectId] as const))
    for (const change of changes) {
      if (change.current === null) {
        entries.delete(change.path)
        content.delete(change.path)
        continue
      }
      entries.set(change.path, change.current)
      if (change.current.type !== 'file') {
        content.delete(change.path)
        continue
      }
      const objectId = contentIdByPath.get(change.path)
      const object = objectId ? changedContent.get(objectId) : undefined
      if (!object || object.checksum !== change.current.digest
        || object.sizeBytes !== change.current.sizeBytes) {
        throw new RejectedPlan('patch artifact content is unavailable')
      }
      content.set(change.path, { path: change.path, ...object })
    }
    const manifest = createWorkspaceManifest(input.resultSnapshotId, [...entries.values()])
    const files = new Set(manifest.entries.filter(entry => entry.type === 'file').map(entry => entry.path))
    if (files.size !== content.size || [...files].some(path => !content.has(path))) {
      throw new RejectedPlan('planned workspace content is incomplete')
    }
    return {
      type: 'ready', manifest,
      contentObjects: [...content.values()].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    }
  } catch (error) {
    if (error instanceof RejectedPlan) return rejected(error.message)
    if (error instanceof WorkspaceManifestError) return rejected(error.message)
    return rejected('patch material is invalid')
  }
}
