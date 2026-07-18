export interface CreatedSandbox { sandboxId: string; rawExecUrl: string }

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

export interface ProviderAdapter {
  create(templateId: string, metadata: Record<string, string>): Promise<CreatedSandbox>
  connect(sandboxId: string): Promise<CreatedSandbox>
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
