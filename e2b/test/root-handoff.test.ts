import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertRootHandoff } from '../src/root-handoff.js'

test('root return requires the exact successful shutdown checkpoint, not only a clean exit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cudex-handoff-'))
  const root = { agentId: randomUUID(), leaseId: 'lease-restored', environmentId: 'environment-restored',
    ownerAgentId: null, ownerLeaseId: null, providerSandboxId: 'sandbox-restored',
    baseSnapshotId: 'restore-base', latestSnapshotId: 'final-checkpoint', state: 'active' }
  const path = join(home, 'cudex-runtime', 'hosted-runtime-v1', `${root.agentId}.json`)
  const valid = { version: 1, deleting: false, deleted: false, pending: null, finalization: null,
    handoffSnapshotId: root.latestSnapshotId,
    request: { agentId: root.agentId, ownerAgentId: null, source: { type: 'sourceSnapshot', sourceSnapshotId: 'source-original' } },
    record: { ownerAgentId: null, leaseId: root.leaseId, environmentId: root.environmentId,
      latestSnapshotId: root.latestSnapshotId, lifecycleState: 'active', referenceRevision: 2 } }
  try {
    await mkdir(join(home, 'cudex-runtime', 'hosted-runtime-v1'), { recursive: true })
    await assert.rejects(assertRootHandoff(home, root, 'source-original'))
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 })
    await assertRootHandoff(home, root, 'source-original')
    for (const invalid of [
      { ...valid, handoffSnapshotId: null },
      { ...valid, handoffSnapshotId: 'stale-checkpoint' },
      { ...valid, pending: 'checkpoint' },
      { ...valid, deleting: true },
      { ...valid, record: { ...valid.record, leaseId: 'retired-lease' } },
    ]) {
      await writeFile(path, JSON.stringify(invalid), { mode: 0o600 })
      await assert.rejects(assertRootHandoff(home, root, 'source-original'))
    }
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 })
    await assert.rejects(assertRootHandoff(home, root, 'different-source'))
  } finally { await rm(home, { recursive: true, force: true }) }
})
