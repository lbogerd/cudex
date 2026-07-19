import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { ProviderAdapter } from './provider.js'
import { ProviderSandboxMissingError } from './provider.js'
import type { Lease, PostgresDurableState } from './postgres-state.js'
import {
  canonicalRequestHash,
  OperationRequestMismatchError,
  OperationTargetNotFoundError,
  type OperationAllocation,
  type OperationClaim,
  type OperationIdentity,
  type PostgresJournal,
} from './postgres-store.js'
import type { AuthenticatedTenant } from './source-snapshots.js'
import { gatewayConnectTicketPurpose, type TicketAuthority } from './tickets.js'
import type { ProvisionRequest, ProvisionedAgent, ToolPolicy } from './types.js'
import { ServiceError } from './types.js'
import { validateProvisionedAgent, validateProvisionRequest } from './validation.js'
import { canonicalJson } from './workspace-manifest.js'
import type {
  PreparedDurableBaseWorkspaceSnapshot,
  WorkspaceSnapshotPublisher,
} from './workspace-snapshots.js'
import { WorkspacePreparationAbortedError } from './workspace-snapshots.js'
import type { LeaseQuiescenceGate } from './postgres-lease-interactions.js'

export interface TrustedChildRole {
  sandboxTemplate: string
  providerTemplateId: string
  toolPolicy: ToolPolicy
  policyVersion: number
}

export interface PostgresChildOptions {
  principal: AuthenticatedTenant
  managedBy: string
  workerId: string
  roles: Record<string, TrustedChildRole>
  waitTimeoutMs?: number
  heartbeatIntervalMs?: number
  interactionGate?: LeaseQuiescenceGate
}

interface LogicalChildResponse {
  leaseId: string
  environmentId: string
  cwd: string
  workspaceRoots: string[]
  baseSnapshotId: string
  toolPolicy: ToolPolicy
}

type ChildProvisionRequest = ProvisionRequest & {
  source: { type: 'agentEnvironment'; ownerLeaseId: string }
  ownerAgentId: string
}

interface ProviderResource {
  allocationKind: 'sandbox' | 'capture_sandbox' | 'provider_snapshot'
  resourceId: string
  allocation?: OperationAllocation
  reclaimed?: boolean
}

const operation = 'provision'

function bounded(label: string, value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

export function deterministicChildId(
  prefix: 'lease' | 'env' | 'snapshot', identity: OperationIdentity,
): string {
  return `${prefix}_${createHash('sha256')
    .update('hosted-agent-child\0').update(prefix).update('\0')
    .update(identity.tenantId).update('\0').update(identity.idempotencyKey)
    .digest('hex').slice(0, 32)}`
}

export function childProviderSnapshotName(
  purpose: 'capture' | 'result', identity: OperationIdentity,
): string {
  return `child-${purpose}-${deterministicChildId('snapshot', identity)}`
}

function policy(value: unknown): ToolPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid durable tool policy')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.allowedDomains) || !Array.isArray(record.allowedTools)) {
    throw new Error('invalid durable tool policy')
  }
  return structuredClone(value) as ToolPolicy
}

export function logicalChildFromLease(lease: Lease): LogicalChildResponse {
  if (lease.state !== 'active' || !lease.baseSnapshotId || !lease.ownerAgentId
    || !lease.ownerLeaseId) throw new ServiceError(503, 'durable child response is unavailable')
  return {
    leaseId: lease.leaseId,
    environmentId: lease.environmentId,
    cwd: lease.cwdUri,
    workspaceRoots: [...lease.workspaceRootUris],
    baseSnapshotId: lease.baseSnapshotId,
    toolPolicy: policy(lease.toolPolicy),
  }
}

function replayLeaseId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError(503, 'durable child response is unavailable')
  }
  const leaseId = (value as Record<string, unknown>).leaseId
  if (typeof leaseId !== 'string') throw new ServiceError(503, 'durable child response is unavailable')
  return bounded('replay lease ID', leaseId)
}

export class PostgresChildCoordinator {
  private readonly tenantId: string
  private readonly managedBy: string
  private readonly workerId: string
  private readonly waitTimeoutMs: number
  private readonly heartbeatIntervalMs: number

  constructor(
    private readonly journal: PostgresJournal,
    private readonly state: PostgresDurableState,
    private readonly publisher: WorkspaceSnapshotPublisher,
    private readonly provider: ProviderAdapter,
    private readonly tickets: TicketAuthority,
    private readonly options: PostgresChildOptions,
  ) {
    this.tenantId = bounded('tenant ID', options.principal.tenantId)
    this.managedBy = bounded('managed-by marker', options.managedBy)
    this.workerId = bounded('worker ID', options.workerId)
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000
    if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs <= 0
      || this.waitTimeoutMs > 5 * 60_000) throw new Error('invalid operation wait timeout')
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0
      || this.heartbeatIntervalMs > 60_000) throw new Error('invalid operation heartbeat interval')
  }

  async provision(untrustedRequest: ProvisionRequest): Promise<ProvisionedAgent> {
    const request = validateProvisionRequest(untrustedRequest)
    if (request.source.type !== 'agentEnvironment') {
      throw new ServiceError(400, 'durable child requires an owner environment')
    }
    if (request.ownerAgentId === null) throw new ServiceError(400, 'durable child requires an owner agent')
    const childRequest = request as ChildProvisionRequest
    const role = this.options.roles[request.agentType]
    if (!role || role.sandboxTemplate !== request.sandboxTemplate) {
      throw new ServiceError(422, 'invalid trusted agent role')
    }
    bounded('provider template ID', role.providerTemplateId)
    if (!Number.isSafeInteger(role.policyVersion) || role.policyVersion <= 0) {
      throw new Error('invalid policy version')
    }
    const identity: OperationIdentity = {
      operation, idempotencyKey: request.idempotencyKey, tenantId: this.tenantId,
    }
    const requestHash = canonicalRequestHash(request)
    let claim: OperationClaim
    try {
      claim = await this.journal.claimOperation({
        ...identity, requestHash, workerId: this.workerId,
        primaryLeaseId: childRequest.source.ownerLeaseId,
        operationSubtype: 'child',
      })
    } catch (error) {
      if (error instanceof OperationRequestMismatchError) throw new ServiceError(409, error.message)
      if (error instanceof OperationTargetNotFoundError) throw new ServiceError(404, 'owner lease missing')
      throw new ServiceError(503, 'durable child service unavailable')
    }
    if (claim.kind === 'in_progress') {
      try {
        claim = await this.journal.waitForTerminal(
          { ...identity, requestHash }, { timeoutMs: this.waitTimeoutMs })
      } catch { throw new ServiceError(503, 'durable child is still in progress') }
    }
    if (claim.kind !== 'claimed') return this.replay(identity, claim, childRequest)
    const fence = { ...identity, generation: claim.generation, workerId: this.workerId }
    const logical = await this.journal.withSessionLeaseLocks(
      this.tenantId, [childRequest.source.ownerLeaseId], client =>
        this.runOwned(childRequest, requestHash, role, fence, client))
    return this.withConnection(logical)
  }

  private async runOwned(request: ChildProvisionRequest,
    requestHash: string, role: TrustedChildRole,
  fence: OperationIdentity & { generation: number; workerId: string },
  client: PoolClient): Promise<LogicalChildResponse> {
    const resources: ProviderResource[] = []
    let prepared: PreparedDurableBaseWorkspaceSnapshot | undefined
    let preparationStarted = false
    let finalCommitStarted = false
    let allocationOutcomeAmbiguous = false
    try {
      const owner = await this.transaction(client, async () => {
        await this.heartbeat(fence, client)
        const lease = await this.state.getLease(this.tenantId, request.source.ownerLeaseId, client)
        if (!lease || !['active', 'paused'].includes(lease.state)
          || lease.agentId !== request.ownerAgentId || !lease.latestSnapshotId
          || !lease.providerSandboxId) throw new ServiceError(404, 'owner lease missing')
        await this.options.interactionGate?.assertQuiescent(
          this.tenantId, lease.leaseId, lease.connectionGeneration, client)
        return lease
      })
      const leaseId = deterministicChildId('lease', fence)
      const environmentId = deterministicChildId('env', fence)
      const snapshotId = deterministicChildId('snapshot', fence)
      const childMetadata = {
        childLeaseId: leaseId, childEnvironmentId: environmentId,
        childSnapshotId: snapshotId, childAgentId: request.agentId,
        ownerAgentId: request.ownerAgentId, ownerLeaseId: owner.leaseId,
        agentType: request.agentType, sandboxTemplate: request.sandboxTemplate,
      }

      allocationOutcomeAmbiguous = true
      const captureSnapshotId = await this.withHeartbeat(fence, () => this.provider.snapshot(
        owner.providerSandboxId!, { name: childProviderSnapshotName('capture', fence) }))
      allocationOutcomeAmbiguous = false
      const captureSnapshot: ProviderResource = {
        allocationKind: 'provider_snapshot', resourceId: captureSnapshotId,
      }
      resources.push(captureSnapshot)
      captureSnapshot.allocation = await this.recordResource(fence, captureSnapshot, client, {
        managedBy: this.managedBy, action: 'child_capture', purpose: 'owner_snapshot',
        name: childProviderSnapshotName('capture', fence), ownerSnapshotId: owner.latestSnapshotId,
        ownerProviderSandboxId: owner.providerSandboxId,
        ownerConnectionGeneration: owner.connectionGeneration,
        ...childMetadata,
      })

      allocationOutcomeAmbiguous = true
      const capture = await this.withHeartbeat(fence, () => this.provider.restore(captureSnapshotId, {
        managedBy: this.managedBy, tenantId: this.tenantId, childLeaseId: leaseId,
        resourcePurpose: 'capture', ownerLeaseId: owner.leaseId,
      }))
      allocationOutcomeAmbiguous = false
      const captureSandbox: ProviderResource = {
        allocationKind: 'capture_sandbox', resourceId: capture.sandboxId,
      }
      resources.push(captureSandbox)
      captureSandbox.allocation = await this.recordResource(fence, captureSandbox, client, {
        managedBy: this.managedBy, action: 'child_capture', purpose: 'capture_sandbox',
        ...childMetadata,
      })
      const workspace = await this.withHeartbeat(
        fence, () => this.provider.exportWorkspace(capture.sandboxId))
      await this.reclaimResource(fence, captureSandbox, client)
      await this.reclaimResource(fence, captureSnapshot, client)

      allocationOutcomeAmbiguous = true
      const created = await this.withHeartbeat(fence, () => this.provider.create(role.providerTemplateId, {
        managedBy: this.managedBy, tenantId: this.tenantId, childLeaseId: leaseId,
        resourcePurpose: 'result', leaseId, agentId: request.agentId,
        sandboxTemplate: request.sandboxTemplate, ownerLeaseId: owner.leaseId,
      }))
      allocationOutcomeAmbiguous = false
      const resultSandbox: ProviderResource = {
        allocationKind: 'sandbox', resourceId: created.sandboxId,
      }
      resources.push(resultSandbox)
      resultSandbox.allocation = await this.recordResource(fence, resultSandbox, client, {
        managedBy: this.managedBy, action: 'child_result', purpose: 'result_sandbox',
        ...childMetadata,
      })
      await this.withHeartbeat(fence, () => this.provider.uploadArchive(created.sandboxId, workspace))
      await this.withHeartbeat(fence, () => this.provider.startExecServer(created.sandboxId))
      await this.withHeartbeat(fence, () => this.provider.probeExecServer(created.sandboxId))
      const archive = await this.withHeartbeat(
        fence, () => this.provider.exportWorkspace(created.sandboxId))

      allocationOutcomeAmbiguous = true
      const resultProviderSnapshotId = await this.withHeartbeat(fence, () => this.provider.snapshot(
        created.sandboxId, { name: childProviderSnapshotName('result', fence) }))
      allocationOutcomeAmbiguous = false
      const resultSnapshot: ProviderResource = {
        allocationKind: 'provider_snapshot', resourceId: resultProviderSnapshotId,
      }
      resources.push(resultSnapshot)
      resultSnapshot.allocation = await this.recordResource(fence, resultSnapshot, client, {
        managedBy: this.managedBy, action: 'child_result',
        purpose: 'result_snapshot', name: childProviderSnapshotName('result', fence),
        ...childMetadata,
      })

      preparationStarted = true
      prepared = await this.publisher.prepareDurableBase({
        fence,
        expectedSourceChecksum: null,
        expectedLatestSnapshotId: owner.latestSnapshotId,
        leaseId,
        environmentId,
        tenantId: this.tenantId,
        agentId: request.agentId,
        ownerAgentId: request.ownerAgentId,
        ownerLeaseId: owner.leaseId,
        sourceSnapshotId: null,
        providerSandboxId: created.sandboxId,
        sandboxTemplate: request.sandboxTemplate,
        cwdUri: owner.cwdUri,
        workspaceRootUris: [...owner.workspaceRootUris],
        toolPolicy: structuredClone(role.toolPolicy) as unknown as Record<string, unknown>,
        policyVersion: role.policyVersion,
        snapshot: { snapshotId, providerSnapshotId: resultProviderSnapshotId, archive, expiresAt: null },
      })
      finalCommitStarted = true
      return await this.transaction(client, async () => {
        await this.heartbeat(fence, client)
        await this.journal.lockProviderResources([
          { kind: 'sandbox', resourceId: created.sandboxId },
          { kind: 'provider_snapshot', resourceId: resultProviderSnapshotId },
        ], client)
        const durable = await this.publisher.commitDurableChild(fence, prepared!, {
          ownerProviderSandboxId: owner.providerSandboxId!,
          ownerConnectionGeneration: owner.connectionGeneration,
        }, client)
        const exactAllocations = await this.journal.listAllocations(fence, 10_001, client)
        const providerAllocations = exactAllocations.filter(item => item.allocationKind !== 'object')
        const providerById = new Map(providerAllocations.map(item => [item.allocationId, item]))
        const expectedProviderIds = new Set(resources.map(item => item.allocation!.allocationId))
        const exactObjects = new Set(durable.objectAllocationIds)
        if (providerAllocations.length !== resources.length
          || providerAllocations.some(item => !expectedProviderIds.has(item.allocationId))
          || resources.some(item => providerById.get(item.allocation!.allocationId)?.state
            !== (item.reclaimed ? 'reclaimed' : 'allocated'))
          || exactAllocations.filter(item => item.allocationKind === 'object').length !== exactObjects.size
          || exactAllocations.some(item => item.allocationKind === 'object'
            && (!exactObjects.has(item.allocationId) || item.state !== 'allocated'))) {
          throw new Error('durable child allocation graph mismatch')
        }
        await this.journal.bindResultLeaseAndAdoptAllocations(
          fence, fence.generation, fence.workerId, durable.lease.leaseId,
          [resultSandbox.allocation!.allocationId, resultSnapshot.allocation!.allocationId,
            ...durable.objectAllocationIds], client)
        const logical = logicalChildFromLease(durable.lease)
        await this.journal.completeOperation(
          fence, fence.generation, fence.workerId, logical, client)
        return logical
      })
    } catch (error) {
      if (finalCommitStarted) {
        const succeeded = await this.recoverCommitOutcome(
          fence, requestHash, request.source.ownerLeaseId)
        if (succeeded) return this.logicalReplay(fence, succeeded, request)
      }
      const cleaned = await this.cleanupFailedChild(fence, prepared, resources, client)
      const preparationReclaimed = error instanceof WorkspacePreparationAbortedError
      if (cleaned && !allocationOutcomeAmbiguous
        && (!preparationStarted || prepared !== undefined || preparationReclaimed)) {
        const failure = error instanceof ServiceError && error.status < 500
          ? error
          : new ServiceError(503, 'durable child failed')
        await this.journal.failOperation(fence, fence.generation, fence.workerId,
          `service_${failure.status}`, failure.message).catch(() => undefined)
        throw failure
      }
      throw new ServiceError(503, 'durable child cleanup pending')
    }
  }

  private async replay(identity: OperationIdentity,
    claim: Exclude<OperationClaim, { kind: 'claimed' | 'in_progress' }>,
    request: ProvisionRequest): Promise<ProvisionedAgent> {
    if (claim.kind === 'failed_terminal') {
      const status = /^service_([0-9]{3})$/u.exec(claim.errorCode ?? '')
      const parsed = status ? Number(status[1]) : 503
      throw new ServiceError(parsed >= 400 && parsed <= 599 ? parsed : 503,
        claim.errorMessage || 'durable child failed')
    }
    return this.withConnection(await this.logicalReplay(identity, claim, request))
  }

  private async logicalReplay(identity: OperationIdentity,
    claim: Extract<OperationClaim, { kind: 'succeeded' }>,
    request: ProvisionRequest): Promise<LogicalChildResponse> {
    if (request.source.type !== 'agentEnvironment' || request.ownerAgentId === null) {
      throw new ServiceError(503, 'durable child response is unavailable')
    }
    const lease = await this.state.getLease(identity.tenantId, replayLeaseId(claim.response))
    if (!lease || lease.leaseId !== deterministicChildId('lease', identity)
      || lease.environmentId !== deterministicChildId('env', identity)
      || lease.baseSnapshotId !== deterministicChildId('snapshot', identity)
      || lease.agentId !== request.agentId || lease.ownerAgentId !== request.ownerAgentId
      || lease.ownerLeaseId !== request.source.ownerLeaseId
      || lease.sandboxTemplate !== request.sandboxTemplate) {
      throw new ServiceError(503, 'durable child response is unavailable')
    }
    return logicalChildFromLease(lease)
  }

  private async withConnection(logical: LogicalChildResponse): Promise<ProvisionedAgent> {
    const lease = await this.state.getLease(this.tenantId, logical.leaseId)
    if (!lease || lease.state !== 'active') {
      throw new ServiceError(503, 'durable child response is unavailable')
    }
    return validateProvisionedAgent({
      ...logical,
      connection: {
        execServerUrl: await this.tickets.issue(
          logical.leaseId, gatewayConnectTicketPurpose, lease.connectionGeneration),
      },
    })
  }

  private async recoverCommitOutcome(identity: OperationIdentity & {
    generation: number; workerId: string
  }, requestHash: string, ownerLeaseId: string): Promise<
    Extract<OperationClaim, { kind: 'succeeded' }> | null
  > {
    try {
      const claim = await this.journal.claimOperation({
        operation: identity.operation, idempotencyKey: identity.idempotencyKey,
        tenantId: identity.tenantId, requestHash, workerId: this.workerId,
        primaryLeaseId: ownerLeaseId,
        operationSubtype: 'child',
      })
      if (claim.kind === 'succeeded') return claim
      if (claim.kind === 'in_progress' && claim.generation === identity.generation
        && await this.journal.heartbeatOperation(
          identity, identity.generation, identity.workerId)) return null
    } catch { /* An unreadable outcome must remain for reconciliation. */ }
    throw new ServiceError(503, 'durable child cleanup pending')
  }

  private async recordResource(fence: OperationIdentity & { generation: number; workerId: string },
    resource: ProviderResource, client: PoolClient,
    metadata: Record<string, unknown>): Promise<OperationAllocation> {
    return this.transaction(client, async () => {
      await this.heartbeat(fence, client)
      await this.journal.lockProviderResources([{
        kind: resource.allocationKind === 'provider_snapshot' ? 'provider_snapshot' : 'sandbox',
        resourceId: resource.resourceId,
      }], client)
      return this.journal.recordAllocation(fence, fence.generation, fence.workerId, {
        kind: resource.allocationKind,
        resourceId: resource.resourceId,
        metadata,
      }, client).then(allocation => {
        if (allocation.allocationKind !== resource.allocationKind
          || allocation.resourceId !== resource.resourceId || allocation.leaseId !== null
          || allocation.state !== 'allocated'
          || canonicalJson(allocation.metadata) !== canonicalJson(metadata)) {
          throw new Error('durable child allocation replay mismatch')
        }
        return allocation
      })
    })
  }

  private async reclaimResource(fence: OperationIdentity & { generation: number; workerId: string },
    resource: ProviderResource, client: PoolClient): Promise<void> {
    if (resource.reclaimed) return
    await this.transaction(client, async () => {
      await this.heartbeat(fence, client)
      await this.journal.lockProviderResources([{
        kind: resource.allocationKind === 'provider_snapshot' ? 'provider_snapshot' : 'sandbox',
        resourceId: resource.resourceId,
      }], client)
      if (resource.allocationKind === 'provider_snapshot') {
        await this.provider.deleteSnapshot(resource.resourceId)
      } else {
        try { await this.provider.kill(resource.resourceId) }
        catch (error) { if (!(error instanceof ProviderSandboxMissingError)) throw error }
      }
      if (resource.allocation) {
        await this.journal.updateAllocationState(
          fence, fence.generation, fence.workerId,
          resource.allocation.allocationId, 'reclaimed', client)
      }
    })
    resource.reclaimed = true
  }

  private async cleanupFailedChild(
    fence: OperationIdentity & { generation: number; workerId: string },
    prepared: PreparedDurableBaseWorkspaceSnapshot | undefined,
    resources: ProviderResource[], client: PoolClient,
  ): Promise<boolean> {
    let failed = false
    if (prepared) {
      try {
        await this.heartbeat(fence)
        await this.publisher.abortDurableBase(fence, prepared)
      } catch { failed = true }
    }
    for (const resource of [...resources].reverse()) {
      try { await this.reclaimResource(fence, resource, client) }
      catch { failed = true }
    }
    return !failed
  }

  private async heartbeat(fence: OperationIdentity & { generation: number; workerId: string },
    executor?: Pick<PoolClient, 'query'>): Promise<void> {
    if (!await this.journal.heartbeatOperation(
      fence, fence.generation, fence.workerId, executor)) {
      throw new ServiceError(503, 'durable child ownership changed')
    }
  }

  private async withHeartbeat<T>(
    fence: OperationIdentity & { generation: number; workerId: string },
    operationCall: () => Promise<T>,
  ): Promise<T> {
    const timer = setInterval(() => {
      void this.journal.heartbeatOperation(fence, fence.generation, fence.workerId)
        .catch(() => undefined)
    }, this.heartbeatIntervalMs)
    timer.unref()
    try {
      const result = await operationCall()
      await this.heartbeat(fence)
      return result
    } finally { clearInterval(timer) }
  }

  private async transaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
    await client.query('BEGIN')
    try {
      const result = await fn()
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  }
}
