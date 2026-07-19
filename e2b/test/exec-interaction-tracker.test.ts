import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ExecInteractionProtocolError,
  ExecInteractionTracker,
} from '../src/exec-interaction-tracker.js'
import type {
  LeaseInteraction,
  LeaseInteractionIdentity,
  LeaseInteractionLedger,
  LeaseInteractionState,
} from '../src/postgres-lease-interactions.js'

const frame = (value: unknown): Buffer => Buffer.from(JSON.stringify(value))

class FakeLedger implements LeaseInteractionLedger {
  readonly values = new Map<string, LeaseInteraction>()
  readonly calls: string[] = []

  async begin(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    this.calls.push(`begin:${identity.kind}:${identity.processId ?? '-'}`)
    return this.set(identity, 'active')
  }
  async resume(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    this.calls.push(`resume:${identity.processId ?? '-'}`)
    return this.set(identity, 'active')
  }
  async reattach(identity: LeaseInteractionIdentity,
    currentConnectionGeneration: number): Promise<LeaseInteraction> {
    this.calls.push(`reattach:${identity.connectionGeneration}->${currentConnectionGeneration}`)
    return this.set(identity, 'active')
  }
  async detach(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    this.calls.push(`detach:${identity.kind}:${identity.processId ?? '-'}`)
    return this.set(identity, 'detached')
  }
  async finish(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    this.calls.push(`finish:${identity.kind}:${identity.processId ?? '-'}`)
    return this.set(identity, 'finished')
  }
  async listUnfinishedProcesses(tenantId: string, leaseId: string,
    _generation: number, sessionId: string): Promise<LeaseInteractionIdentity[]> {
    this.calls.push(`list:${sessionId}`)
    return [...this.values.values()].filter(value => value.tenantId === tenantId
      && value.leaseId === leaseId && value.sessionId === sessionId
      && value.kind === 'process' && value.state !== 'finished').map(value => ({
      tenantId: value.tenantId, leaseId: value.leaseId,
      interactionId: value.interactionId,
      connectionGeneration: value.connectionGeneration, sessionId: value.sessionId,
      kind: value.kind, processId: value.processId,
    }))
  }
  async listUnfinishedFilesystem(tenantId: string, leaseId: string,
    _generation: number, sessionId: string): Promise<LeaseInteractionIdentity[]> {
    this.calls.push(`list-filesystem:${sessionId}`)
    return [...this.values.values()].filter(value => value.tenantId === tenantId
      && value.leaseId === leaseId && value.sessionId === sessionId
      && value.kind === 'filesystem' && value.state !== 'finished').map(value => ({
      tenantId: value.tenantId, leaseId: value.leaseId,
      interactionId: value.interactionId,
      connectionGeneration: value.connectionGeneration, sessionId: value.sessionId,
      kind: value.kind, processId: value.processId,
    }))
  }
  async assertQuiescent(): Promise<void> {}

  seed(identity: LeaseInteractionIdentity, state: LeaseInteractionState): void {
    this.set(identity, state)
  }

  private set(identity: LeaseInteractionIdentity,
    state: LeaseInteractionState): LeaseInteraction {
    const now = new Date()
    const value: LeaseInteraction = {
      ...identity, state, createdAt: this.values.get(identity.interactionId)?.createdAt ?? now,
      updatedAt: now, detachedAt: state === 'detached' ? now : null,
      finishedAt: state === 'finished' ? now : null,
    }
    this.values.set(identity.interactionId, value)
    return value
  }
}

async function initialized(tracker: ExecInteractionTracker, sessionId = 'session-1'): Promise<void> {
  const key = await tracker.clientFrame(frame({
    id: 1, method: 'initialize', params: { clientName: 'test' },
  }), false)
  tracker.markForwarded(key)
  await tracker.serverFrame(frame({ id: 1, result: { sessionId } }), false)
}

test('tracks process quiescence and filesystem completion before releasing frames', async () => {
  const ledger = new FakeLedger()
  const tracker = new ExecInteractionTracker({ tenantId: 'tenant', ledger }, 'lease', 0)
  await initialized(tracker)

  const start = await tracker.clientFrame(frame({
    id: 2, method: 'process/start', params: { processId: 'process-1' },
  }), true)
  assert.match(ledger.calls.at(-1)!, /^begin:process:process-1$/)
  tracker.markForwarded(start)
  await tracker.serverFrame(frame({
    method: 'process/exited', params: { processId: 'process-1' },
  }), false)
  assert.equal(ledger.calls.some(call => call === 'finish:process:process-1'), false)
  await tracker.serverFrame(frame({
    method: 'process/quiesced', params: { processId: 'process-1' },
  }), false)
  await tracker.serverFrame(frame({ id: 2, result: { processId: 'process-1' } }), false)
  assert.equal(ledger.calls.includes('finish:process:process-1'), true)

  const filesystem = await tracker.clientFrame(frame({
    id: 'write-1', method: 'fs/writeFile', params: { path: 'file:///workspace/a' },
  }), false)
  tracker.markForwarded(filesystem)
  await tracker.serverFrame(frame({
    id: 'write-1', error: { code: -32603, message: 'failed' },
  }), false)
  assert.equal(ledger.calls.at(-1), 'finish:filesystem:-')
})

test('finishes admitted requests that provably were never forwarded and rejects unknown methods',
  async () => {
    const ledger = new FakeLedger()
    const tracker = new ExecInteractionTracker({ tenantId: 'tenant', ledger }, 'lease', 0)
    await initialized(tracker)
    await assert.rejects(tracker.clientFrame(frame({
      id: 2, method: 'future/workspaceMutation', params: {},
    }), false), ExecInteractionProtocolError)
    await tracker.clientFrame(frame({
      id: 3, method: 'process/start', params: { processId: 'never-forwarded' },
    }), false)
    await tracker.detach()
    assert.equal(ledger.calls.at(-1), 'finish:process:never-forwarded')
  })

test('reattaches an older-generation process and applies pre-initialize quiescence', async () => {
  const ledger = new FakeLedger()
  ledger.seed({
    tenantId: 'tenant', leaseId: 'lease', interactionId: 'old-process',
    connectionGeneration: 2, sessionId: 'resumed-session',
    kind: 'process', processId: 'process-1',
  }, 'detached')
  ledger.seed({
    tenantId: 'tenant', leaseId: 'lease', interactionId: 'old-filesystem',
    connectionGeneration: 2, sessionId: 'resumed-session',
    kind: 'filesystem', processId: null,
  }, 'detached')
  const tracker = new ExecInteractionTracker({ tenantId: 'tenant', ledger }, 'lease', 3)
  const initialize = await tracker.clientFrame(frame({
    id: 1, method: 'initialize',
    params: { clientName: 'test', resumeSessionId: 'resumed-session' },
  }), false)
  tracker.markForwarded(initialize)
  await tracker.serverFrame(frame({
    method: 'process/quiesced', params: { processId: 'process-1' },
  }), false)
  await tracker.serverFrame(frame({
    id: 1, result: { sessionId: 'resumed-session' },
  }), false)
  assert.deepEqual(ledger.calls.slice(-5), [
    'list:resumed-session', 'reattach:2->3', 'finish:process:process-1',
    'list-filesystem:resumed-session', 'finish:filesystem:-',
  ])
})

test('recovers a missed quiescence notification from process/read after resume', async () => {
  const ledger = new FakeLedger()
  ledger.seed({
    tenantId: 'tenant', leaseId: 'lease', interactionId: 'detached-process',
    connectionGeneration: 0, sessionId: 'resumed-session',
    kind: 'process', processId: 'process-1',
  }, 'detached')
  const tracker = new ExecInteractionTracker({ tenantId: 'tenant', ledger }, 'lease', 0)
  const initialize = await tracker.clientFrame(frame({
    id: 1, method: 'initialize',
    params: { clientName: 'test', resumeSessionId: 'resumed-session' },
  }), false)
  tracker.markForwarded(initialize)
  await tracker.serverFrame(frame({ id: 1, result: { sessionId: 'resumed-session' } }), false)
  const read = await tracker.clientFrame(frame({
    id: 2, method: 'process/read', params: { processId: 'process-1' },
  }), false)
  tracker.markForwarded(read)
  await tracker.serverFrame(frame({
    id: 2, result: { chunks: [], nextSeq: 1, exited: true, closed: true, quiesced: true },
  }), false)
  assert.equal(ledger.calls.at(-1), 'finish:process:process-1')
})
