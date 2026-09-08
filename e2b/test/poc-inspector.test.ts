import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { QueryResult } from 'pg'
import { evaluatePocCleanupInspection, evaluatePocFunctionalInspection, PocDatabaseInspector, PocProviderInspector,
  retainedFilesAreRedacted, serializePocReport,
  type PocDatabaseInspection } from '../src/poc-inspector.js'
import type { PocAppServerEvidence } from '../src/poc-app-server-client.js'

test('database inspector scopes every SQL lookup to the exact run tenant', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const database = { async query(sql: string, values: unknown[]) {
    calls.push({ sql, values })
    return { rows: sql.includes('count(*)') ? [{ count: '0' }] : [], rowCount: 0,
      command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult<Record<string, unknown>>
  } }
  const inspector = new PocDatabaseInspector(database, 'poc-run-id')
  await inspector.inspect()
  assert.equal(calls.length, 8)
  for (const call of calls) {
    assert.match(call.sql, /tenant_id = \$1/)
    assert.deepEqual(call.values, ['poc-run-id'])
  }
})

test('functional inspector requires distinct owned child, durable artifact, and advanced applied snapshot', () => {
  const evidence: PocAppServerEvidence = { rootThreadId: 'root-agent', childThreadId: 'child-agent',
    rootThreadStarted: true, rootEnvironmentReady: true, noLocalHostedCodeModeProcess: true,
    spawnAgentCompleted: true, spawnAgentCount: 1,
    spawnCallIds: ['spawn-call'], waitCompleted: true,
    rootPatchAvailable: true, childPatchAvailable: true, rootTurnCompleted: true, finalMarker: true,
    deletedThreadIds: [] }
  const database: PocDatabaseInspection = {
    leases: [
      { leaseId: 'root-lease', environmentId: 'root-env', agentId: 'root-agent', ownerAgentId: null,
        ownerLeaseId: null, providerSandboxId: 'root-sandbox', baseSnapshotId: 'base', latestSnapshotId: 'result', state: 'active' },
      { leaseId: 'child-lease', environmentId: 'child-env', agentId: 'child-agent', ownerAgentId: 'root-agent',
        ownerLeaseId: 'root-lease', providerSandboxId: 'child-sandbox', baseSnapshotId: 'child-base', latestSnapshotId: 'child-current', state: 'released' },
    ],
    operations: [], snapshots: [{ snapshotId: 'result', leaseId: 'root-lease',
      providerSnapshotId: 'provider-result', state: 'available' }],
    allocations: [], liveTicketCount: 0, unfinishedInteractionCount: 0,
    interactions: [
      { leaseId: 'root-lease', connectionGeneration: 1, processId: 'hosted-code-mode-root', state: 'active' },
      { leaseId: 'child-lease', connectionGeneration: 1, processId: 'hosted-code-mode-child', state: 'finished' },
    ],
    artifacts: [{ artifactId: 'artifact', agentId: 'child-agent', sourceLeaseId: 'child-lease', state: 'available' }],
    patchApplications: [{ applicationId: 'application', targetLeaseId: 'root-lease', artifactId: 'artifact',
      sourceTargetSnapshotId: 'before-apply', resultSnapshotId: 'result', phase: 'checkpointed' }],
  }
  assert.ok(Object.values(evaluatePocFunctionalInspection(database, evidence).assertions).every(Boolean))
})

test('report serializer rejects secret fields, exact taint, tickets, and connection URLs', () => {
  assert.throws(() => serializePocReport({ bearerToken: 'x' }, []), /forbidden/)
  assert.throws(() => serializePocReport({ value: 'prefix exact-secret suffix' }, ['exact-secret']), /forbidden/)
  assert.throws(() => serializePocReport({ value: 'wss://localhost/leases/x?ticket=y' }, []), /forbidden/)
  assert.throws(() => serializePocReport({ value: 'postgresql://user:pass@localhost/db' }, []), /forbidden/)
  assert.equal(JSON.parse(serializePocReport({ version: 1,
    assertions: { safe: true, noLiveTickets: true } }, [])).version, 1)
})

test('cleanup evaluation requires terminal database state and an empty exact provider scope', () => {
  const database: PocDatabaseInspection = { leases: [{ leaseId: 'lease', environmentId: 'environment', agentId: 'agent',
    ownerAgentId: null, ownerLeaseId: null, providerSandboxId: 'sandbox', baseSnapshotId: 'base', latestSnapshotId: 'latest',
    state: 'released' }, { leaseId: 'child-lease', environmentId: 'child-environment', agentId: 'child-agent',
    ownerAgentId: 'agent', ownerLeaseId: 'lease', providerSandboxId: 'child-sandbox', baseSnapshotId: 'child-base',
    latestSnapshotId: 'child-latest', state: 'released' }],
    operations: [{ operation: 'release', state: 'succeeded', primaryLeaseId: 'lease', resultLeaseId: null }],
    snapshots: [], artifacts: [], patchApplications: [], allocations: [], liveTicketCount: 0, unfinishedInteractionCount: 0,
    interactions: [{ leaseId: 'lease', connectionGeneration: 1,
      processId: 'hosted-code-mode-root', state: 'finished' }, { leaseId: 'child-lease', connectionGeneration: 1,
      processId: 'hosted-code-mode-child', state: 'finished' }] }
  assert.ok(Object.values(evaluatePocCleanupInspection(database, { managedSandboxIds: [], knownProviderSnapshotIds: [] })).every(Boolean))
  assert.equal(evaluatePocCleanupInspection({ ...database, liveTicketCount: 1 }, {
    managedSandboxIds: [], knownProviderSnapshotIds: [],
  }).noLiveTickets, false)
})

test('aborted cleanup accepts zero leases without weakening functional proof', () => {
  const database: PocDatabaseInspection = { leases: [], operations: [], snapshots: [], artifacts: [],
    patchApplications: [], allocations: [], liveTicketCount: 0, unfinishedInteractionCount: 0, interactions: [] }
  assert.ok(Object.values(evaluatePocCleanupInspection(database,
    { managedSandboxIds: [], knownProviderSnapshotIds: [] })).every(Boolean))
  const functional = evaluatePocFunctionalInspection(database, undefined).assertions
  assert.equal(functional.rootLeaseExists, false)
  assert.equal(functional.childLeaseExists, false)
  assert.equal(functional.rootCodeModeRuntimeReady, false)
  assert.equal(functional.childCodeModeRuntimeReady, false)
})

test('aborted cleanup accepts a released root without a child or a started runtime', () => {
  const database: PocDatabaseInspection = { leases: [{ leaseId: 'root', environmentId: 'environment', agentId: 'agent',
    ownerAgentId: null, ownerLeaseId: null, providerSandboxId: 'sandbox', baseSnapshotId: 'base',
    latestSnapshotId: 'base', state: 'released' }], operations: [], snapshots: [], artifacts: [],
    patchApplications: [], allocations: [], liveTicketCount: 0, unfinishedInteractionCount: 0, interactions: [] }
  for (const interactions of [[], [{ leaseId: 'root', connectionGeneration: 1,
    processId: 'hosted-code-mode-root', state: 'finished' }]]) {
    assert.ok(Object.values(evaluatePocCleanupInspection({ ...database, interactions },
      { managedSandboxIds: [], knownProviderSnapshotIds: [] })).every(Boolean))
  }
})

test('cleanup rejects every unfinished observed runtime, including later leases and unknown roles', () => {
  const leases = ['root', 'restored-root', 'child', 'second-child'].map((leaseId, index) => ({ leaseId,
    environmentId: `env-${index}`, agentId: `agent-${index}`, ownerAgentId: index < 2 ? null : 'agent-0',
    ownerLeaseId: index < 2 ? null : 'root', providerSandboxId: null,
    baseSnapshotId: 'base', latestSnapshotId: 'base', state: 'released' }))
  for (const leaseId of [...leases.map(lease => lease.leaseId), 'unknown']) {
    const database: PocDatabaseInspection = { leases, operations: [], snapshots: [], artifacts: [],
      patchApplications: [], allocations: [], liveTicketCount: 0, unfinishedInteractionCount: 0,
      interactions: [{ leaseId, connectionGeneration: 1, processId: 'hosted-code-mode-observed', state: 'active' }] }
    const cleanup = evaluatePocCleanupInspection(database, { managedSandboxIds: [], knownProviderSnapshotIds: [] })
    assert.equal(cleanup.noUnfinishedInteractions, false, leaseId)
    if (leaseId !== 'unknown') {
      assert.equal(cleanup[leaseId.includes('child') ? 'childCodeModeRuntimeQuiesced' : 'rootCodeModeRuntimeQuiesced'],
        false, leaseId)
    }
    assert.ok(!Object.values(cleanup).every(Boolean), leaseId)
  }
})

test('provider inspection and cleanup use only the exact run ownership scope and known IDs', async () => {
  const calls: unknown[] = []
  const provider = {
    async listManagedSandboxes(query: { metadata: Record<string, string> }) {
      calls.push(['list', query]); return [{ sandboxId: 'sandbox-exact' }]
    },
    async listSnapshots(query: { sandboxId: string }) {
      calls.push(['snapshots', query]); return [{ snapshotId: 'snapshot-exact' }, { snapshotId: 'unaffiliated' }]
    },
    async kill(id: string) { calls.push(['kill', id]) },
    async deleteSnapshot(id: string) { calls.push(['delete', id]); return true },
  }
  const inspector = new PocProviderInspector({ apiKey: 'key', apiUrl: 'https://api.example', domain: 'example' },
    'cudex-poc-run-id', 'poc-run-id', provider)
  const database: PocDatabaseInspection = { leases: [{ leaseId: 'lease', environmentId: 'environment', agentId: 'agent',
    ownerAgentId: null, ownerLeaseId: null, providerSandboxId: 'sandbox-exact', baseSnapshotId: 'base', latestSnapshotId: 'latest',
    state: 'released' }], operations: [], snapshots: [{ snapshotId: 'snapshot', leaseId: 'lease',
      providerSnapshotId: 'snapshot-exact', state: 'available' }], artifacts: [], patchApplications: [], allocations: [],
    liveTicketCount: 0, unfinishedInteractionCount: 0, interactions: [] }
  assert.deepEqual(await inspector.inspect(database), {
    managedSandboxIds: ['sandbox-exact'], knownProviderSnapshotIds: ['snapshot-exact'],
  })
  assert.equal(await inspector.forceCleanup(database), true)
  assert.deepEqual(calls.filter(call => (call as unknown[])[0] === 'list'), [
    ['list', { metadata: { managedBy: 'cudex-poc-run-id', tenantId: 'poc-run-id' } }],
    ['list', { metadata: { managedBy: 'cudex-poc-run-id', tenantId: 'poc-run-id' } }],
  ])
  assert.deepEqual(calls.filter(call => (call as unknown[])[0] === 'delete'), [['delete', 'snapshot-exact']])
})

test('exact provider cleanup is idempotent', async () => {
  let liveSandbox = true
  let liveSnapshot = true
  const provider = {
    async listManagedSandboxes() { return liveSandbox ? [{ sandboxId: 'sandbox' }] : [] },
    async listSnapshots() { return liveSnapshot ? [{ snapshotId: 'snapshot' }] : [] },
    async kill() { liveSandbox = false },
    async deleteSnapshot() { const deleted = liveSnapshot; liveSnapshot = false; return deleted },
  }
  const inspector = new PocProviderInspector({ apiKey: 'key', apiUrl: 'https://api.example', domain: 'example' },
    'cudex-poc-run-id', 'poc-run-id', provider)
  const database: PocDatabaseInspection = { leases: [{ leaseId: 'lease', environmentId: 'environment', agentId: 'agent',
    ownerAgentId: null, ownerLeaseId: null, providerSandboxId: 'sandbox', baseSnapshotId: 'base', latestSnapshotId: 'latest',
    state: 'released' }], operations: [], snapshots: [{ snapshotId: 'durable', leaseId: 'lease',
      providerSnapshotId: 'snapshot', state: 'available' }], artifacts: [], patchApplications: [], allocations: [],
    liveTicketCount: 0, unfinishedInteractionCount: 0, interactions: [] }
  assert.equal(await inspector.forceCleanup(database), true)
  assert.equal(await inspector.forceCleanup(database), false)
})

test('retained file scan detects exact taint and connection tickets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poc-inspector-'))
  try {
    const log = join(root, 'service.log')
    await writeFile(log, 'safe lifecycle output\n')
    assert.equal(await retainedFilesAreRedacted([log], ['exact-secret']), true)
    await writeFile(log, 'unexpected exact-secret\n')
    assert.equal(await retainedFilesAreRedacted([log], ['exact-secret']), false)
    await writeFile(log, 'wss://host/path?ticket=opaque\n')
    assert.equal(await retainedFilesAreRedacted([log], []), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
