import { Sandbox, SandboxNotFoundError } from 'e2b'
import WebSocket from 'ws'
import {
  ProviderCapabilityError,
  ProviderSandboxMissingError,
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
import { E2BSecureDataPlane } from './e2b-secure-data-plane.js'

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

function normalizeMissing(error: unknown): never {
  if (error instanceof SandboxNotFoundError) throw new ProviderSandboxMissingError()
  throw error
}

async function execServerRpc(socket: WebSocket, id: number, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', receive)
      reject(new Error('exec server protocol probe timed out'))
    }, 10_000)
    const receive = (data: WebSocket.RawData) => {
      let message: unknown
      try { message = JSON.parse(data.toString()) } catch { return }
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || (message as Record<string, unknown>).id !== id) return
      clearTimeout(timer); socket.off('message', receive)
      const response = message as Record<string, unknown>
      if (Object.hasOwn(response, 'error')) reject(new Error('exec server protocol probe failed'))
      else if (Object.hasOwn(response, 'result')) resolve(response.result)
      else reject(new Error('exec server protocol probe failed'))
    }
    socket.on('message', receive)
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (!error) return
      clearTimeout(timer); socket.off('message', receive)
      reject(new Error('exec server protocol probe failed'))
    })
  })
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
    const sandbox = await Sandbox.create(template, {
      ...this.connection,
      metadata,
      timeoutMs: this.timeoutMs,
      // `secure` protects SDK/envd control traffic. `allowPublicTraffic: false`
      // independently requires the provider's public-port proxy to mint and
      // enforce a per-sandbox traffic token. Keep both explicit: CubeSandbox
      // and E2B expose the latter through their shared network-policy shape.
      secure: true,
      network: { allowPublicTraffic: false },
      lifecycle: { onTimeout: 'pause', autoResume: false },
    })
    this.sandboxes.set(sandbox.sandboxId, sandbox); return this.describe(sandbox)
  }
  async connect(sandboxId: string): Promise<CreatedSandbox> {
    let sandbox: Sandbox
    try { sandbox = await Sandbox.connect(sandboxId, { ...this.connection, timeoutMs: this.timeoutMs }) }
    catch (error) { normalizeMissing(error) }
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
    await uploadWorkspaceArchive(this.dataPlane(await this.handle(sandboxId)), archive, this.workspaceTransfer)
  }
  async exportWorkspace(sandboxId: string): Promise<Uint8Array> {
    return exportWorkspaceArchive(this.dataPlane(await this.handle(sandboxId)), this.workspaceTransfer)
  }
  async startExecServer(sandboxId: string): Promise<void> {
    try {
      const sandbox = await this.handle(sandboxId)
      const result = await this.dataPlane(sandbox).commands.run(
        'pkill -x codex || true; nohup codex exec-server --listen ws://0.0.0.0:22101 >/tmp/cudex-exec-server.log 2>&1 </dev/null &',
        { user: 'root', timeoutMs: 10_000 },
      )
      if (result.exitCode !== 0) throw new Error('exec server start failed')
    } catch (error) { normalizeMissing(error) }
  }
  async probeExecServer(sandboxId: string): Promise<void> {
    try {
      const sandbox = await this.handle(sandboxId)
      const result = await this.dataPlane(sandbox).commands.run(
        "for attempt in 1 2 3 4 5 6 7 8 9 10; do (exec 3<>/dev/tcp/127.0.0.1/22101) >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1",
        { user: 'root', timeoutMs: 5_000 },
      )
      if (result.exitCode !== 0) throw new Error('exec server health probe failed')
      const upstream = validateExecUpstream({
        url: `wss://${sandbox.getHost(22101)}/`, accessToken: sandbox.trafficAccessToken,
      })
      const socket = new WebSocket(upstream.url, {
        headers: { 'E2b-Traffic-Access-Token': upstream.accessToken }, maxPayload: 1024 * 1024,
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('exec server protocol probe timed out')), 10_000)
          socket.once('open', () => { clearTimeout(timer); resolve() })
          socket.once('error', () => { clearTimeout(timer); reject(new Error('exec server protocol probe failed')) })
        })
        const initialized = await execServerRpc(socket, 1, 'initialize', { clientName: 'cudex-provider-probe' })
        if (!initialized || typeof initialized !== 'object' || Array.isArray(initialized)
          || typeof (initialized as Record<string, unknown>).sessionId !== 'string') {
          throw new Error('exec server protocol probe failed')
        }
        socket.send(JSON.stringify({ method: 'initialized', params: {} }))
        const info = await execServerRpc(socket, 2, 'environment/info', {})
        const shell = info && typeof info === 'object' && !Array.isArray(info)
          ? (info as Record<string, unknown>).shell : undefined
        if (!shell || typeof shell !== 'object' || Array.isArray(shell)
          || typeof (shell as Record<string, unknown>).name !== 'string'
          || typeof (shell as Record<string, unknown>).path !== 'string') {
          throw new Error('exec server protocol probe failed')
        }
      } finally { socket.close() }
    } catch (error) { normalizeMissing(error) }
  }
  async snapshot(sandboxId: string, options: ProviderSnapshotOptions = {}): Promise<string> {
    if (options.name !== undefined) validateOpaque('provider snapshot name', options.name)
    const sandbox = await this.handle(sandboxId)
    const snapshotId = (await sandbox.createSnapshot(
      options.name === undefined ? undefined : { name: options.name },
    )).snapshotId
    // Snapshot APIs may leave the source paused even though the hosted lease
    // remains active. Resume through the control plane, but retain the
    // create-time Sandbox instance because restricted public-port credentials
    // are intentionally delivered only once on creation.
    try { await Sandbox.connect(sandboxId, { ...this.connection, timeoutMs: this.timeoutMs }) }
    catch (error) { normalizeMissing(error) }
    this.sandboxes.set(sandboxId, sandbox)
    await this.probeExecServer(sandboxId)
    return snapshotId
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
    try {
      if (!await Sandbox.kill(sandboxId, this.connection)) throw new ProviderSandboxMissingError()
    }
    catch (error) { this.sandboxes.delete(sandboxId); normalizeMissing(error) }
    this.sandboxes.delete(sandboxId)
  }
  /** Fixed, read-only POC acceptance probe; never exposes the provider token. */
  async verifyPocWorkspace(sandboxId: string): Promise<boolean> {
    validateOpaque('provider sandbox ID', sandboxId)
    const result = await this.dataPlane(await this.handle(sandboxId)).commands.run(
      './verify.sh && test -e /tmp/cudex-poc-owner-secret',
      { cwd: '/workspace/roots/0/fixture', user: 'root', timeoutMs: 60_000 },
    )
    return result.exitCode === 0
  }
  private describe(sandbox: Sandbox): CreatedSandbox { return { sandboxId: sandbox.sandboxId } }
  private dataPlane(sandbox: Sandbox): E2BSecureDataPlane {
    return new E2BSecureDataPlane(sandbox, { requestTimeoutMs: this.timeoutMs })
  }
  private async handle(id: string): Promise<Sandbox> {
    const existing = this.sandboxes.get(id)
    if (existing) return existing
    let sandbox: Sandbox
    try { sandbox = await Sandbox.connect(id, { ...this.connection, timeoutMs: this.timeoutMs }) }
    catch (error) { normalizeMissing(error) }
    this.sandboxes.set(id, sandbox)
    return sandbox
  }
}
