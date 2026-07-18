export interface CreatedSandbox { sandboxId: string; rawExecUrl: string }
export interface ProviderAdapter {
  create(templateId: string, metadata: Record<string, string>): Promise<CreatedSandbox>
  connect(sandboxId: string): Promise<CreatedSandbox>
  restore(providerSnapshotId: string, metadata: Record<string, string>): Promise<CreatedSandbox>
  uploadArchive(sandboxId: string, archive: Uint8Array): Promise<void>
  exportWorkspace(sandboxId: string): Promise<Uint8Array>
  startExecServer(sandboxId: string): Promise<void>
  snapshot(sandboxId: string): Promise<string>
  kill(sandboxId: string): Promise<void>
}
