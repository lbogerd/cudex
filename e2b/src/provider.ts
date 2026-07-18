export interface CreatedSandbox { sandboxId: string }

/** Transient provider credential used only while the gateway opens an upstream socket. */
export interface ExecUpstream { url: string; accessToken: string }

export function validateExecUpstream(value: unknown, allowInsecure = false): ExecUpstream {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('invalid exec upstream')
  }
  const record = value as Record<string, unknown>
  const keys = Reflect.ownKeys(record)
  if (keys.some(key => typeof key !== 'string') || keys.length !== 2
    || !keys.includes('url') || !keys.includes('accessToken')) throw new Error('invalid exec upstream')
  const values = new Map<string, unknown>()
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('invalid exec upstream')
    values.set(key, descriptor.value)
  }
  const url = values.get('url')
  const accessToken = values.get('accessToken')
  if (typeof url !== 'string' || Buffer.byteLength(url, 'utf8') > 4096
    || Buffer.from(url, 'utf8').toString('utf8') !== url
    || typeof accessToken !== 'string' || !accessToken
    || accessToken !== accessToken.trim() || Buffer.byteLength(accessToken, 'utf8') > 4096
    || Buffer.from(accessToken, 'utf8').toString('utf8') !== accessToken
    || /[\u0000-\u001f\u007f]/u.test(accessToken)) throw new Error('invalid exec upstream')
  let endpoint: URL
  try { endpoint = new URL(url) } catch { throw new Error('invalid exec upstream') }
  const insecureLoopback = allowInsecure && endpoint.protocol === 'ws:'
    && (endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]')
  if ((endpoint.protocol !== 'wss:' && !insecureLoopback) || !endpoint.hostname
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
    || endpoint.href !== url) throw new Error('invalid exec upstream')
  return { url, accessToken }
}

export interface ManagedSandbox {
  sandboxId: string
  templateId: string
  metadata: Record<string, string>
  state: 'running' | 'paused'
  startedAt: Date
  endAt: Date
}

export interface ManagedSnapshot {
  snapshotId: string
  names: string[]
}

export interface ManagedSandboxQuery {
  /** Required service and tenant ownership markers. Unscoped provider inventory is forbidden. */
  metadata: Record<string, string> & { managedBy: string; tenantId: string }
}

export interface ProviderSnapshotQuery {
  /** E2B does not expose snapshot metadata; callers must scope by source sandbox or deterministic name. */
  sandboxId?: string
  name?: string
}

export interface ProviderSnapshotOptions { name?: string }

export class ProviderCapabilityError extends Error {
  constructor(capability: string, message: string) {
    super(`provider capability ${capability} is unavailable: ${message}`)
    this.name = 'ProviderCapabilityError'
  }
}

/** A provider-neutral signal that a sandbox no longer exists or is no longer resumable. */
export class ProviderSandboxMissingError extends Error {
  constructor() {
    super('provider sandbox missing')
    this.name = 'ProviderSandboxMissingError'
  }
}

export interface ProviderAdapter {
  create(templateId: string, metadata: Record<string, string>): Promise<CreatedSandbox>
  connect(sandboxId: string): Promise<CreatedSandbox>
  execUpstream(sandboxId: string): Promise<ExecUpstream>
  restore(providerSnapshotId: string, metadata: Record<string, string>): Promise<CreatedSandbox>
  uploadArchive(sandboxId: string, archive: Uint8Array): Promise<void>
  exportWorkspace(sandboxId: string): Promise<Uint8Array>
  startExecServer(sandboxId: string): Promise<void>
  probeExecServer(sandboxId: string): Promise<void>
  snapshot(sandboxId: string, options?: ProviderSnapshotOptions): Promise<string>
  listManagedSandboxes(query: ManagedSandboxQuery): Promise<ManagedSandbox[]>
  listSnapshots(query: ProviderSnapshotQuery): Promise<ManagedSnapshot[]>
  deleteSnapshot(snapshotId: string): Promise<boolean>
  kill(sandboxId: string): Promise<void>
}
