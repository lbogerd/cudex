export type SnapshotSource =
  | { type: 'rootWorkspace'; cwd: string; workspaceRoots: string[] }
  | { type: 'sourceSnapshot'; sourceSnapshotId: string; checksum: string }
  | { type: 'agentEnvironment'; ownerLeaseId: string }
  | { type: 'durableSnapshot'; snapshotId: string }

export interface ProvisionRequest {
  agentId: string; ownerAgentId: string | null; agentType: string; sandboxTemplate: string
  source: SnapshotSource; idempotencyKey: string
}
export interface ReconnectRequest { leaseId: string; idempotencyKey: string }
export interface CheckpointRequest { leaseId: string; idempotencyKey: string }
export interface ReleaseRequest { leaseId: string; idempotencyKey: string }
export interface PatchExportRequest {
  leaseId: string
  agentId: string
  baseSnapshotId: string
  idempotencyKey: string
}
export interface AgentPatchArtifact {
  artifactId: string
  agentId: string
  baseSnapshotId: string
  checksum: string
  changedFiles: number
  sizeBytes: number
}
export interface PatchApplyRequest {
  targetLeaseId: string
  artifactId: string
  idempotencyKey: string
}
export type PatchApplyResult =
  | { type: 'applied'; checkpoint: { snapshotId: string } }
  | { type: 'conflict'; paths: string[] }
  | { type: 'rejected'; reason: string }
export interface ToolPolicy {
  allowedDomains: string[]
  allowedTools: Array<{ name: string; namespace: string | null }>
}
export interface ProvisionedAgent {
  leaseId: string; environmentId: string; connection: { execServerUrl: string }; cwd: string
  workspaceRoots: string[]; baseSnapshotId: string; toolPolicy: ToolPolicy
}
export interface LeaseRecord {
  leaseId: string; environmentId: string; sandboxId: string; agentId: string
  ownerAgentId: string | null; template: string; cwd: string; workspaceRoots: string[]
  baseSnapshotId: string; latestSnapshotId: string; state: 'provisioning' | 'active' | 'released'
  toolPolicy: ToolPolicy
}
export interface SnapshotRecord {
  snapshotId: string; providerSnapshotId: string; workspaceArchiveId: string; leaseId: string; createdAt: number
}
export interface OperationRecord {
  operation: string; idempotencyKey: string; requestHash: string
  state: 'in_progress' | 'succeeded' | 'failed_terminal'; response?: unknown
  allocatedSandboxId?: string; error?: string
}
export type TicketPurpose = 'exec_gateway_connect' | 'exec_gateway_probe'
export interface TicketRecord {
  ticketHash: string; leaseId: string; purpose: TicketPurpose; issuedAt: number; expiresAt: number
  consumedAt?: number; revokedAt?: number
}
export interface Database {
  leases: Record<string, LeaseRecord>; snapshots: Record<string, SnapshotRecord>
  operations: Record<string, OperationRecord>; tickets: Record<string, TicketRecord>
}
export class ServiceError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}
