import type { CreatedSandbox, ProviderAdapter } from '../src/provider.js'

interface FakeSandbox { bytes: Uint8Array; alive: boolean }
export class FakeProvider implements ProviderAdapter {
  readonly sandboxes = new Map<string, FakeSandbox>(); readonly snapshots = new Map<string, Uint8Array>()
  creates = 0; kills = 0; connects = 0; failAt: string | undefined
  rawExecUrl: string | undefined
  private id = 0
  async create(): Promise<CreatedSandbox> { this.failure('create'); this.creates++; return this.allocate() }
  async connect(sandboxId: string): Promise<CreatedSandbox> {
    this.failure('connect'); this.connects++; const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox?.alive) throw new Error('missing'); return { sandboxId, rawExecUrl: this.rawExecUrl ?? `wss://raw.invalid/${sandboxId}` }
  }
  async restore(snapshotId: string): Promise<CreatedSandbox> {
    this.failure('restore'); const bytes = this.snapshots.get(snapshotId); if (!bytes) throw new Error('missing snapshot')
    const created = this.allocate(); this.sandboxes.get(created.sandboxId)!.bytes = Uint8Array.from(bytes); return created
  }
  async uploadArchive(sandboxId: string, archive: Uint8Array): Promise<void> { this.failure('upload'); this.sandboxes.get(sandboxId)!.bytes = Uint8Array.from(archive) }
  async exportWorkspace(sandboxId: string): Promise<Uint8Array> { this.failure('export'); return Uint8Array.from(this.sandboxes.get(sandboxId)!.bytes) }
  async startExecServer(): Promise<void> { this.failure('start') }
  async snapshot(sandboxId: string): Promise<string> {
    this.failure('snapshot'); const id = `provider-snapshot-${++this.id}`; this.snapshots.set(id, Uint8Array.from(this.sandboxes.get(sandboxId)!.bytes)); return id
  }
  async kill(sandboxId: string): Promise<void> { this.kills++; const sandbox = this.sandboxes.get(sandboxId); if (sandbox) sandbox.alive = false }
  live(): string[] { return [...this.sandboxes].filter(([, sandbox]) => sandbox.alive).map(([id]) => id) }
  private allocate(): CreatedSandbox { const sandboxId = `sandbox-${++this.id}`; this.sandboxes.set(sandboxId, { bytes: new Uint8Array(), alive: true }); return { sandboxId, rawExecUrl: `wss://raw.invalid/${sandboxId}` } }
  private failure(point: string): void { if (this.failAt === point) throw new Error(`injected ${point}`) }
}
