import { Sandbox } from 'e2b'
import type { ProviderAdapter, CreatedSandbox } from './provider.js'

interface Connection { apiKey: string; apiUrl?: string; domain?: string; validateApiKey?: boolean; requestTimeoutMs: number }
export class E2BProvider implements ProviderAdapter {
  private readonly sandboxes = new Map<string, Sandbox>()
  constructor(private readonly connection: Connection, private readonly timeoutMs = 120_000) {}
  async create(templateId: string, metadata: Record<string, string>): Promise<CreatedSandbox> { return this.createFrom(templateId, metadata) }
  async restore(snapshotId: string, metadata: Record<string, string>): Promise<CreatedSandbox> { return this.createFrom(snapshotId, metadata) }
  private async createFrom(template: string, metadata: Record<string, string>): Promise<CreatedSandbox> {
    const sandbox = await Sandbox.create(template, { ...this.connection, metadata, timeoutMs: this.timeoutMs, secure: true, lifecycle: { onTimeout: 'pause', autoResume: false } })
    this.sandboxes.set(sandbox.sandboxId, sandbox); return this.describe(sandbox)
  }
  async connect(sandboxId: string): Promise<CreatedSandbox> {
    const sandbox = await Sandbox.connect(sandboxId, { ...this.connection, timeoutMs: this.timeoutMs })
    this.sandboxes.set(sandboxId, sandbox); return this.describe(sandbox)
  }
  async uploadArchive(sandboxId: string, archive: Uint8Array): Promise<void> {
    const sandbox = await this.handle(sandboxId)
    const copy = Uint8Array.from(archive)
    await sandbox.files.write('/tmp/cudex-workspace.tar', copy.buffer)
    const result = await sandbox.commands.run('mkdir -p /workspace && tar -xf /tmp/cudex-workspace.tar -C /workspace && chown -R 1000:1000 /workspace/roots && rm /tmp/cudex-workspace.tar', { user: 'root' })
    if (result.exitCode !== 0) throw new Error(`workspace extraction failed: ${result.stderr}`)
  }
  async exportWorkspace(sandboxId: string): Promise<Uint8Array> {
    const sandbox = await this.handle(sandboxId)
    const result = await sandbox.commands.run('tar -cf /tmp/cudex-workspace.tar -C /workspace roots', { user: 'root' })
    if (result.exitCode !== 0) throw new Error(`workspace capture failed: ${result.stderr}`)
    return sandbox.files.read('/tmp/cudex-workspace.tar', { format: 'bytes' })
  }
  async startExecServer(sandboxId: string): Promise<void> {
    const sandbox = await this.handle(sandboxId)
    await sandbox.commands.run('pkill -x codex || true; codex exec-server --listen ws://0.0.0.0:22101', { background: true, timeoutMs: 10_000 })
  }
  async snapshot(sandboxId: string): Promise<string> { return (await (await this.handle(sandboxId)).createSnapshot()).snapshotId }
  async kill(sandboxId: string): Promise<void> {
    this.sandboxes.delete(sandboxId); await Sandbox.kill(sandboxId, this.connection).catch(() => false)
  }
  private describe(sandbox: Sandbox): CreatedSandbox { return { sandboxId: sandbox.sandboxId, rawExecUrl: `wss://${sandbox.getHost(22101)}` } }
  private async handle(id: string): Promise<Sandbox> { return this.sandboxes.get(id) ?? Sandbox.connect(id, { ...this.connection, timeoutMs: this.timeoutMs }) }
}
