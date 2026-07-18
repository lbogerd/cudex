import { Sandbox } from 'e2b'
import {
  ProviderCapabilityError,
  type CreatedSandbox,
  type ExecUpstream,
  type ManagedSandbox,
  type ManagedSandboxQuery,
  type ManagedSnapshot,
  type ProviderAdapter,
  type ProviderSnapshotOptions,
  type ProviderSnapshotQuery,
  validateExecUpstream,
} from './provider.js'
import { exportWorkspaceArchive, uploadWorkspaceArchive, type WorkspaceTransferOptions } from './workspace-transfer.js'

interface Connection { apiKey: string; apiUrl?: string; domain?: string; validateApiKey?: boolean; requestTimeoutMs: number }

function validateOpaque(label: string, value: string, maxBytes = 512): void {
  if (!value.trim() || Buffer.byteLength(value) > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
}

function validateMetadata(metadata: Record<string, string>, requireOwnershipMarker = false): void {
  if (requireOwnershipMarker && (!metadata.managedBy || !metadata.tenantId)) {
    throw new ProviderCapabilityError('managed sandbox inventory', 'managedBy and tenantId metadata filters are required')
  }
  const entries = Object.entries(metadata)
  if (entries.length === 0 || entries.length > 32) throw new Error('invalid provider metadata')
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(key) || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error('invalid provider metadata')
    }
    if (/(?:api.?key|credential|password|secret|token|url)/iu.test(key) || /(?:[?&]ticket=|:\/\/[^/\s]*@)/iu.test(value)) {
      throw new Error('provider metadata must not contain credentials or connection material')
    }
  }
}

export class E2BProvider implements ProviderAdapter {
  private readonly sandboxes = new Map<string, Sandbox>()
  constructor(
    private readonly connection: Connection,
    private readonly timeoutMs = 120_000,
    private readonly workspaceTransfer: WorkspaceTransferOptions = {},
  ) {}
  async create(templateId: string, metadata: Record<string, string>): Promise<CreatedSandbox> { return this.createFrom(templateId, metadata) }
  async restore(snapshotId: string, metadata: Record<string, string>): Promise<CreatedSandbox> { return this.createFrom(snapshotId, metadata) }
  private async createFrom(template: string, metadata: Record<string, string>): Promise<CreatedSandbox> {
    validateOpaque('provider template', template); validateMetadata(metadata)
    const sandbox = await Sandbox.create(template, { ...this.connection, metadata, timeoutMs: this.timeoutMs, secure: true, lifecycle: { onTimeout: 'pause', autoResume: false } })
    this.sandboxes.set(sandbox.sandboxId, sandbox); return this.describe(sandbox)
  }
  async connect(sandboxId: string): Promise<CreatedSandbox> {
    const sandbox = await Sandbox.connect(sandboxId, { ...this.connection, timeoutMs: this.timeoutMs })
    this.sandboxes.set(sandboxId, sandbox); return this.describe(sandbox)
  }
  async execUpstream(sandboxId: string): Promise<ExecUpstream> {
    const sandbox = await this.handle(sandboxId)
    return validateExecUpstream({
      url: `wss://${sandbox.getHost(22101)}/`,
      accessToken: sandbox.trafficAccessToken,
    })
  }
  async uploadArchive(sandboxId: string, archive: Uint8Array): Promise<void> {
    await uploadWorkspaceArchive(await this.handle(sandboxId), archive, this.workspaceTransfer)
  }
  async exportWorkspace(sandboxId: string): Promise<Uint8Array> {
    return exportWorkspaceArchive(await this.handle(sandboxId), this.workspaceTransfer)
  }
  async startExecServer(sandboxId: string): Promise<void> {
    const sandbox = await this.handle(sandboxId)
    await sandbox.commands.run('pkill -x codex || true; codex exec-server --listen ws://0.0.0.0:22101', { background: true, timeoutMs: 10_000 })
  }
  async probeExecServer(sandboxId: string): Promise<void> {
    const sandbox = await this.handle(sandboxId)
    const result = await sandbox.commands.run(
      "for attempt in 1 2 3 4 5 6 7 8 9 10; do (exec 3<>/dev/tcp/127.0.0.1/22101) >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1",
      { user: 'root', timeoutMs: 5_000 },
    )
    if (result.exitCode !== 0) throw new Error('exec server health probe failed')
  }
  async snapshot(sandboxId: string, options: ProviderSnapshotOptions = {}): Promise<string> {
    if (options.name !== undefined) validateOpaque('provider snapshot name', options.name)
    return (await (await this.handle(sandboxId)).createSnapshot(
      options.name === undefined ? undefined : { name: options.name },
    )).snapshotId
  }
  async listManagedSandboxes(query: ManagedSandboxQuery): Promise<ManagedSandbox[]> {
    validateMetadata(query.metadata, true)
    const paginator = Sandbox.list({ ...this.connection, query: { metadata: query.metadata }, limit: 100 })
    const resources: ManagedSandbox[] = []
    while (paginator.hasNext) {
      const page = await paginator.nextItems()
      for (const sandbox of page) {
        if (resources.length >= 10_000) throw new Error('managed sandbox inventory limit exceeded')
        validateOpaque('provider sandbox ID', sandbox.sandboxId)
        validateOpaque('provider template ID', sandbox.templateId)
        validateMetadata(sandbox.metadata)
        resources.push({
          sandboxId: sandbox.sandboxId,
          templateId: sandbox.templateId,
          metadata: { ...sandbox.metadata },
          state: sandbox.state,
          startedAt: new Date(sandbox.startedAt),
          endAt: new Date(sandbox.endAt),
        })
      }
    }
    return resources
  }
  async listSnapshots(query: ProviderSnapshotQuery): Promise<ManagedSnapshot[]> {
    if (query.sandboxId === undefined && query.name === undefined) {
      throw new ProviderCapabilityError('managed snapshot inventory', 'E2B cannot filter snapshots by service metadata; sandboxId or deterministic name is required')
    }
    if (query.sandboxId !== undefined) validateOpaque('provider sandbox ID', query.sandboxId)
    if (query.name !== undefined) validateOpaque('provider snapshot name', query.name)
    const paginator = Sandbox.listSnapshots({ ...this.connection,
      ...(query.sandboxId === undefined ? {} : { sandboxId: query.sandboxId }),
      ...(query.name === undefined ? {} : { name: query.name }),
      limit: 100 })
    const resources: ManagedSnapshot[] = []
    while (paginator.hasNext) {
      const page = await paginator.nextItems()
      for (const snapshot of page) {
        if (resources.length >= 10_000) throw new Error('managed snapshot inventory limit exceeded')
        validateOpaque('provider snapshot ID', snapshot.snapshotId)
        for (const name of snapshot.names) validateOpaque('provider snapshot name', name)
        resources.push({ snapshotId: snapshot.snapshotId, names: [...snapshot.names] })
      }
    }
    return resources
  }
  async deleteSnapshot(snapshotId: string): Promise<boolean> {
    validateOpaque('provider snapshot ID', snapshotId)
    return Sandbox.deleteSnapshot(snapshotId, this.connection)
  }
  async kill(sandboxId: string): Promise<void> {
    validateOpaque('provider sandbox ID', sandboxId)
    await Sandbox.kill(sandboxId, this.connection)
    this.sandboxes.delete(sandboxId)
  }
  private describe(sandbox: Sandbox): CreatedSandbox { return { sandboxId: sandbox.sandboxId } }
  private async handle(id: string): Promise<Sandbox> {
    const existing = this.sandboxes.get(id)
    if (existing) return existing
    const sandbox = await Sandbox.connect(id, { ...this.connection, timeoutMs: this.timeoutMs })
    this.sandboxes.set(id, sandbox)
    return sandbox
  }
}
