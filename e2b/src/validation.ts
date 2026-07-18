import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { CheckpointRequest, ProvisionedAgent, ProvisionRequest, ReconnectRequest, ReleaseRequest, SnapshotSource, ToolPolicy } from './types.js'
import { ServiceError } from './types.js'

export const contractLimits = {
  maxOpaqueIdBytes: 512,
  maxNameBytes: 128,
  maxPathUriBytes: 4096,
  maxConnectionUrlBytes: 4096,
  maxWorkspaceRoots: 8,
  maxAllowedDomains: 8,
  maxAllowedTools: 256,
  maxToolNameBytes: 512,
} as const

const toolDomains = new Set([
  'agentEnvironment', 'controlPlane', 'providerHosted', 'environmentBoundMcp',
  'ambientMcp', 'clientCallback', 'extension', 'orchestratorProcess',
])

type Failure = (message: string) => never
const requestFailure: Failure = message => { throw new ServiceError(400, message) }
const responseFailure: Failure = message => { throw new ServiceError(503, message) }

function object(value: unknown, keys: readonly string[], fail: Failure, kind: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail(`${kind} must be an object`)
  }
  const record = value as Record<string, unknown>
  const ownKeys = Reflect.ownKeys(record)
  if (ownKeys.some(key => typeof key !== 'string')) fail(`${kind} has invalid properties`)
  const actual = (ownKeys as string[]).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${kind} has invalid properties`)
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) fail(`${kind} is not JSON data`)
  }
  return record
}

function array(value: unknown, maxItems: number, fail: Failure, kind: string, allowEmpty: boolean): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maxItems) fail(`${kind} is invalid`)
  const ownKeys = Reflect.ownKeys(value as unknown[])
  if (ownKeys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) fail(`${kind} is invalid`)
  for (let index = 0; index < (value as unknown[]).length; index++) {
    if (!Object.hasOwn(value as unknown[], index)) fail(`${kind} is invalid`)
  }
  return value as unknown[]
}

function validUtf8(value: string): boolean { return Buffer.from(value, 'utf8').toString('utf8') === value }

function boundedString(value: unknown, maxBytes: number, fail: Failure, kind: string): string {
  if (typeof value !== 'string' || !validUtf8(value) || value.length === 0 || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${kind} is invalid`)
  }
  return value as string
}

function opaqueId(value: unknown, fail: Failure, kind: string): string {
  return boundedString(value, contractLimits.maxOpaqueIdBytes, fail, kind)
}

function canonicalFileUri(value: unknown, fail: Failure, kind: string): { uri: string; path: string } {
  if (typeof value !== 'string' || !validUtf8(value) || Buffer.byteLength(value, 'utf8') > contractLimits.maxPathUriBytes) {
    fail(`${kind} is invalid`)
  }
  let parsed: URL
  try { parsed = new URL(value as string) } catch { fail(`${kind} is invalid`) }
  if (parsed!.protocol !== 'file:' || parsed!.hostname || parsed!.username || parsed!.password || parsed!.search || parsed!.hash
    || parsed!.href !== value) fail(`${kind} is invalid`)
  let path: string
  try { path = fileURLToPath(parsed!) } catch { fail(`${kind} is invalid`) }
  if (!isAbsolute(path!) || pathToFileURL(path!).href !== value) fail(`${kind} is invalid`)
  return { uri: value as string, path: path! }
}

function below(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function workspace(value: unknown, fail: Failure, kind: string): Array<{ uri: string; path: string }> {
  const items = array(value, contractLimits.maxWorkspaceRoots, fail, kind, false)
  const roots = items.map((root, index) => canonicalFileUri(root, fail, `${kind}[${index}]`))
  if (new Set(roots.map(root => root.uri)).size !== roots.length) fail(`${kind} must be unique`)
  for (const [index, root] of roots.entries()) {
    if (roots.some((candidate, candidateIndex) => candidateIndex !== index
      && (below(root.path, candidate.path) || below(candidate.path, root.path)))) fail(`${kind} must not overlap`)
  }
  return roots
}

function rootWorkspace(source: Record<string, unknown>, fail: Failure): SnapshotSource {
  object(source, ['type', 'cwd', 'workspaceRoots'], fail, 'root workspace source')
  const cwd = canonicalFileUri(source.cwd, fail, 'workspace cwd')
  const roots = workspace(source.workspaceRoots, fail, 'workspace roots')
  if (!roots.some(root => below(cwd.path, root.path))) fail('workspace cwd must be under a workspace root')
  return { type: 'rootWorkspace', cwd: cwd.uri, workspaceRoots: roots.map(root => root.uri) }
}

function source(value: unknown, fail: Failure): SnapshotSource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('source must be an object')
  const record = value as Record<string, unknown>
  if (record.type === 'rootWorkspace') return rootWorkspace(record, fail)
  if (record.type === 'agentEnvironment') {
    object(record, ['type', 'ownerLeaseId'], fail, 'agent environment source')
    return { type: 'agentEnvironment', ownerLeaseId: opaqueId(record.ownerLeaseId, fail, 'owner lease ID') }
  }
  if (record.type === 'durableSnapshot') {
    object(record, ['type', 'snapshotId'], fail, 'durable snapshot source')
    return { type: 'durableSnapshot', snapshotId: opaqueId(record.snapshotId, fail, 'snapshot ID') }
  }
  fail('source type is invalid')
}

export function validateProvisionRequest(value: unknown): ProvisionRequest {
  const record = object(value, ['agentId', 'ownerAgentId', 'agentType', 'sandboxTemplate', 'source', 'idempotencyKey'], requestFailure, 'provision request')
  const agentId = opaqueId(record.agentId, requestFailure, 'agent ID')
  const ownerAgentId = record.ownerAgentId === null ? null : opaqueId(record.ownerAgentId, requestFailure, 'owner agent ID')
  const agentType = boundedString(record.agentType, contractLimits.maxNameBytes, requestFailure, 'agent type')
  const sandboxTemplate = boundedString(record.sandboxTemplate, contractLimits.maxNameBytes, requestFailure, 'sandbox template')
  const parsedSource = source(record.source, requestFailure)
  const idempotencyKey = opaqueId(record.idempotencyKey, requestFailure, 'idempotency key')
  if (ownerAgentId === agentId) requestFailure('agent and owner IDs must be distinct')
  if (parsedSource.type === 'rootWorkspace' && ownerAgentId !== null) requestFailure('root workspace agent must not have an owner')
  if (parsedSource.type === 'agentEnvironment' && ownerAgentId === null) {
    requestFailure('agent environment source requires a distinct owner')
  }
  return { agentId, ownerAgentId, agentType, sandboxTemplate, source: parsedSource, idempotencyKey }
}

function validateLeaseRequest(value: unknown, kind: string): { leaseId: string; idempotencyKey: string } {
  const record = object(value, ['leaseId', 'idempotencyKey'], requestFailure, `${kind} request`)
  return { leaseId: opaqueId(record.leaseId, requestFailure, 'lease ID'), idempotencyKey: opaqueId(record.idempotencyKey, requestFailure, 'idempotency key') }
}

export function validateReconnectRequest(value: unknown): ReconnectRequest { return validateLeaseRequest(value, 'reconnect') }
export function validateCheckpointRequest(value: unknown): CheckpointRequest { return validateLeaseRequest(value, 'checkpoint') }
export function validateReleaseRequest(value: unknown): ReleaseRequest { return validateLeaseRequest(value, 'release') }

export function validateCheckpointResponse(value: unknown): { snapshotId: string } {
  const record = object(value, ['snapshotId'], responseFailure, 'checkpoint response')
  return { snapshotId: opaqueId(record.snapshotId, responseFailure, 'snapshot ID') }
}

function validateConnection(value: unknown, leaseId: string): { execServerUrl: string } {
  const record = object(value, ['execServerUrl'], responseFailure, 'connection')
  const endpoint = boundedString(record.execServerUrl, contractLimits.maxConnectionUrlBytes, responseFailure, 'exec server URL')
  let parsed: URL
  try { parsed = new URL(endpoint) } catch { responseFailure('exec server URL is invalid') }
  const queryKeys = [...parsed!.searchParams.keys()]
  const tickets = parsed!.searchParams.getAll('ticket')
  const expectedSuffix = `/leases/${encodeURIComponent(leaseId)}`
  if (parsed!.protocol !== 'wss:' || !parsed!.hostname || parsed!.username || parsed!.password || parsed!.hash
    || parsed!.href !== endpoint || !parsed!.pathname.endsWith(expectedSuffix)
    || queryKeys.length !== 1 || queryKeys[0] !== 'ticket' || tickets.length !== 1
    || parsed!.search !== `?ticket=${encodeURIComponent(tickets[0]!)}`
    || !/^[A-Za-z0-9_-]+$/.test(tickets[0]!) || Buffer.byteLength(tickets[0]!, 'utf8') > contractLimits.maxOpaqueIdBytes) {
    responseFailure('exec server URL is invalid')
  }
  return { execServerUrl: endpoint }
}

function validateToolPolicy(value: unknown): ToolPolicy {
  const record = object(value, ['allowedDomains', 'allowedTools'], responseFailure, 'tool policy')
  const domains = array(record.allowedDomains, contractLimits.maxAllowedDomains, responseFailure, 'allowed domains', true)
  const allowedDomains = domains.map(domain => {
    if (typeof domain !== 'string' || !toolDomains.has(domain)) responseFailure('allowed domain is invalid')
    return domain
  })
  if (new Set(allowedDomains).size !== allowedDomains.length) responseFailure('allowed domains must be unique')
  const tools = array(record.allowedTools, contractLimits.maxAllowedTools, responseFailure, 'allowed tools', true)
  const allowedTools = tools.map((tool, index) => {
    const item = object(tool, ['name', 'namespace'], responseFailure, `allowed tool ${index}`)
    const name = boundedString(item.name, contractLimits.maxToolNameBytes, responseFailure, 'tool name')
    const namespace = item.namespace === null ? null : boundedString(item.namespace, contractLimits.maxToolNameBytes, responseFailure, 'tool namespace')
    return { name, namespace }
  })
  const toolKeys = allowedTools.map(tool => `${tool.namespace === null ? '-' : `+${tool.namespace}`}\0${tool.name}`)
  if (new Set(toolKeys).size !== toolKeys.length) responseFailure('allowed tools must be unique')
  return { allowedDomains, allowedTools }
}

export function validateProvisionedAgent(value: unknown): ProvisionedAgent {
  const record = object(value, ['leaseId', 'environmentId', 'connection', 'cwd', 'workspaceRoots', 'baseSnapshotId', 'toolPolicy'], responseFailure, 'provisioned agent')
  const leaseId = opaqueId(record.leaseId, responseFailure, 'lease ID')
  const environmentId = opaqueId(record.environmentId, responseFailure, 'environment ID')
  const baseSnapshotId = opaqueId(record.baseSnapshotId, responseFailure, 'base snapshot ID')
  const cwd = canonicalFileUri(record.cwd, responseFailure, 'workspace cwd')
  const roots = workspace(record.workspaceRoots, responseFailure, 'workspace roots')
  if (leaseId === environmentId) responseFailure('lease and environment IDs must be distinct')
  if (!roots.some(root => below(cwd.path, root.path))) responseFailure('workspace cwd must be under a workspace root')
  return {
    leaseId, environmentId, connection: validateConnection(record.connection, leaseId), cwd: cwd.uri,
    workspaceRoots: roots.map(root => root.uri), baseSnapshotId, toolPolicy: validateToolPolicy(record.toolPolicy),
  }
}
