import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceError } from '../src/types.js'
import {
  contractLimits,
  validateCheckpointRequest,
  validatePatchApplyRequest,
  validatePatchApplyResponse,
  validatePatchExportRequest,
  validatePatchExportResponse,
  validateProvisionedAgent,
  validateProvisionRequest,
  validateReconnectRequest,
  validateReferenceClearRequest,
  validateRetentionRequest,
  validateRetentionResponse,
  validateReleaseRequest,
} from '../src/validation.js'

test('retention request is an exact bounded durable set', () => {
  const request = { agentId: 'agent', leaseId: 'lease', baseSnapshotId: 'base',
    latestSnapshotId: 'latest', artifactId: null, expectedRevision: null }
  assert.deepEqual(validateRetentionRequest(request), request)
  assert.deepEqual(validateRetentionRequest({ ...request, artifactId: 'artifact' }),
    { ...request, artifactId: 'artifact' })
  assert.deepEqual(validateRetentionResponse({ revision: 2, desiredHash: 'a'.repeat(64) }),
    { revision: 2, desiredHash: 'a'.repeat(64) })
  rejectsStatus(400, () => validateRetentionRequest({ ...request, extra: true }))
  rejectsStatus(400, () => validateRetentionRequest({ ...request, artifactId: '' }))
  rejectsStatus(400, () => validateRetentionRequest({ ...request, expectedRevision: 0 }))
  rejectsStatus(503, () => validateRetentionResponse({ revision: 0, desiredHash: 'a'.repeat(64) }))
  const clear = { agentId: 'agent', leaseId: 'lease', expectedRevision: 2 }
  assert.deepEqual(validateReferenceClearRequest(clear), clear)
  rejectsStatus(400, () => validateReferenceClearRequest({ ...clear, expectedRevision: 0 }))
  rejectsStatus(400, () => validateReferenceClearRequest({ ...clear, extra: true }))
})

const rootProvision = () => ({
  agentId: 'agent_root', ownerAgentId: null, agentType: 'default', sandboxTemplate: 'general-v1',
  source: { type: 'rootWorkspace', cwd: 'file:///source/project/src', workspaceRoots: ['file:///source/project', 'file:///source/other'] },
  idempotencyKey: 'provision-1',
})

const provisioned = () => ({
  leaseId: 'lease_a', environmentId: 'env_a',
  connection: { execServerUrl: 'wss://gateway.example/leases/lease_a?ticket=abc_DEF-123' },
  cwd: 'file:///workspace/roots/0/project/src',
  workspaceRoots: ['file:///workspace/roots/0/project', 'file:///workspace/roots/1/other'],
  baseSnapshotId: 'snapshot_a',
  toolPolicy: {
    allowedDomains: ['agentEnvironment', 'controlPlane'],
    allowedTools: [{ name: 'exec_command', namespace: null }, { name: 'tool', namespace: 'provider' }],
  },
})

const patchExportRequest = () => ({
  leaseId: 'lease_child', agentId: 'agent_child', baseSnapshotId: 'snapshot_base',
  idempotencyKey: 'patch-export-1',
})

const patchExportResponse = () => ({
  artifactId: 'artifact_123', agentId: 'agent_child', baseSnapshotId: 'snapshot_base',
  checksum: `sha256:${'a'.repeat(64)}`, changedFiles: 12, sizeBytes: 48_192,
})

const patchApplyRequest = () => ({
  targetLeaseId: 'lease_owner', artifactId: 'artifact_123', idempotencyKey: 'patch-apply-1',
})

function rejectsStatus(status: number, fn: () => unknown): void {
  assert.throws(fn, error => error instanceof ServiceError && error.status === status)
}

test('request validators accept every current exact request shape', () => {
  assert.deepEqual(validateProvisionRequest(rootProvision()), rootProvision())
  const immutable = { ...rootProvision(), source: {
    type: 'sourceSnapshot', sourceSnapshotId: `source_${'a'.repeat(32)}`, checksum: `sha256:${'b'.repeat(64)}`,
  } }
  assert.deepEqual(validateProvisionRequest(immutable), immutable)
  const child = { ...rootProvision(), agentId: 'agent_child', ownerAgentId: 'agent_root',
    source: { type: 'agentEnvironment', ownerLeaseId: 'lease_owner' } }
  assert.deepEqual(validateProvisionRequest(child), child)
  const restore = { ...rootProvision(), source: { type: 'durableSnapshot', snapshotId: 'snapshot_base' } }
  assert.deepEqual(validateProvisionRequest(restore), restore)
  const leaseRequest = { leaseId: 'lease_a', idempotencyKey: 'operation-1' }
  assert.deepEqual(validateReconnectRequest(leaseRequest), leaseRequest)
  assert.deepEqual(validateCheckpointRequest(leaseRequest), leaseRequest)
  assert.deepEqual(validateReleaseRequest(leaseRequest), leaseRequest)
  assert.deepEqual(validatePatchExportRequest(patchExportRequest()), patchExportRequest())
  assert.deepEqual(validatePatchApplyRequest(patchApplyRequest()), patchApplyRequest())
})

test('request validators reject malformed types, discriminants, extra keys, and owner violations', () => {
  for (const value of [null, [], 'request', { ...rootProvision(), extra: true }, { ...rootProvision(), ownerAgentId: undefined }]) {
    rejectsStatus(400, () => validateProvisionRequest(value))
  }
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { type: 'unknown', snapshotId: 'snapshot' } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { type: 'durableSnapshot', snapshotId: 'snapshot', extra: true } }))
  const immutable = { type: 'sourceSnapshot', sourceSnapshotId: `source_${'a'.repeat(32)}`, checksum: `sha256:${'b'.repeat(64)}` }
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { ...immutable, tenantId: 'tenant_from_body' } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { ...immutable, cwd: 'file:///host/workspace' } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { ...immutable, sourceSnapshotId: 'source_short' } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { ...immutable, checksum: `sha256:${'B'.repeat(64)}` } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), ownerAgentId: 'owner', source: immutable }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), ownerAgentId: 'owner' }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), agentId: 'same', ownerAgentId: 'same', source: { type: 'agentEnvironment', ownerLeaseId: 'lease' } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), agentId: 'same', ownerAgentId: 'same', source: { type: 'durableSnapshot', snapshotId: 'snapshot' } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), ownerAgentId: null, source: { type: 'agentEnvironment', ownerLeaseId: 'lease' } }))
  rejectsStatus(400, () => validateReconnectRequest({ leaseId: 'lease', idempotencyKey: 'key', extra: 1 }))
  rejectsStatus(400, () => validateCheckpointRequest({ leaseId: 1, idempotencyKey: 'key' }))
  rejectsStatus(400, () => validateReleaseRequest({ leaseId: 'lease' }))
  rejectsStatus(400, () => validatePatchExportRequest({ ...patchExportRequest(), tenantId: 'tenant_from_body' }))
  rejectsStatus(400, () => validatePatchExportRequest({ ...patchExportRequest(), agentId: 1 }))
  rejectsStatus(400, () => validatePatchExportRequest({ ...patchExportRequest(), baseSnapshotId: '' }))
  rejectsStatus(400, () => validatePatchApplyRequest({ ...patchApplyRequest(), accessToken: 'secret' }))
  rejectsStatus(400, () => validatePatchApplyRequest({ targetLeaseId: 'lease', artifactId: 'artifact' }))
})

test('patch export response is exact, checksummed, and numerically bounded', () => {
  assert.deepEqual(validatePatchExportResponse(patchExportResponse()), patchExportResponse())
  assert.deepEqual(validatePatchExportResponse({ ...patchExportResponse(), changedFiles: 0, sizeBytes: 0 }), {
    ...patchExportResponse(), changedFiles: 0, sizeBytes: 0,
  })
  rejectsStatus(503, () => validatePatchExportResponse(null))
  rejectsStatus(503, () => validatePatchExportResponse({ ...patchExportResponse(), connection: { execServerUrl: 'wss://secret' } }))
  rejectsStatus(503, () => validatePatchExportResponse({ ...patchExportResponse(), checksum: `sha256:${'A'.repeat(64)}` }))
  rejectsStatus(503, () => validatePatchExportResponse({ ...patchExportResponse(), checksum: 'a'.repeat(64) }))
  for (const changedFiles of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, contractLimits.maxPatchChangedFiles + 1]) {
    rejectsStatus(503, () => validatePatchExportResponse({ ...patchExportResponse(), changedFiles }))
  }
  for (const sizeBytes of [-1, 1.5, Number.POSITIVE_INFINITY, contractLimits.maxPatchSizeBytes + 1]) {
    rejectsStatus(503, () => validatePatchExportResponse({ ...patchExportResponse(), sizeBytes }))
  }
})

test('patch apply response accepts exact applied, conflict, and rejected variants', () => {
  const applied = { type: 'applied', checkpoint: { snapshotId: 'snapshot_after' } }
  const conflict = { type: 'conflict', paths: [
    'file:///workspace/project/a.txt', 'file:///workspace/project/src/lib.rs',
  ] }
  const rejected = { type: 'rejected', reason: 'artifact expired' }
  assert.deepEqual(validatePatchApplyResponse(applied), applied)
  assert.deepEqual(validatePatchApplyResponse(conflict), conflict)
  assert.deepEqual(validatePatchApplyResponse(rejected), rejected)
})

test('patch apply response rejects invalid tags, extra/access fields, and malformed nested shapes', () => {
  for (const value of [null, [], {}, { type: 'unknown' }, { type: 'applied' },
    { type: 'applied', checkpoint: { snapshotId: 'snapshot', ticket: 'secret' } },
    { type: 'conflict', paths: ['file:///workspace/a'], accessToken: 'secret' },
    { type: 'rejected', reason: 'rejected', connection: {} }]) {
    rejectsStatus(503, () => validatePatchApplyResponse(value))
  }
  rejectsStatus(503, () => validatePatchApplyResponse({ type: 'applied', checkpoint: { snapshotId: 1 } }))
  rejectsStatus(503, () => validatePatchApplyResponse({ type: 'rejected', reason: '' }))
  rejectsStatus(503, () => validatePatchApplyResponse({ type: 'rejected', reason: ' line padded ' }))
  rejectsStatus(503, () => validatePatchApplyResponse({ type: 'rejected', reason: 'bad\nreason' }))
  const accessor = { checkpoint: { snapshotId: 'snapshot' } }
  Object.defineProperty(accessor, 'type', { enumerable: true, get: () => 'applied' })
  rejectsStatus(503, () => validatePatchApplyResponse(accessor))
  rejectsStatus(503, () => validatePatchApplyResponse(Object.assign(Object.create({ inherited: true }), {
    type: 'rejected', reason: 'rejected',
  })))
})

test('patch conflicts require one to 256 unique sorted canonical workspace file URIs', () => {
  const path = (index: number) => `file:///workspace/project/${String(index).padStart(3, '0')}.txt`
  const maximum = Array.from({ length: contractLimits.maxConflictPaths }, (_, index) => path(index))
  assert.deepEqual(validatePatchApplyResponse({ type: 'conflict', paths: maximum }),
    { type: 'conflict', paths: maximum })
  const invalid = [
    [], [path(0), path(0)], [path(1), path(0)],
    ['file:///host/project/a.txt'], ['file:///workspace'], ['https://example.test/workspace/a'],
    ['file:///workspace/project/../secret'], ['file:///workspace/project/a.txt?ticket=secret'],
    Array.from({ length: contractLimits.maxConflictPaths + 1 }, (_, index) => path(index)),
  ]
  for (const paths of invalid) rejectsStatus(503, () => validatePatchApplyResponse({ type: 'conflict', paths }))
})

test('patch rejection reasons use UTF-8 byte bounds without truncation', () => {
  const exact = 'é'.repeat(contractLimits.maxRejectionReasonBytes / 2)
  assert.deepEqual(validatePatchApplyResponse({ type: 'rejected', reason: exact }), { type: 'rejected', reason: exact })
  rejectsStatus(503, () => validatePatchApplyResponse({ type: 'rejected', reason: `${exact}é` }))
  rejectsStatus(503, () => validatePatchApplyResponse({ type: 'rejected', reason: '\ud800' }))
})

test('request string bounds use UTF-8 bytes and reject invalid Unicode', () => {
  const exact = 'é'.repeat(contractLimits.maxOpaqueIdBytes / 2)
  assert.equal(validateReconnectRequest({ leaseId: exact, idempotencyKey: 'key' }).leaseId, exact)
  rejectsStatus(400, () => validateReconnectRequest({ leaseId: `${exact}é`, idempotencyKey: 'key' }))
  rejectsStatus(400, () => validateReconnectRequest({ leaseId: '\ud800', idempotencyKey: 'key' }))
  rejectsStatus(400, () => validateReconnectRequest({ leaseId: 'lease', idempotencyKey: ' '.repeat(10) }))
  const exactName = 'é'.repeat(contractLimits.maxNameBytes / 2)
  assert.equal(validateProvisionRequest({ ...rootProvision(), agentType: exactName }).agentType, exactName)
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), agentType: `${exactName}é` }))
})

test('root workspace paths must be canonical, unique, bounded, and contain cwd', () => {
  const invalidUris = [
    'https://example.test/source', 'file://host/source', 'file:///source/project?query=1',
    'file:///source/project#fragment', 'file:///source/project/../other', 'file:relative',
  ]
  for (const cwd of invalidUris) rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { ...rootProvision().source, cwd } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { type: 'rootWorkspace', cwd: 'file:///elsewhere', workspaceRoots: ['file:///source'] } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { type: 'rootWorkspace', cwd: 'file:///source', workspaceRoots: [] } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { type: 'rootWorkspace', cwd: 'file:///source', workspaceRoots: ['file:///source', 'file:///source'] } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { type: 'rootWorkspace', cwd: 'file:///source', workspaceRoots: ['file:///source', 'file:///source/nested'] } }))
  const tooMany = Array.from({ length: contractLimits.maxWorkspaceRoots + 1 }, (_, index) => `file:///source/${index}`)
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { type: 'rootWorkspace', cwd: tooMany[0], workspaceRoots: tooMany } }))
})

test('provisioned-agent validator accepts a bounded exact response and tool policy', () => {
  assert.deepEqual(validateProvisionedAgent(provisioned()), provisioned())
  const emptyPolicy = provisioned(); emptyPolicy.toolPolicy = { allowedDomains: [], allowedTools: [] }
  assert.deepEqual(validateProvisionedAgent(emptyPolicy), emptyPolicy)
})

test('provisioned-agent response failures are 503 and reject extra fields or invalid paths', () => {
  rejectsStatus(503, () => validateProvisionedAgent(null))
  rejectsStatus(503, () => validateProvisionedAgent({ ...provisioned(), extra: true }))
  rejectsStatus(503, () => validateProvisionedAgent({ ...provisioned(), leaseId: 'é'.repeat(257) }))
  rejectsStatus(503, () => validateProvisionedAgent({ ...provisioned(), cwd: 'file:///workspace/outside' }))
  rejectsStatus(503, () => validateProvisionedAgent({ ...provisioned(), workspaceRoots: [] }))
  rejectsStatus(503, () => validateProvisionedAgent({ ...provisioned(), workspaceRoots: ['file:///workspace/root', 'file:///workspace/root'] }))
  rejectsStatus(503, () => validateProvisionedAgent({ ...provisioned(), connection: { ...provisioned().connection, extra: true } }))
})

test('exec connection must be canonical WSS with one opaque ticket for the returned lease', () => {
  const invalid = [
    'ws://gateway.example/leases/lease_a?ticket=abc',
    'wss://user@gateway.example/leases/lease_a?ticket=abc',
    'wss://gateway.example/leases/lease_b?ticket=abc',
    'wss://gateway.example/leases/lease_a',
    'wss://gateway.example/leases/lease_a?ticket=abc&other=value',
    'wss://gateway.example/leases/lease_a?ticket=abc&ticket=def',
    'wss://gateway.example/leases/lease_a?ticket=%20',
    'wss://gateway.example/leases/lease_a?ticket=abc%5Fdef',
    'wss://gateway.example/leases/lease_a?ticket=abc#fragment',
    'wss://GATEWAY.example/leases/lease_a?ticket=abc',
  ]
  for (const execServerUrl of invalid) rejectsStatus(503, () => validateProvisionedAgent({ ...provisioned(), connection: { execServerUrl } }))
})

test('tool policy validates domains, exact tool names, uniqueness, and collection bounds', () => {
  const withPolicy = (toolPolicy: unknown) => ({ ...provisioned(), toolPolicy })
  rejectsStatus(503, () => validateProvisionedAgent(withPolicy({ allowedDomains: ['unknown'], allowedTools: [] })))
  rejectsStatus(503, () => validateProvisionedAgent(withPolicy({ allowedDomains: ['controlPlane', 'controlPlane'], allowedTools: [] })))
  rejectsStatus(503, () => validateProvisionedAgent(withPolicy({ allowedDomains: [], allowedTools: [{ name: 'tool', namespace: null, extra: true }] })))
  rejectsStatus(503, () => validateProvisionedAgent(withPolicy({ allowedDomains: [], allowedTools: [{ name: 'tool', namespace: 1 }] })))
  rejectsStatus(503, () => validateProvisionedAgent(withPolicy({ allowedDomains: [], allowedTools: [{ name: 'tool', namespace: null }, { name: 'tool', namespace: null }] })))
  const tooMany = Array.from({ length: contractLimits.maxAllowedTools + 1 }, (_, index) => ({ name: `tool_${index}`, namespace: null }))
  rejectsStatus(503, () => validateProvisionedAgent(withPolicy({ allowedDomains: [], allowedTools: tooMany })))
})
