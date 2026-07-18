import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { ObjectStore } from '../src/blob-store.js'
import { PostgresRestoreSourceResolver } from '../src/postgres-restore-source.js'
import type { AuthorizedRestoreSource, RestoreSourceAuthorization } from '../src/postgres-state.js'
import { ServiceError } from '../src/types.js'

const archive = Uint8Array.from([0, 255, 17, 42])
const digest = createHash('sha256').update(archive).digest('hex')
const authorization: RestoreSourceAuthorization = {
  tenantId: 'tenant', sourceLeaseId: 'source-lease', sourceSnapshotId: 'source-snapshot',
  agentId: 'agent', ownerAgentId: null, ownerLeaseId: null, sandboxTemplate: 'general-v1',
}
const authorized = {
  lease: { leaseId: 'source-lease' }, snapshot: { snapshotId: 'source-snapshot' },
  archiveObject: {
    objectId: 'archive-object', tenantId: 'tenant', kind: 'workspace_archive',
    storageBucket: 'bucket', storageKey: `objects/${digest}`, checksum: `sha256:${digest}`,
    sizeBytes: archive.byteLength, state: 'available', expiresAt: null,
  },
} as AuthorizedRestoreSource

function store(bytes = archive, key = `objects/${digest}`): ObjectStore {
  return {
    put: async () => digest,
    get: async () => Uint8Array.from(bytes),
    delete: async () => undefined,
    location: () => ({ storageBucket: 'bucket', storageKey: key }),
  }
}

test('durable restore resolver loads the exact authorized content-addressed archive', async () => {
  const state = { lockAuthorizedRestoreSource: async (input: RestoreSourceAuthorization) => {
    assert.deepEqual(input, authorization); return authorized
  } }
  const resolved = await new PostgresRestoreSourceResolver(state, store()).resolve(authorization)
  assert.deepEqual(resolved.archive, archive)
  assert.equal(resolved.lease.leaseId, 'source-lease')
})

test('durable restore resolver fails closed on locator, digest, or size drift', async () => {
  const state = { lockAuthorizedRestoreSource: async () => authorized }
  for (const objects of [store(archive, 'wrong-key'), store(Uint8Array.from([1, 2, 3]))]) {
    await assert.rejects(new PostgresRestoreSourceResolver(state, objects).resolve(authorization),
      (error: unknown) => error instanceof ServiceError && error.status === 503
        && error.message === 'durable restore source unavailable')
  }
})
