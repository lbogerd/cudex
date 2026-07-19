import type { Readable, Writable } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createCodexProcessEnvironment, redactSecrets } from './poc-auth.js'
import type { PocProvenance, PocRunPaths } from './poc-config.js'

const maxLineBytes = 1024 * 1024
const maxQueuedNotifications = 10_000

export interface JsonRpcNotification {
  method: string
  params?: unknown
}

interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface NotificationWaiter {
  resolve(value: JsonRpcNotification): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class PocAppServerClient {
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notifications: JsonRpcNotification[] = []
  private readonly waiters: NotificationWaiter[] = []
  private failure?: Error

  constructor(private readonly input: Writable, output: Readable) {
    output.on('data', chunk => this.data(Buffer.from(chunk)))
    output.once('end', () => this.fail(new Error('app-server reached EOF')))
    output.once('error', () => this.fail(new Error('app-server output failed')))
    input.once('error', () => this.fail(new Error('app-server input failed')))
  }

  async request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (this.failure) throw this.failure
    if (!method || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid app-server request')
    const id = this.nextId++
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} request timed out`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
    })
    await this.write({ id, method, params }).catch(() => {
      const pending = this.pending.get(id)
      if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error(`${method} request failed`)) }
    })
    return result
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.failure) throw this.failure
    await this.write(params === undefined ? { method } : { method, params })
  }

  async nextNotification(timeoutMs: number): Promise<JsonRpcNotification> {
    if (this.notifications.length > 0) return this.notifications.shift()!
    if (this.failure) throw this.failure
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid notification timeout')
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = { resolve, reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('app-server notification timed out'))
        }, timeoutMs) }
      this.waiters.push(waiter)
    })
  }

  close(): void { this.fail(new Error('app-server client closed')) }

  private async write(value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(line) > maxLineBytes) throw new Error('app-server request is too large')
    await new Promise<void>((resolve, reject) => this.input.write(line, error => error ? reject(error) : resolve()))
  }

  private data(chunk: Buffer): void {
    if (this.failure) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.byteLength > maxLineBytes && !this.buffer.includes(0x0a)) {
      this.fail(new Error('app-server message is too large')); return
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) break
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.byteLength === 0) continue
      if (line.byteLength > maxLineBytes) { this.fail(new Error('app-server message is too large')); return }
      let message: unknown
      try { message = JSON.parse(line.toString('utf8')) } catch { this.fail(new Error('app-server emitted invalid JSON')); return }
      this.message(message)
    }
  }

  private message(value: unknown): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.fail(new Error('app-server emitted an invalid message')); return
    }
    const message = value as Record<string, unknown>
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (Object.hasOwn(message, 'error')) pending.reject(new Error(`${pending.method} request failed`))
      else if (Object.hasOwn(message, 'result')) pending.resolve(message.result)
      else pending.reject(new Error(`${pending.method} response is invalid`))
      return
    }
    if (typeof message.method === 'string' && !Object.hasOwn(message, 'id')) {
      const notification: JsonRpcNotification = { method: message.method,
        ...(Object.hasOwn(message, 'params') ? { params: message.params } : {}) }
      const waiter = this.waiters.shift()
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(notification); return }
      if (this.notifications.length >= maxQueuedNotifications) {
        this.fail(new Error('app-server notification queue overflow')); return
      }
      this.notifications.push(notification); return
    }
    this.fail(new Error('app-server emitted an unsupported message'))
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error) }
    this.waiters.length = 0
  }
}

export interface PocAppServerProcess {
  client: PocAppServerClient
  child: ChildProcessWithoutNullStreams
  stop(): Promise<void>
}

export function startPocAppServer(input: {
  provenance: PocProvenance
  paths: PocRunPaths
  caBundlePath: string
  hostedBearer: string
  accessToken?: string
  stderrLogPath: string
}): PocAppServerProcess {
  const environment = createCodexProcessEnvironment({ codexHome: input.paths.codexHome,
    caBundlePath: input.caBundlePath, hostedBearer: input.hostedBearer,
    ...(input.accessToken ? { accessToken: input.accessToken } : {}) })
  const child = spawn(input.provenance.binaryPath, ['app-server', '--listen', 'stdio://', '--strict-config'], {
    cwd: input.paths.repositoryRoot, env: environment, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const client = new PocAppServerClient(child.stdin, child.stdout)
  const stderr: Buffer[] = []; let stderrBytes = 0
  child.stderr.on('data', chunk => {
    if (stderrBytes >= 4 * 1024 * 1024) return
    const bytes = Buffer.from(chunk).subarray(0, 4 * 1024 * 1024 - stderrBytes)
    stderr.push(bytes); stderrBytes += bytes.byteLength
  })
  let stopped: Promise<void> | undefined
  return { client, child, stop() {
    stopped ??= (async () => {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      if (child.exitCode === null && child.signalCode === null) {
        const graceful = await Promise.race([exited.then(() => true), new Promise<false>(resolve => {
          const timer = setTimeout(() => resolve(false), 5_000); timer.unref()
        })])
        if (!graceful) { child.kill('SIGKILL'); await exited }
      }
      client.close()
      const text = redactSecrets(Buffer.concat(stderr).toString('utf8'),
        [input.hostedBearer, input.accessToken ?? ''])
      await writeFile(input.stderrLogPath, text, { mode: 0o600 })
    })()
    return stopped
  } }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${label} response`)
  return value as Record<string, unknown>
}

export async function initializeAndReadAccount(process: PocAppServerProcess): Promise<void> {
  await process.client.request('initialize', { clientInfo: { name: 'cudex-hosted-poc', title: 'Cudex hosted POC', version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false } })
  await process.client.notify('initialized')
  const response = record(await process.client.request('account/read', { refreshToken: false }), 'account/read')
  const account = record(response.account, 'ChatGPT account')
  if (account.type !== 'chatgpt') throw new Error('Codex authentication is not ChatGPT-compatible')
}

export interface PocAppServerEvidence {
  rootThreadId: string
  childThreadId?: string
  artifactId?: string
  rootThreadStarted: boolean
  spawnAgentCompleted: boolean
  spawnAgentCount: number
  waitCompleted: boolean
  rootPatchAvailable: boolean
  childPatchAvailable: boolean
  rootTurnCompleted: boolean
  finalMarker: boolean
  deletedThreadIds: string[]
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

export function collectAppServerNotification(evidence: PocAppServerEvidence, notification: JsonRpcNotification): boolean {
  const params = notification.params && typeof notification.params === 'object' && !Array.isArray(notification.params)
    ? notification.params as Record<string, unknown> : {}
  if (notification.method === 'item/completed') {
    const item = params.item && typeof params.item === 'object' && !Array.isArray(params.item)
      ? params.item as Record<string, unknown> : {}
    const itemType = item.type
    if (itemType === 'collabToolCall' || itemType === 'collabAgentToolCall') {
      const tool = item.tool
      if (tool === 'spawnAgent' && item.status === 'completed') {
        evidence.spawnAgentCount += 1; evidence.spawnAgentCompleted = true
        const ids = [...strings(item.receiverThreadIds),
          ...[optionalString(item.receiverThreadId), optionalString(item.newThreadId)].filter((id): id is string => Boolean(id))]
        if (!evidence.childThreadId && ids[0]) evidence.childThreadId = ids[0]
      }
      if (tool === 'wait' && item.status === 'completed') evidence.waitCompleted = true
    }
    if (params.threadId === evidence.rootThreadId && itemType === 'agentMessage'
      && typeof item.text === 'string' && item.text.includes('HOSTED_CODEX_POC_OK')) evidence.finalMarker = true
  }
  if (notification.method === 'agent/patchAvailable') {
    const artifact = params.artifact && typeof params.artifact === 'object' && !Array.isArray(params.artifact)
      ? params.artifact as Record<string, unknown> : {}
    const agentId = optionalString(artifact.agentId)
    const artifactId = optionalString(artifact.artifactId)
    if (!evidence.artifactId && artifactId) evidence.artifactId = artifactId
    if (agentId === evidence.rootThreadId) evidence.rootPatchAvailable = true
    if (agentId && agentId === evidence.childThreadId) evidence.childPatchAvailable = true
  }
  if (notification.method === 'turn/completed' && params.threadId === evidence.rootThreadId) {
    const turn = params.turn && typeof params.turn === 'object' && !Array.isArray(params.turn)
      ? params.turn as Record<string, unknown> : {}
    evidence.rootTurnCompleted = turn.status === 'completed'
    return true
  }
  if (notification.method === 'thread/deleted') {
    const id = optionalString(params.threadId)
    if (id && !evidence.deletedThreadIds.includes(id)) evidence.deletedThreadIds.push(id)
  }
  return false
}

export async function runAutomatedTurn(input: {
  process: PocAppServerProcess
  prompt: string
  fixturePath: string
  model?: string
  deadlineMs: number
  onEvidence?(evidence: PocAppServerEvidence): void
}): Promise<PocAppServerEvidence> {
  await initializeAndReadAccount(input.process)
  const threadResult = record(await input.process.client.request('thread/start', {
    agentType: 'root', cwd: input.fixturePath, approvalPolicy: 'never',
    ...(input.model ? { model: input.model } : {}),
  }), 'thread/start')
  const thread = record(threadResult.thread, 'thread/start thread')
  const rootThreadId = optionalString(thread.id)
  if (!rootThreadId) throw new Error('thread/start returned no root thread ID')
  const evidence: PocAppServerEvidence = { rootThreadId, rootThreadStarted: true,
    spawnAgentCompleted: false, spawnAgentCount: 0, waitCompleted: false,
    rootPatchAvailable: false, childPatchAvailable: false, rootTurnCompleted: false,
    finalMarker: false, deletedThreadIds: [] }
  input.onEvidence?.(evidence)
  await input.process.client.request('turn/start', { threadId: rootThreadId,
    input: [{ type: 'text', text: input.prompt, textElements: [] }] })
  const deadline = Date.now() + input.deadlineMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('automated Codex turn exceeded its overall deadline')
    if (collectAppServerNotification(evidence, await input.process.client.nextNotification(remaining))) break
  }
  return evidence
}

export async function deleteThreadTree(process: PocAppServerProcess, evidence: PocAppServerEvidence): Promise<void> {
  await process.client.request('thread/delete', { threadId: evidence.rootThreadId }, 120_000)
  const expected = new Set([evidence.rootThreadId, ...(evidence.childThreadId ? [evidence.childThreadId] : [])])
  const deadline = Date.now() + 60_000
  while ([...expected].some(id => !evidence.deletedThreadIds.includes(id))) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('thread tree deletion notification timed out')
    collectAppServerNotification(evidence, await process.client.nextNotification(remaining))
  }
}
