import { ProviderCapabilityError, type CreatedSandbox, type ManagedSandbox, type ManagedSandboxQuery,
  type ManagedSnapshot, type ProviderAdapter, type ProviderSnapshotOptions, type ProviderSnapshotQuery } from '../src/provider.js'

interface FakeSandbox { bytes: Uint8Array; alive: boolean; execReady: boolean; metadata: Record<string, string>; templateId: string; startedAt: Date; endAt: Date }
interface FakeSnapshot { bytes: Uint8Array; sandboxId: string; names: string[] }
export class FakeProvider implements ProviderAdapter {
  readonly sandboxes = new Map<string, FakeSandbox>(); readonly snapshots = new Map<string, FakeSnapshot>()
  creates = 0; kills = 0; connects = 0; failAt: string | undefined
  rawExecUrl: string | undefined
  private id = 0
  async create(templateId = 'fake-template', metadata: Record<string, string> = {}): Promise<CreatedSandbox> { this.failure('create'); this.creates++; return this.allocate(templateId, metadata) }
  async connect(sandboxId: string): Promise<CreatedSandbox> {
    this.failure('connect'); this.connects++; const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox?.alive) throw new Error('missing'); return { sandboxId, rawExecUrl: this.rawExecUrl ?? `wss://raw.invalid/${sandboxId}` }
  }
  async restore(snapshotId: string, metadata: Record<string, string> = {}): Promise<CreatedSandbox> {
    this.failure('restore'); const snapshot = this.snapshots.get(snapshotId); if (!snapshot) throw new Error('missing snapshot')
    const created = this.allocate('restored-snapshot', metadata); this.sandboxes.get(created.sandboxId)!.bytes = Uint8Array.from(snapshot.bytes); return created
  }
  async uploadArchive(sandboxId: string, archive: Uint8Array): Promise<void> { this.failure('upload'); this.sandboxes.get(sandboxId)!.bytes = Uint8Array.from(archive) }
  async exportWorkspace(sandboxId: string): Promise<Uint8Array> { this.failure('export'); return Uint8Array.from(this.sandboxes.get(sandboxId)!.bytes) }
  async startExecServer(sandboxId: string): Promise<void> { this.failure('start'); const sandbox = this.sandboxes.get(sandboxId); if (!sandbox?.alive) throw new Error('missing'); sandbox.execReady = true }
  async probeExecServer(sandboxId: string): Promise<void> {
    this.failure('probe'); const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox?.alive || !sandbox.execReady) throw new Error('exec server health probe failed')
  }
  async snapshot(sandboxId: string, options: ProviderSnapshotOptions = {}): Promise<string> {
    this.failure('snapshot'); const sandbox = this.sandboxes.get(sandboxId); if (!sandbox?.alive) throw new Error('missing')
    const id = `provider-snapshot-${++this.id}`
    this.snapshots.set(id, { bytes: Uint8Array.from(sandbox.bytes), sandboxId, names: options.name ? [options.name] : [] }); return id
  }
  async listManagedSandboxes(query: ManagedSandboxQuery): Promise<ManagedSandbox[]> {
    this.failure('list')
    if (!query.metadata.managedBy || !query.metadata.tenantId) {
      throw new ProviderCapabilityError('managed sandbox inventory', 'managedBy and tenantId metadata filters are required')
    }
    return [...this.sandboxes].filter(([, sandbox]) => sandbox.alive && Object.entries(query.metadata).every(([key, value]) => sandbox.metadata[key] === value))
      .map(([sandboxId, sandbox]) => ({ sandboxId, templateId: sandbox.templateId, metadata: { ...sandbox.metadata }, state: 'running',
        startedAt: new Date(sandbox.startedAt), endAt: new Date(sandbox.endAt) }))
  }
  async listSnapshots(query: ProviderSnapshotQuery): Promise<ManagedSnapshot[]> {
    this.failure('listSnapshots')
    if (query.sandboxId === undefined && query.name === undefined) throw new ProviderCapabilityError('managed snapshot inventory', 'sandboxId or deterministic name is required')
    return [...this.snapshots].filter(([, snapshot]) => (query.sandboxId === undefined || snapshot.sandboxId === query.sandboxId)
      && (query.name === undefined || snapshot.names.includes(query.name)))
      .map(([snapshotId, snapshot]) => ({ snapshotId, names: [...snapshot.names] }))
  }
  async deleteSnapshot(snapshotId: string): Promise<boolean> { this.failure('deleteSnapshot'); return this.snapshots.delete(snapshotId) }
  async kill(sandboxId: string): Promise<void> { this.failure('kill'); this.kills++; const sandbox = this.sandboxes.get(sandboxId); if (sandbox) sandbox.alive = false }
  live(): string[] { return [...this.sandboxes].filter(([, sandbox]) => sandbox.alive).map(([id]) => id) }
  private allocate(templateId: string, metadata: Record<string, string>): CreatedSandbox {
    const sandboxId = `sandbox-${++this.id}`
    this.sandboxes.set(sandboxId, { bytes: new Uint8Array(), alive: true, execReady: false, metadata: { ...metadata }, templateId,
      startedAt: new Date(), endAt: new Date(Date.now() + 60_000) })
    return { sandboxId, rawExecUrl: `wss://raw.invalid/${sandboxId}` }
  }
  private failure(point: string): void { if (this.failAt === point) throw new Error(`injected ${point}`) }
}
