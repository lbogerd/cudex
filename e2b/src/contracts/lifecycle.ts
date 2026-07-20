import { z } from 'zod'
import {
  validateCheckpointRequest,
  validateCheckpointResponse,
  validatePatchApplyRequest,
  validatePatchApplyResponse,
  validatePatchExportRequest,
  validatePatchExportResponse,
  validateProvisionedAgent,
  validateProvisionRequest,
  validateReconnectRequest,
  validateReferenceClearRequest,
  validateReleaseRequest,
  validateRetentionRequest,
  validateRetentionResponse,
  validateToolPolicy,
} from '../validation.js'

export type SnapshotSource =
  | { type: 'rootWorkspace'; cwd: string; workspaceRoots: string[] }
  | { type: 'sourceSnapshot'; sourceSnapshotId: string; checksum: string }
  | { type: 'agentEnvironment'; ownerLeaseId: string }
  | { type: 'durableSnapshot'; snapshotId: string }

type ProvisionRequestShape = {
  agentId: string; ownerAgentId: string | null; agentType: string; sandboxTemplate: string
  source: SnapshotSource; idempotencyKey: string
}
type LeaseRequestShape = { leaseId: string; idempotencyKey: string }
type RetentionRequestShape = {
  agentId: string; leaseId: string; baseSnapshotId: string; latestSnapshotId: string
  artifactId: string | null; expectedRevision: number | null
}
type RetentionResponseShape = { revision: number; desiredHash: string }
type ReferenceClearRequestShape = { agentId: string; leaseId: string; expectedRevision: number }
type PatchExportRequestShape = {
  leaseId: string; agentId: string; baseSnapshotId: string; idempotencyKey: string
}
type AgentPatchArtifactShape = {
  artifactId: string; agentId: string; baseSnapshotId: string; checksum: string
  changedFiles: number; sizeBytes: number
}
type PatchApplyRequestShape = { targetLeaseId: string; artifactId: string; idempotencyKey: string }
type PatchApplyResultShape =
  | { type: 'applied'; checkpoint: { snapshotId: string } }
  | { type: 'conflict'; paths: string[] }
  | { type: 'rejected'; reason: string }
type ToolPolicyShape = {
  allowedDomains: string[]
  allowedTools: Array<{ name: string; namespace: string | null }>
}
type ProvisionedAgentShape = {
  leaseId: string; environmentId: string; connection: { execServerUrl: string }; cwd: string
  workspaceRoots: string[]; baseSnapshotId: string; connectionGeneration: number; toolPolicy: ToolPolicyShape
}

// The boundary parsers deliberately retain the hardened plain-JSON checks in validation.ts.
// z.custom makes those checks part of each schema while preserving their request (400) versus
// service-output (503) error classification.
const checked = <T>(parser: (value: unknown) => T) => z.custom<T>(value => {
  parser(value)
  return true
}).transform(value => parser(value))

export const ProvisionRequestSchema = checked<ProvisionRequestShape>(validateProvisionRequest)
export const ReconnectRequestSchema = checked<LeaseRequestShape>(validateReconnectRequest)
export const CheckpointRequestSchema = checked<LeaseRequestShape>(validateCheckpointRequest)
export const ReleaseRequestSchema = checked<LeaseRequestShape>(validateReleaseRequest)
export const RetentionRequestSchema = checked<RetentionRequestShape>(validateRetentionRequest)
export const RetentionResponseSchema = checked<RetentionResponseShape>(validateRetentionResponse)
export const ReferenceClearRequestSchema = checked<ReferenceClearRequestShape>(validateReferenceClearRequest)
export const PatchExportRequestSchema = checked<PatchExportRequestShape>(validatePatchExportRequest)
export const PatchExportResponseSchema = checked<AgentPatchArtifactShape>(validatePatchExportResponse)
export const PatchApplyRequestSchema = checked<PatchApplyRequestShape>(validatePatchApplyRequest)
export const PatchApplyResponseSchema = checked<PatchApplyResultShape>(validatePatchApplyResponse)
export const CheckpointResponseSchema = checked<{ snapshotId: string }>(validateCheckpointResponse)
export const ToolPolicySchema = checked<ToolPolicyShape>(validateToolPolicy)
export const ProvisionedAgentSchema = checked<ProvisionedAgentShape>(validateProvisionedAgent)

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>
export type ReconnectRequest = z.infer<typeof ReconnectRequestSchema>
export type CheckpointRequest = z.infer<typeof CheckpointRequestSchema>
export type ReleaseRequest = z.infer<typeof ReleaseRequestSchema>
export type RetentionRequest = z.infer<typeof RetentionRequestSchema>
export type RetentionResponse = z.infer<typeof RetentionResponseSchema>
export type ReferenceClearRequest = z.infer<typeof ReferenceClearRequestSchema>
export type PatchExportRequest = z.infer<typeof PatchExportRequestSchema>
export type AgentPatchArtifact = z.infer<typeof PatchExportResponseSchema>
export type PatchApplyRequest = z.infer<typeof PatchApplyRequestSchema>
export type PatchApplyResult = z.infer<typeof PatchApplyResponseSchema>
export type ToolPolicy = z.infer<typeof ToolPolicySchema>
export type ProvisionedAgent = z.infer<typeof ProvisionedAgentSchema>
