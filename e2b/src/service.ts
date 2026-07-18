import { createHash, randomUUID } from 'node:crypto'
import type { ProviderAdapter } from './provider.js'
import type { JsonStore } from './store.js'
import type { TicketIssuer } from './tickets.js'
import { archiveWorkspace, type IngressLimits } from './ingress.js'
import type { CheckpointRequest, LeaseRecord, OperationRecord, ProvisionRequest, ProvisionedAgent, ReconnectRequest, ReleaseRequest, ToolPolicy } from './types.js'
import { ServiceError } from './types.js'
import type { ObjectStore } from './blob-store.js'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
  return value
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const opaque = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`
const defaultPolicy: ToolPolicy = {
  allowedDomains: ['agentEnvironment', 'controlPlane'],
  allowedTools: [
    { name: 'exec_command', namespace: null }, { name: 'write_stdin', namespace: null },
    { name: 'apply_patch', namespace: null }, { name: 'view_image', namespace: null },
    { name: 'update_plan', namespace: null }, { name: 'spawn_agent', namespace: null },
    { name: 'send_message', namespace: null }, { name: 'wait_agent', namespace: null },
  ],
}
interface ServiceOptions { templates: Record<string, string>; allowedRoots: string[]; ingress: IngressLimits; allowLocalIngress?: boolean }
interface ConnectionRevoker { revoke(leaseId: string): void }

export class ControlPlane {
  constructor(
    private readonly store: JsonStore,
    private readonly provider: ProviderAdapter,
    private readonly tickets: TicketIssuer,
    private readonly blobs: ObjectStore,
    private readonly options: ServiceOptions,
    private readonly connections?: ConnectionRevoker,
  ) {}

  async reconcile(): Promise<void> {
    const abandoned = await this.store.read(database => Object.values(database.operations).filter(operation => operation.state === 'in_progress' && operation.allocatedSandboxId))
    for (const operation of abandoned) {
      await this.provider.kill(operation.allocatedSandboxId!).catch(() => undefined)
      await this.store.transaction(database => { const record = database.operations[this.operationKey(operation.operation, operation.idempotencyKey)]; if (record) { record.state = 'failed_terminal'; record.error = 'reconciled after restart' } })
    }
  }

  async provision(request: ProvisionRequest): Promise<ProvisionedAgent> {
    return this.idempotent('provision', request.idempotencyKey, request, async operation => {
      const templateId = this.options.templates[request.sandboxTemplate]
      if (!templateId) throw new ServiceError(422, 'invalid sandbox template')
      if (request.source.type === 'rootWorkspace' && this.options.allowLocalIngress === false) {
        throw new ServiceError(400, 'local workspace ingress is disabled')
      }
      const leaseId = opaque('lease'); const environmentId = opaque('env')
      let sandboxId: string | undefined; let cwd: string; let roots: string[]; let created
      try {
        if (request.source.type === 'durableSnapshot') {
          const snapshot = await this.store.read(database => database.snapshots[request.source.type === 'durableSnapshot' ? request.source.snapshotId : ''])
          if (!snapshot) throw new ServiceError(404, 'snapshot missing')
          created = await this.provider.restore(snapshot.providerSnapshotId, { leaseId, agentId: request.agentId, template: request.sandboxTemplate })
          sandboxId = created.sandboxId; operation.allocatedSandboxId = sandboxId; await this.persistOperation(operation)
          await this.provider.uploadArchive(sandboxId, await this.blobs.get(snapshot.workspaceArchiveId))
          const original = await this.store.read(database => database.leases[snapshot.leaseId])
          if (!original) throw new ServiceError(404, 'snapshot lease metadata missing')
          cwd = original.cwd; roots = original.workspaceRoots
        } else {
          created = await this.provider.create(templateId, { leaseId, agentId: request.agentId, template: request.sandboxTemplate })
          sandboxId = created.sandboxId; operation.allocatedSandboxId = sandboxId; await this.persistOperation(operation)
          if (request.source.type === 'rootWorkspace') {
            const archive = await archiveWorkspace(request.source.cwd, request.source.workspaceRoots, this.options.allowedRoots, this.options.ingress)
            await this.provider.uploadArchive(created.sandboxId, archive.bytes); cwd = archive.cwd; roots = archive.roots
          } else {
            const owner = await this.activeLease(request.source.ownerLeaseId)
            const ownerSnapshot = await this.provider.snapshot(owner.sandboxId)
            const capture = await this.provider.restore(ownerSnapshot, { leaseId: `${leaseId}-capture`, agentId: request.agentId, template: request.sandboxTemplate })
            let workspace: Uint8Array
            try { workspace = await this.provider.exportWorkspace(capture.sandboxId) }
            finally { await this.provider.kill(capture.sandboxId).catch(() => undefined) }
            await this.provider.uploadArchive(created.sandboxId, workspace)
            cwd = owner.cwd; roots = owner.workspaceRoots
          }
        }
        sandboxId = created.sandboxId
        await this.provider.startExecServer(sandboxId)
        const workspaceArchiveId = await this.blobs.put(await this.provider.exportWorkspace(sandboxId)); const providerSnapshotId = await this.provider.snapshot(sandboxId); const snapshotId = opaque('snapshot')
        const lease: LeaseRecord = { leaseId, environmentId, sandboxId, agentId: request.agentId, ownerAgentId: request.ownerAgentId,
          template: request.sandboxTemplate, cwd, workspaceRoots: roots, baseSnapshotId: snapshotId, latestSnapshotId: snapshotId, state: 'active', toolPolicy: defaultPolicy }
        await this.store.transaction(database => { database.leases[leaseId] = lease; database.snapshots[snapshotId] = { snapshotId, providerSnapshotId, workspaceArchiveId, leaseId, createdAt: Date.now() } })
        return this.response(lease)
      } catch (error) { if (sandboxId) await this.provider.kill(sandboxId).catch(() => undefined); throw error }
    })
  }

  async reconnect(request: ReconnectRequest): Promise<ProvisionedAgent> {
    return this.idempotent('reconnect', request.idempotencyKey, request, async () => {
      const lease = await this.activeLease(request.leaseId)
      try { await this.provider.connect(lease.sandboxId); await this.provider.startExecServer(lease.sandboxId) }
      catch { throw new ServiceError(404, 'lease missing') }
      return this.response(lease)
    })
  }

  async checkpoint(request: CheckpointRequest): Promise<{ snapshotId: string }> {
    return this.idempotent('checkpoint', request.idempotencyKey, request, async () => {
      const lease = await this.activeLease(request.leaseId); const workspaceArchiveId = await this.blobs.put(await this.provider.exportWorkspace(lease.sandboxId))
      const providerSnapshotId = await this.provider.snapshot(lease.sandboxId); const snapshotId = opaque('snapshot')
      await this.store.transaction(database => { database.snapshots[snapshotId] = { snapshotId, providerSnapshotId, workspaceArchiveId, leaseId: lease.leaseId, createdAt: Date.now() }; database.leases[lease.leaseId]!.latestSnapshotId = snapshotId })
      return { snapshotId }
    })
  }

  async release(request: ReleaseRequest): Promise<void> {
    await this.idempotent('release', request.idempotencyKey, request, async () => {
      const lease = await this.store.read(database => database.leases[request.leaseId])
      await this.tickets.revokeLease(request.leaseId)
      this.connections?.revoke(request.leaseId)
      if (lease) { await this.provider.kill(lease.sandboxId).catch(() => undefined); await this.store.transaction(database => { database.leases[request.leaseId]!.state = 'released' }) }
      return { released: true }
    })
  }

  private async response(lease: LeaseRecord): Promise<ProvisionedAgent> {
    return { leaseId: lease.leaseId, environmentId: lease.environmentId, connection: { execServerUrl: await this.tickets.issue(lease.leaseId) }, cwd: lease.cwd,
      workspaceRoots: lease.workspaceRoots, baseSnapshotId: lease.baseSnapshotId, toolPolicy: lease.toolPolicy }
  }
  private async activeLease(leaseId: string): Promise<LeaseRecord> {
    const lease = await this.store.read(database => database.leases[leaseId])
    if (!lease || lease.state !== 'active') throw new ServiceError(404, 'lease missing')
    return lease
  }
  private operationKey(operation: string, key: string): string { return `${operation}\0${key}` }
  private async persistOperation(operation: OperationRecord): Promise<void> { await this.store.transaction(database => { database.operations[this.operationKey(operation.operation, operation.idempotencyKey)] = operation }) }
  private async idempotent<T>(operation: string, key: string, request: unknown, execute: (record: OperationRecord) => Promise<T>): Promise<T> {
    if (!key || key.length > 512) throw new ServiceError(400, 'invalid idempotency key')
    const requestHash = hash(request); const recordKey = this.operationKey(operation, key)
    const existing = await this.store.read(database => database.operations[recordKey])
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ServiceError(409, 'idempotency key reused with different request')
      if (existing.state === 'succeeded') {
        if ((operation === 'provision' || operation === 'reconnect') && existing.response && typeof existing.response === 'object' && 'leaseId' in existing.response) {
          return this.response(await this.activeLease(String(existing.response.leaseId))) as Promise<T>
        }
        return existing.response as T
      }
      throw new ServiceError(503, 'operation incomplete')
    }
    const record: OperationRecord = { operation, idempotencyKey: key, requestHash, state: 'in_progress' }; await this.persistOperation(record)
    try {
      const response = await execute(record); record.state = 'succeeded'
      record.response = response && typeof response === 'object' && 'connection' in response
        ? { ...(response as Record<string, unknown>), connection: undefined }
        : response
      delete record.allocatedSandboxId; await this.persistOperation(record); return response
    }
    catch (error) { record.state = 'failed_terminal'; record.error = error instanceof Error ? error.message.slice(0, 1024) : 'unknown error'; await this.persistOperation(record); throw error }
  }
}
