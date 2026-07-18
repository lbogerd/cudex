import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  AuthenticatedSourceSnapshotApi,
  validateSourceSnapshotCreateBody,
  validateSourceSnapshotReferenceBody,
  validateSourceSnapshotResolutionBody,
  validateSourceSnapshotResolveBody,
} from '../src/source-snapshot-api.js'
import { ServiceError } from '../src/types.js'

const sourceSnapshotId = `source_${'a'.repeat(32)}`
const archive = new TextEncoder().encode('immutable archive bytes')
const checksum = `sha256:${createHash('sha256').update(archive).digest('hex')}`
const manifestChecksum = `sha256:${'b'.repeat(64)}`
const expiresAt = '2026-07-18T12:00:00.000Z'
const createBody = () => ({
  checksum,
  cwdUri: 'file:///workspace/roots/0/project/src',
  workspaceRootUris: ['file:///workspace/roots/0/project'],
  expiresAt,
})
const referenceBody = () => ({ sourceSnapshotId, checksum, expiresAt, manifestChecksum, sizeBytes: archive.byteLength })

function rejectsStatus(status: number, fn: () => unknown): void {
  assert.throws(fn, error => error instanceof ServiceError && error.status === status)
}

test('source snapshot request and response validators accept exact canonical bodies', () => {
  assert.deepEqual(validateSourceSnapshotCreateBody(createBody()), createBody())
  assert.deepEqual(validateSourceSnapshotResolveBody({ sourceSnapshotId, checksum }), { sourceSnapshotId, checksum })
  assert.deepEqual(validateSourceSnapshotReferenceBody(referenceBody()), referenceBody())
  const resolution = { ...referenceBody(), cwdUri: createBody().cwdUri, workspaceRootUris: createBody().workspaceRootUris }
  assert.deepEqual(validateSourceSnapshotResolutionBody(resolution), resolution)
})

test('source snapshot request bodies cannot supply tenant identity, archive bytes, or host paths', () => {
  rejectsStatus(400, () => validateSourceSnapshotCreateBody({ ...createBody(), tenantId: 'tenant_from_json' }))
  rejectsStatus(400, () => validateSourceSnapshotCreateBody({ ...createBody(), archive: [1, 2, 3] }))
  rejectsStatus(400, () => validateSourceSnapshotCreateBody({ ...createBody(), cwdUri: 'file:///home/user/project/src',
    workspaceRootUris: ['file:///home/user/project'] }))
  rejectsStatus(400, () => validateSourceSnapshotResolveBody({ sourceSnapshotId, checksum, tenantId: 'tenant_from_json' }))
  rejectsStatus(400, () => validateSourceSnapshotResolveBody({ sourceSnapshotId, checksum, cwd: 'file:///host/project' }))
})

test('source snapshot validators reject noncanonical identities, checksums, timestamps, roots, and JSON shapes', () => {
  rejectsStatus(400, () => validateSourceSnapshotCreateBody({ ...createBody(), checksum: `sha256:${'A'.repeat(64)}` }))
  rejectsStatus(400, () => validateSourceSnapshotCreateBody({ ...createBody(), expiresAt: '2026-07-18T12:00:00Z' }))
  rejectsStatus(400, () => validateSourceSnapshotCreateBody({ ...createBody(), workspaceRootUris: [
    'file:///workspace/roots/0/project', 'file:///workspace/roots/0/project/nested',
  ] }))
  const sparse = new Array(1)
  rejectsStatus(400, () => validateSourceSnapshotCreateBody({ ...createBody(), workspaceRootUris: sparse }))
  const accessor = { ...createBody() }
  Object.defineProperty(accessor, 'checksum', { enumerable: true, get: () => checksum })
  rejectsStatus(400, () => validateSourceSnapshotCreateBody(accessor))
  rejectsStatus(400, () => validateSourceSnapshotResolveBody({ sourceSnapshotId: 'source_short', checksum }))
})

test('source snapshot response validators fail closed with service errors', () => {
  rejectsStatus(503, () => validateSourceSnapshotReferenceBody({ ...referenceBody(), tenantId: 'tenant_leak' }))
  rejectsStatus(503, () => validateSourceSnapshotReferenceBody({ ...referenceBody(), sizeBytes: 0 }))
  rejectsStatus(503, () => validateSourceSnapshotReferenceBody({ ...referenceBody(), expiresAt: 'not-a-date' }))
  rejectsStatus(503, () => validateSourceSnapshotResolutionBody({ ...referenceBody(), cwdUri: 'file:///host/project',
    workspaceRootUris: ['file:///host/project'] }))
})

test('authenticated adapter passes tenant only through trusted context and archive only out of band', async () => {
  let createCall: unknown
  let resolveCall: unknown
  const principal = { tenantId: 'tenant_authenticated' }
  const api = new AuthenticatedSourceSnapshotApi({
    async create(receivedPrincipal, input) {
      createCall = { receivedPrincipal, input }
      return { sourceSnapshotId, checksum, expiresAt: new Date(expiresAt), manifestChecksum, sizeBytes: archive.byteLength }
    },
    async resolve(receivedPrincipal, receivedId, receivedChecksum) {
      resolveCall = { receivedPrincipal, receivedId, receivedChecksum }
      return {
        sourceSnapshotId, checksum, expiresAt: new Date(expiresAt), manifestChecksum, sizeBytes: archive.byteLength,
        archive, cwdUri: createBody().cwdUri, workspaceRootUris: createBody().workspaceRootUris,
        manifest: { version: 1, identity: sourceSnapshotId, entries: [] },
      }
    },
  })

  assert.deepEqual(await api.create(principal, createBody(), archive), referenceBody())
  const createRecord = createCall as { receivedPrincipal: unknown; input: Record<string, unknown> }
  assert.equal(createRecord.receivedPrincipal, principal)
  assert.deepEqual(Object.keys(createRecord.input).sort(), ['archive', 'checksum', 'cwdUri', 'expiresAt', 'workspaceRootUris'])
  assert.equal(createRecord.input.archive, archive)
  assert.equal(Object.hasOwn(createRecord.input, 'tenantId'), false)

  const resolution = await api.resolve(principal, { sourceSnapshotId, checksum })
  assert.deepEqual(resolveCall, { receivedPrincipal: principal, receivedId: sourceSnapshotId, receivedChecksum: checksum })
  assert.deepEqual(resolution.metadata, {
    ...referenceBody(), cwdUri: createBody().cwdUri, workspaceRootUris: createBody().workspaceRootUris,
  })
  assert.deepEqual(resolution.archive, archive)
  assert.notEqual(resolution.archive, archive)
})

test('authenticated adapter rejects invalid or oversized archive values before lifecycle dispatch', async () => {
  let creates = 0
  const api = new AuthenticatedSourceSnapshotApi({
    async create() {
      creates += 1
      throw new Error('must not dispatch')
    },
    async resolve() { throw new Error('unused') },
  })
  await assert.rejects(api.create({ tenantId: 'tenant_authenticated' }, createBody(), [] as unknown as Uint8Array),
    error => error instanceof ServiceError && error.status === 400)

  class OversizedArchive extends Uint8Array {
    override get byteLength(): number { return 512 * 1024 * 1024 + 1 }
  }
  await assert.rejects(api.create({ tenantId: 'tenant_authenticated' }, createBody(), new OversizedArchive(1)),
    error => error instanceof ServiceError && error.status === 400)
  assert.equal(creates, 0)
})

test('authenticated adapter rejects lifecycle responses that do not match the requested immutable source', async () => {
  const principal = { tenantId: 'tenant_authenticated' }
  const mismatchedCreate = new AuthenticatedSourceSnapshotApi({
    async create() {
      return { sourceSnapshotId, checksum: `sha256:${'c'.repeat(64)}`, expiresAt: new Date(expiresAt), manifestChecksum,
        sizeBytes: archive.byteLength }
    },
    async resolve() { throw new Error('unused') },
  })
  await assert.rejects(mismatchedCreate.create(principal, createBody(), archive),
    error => error instanceof ServiceError && error.status === 503)

  const corruptedResolve = new AuthenticatedSourceSnapshotApi({
    async create() { throw new Error('unused') },
    async resolve() {
      return {
        sourceSnapshotId, checksum, expiresAt: new Date(expiresAt), manifestChecksum, sizeBytes: archive.byteLength,
        archive: new TextEncoder().encode('corrupted archive'), cwdUri: createBody().cwdUri,
        workspaceRootUris: createBody().workspaceRootUris,
        manifest: { version: 1, identity: sourceSnapshotId, entries: [] },
      }
    },
  })
  await assert.rejects(corruptedResolve.resolve(principal, { sourceSnapshotId, checksum }),
    error => error instanceof ServiceError && error.status === 503)
})
