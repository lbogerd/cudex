import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { planPatchApplication, type PatchContentMaterial } from '../src/patch-apply.js'
import { serializePatchArtifact } from '../src/patch-artifact.js'
import {
  createWorkspaceManifest,
  type WorkspaceEntry,
  type WorkspaceManifest,
} from '../src/workspace-manifest.js'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const checksum = (value: Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`
const file = (path: string, value: Uint8Array, mode = 0o644): WorkspaceEntry => ({
  path, type: 'file', mode, digest: checksum(value), sizeBytes: value.byteLength,
})
const material = (objectId: string, value: Uint8Array): PatchContentMaterial => ({
  objectId, checksum: checksum(value), sizeBytes: value.byteLength,
})

function artifact(base: WorkspaceManifest, current: WorkspaceManifest,
  content: Array<{ path: string; objectId: string }>) {
  return serializePatchArtifact({
    agentId: 'agent-child', baseSnapshotId: base.identity,
    currentSnapshotId: current.identity, baseManifest: base, currentManifest: current,
    contentObjects: content,
  })
}

test('ready plan applies every file type and preserves unrelated target changes', () => {
  const old = bytes('old'); const changed = bytes('changed'); const removed = bytes('removed')
  const binary = Uint8Array.from([0, 255, 1, 2]); const owner = bytes('owner')
  const base = createWorkspaceManifest('snapshot-base', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/changed', old),
    file('roots/removed', removed), { path: 'roots/old-dir', type: 'directory', mode: 0o755 },
  ])
  const current = createWorkspaceManifest('snapshot-current', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/changed', changed, 0o755),
    file('roots/added.bin', binary), { path: 'roots/new-dir', type: 'directory', mode: 0o700 },
    { path: 'roots/link', type: 'symlink', mode: 0o777, linkTarget: 'new-dir' },
  ])
  const target = createWorkspaceManifest('snapshot-target', [
    ...base.entries, file('roots/owner.txt', owner),
  ])
  const plan = planPatchApplication({
    artifact: artifact(base, current, [
      { path: 'roots/changed', objectId: 'content-changed' },
      { path: 'roots/added.bin', objectId: 'content-binary' },
    ]),
    targetManifest: target, resultSnapshotId: 'snapshot-result',
    targetContentObjects: [material('content-old', old), material('content-removed', removed),
      material('content-owner', owner)],
    artifactContentObjects: [material('content-changed', changed), material('content-binary', binary)],
  })
  assert.equal(plan.type, 'ready')
  if (plan.type !== 'ready') return
  assert.deepEqual(plan.manifest, createWorkspaceManifest('snapshot-result', [
    ...current.entries, file('roots/owner.txt', owner),
  ]))
  assert.deepEqual(plan.contentObjects.map(object => [object.path, object.objectId]), [
    ['roots/added.bin', 'content-binary'], ['roots/changed', 'content-changed'],
    ['roots/owner.txt', 'content-owner'],
  ])
})

test('planner collects and canonically caps every conflict before mutation', () => {
  const baseEntries: WorkspaceEntry[] = [{ path: 'roots', type: 'directory', mode: 0o755 }]
  const currentEntries: WorkspaceEntry[] = [{ path: 'roots', type: 'directory', mode: 0o755 }]
  const targetEntries: WorkspaceEntry[] = [{ path: 'roots', type: 'directory', mode: 0o755 }]
  const artifactContentObjects: PatchContentMaterial[] = []
  const targetContentObjects: PatchContentMaterial[] = []
  const references: Array<{ path: string; objectId: string }> = []
  for (let index = 0; index < 300; index += 1) {
    const path = `roots/file-${String(index).padStart(3, '0')}`
    const baseBytes = bytes(`base-${index}`); const currentBytes = bytes(`agent-${index}`)
    const targetBytes = bytes(`owner-${index}`); const artifactId = `artifact-${index}`
    const targetId = `target-${index}`
    baseEntries.push(file(path, baseBytes)); currentEntries.push(file(path, currentBytes))
    targetEntries.push(file(path, targetBytes)); references.push({ path, objectId: artifactId })
    artifactContentObjects.push(material(artifactId, currentBytes))
    targetContentObjects.push(material(targetId, targetBytes))
  }
  const base = createWorkspaceManifest('snapshot-base', baseEntries)
  const current = createWorkspaceManifest('snapshot-current', currentEntries)
  const plan = planPatchApplication({
    artifact: artifact(base, current, references),
    targetManifest: createWorkspaceManifest('snapshot-target', targetEntries),
    resultSnapshotId: 'snapshot-result', targetContentObjects, artifactContentObjects,
  })
  assert.equal(plan.type, 'conflict')
  if (plan.type !== 'conflict') return
  assert.equal(plan.total, 300); assert.equal(plan.truncated, true); assert.equal(plan.paths.length, 256)
  assert.equal(plan.paths[0], 'file:///workspace/roots/file-000')
  assert.equal(plan.paths[255], 'file:///workspace/roots/file-255')
})

test('target paths already equal to artifact current apply without conflict', () => {
  const baseBytes = bytes('base'); const currentBytes = bytes('current')
  const base = createWorkspaceManifest('snapshot-base', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/file', baseBytes),
  ])
  const current = createWorkspaceManifest('snapshot-current', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/file', currentBytes),
  ])
  const plan = planPatchApplication({
    artifact: artifact(base, current, [{ path: 'roots/file', objectId: 'content-current' }]),
    targetManifest: createWorkspaceManifest('snapshot-target', current.entries),
    resultSnapshotId: 'snapshot-result',
    targetContentObjects: [material('content-current', currentBytes)],
    artifactContentObjects: [material('content-current', currentBytes)],
  })
  assert.equal(plan.type, 'ready')
})

test('planner rejects incomplete content and hierarchy collisions without a ready plan', () => {
  const old = bytes('old'); const changed = bytes('changed')
  const base = createWorkspaceManifest('snapshot-base', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/node', type: 'directory', mode: 0o755 }, file('roots/node/child', old),
  ])
  const current = createWorkspaceManifest('snapshot-current', [
    { path: 'roots', type: 'directory', mode: 0o755 }, file('roots/node', changed),
  ])
  const serialized = artifact(base, current, [{ path: 'roots/node', objectId: 'content-changed' }])
  const incomplete = planPatchApplication({
    artifact: serialized, targetManifest: base, resultSnapshotId: 'snapshot-result',
    targetContentObjects: [], artifactContentObjects: [material('content-changed', changed)],
  })
  assert.deepEqual(incomplete, { type: 'rejected', reason: 'workspace file content is unavailable' })

  const targetWithUnrelatedChild = createWorkspaceManifest('snapshot-target', [
    ...base.entries, file('roots/node/owner-child', old),
  ])
  const collision = planPatchApplication({
    artifact: serialized, targetManifest: targetWithUnrelatedChild,
    resultSnapshotId: 'snapshot-result',
    targetContentObjects: [material('content-old', old)],
    artifactContentObjects: [material('content-changed', changed)],
  })
  assert.deepEqual(collision, {
    type: 'rejected', reason: 'workspace manifest contains a non-directory ancestor',
  })
})
