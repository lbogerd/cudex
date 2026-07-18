import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  parsePatchArtifact,
  serializePatchArtifact,
  type CanonicalPatchArtifact,
  type PatchContentObject,
} from '../src/patch-artifact.js'
import { canonicalJson, createWorkspaceManifest, defaultWorkspaceManifestLimits, type WorkspaceEntry } from '../src/workspace-manifest.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const file = (path: string, character: string, sizeBytes: number, mode = 0o644): WorkspaceEntry => ({
  path, type: 'file', mode, digest: digest(character), sizeBytes,
})

function fixture() {
  const baseManifest = createWorkspaceManifest('snapshot-base', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/dir', type: 'directory', mode: 0o755 },
    file('roots/binary', 'a', 4), file('roots/mode', 'b', 3, 0o644), file('roots/deleted', 'c', 6),
    { path: 'roots/link', type: 'symlink', mode: 0o777, linkTarget: 'binary' },
  ])
  const currentManifest = createWorkspaceManifest('snapshot-current', [
    { path: 'roots', type: 'directory', mode: 0o755 },
    { path: 'roots/dir', type: 'directory', mode: 0o700 },
    file('roots/added', 'd', 5), file('roots/binary', 'e', 4), file('roots/mode', 'b', 3, 0o755),
    { path: 'roots/link', type: 'symlink', mode: 0o777, linkTarget: 'added' },
  ])
  const contentObjects: PatchContentObject[] = [
    { path: 'roots/mode', objectId: 'b'.repeat(64) },
    { path: 'roots/binary', objectId: 'e'.repeat(64) },
    { path: 'roots/added', objectId: 'd'.repeat(64) },
  ]
  return { agentId: 'agent-1', baseSnapshotId: 'snapshot-base', currentSnapshotId: 'snapshot-current', baseManifest, currentManifest, contentObjects }
}

function recanonicalize(artifact: CanonicalPatchArtifact): Uint8Array {
  return new TextEncoder().encode(canonicalJson(artifact))
}

function checksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

test('serialization is deterministic and contains manifests and content IDs without file bodies', () => {
  const input = fixture()
  const first = serializePatchArtifact(input)
  const second = serializePatchArtifact({ ...input, contentObjects: [...input.contentObjects].reverse() })
  assert.deepEqual(first.bytes, second.bytes)
  assert.equal(first.checksum, second.checksum)
  assert.equal(first.changedFiles, 6)
  assert.equal(first.sizeBytes, 12)
  assert.deepEqual(first.contentObjectIds, ['b'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)])
  assert.deepEqual(first.artifact.changes.map(change => change.path), [
    'roots/added', 'roots/binary', 'roots/deleted', 'roots/dir', 'roots/link', 'roots/mode',
  ])
  assert.equal(Buffer.from(first.bytes).includes(Buffer.from([0, 255, 128])), false)
  assert.deepEqual(parsePatchArtifact(first.bytes, first.checksum).artifact, first.artifact)
})

test('serializer rejects missing, mismatched, duplicate, non-file, and unused content references', () => {
  const input = fixture()
  assert.throws(() => serializePatchArtifact({ ...input, contentObjects: input.contentObjects.slice(1) }), /does not match/)
  assert.throws(() => serializePatchArtifact({ ...input, contentObjects: input.contentObjects.map(reference =>
    reference.path === 'roots/binary' ? { ...reference, objectId: 'f'.repeat(64) } : reference) }), /does not match/)
  assert.throws(() => serializePatchArtifact({ ...input, contentObjects: [...input.contentObjects, input.contentObjects[0]!] }), /duplicate/)
  assert.throws(() => serializePatchArtifact({ ...input, contentObjects: [...input.contentObjects,
    { path: 'roots/link', objectId: 'a'.repeat(64) }] }), /non-file/)
  assert.throws(() => serializePatchArtifact({ ...input, contentObjects: [...input.contentObjects,
    { path: 'roots/unchanged', objectId: 'a'.repeat(64) }] }), /unused/)
  assert.throws(() => serializePatchArtifact({ ...input, agentId: ' agent-1' }), /agent ID/)
  assert.throws(() => serializePatchArtifact({ ...input, agentId: '\ud800' }), /agent ID/)
  assert.throws(() => serializePatchArtifact(input, {
    maxArtifactBytes: 64 * 1024 * 1024, maxAgentIdBytes: 512,
    workspace: { ...defaultWorkspaceManifestLimits, maxChanges: 1 },
  }), error => error instanceof Error && 'kind' in error && error.kind === 'quota')
})

test('parser rejects checksum mismatch, noncanonical bytes, invalid UTF-8, and byte quota', () => {
  const serialized = serializePatchArtifact(fixture())
  assert.throws(() => parsePatchArtifact(serialized.bytes, `sha256:${'0'.repeat(64)}`), /checksum/)
  const padded = Buffer.concat([serialized.bytes, Buffer.from('\n')])
  assert.throws(() => parsePatchArtifact(padded, checksum(padded)), /canonical/)
  const invalidUtf8 = Uint8Array.from([0xff])
  assert.throws(() => parsePatchArtifact(invalidUtf8, checksum(invalidUtf8)), /UTF-8/)
  assert.throws(() => parsePatchArtifact(serialized.bytes, serialized.checksum, {
    maxArtifactBytes: serialized.bytes.byteLength - 1, maxAgentIdBytes: 512,
    workspace: { ...defaultWorkspaceManifestLimits },
  }), /byte limit/)
})

test('parser rejects extra shape and inconsistent identities, changes, counts, sizes, and content IDs', () => {
  const serialized = serializePatchArtifact(fixture())
  const cases: CanonicalPatchArtifact[] = []
  cases.push({ ...structuredClone(serialized.artifact), changedFiles: 99 })
  cases.push({ ...structuredClone(serialized.artifact), sizeBytes: 99 })
  cases.push({ ...structuredClone(serialized.artifact), baseSnapshotId: 'wrong-base' })
  const missing = structuredClone(serialized.artifact); missing.changes.pop(); cases.push(missing)
  const reordered = structuredClone(serialized.artifact); reordered.changes.reverse(); cases.push(reordered)
  const wrongContent = structuredClone(serialized.artifact); wrongContent.changes[0]!.contentObjectId = 'f'.repeat(64); cases.push(wrongContent)
  for (const artifact of cases) {
    const bytes = recanonicalize(artifact)
    assert.throws(() => parsePatchArtifact(bytes, checksum(bytes)))
  }

  const extra = { ...structuredClone(serialized.artifact), unexpected: true }
  const extraBytes = new TextEncoder().encode(canonicalJson(extra))
  assert.throws(() => parsePatchArtifact(extraBytes, checksum(extraBytes)), /shape/)
})

test('manifest exact shape and canonical entry ordering are enforced', () => {
  const serialized = serializePatchArtifact(fixture())
  const extraEntry = structuredClone(serialized.artifact) as CanonicalPatchArtifact & { baseManifest: WorkspaceManifestWithUnknown }
  type WorkspaceManifestWithUnknown = CanonicalPatchArtifact['baseManifest'] & { unexpected?: boolean }
  extraEntry.baseManifest.unexpected = true
  const extraBytes = recanonicalize(extraEntry)
  assert.throws(() => parsePatchArtifact(extraBytes, checksum(extraBytes)), /shape/)

  const unsorted = structuredClone(serialized.artifact)
  unsorted.currentManifest.entries.reverse()
  const unsortedBytes = recanonicalize(unsorted)
  assert.throws(() => parsePatchArtifact(unsortedBytes, checksum(unsortedBytes)), /canonical/)
})
