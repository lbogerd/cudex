import type { ToolPolicy } from './contracts/lifecycle.js'

export type {
  AgentPatchArtifact, CheckpointRequest, PatchApplyRequest, PatchApplyResult, PatchExportRequest,
  ProvisionedAgent, ProvisionRequest, ReconnectRequest, ReferenceClearRequest, ReleaseRequest,
  RetentionRequest, RetentionResponse, SnapshotSource, ToolPolicy,
} from './contracts/lifecycle.js'
export interface LeaseRecord {
  leaseId: string; environmentId: string; sandboxId: string; agentId: string
  ownerAgentId: string | null; template: string; cwd: string; workspaceRoots: string[]
  baseSnapshotId: string; latestSnapshotId: string; state: 'provisioning' | 'active' | 'lost' | 'released'
  connectionGeneration?: number
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
  connectionGeneration: number
  consumedAt?: number; revokedAt?: number
}
export interface Database {
  leases: Record<string, LeaseRecord>; snapshots: Record<string, SnapshotRecord>
  operations: Record<string, OperationRecord>; tickets: Record<string, TicketRecord>
}
export class ServiceError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}
