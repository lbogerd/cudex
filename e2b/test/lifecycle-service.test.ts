import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresLifecycleService } from '../src/lifecycle-service.js'
import type { ProvisionRequest, ProvisionedAgent } from '../src/types.js'
import { ServiceError } from '../src/types.js'

const response: ProvisionedAgent = {
  leaseId: 'lease', environmentId: 'environment', baseSnapshotId: 'snapshot',
  connectionGeneration: 0,
  connection: { execServerUrl: 'wss://gateway.example/leases/lease?ticket=ticket' },
  cwd: 'file:///workspace/root', workspaceRoots: ['file:///workspace/root'],
  toolPolicy: { allowedDomains: [], allowedTools: [] },
}

function request(source: ProvisionRequest['source']): ProvisionRequest {
  return {
    agentId: 'agent', ownerAgentId: source.type === 'agentEnvironment' ? 'owner' : null,
    agentType: 'default', sandboxTemplate: 'general-v1', source,
    idempotencyKey: `request-${source.type}`,
  }
}

test('production lifecycle dispatches each provision source to exactly one durable coordinator', async () => {
  const calls: string[] = []
  const provision = (name: string) => ({ async provision() { calls.push(name); return response } })
  const service = new PostgresLifecycleService({
    immutableSource: provision('immutable'), durableRestore: provision('restore'),
    child: provision('child'),
    reconnect: { async reconnect() { calls.push('reconnect'); return response } },
    checkpoint: { async checkpoint() { calls.push('checkpoint'); return { snapshotId: 'next' } } },
    release: { async release() { calls.push('release') } },
  })

  await service.provision(request({
    type: 'sourceSnapshot', sourceSnapshotId: 'source', checksum: `sha256:${'a'.repeat(64)}`,
  }))
  await service.provision(request({ type: 'durableSnapshot', snapshotId: 'snapshot' }))
  await service.provision(request({ type: 'agentEnvironment', ownerLeaseId: 'owner-lease' }))
  await service.reconnect({ leaseId: 'lease', idempotencyKey: 'reconnect' })
  await service.checkpoint({ leaseId: 'lease', idempotencyKey: 'checkpoint' })
  await service.release({ leaseId: 'lease', idempotencyKey: 'release' })
  assert.deepEqual(calls, ['immutable', 'restore', 'child', 'reconnect', 'checkpoint', 'release'])
})

test('production lifecycle rejects local root ingress before coordinator dispatch', async () => {
  let calls = 0
  const unavailable = { async provision() { calls += 1; return response } }
  const service = new PostgresLifecycleService({
    immutableSource: unavailable, durableRestore: unavailable, child: unavailable,
    reconnect: { async reconnect() { return response } },
    checkpoint: { async checkpoint() { return { snapshotId: 'next' } } },
    release: { async release() {} },
  })
  assert.throws(
    () => service.provision(request({
      type: 'rootWorkspace', cwd: 'file:///workspace/root',
      workspaceRoots: ['file:///workspace/root'],
    })),
    (error: unknown) => error instanceof ServiceError && error.status === 400,
  )
  assert.equal(calls, 0)
})

test('production lifecycle fails child provision closed when the command gate is absent', () => {
  const unavailable = { async provision() { return response } }
  const service = new PostgresLifecycleService({
    immutableSource: unavailable, durableRestore: unavailable,
    reconnect: { async reconnect() { return response } },
    checkpoint: { async checkpoint() { return { snapshotId: 'next' } } },
    release: { async release() {} },
  })
  assert.throws(
    () => service.provision(request({ type: 'agentEnvironment', ownerLeaseId: 'owner-lease' })),
    (error: unknown) => error instanceof ServiceError && error.status === 503,
  )
})
