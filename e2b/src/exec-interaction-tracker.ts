import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type WebSocket from 'ws'
import type {
  LeaseInteractionIdentity,
  LeaseInteractionLedger,
} from './postgres-lease-interactions.js'

export interface ExecInteractionContext {
  tenantId: string
  ledger: LeaseInteractionLedger
}

type RequestId = string | number
type TrackedKind = 'process_start' | 'filesystem'
type PendingValue =
  | { kind: 'initialize'; resumeSessionId: string | null }
  | { kind: TrackedKind; identity: LeaseInteractionIdentity }
  | { kind: 'process_read'; identity: LeaseInteractionIdentity }
  | { kind: 'passthrough' }
interface Pending { value: PendingValue; forwarded: boolean }
interface RpcObject { [key: string]: unknown }

const requestMethods = new Set([
  'initialize', 'environment/info', 'environment/status',
  'process/start', 'process/read', 'process/write', 'process/signal', 'process/terminate',
  'fs/readFile', 'fs/open', 'fs/readBlock', 'fs/close', 'fs/writeFile',
  'fs/createDirectory', 'fs/getMetadata', 'fs/canonicalize', 'fs/readDirectory',
  'fs/walk', 'fs/remove', 'fs/copy', 'capabilityRoots/discoverV1', 'http/request',
])
const filesystemMutations = new Set([
  'fs/writeFile', 'fs/createDirectory', 'fs/remove', 'fs/copy',
])
const serverNotifications = new Set([
  'process/output', 'process/exited', 'process/closed', 'process/quiesced',
  'http/request/bodyDelta',
])
const decoder = new TextDecoder('utf-8', { fatal: true })

export class ExecInteractionProtocolError extends Error {
  constructor() { super('invalid tracked exec protocol') }
}

function bounded(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ExecInteractionProtocolError()
  }
  return value
}

function object(value: unknown): RpcObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecInteractionProtocolError()
  }
  return value as RpcObject
}

function requestId(value: unknown): RequestId {
  if (typeof value === 'string') return bounded(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw new ExecInteractionProtocolError()
}

function requestKey(value: unknown): string {
  const id = requestId(value)
  return typeof id === 'string' ? `s:${id}` : `i:${id}`
}

function decode(data: WebSocket.RawData): RpcObject {
  let body: Uint8Array
  if (Array.isArray(data)) body = Buffer.concat(data)
  else if (data instanceof ArrayBuffer) body = new Uint8Array(data)
  else body = data
  try { return object(JSON.parse(decoder.decode(body))) }
  catch (error) {
    if (error instanceof ExecInteractionProtocolError) throw error
    throw new ExecInteractionProtocolError()
  }
}

/** Per-WebSocket JSON-RPC tracker. Every mutating request is journaled before forwarding. */
export class ExecInteractionTracker {
  private readonly pending = new Map<string, Pending>()
  private readonly processes = new Map<string, LeaseInteractionIdentity>()
  private readonly preInitializeQuiesced = new Set<string>()
  private sessionId: string | undefined

  constructor(
    private readonly context: ExecInteractionContext,
    private readonly leaseId: string,
    private readonly connectionGeneration: number,
  ) {
    bounded(context.tenantId)
    bounded(leaseId)
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0) {
      throw new ExecInteractionProtocolError()
    }
  }

  async clientFrame(data: WebSocket.RawData, _binary: boolean): Promise<string | null> {
    const message = decode(data)
    if (typeof message.method !== 'string') throw new ExecInteractionProtocolError()
    if (!Object.hasOwn(message, 'id')) {
      if (message.method !== 'initialized') throw new ExecInteractionProtocolError()
      object(message.params)
      return null
    }
    const method = message.method
    if (!requestMethods.has(method)) throw new ExecInteractionProtocolError()
    const key = requestKey(message.id)
    this.ensurePendingAvailable(key)

    if (method === 'initialize') {
      const params = object(message.params)
      if (this.sessionId || [...this.pending.values()]
        .some(pending => pending.value.kind === 'initialize')) {
        throw new ExecInteractionProtocolError()
      }
      const rawResume = params.resumeSessionId
      const resumeSessionId = rawResume === undefined || rawResume === null
        ? null : bounded(rawResume)
      this.addPending(key, { kind: 'initialize', resumeSessionId })
      return key
    }

    if (method === 'process/start') {
      const sessionId = this.requireSession()
      const processId = bounded(object(message.params).processId)
      if (this.processes.has(processId)) throw new ExecInteractionProtocolError()
      const identity: LeaseInteractionIdentity = {
        tenantId: this.context.tenantId, leaseId: this.leaseId,
        interactionId: `gateway-process-${randomUUID()}`,
        connectionGeneration: this.connectionGeneration, sessionId,
        kind: 'process', processId,
      }
      await this.context.ledger.begin(identity)
      this.processes.set(processId, identity)
      this.addPending(key, { kind: 'process_start', identity })
      return key
    }

    if (filesystemMutations.has(method)) {
      const sessionId = this.requireSession()
      const identity: LeaseInteractionIdentity = {
        tenantId: this.context.tenantId, leaseId: this.leaseId,
        interactionId: `gateway-filesystem-${randomUUID()}`,
        connectionGeneration: this.connectionGeneration, sessionId,
        kind: 'filesystem', processId: null,
      }
      await this.context.ledger.begin(identity)
      this.addPending(key, { kind: 'filesystem', identity })
      return key
    }

    if (method === 'process/read') {
      const identity = this.processes.get(bounded(object(message.params).processId))
      this.addPending(key, identity
        ? { kind: 'process_read', identity } : { kind: 'passthrough' })
      return key
    }

    this.addPending(key, { kind: 'passthrough' })
    return key
  }

  markForwarded(key: string | null): void {
    if (!key) return
    const pending = this.pending.get(key)
    if (!pending) throw new ExecInteractionProtocolError()
    pending.forwarded = true
  }

  async serverFrame(data: WebSocket.RawData, _binary: boolean): Promise<void> {
    const message = decode(data)
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id') || !serverNotifications.has(message.method)) {
        throw new ExecInteractionProtocolError()
      }
      if (message.method === 'process/quiesced') {
        const processId = bounded(object(message.params).processId)
        const identity = this.processes.get(processId)
        if (identity) await this.finishProcess(identity)
        else if ([...this.pending.values()].some(pending =>
          pending.value.kind === 'initialize' && pending.value.resumeSessionId)) {
          this.preInitializeQuiesced.add(processId)
        }
      }
      return
    }
    if (!Object.hasOwn(message, 'id')) throw new ExecInteractionProtocolError()
    const key = requestKey(message.id)
    const pending = this.pending.get(key)
    if (!pending || !pending.forwarded) throw new ExecInteractionProtocolError()
    const isResult = Object.hasOwn(message, 'result')
    const isError = Object.hasOwn(message, 'error')
    if (isResult === isError) throw new ExecInteractionProtocolError()
    const value = pending.value

    if (value.kind === 'initialize') {
      if (isResult) {
        const sessionId = bounded(object(message.result).sessionId)
        if (value.resumeSessionId && value.resumeSessionId !== sessionId) {
          throw new ExecInteractionProtocolError()
        }
        if (value.resumeSessionId) {
          const unfinished = await this.context.ledger.listUnfinishedProcesses(
            this.context.tenantId, this.leaseId, this.connectionGeneration, sessionId)
          for (const identity of unfinished) {
            if (identity.kind !== 'process' || !identity.processId
              || identity.sessionId !== sessionId || this.processes.has(identity.processId)) {
              throw new ExecInteractionProtocolError()
            }
            await this.context.ledger.reattach(identity, this.connectionGeneration)
            this.processes.set(identity.processId, identity)
          }
          for (const processId of this.preInitializeQuiesced) {
            const identity = this.processes.get(processId)
            if (identity) await this.finishProcess(identity)
          }
          const filesystem = await this.context.ledger.listUnfinishedFilesystem(
            this.context.tenantId, this.leaseId, this.connectionGeneration, sessionId)
          for (const identity of filesystem) await this.context.ledger.finish(identity)
        }
        this.sessionId = sessionId
      }
      this.preInitializeQuiesced.clear()
    } else if (value.kind === 'filesystem') {
      await this.context.ledger.finish(value.identity)
    } else if (value.kind === 'process_start') {
      if (isError) await this.finishProcess(value.identity)
      else if (bounded(object(message.result).processId) !== value.identity.processId) {
        throw new ExecInteractionProtocolError()
      }
    } else if (value.kind === 'process_read' && isResult
      && object(message.result).quiesced === true) {
      await this.finishProcess(value.identity)
    }
    this.pending.delete(key)
  }

  async detach(): Promise<void> {
    const unfinished = new Map<string, LeaseInteractionIdentity>()
    const neverForwarded = new Map<string, LeaseInteractionIdentity>()
    for (const identity of this.processes.values()) unfinished.set(identity.interactionId, identity)
    for (const pending of this.pending.values()) {
      const value = pending.value
      if (value.kind === 'process_start' || value.kind === 'filesystem') {
        const target = pending.forwarded ? unfinished : neverForwarded
        target.set(value.identity.interactionId, value.identity)
      }
    }
    for (const interactionId of neverForwarded.keys()) unfinished.delete(interactionId)
    await Promise.allSettled([
      ...[...neverForwarded.values()].map(identity => this.context.ledger.finish(identity)),
      ...[...unfinished.values()].map(identity => this.context.ledger.detach(identity)),
    ])
  }

  private requireSession(): string {
    if (!this.sessionId) throw new ExecInteractionProtocolError()
    return this.sessionId
  }

  private ensurePendingAvailable(key: string): void {
    if (this.pending.has(key)) throw new ExecInteractionProtocolError()
  }

  private addPending(key: string, value: PendingValue): void {
    this.ensurePendingAvailable(key)
    this.pending.set(key, { value, forwarded: false })
  }

  private async finishProcess(identity: LeaseInteractionIdentity): Promise<void> {
    await this.context.ledger.finish(identity)
    if (identity.processId) this.processes.delete(identity.processId)
  }
}
