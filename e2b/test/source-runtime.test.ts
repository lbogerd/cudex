import assert from 'node:assert/strict'
import test from 'node:test'
import type { ObjectStore } from '../src/blob-store.js'
import { defaultArchiveManifestLimits } from '../src/archive-manifest.js'
import { createSourceSnapshotRuntime } from '../src/source-runtime.js'

const objects: ObjectStore = {
  async put() { throw new Error('not used') },
  async get() { throw new Error('not used') },
  async delete() {},
  location() { return { storageBucket: 'unused', storageKey: 'unused' } },
}

function options(override: { databaseUrl?: string; tenantId?: string; required?: boolean } = {}) {
  return {
    required: override.required ?? false,
    objects,
    archiveLimits: defaultArchiveManifestLimits,
    maxRoots: 8,
    maxTtlMs: 60_000,
    ...(override.databaseUrl === undefined ? {} : { databaseUrl: override.databaseUrl }),
    ...(override.tenantId === undefined ? {} : { tenantId: override.tenantId }),
  }
}

test('source runtime is optional only when both durable database and trusted tenant are absent', async () => {
  assert.equal(await createSourceSnapshotRuntime(options()), null)
  await assert.rejects(createSourceSnapshotRuntime(options({ required: true })), /HOSTED_AGENT_DATABASE_URL/)
  await assert.rejects(createSourceSnapshotRuntime(options({ databaseUrl: 'postgresql://unused' })), /HOSTED_AGENT_TENANT_ID/)
  await assert.rejects(createSourceSnapshotRuntime(options({ tenantId: 'tenant' })), /HOSTED_AGENT_DATABASE_URL/)
})

test('source runtime validates limits before opening its database', async () => {
  await assert.rejects(createSourceSnapshotRuntime({
    ...options({ databaseUrl: 'postgresql://unused', tenantId: 'tenant' }), maxRoots: 65,
  }), /runtime limits/)
  await assert.rejects(createSourceSnapshotRuntime({
    ...options({ databaseUrl: 'postgresql://unused', tenantId: 'tenant' }), maxTtlMs: 0,
  }), /runtime limits/)
})
