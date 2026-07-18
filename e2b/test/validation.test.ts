import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceError } from '../src/types.js'
import {
  contractLimits,
  validateCheckpointRequest,
  validateProvisionedAgent,
  validateProvisionRequest,
  validateReconnectRequest,
  validateReleaseRequest,
} from '../src/validation.js'

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

function rejectsStatus(status: number, fn: () => unknown): void {
  assert.throws(fn, error => error instanceof ServiceError && error.status === status)
}

test('request validators accept every current exact request shape', () => {
  assert.deepEqual(validateProvisionRequest(rootProvision()), rootProvision())
  const child = { ...rootProvision(), agentId: 'agent_child', ownerAgentId: 'agent_root',
    source: { type: 'agentEnvironment', ownerLeaseId: 'lease_owner' } }
  assert.deepEqual(validateProvisionRequest(child), child)
  const restore = { ...rootProvision(), source: { type: 'durableSnapshot', snapshotId: 'snapshot_base' } }
  assert.deepEqual(validateProvisionRequest(restore), restore)
  const leaseRequest = { leaseId: 'lease_a', idempotencyKey: 'operation-1' }
  assert.deepEqual(validateReconnectRequest(leaseRequest), leaseRequest)
  assert.deepEqual(validateCheckpointRequest(leaseRequest), leaseRequest)
  assert.deepEqual(validateReleaseRequest(leaseRequest), leaseRequest)
})

test('request validators reject malformed types, discriminants, extra keys, and owner violations', () => {
  for (const value of [null, [], 'request', { ...rootProvision(), extra: true }, { ...rootProvision(), ownerAgentId: undefined }]) {
    rejectsStatus(400, () => validateProvisionRequest(value))
  }
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { type: 'unknown', snapshotId: 'snapshot' } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), source: { type: 'durableSnapshot', snapshotId: 'snapshot', extra: true } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), ownerAgentId: 'owner' }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), agentId: 'same', ownerAgentId: 'same', source: { type: 'agentEnvironment', ownerLeaseId: 'lease' } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), agentId: 'same', ownerAgentId: 'same', source: { type: 'durableSnapshot', snapshotId: 'snapshot' } }))
  rejectsStatus(400, () => validateProvisionRequest({ ...rootProvision(), ownerAgentId: null, source: { type: 'agentEnvironment', ownerLeaseId: 'lease' } }))
  rejectsStatus(400, () => validateReconnectRequest({ leaseId: 'lease', idempotencyKey: 'key', extra: 1 }))
  rejectsStatus(400, () => validateCheckpointRequest({ leaseId: 1, idempotencyKey: 'key' }))
  rejectsStatus(400, () => validateReleaseRequest({ leaseId: 'lease' }))
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
