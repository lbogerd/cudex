const ENVD_PORT = 49_983
const CONNECT_CONTENT_TYPE = 'application/connect+json'
const CONNECT_END_STREAM = 0x02
const CONNECT_COMPRESSED = 0x01
const MAX_FRAME_BYTES = 64 * 1024 * 1024

interface SandboxEndpoint {
  getHost(port: number): string
  trafficAccessToken?: string
}

interface FetchResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<FetchResponse>

export interface SecureDataPlaneOptions {
  requestTimeoutMs?: number
  maxFileBytes?: number
  maxCommandOutputBytes?: number
  fetch?: FetchImplementation
}

export interface SecureCommandOptions {
  user?: string
  cwd?: string
  envs?: Record<string, string>
  timeoutMs?: number
}

export interface SecureCommandResult { stdout: string; stderr: string; exitCode: number }

function positiveInteger(label: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`invalid ${label}`)
  return value
}

function opaqueToken(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('secured provider data plane is unavailable')
  }
  return value
}

function safePath(value: string): string {
  if (!value.startsWith('/') || Buffer.byteLength(value) > 4096 || /[\u0000\r\n]/u.test(value)) {
    throw new Error('invalid provider file path')
  }
  return value
}

function connectEnvelope(payload: Uint8Array): ArrayBuffer {
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error('provider command request too large')
  const result = new Uint8Array(5 + payload.byteLength)
  result[0] = 0
  new DataView(result.buffer).setUint32(1, payload.byteLength, false)
  result.set(payload, 5)
  return result.buffer
}

async function* connectFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ flags: number; payload: Uint8Array }> {
  const reader = body.getReader()
  let pending = new Uint8Array(0)
  try {
    for (;;) {
      while (pending.byteLength >= 5) {
        const size = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(1, false)
        if (size > MAX_FRAME_BYTES) throw new Error('provider command response too large')
        if (pending.byteLength < 5 + size) break
        const frame = pending.subarray(0, 5 + size)
        yield { flags: frame[0]!, payload: frame.subarray(5) }
        pending = pending.subarray(5 + size)
      }
      const next = await reader.read()
      if (next.done) break
      if (next.value.byteLength > 0) {
        if (pending.byteLength + next.value.byteLength > MAX_FRAME_BYTES + 5) {
          throw new Error('provider command response too large')
        }
        const joined = new Uint8Array(pending.byteLength + next.value.byteLength)
        joined.set(pending)
        joined.set(next.value, pending.byteLength)
        pending = joined
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (pending.byteLength !== 0) throw new Error('provider command response was truncated')
}

async function readBounded(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<Uint8Array> {
  if (!body) throw new Error('provider file response is missing a body')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) {
        await reader.cancel().catch(() => undefined)
        throw new Error('provider file limit exceeded')
      }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

function exitCodeFromStatus(status: unknown): number | undefined {
  if (typeof status !== 'string') return undefined
  const exit = /(?:exit status|exited with code)\s+(-?\d+)/u.exec(status)
  if (exit) return Number(exit[1])
  const signal = /(?:signal|terminated by signal)\s+(\d+)/u.exec(status)
  if (signal) return 128 + Number(signal[1])
  return status === 'exited' ? 0 : undefined
}

function basicUser(user: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(user)) throw new Error('invalid provider command user')
  return `Basic ${Buffer.from(`${user}:`).toString('base64')}`
}

/**
 * Minimal E2B envd client for sandboxes whose public ports require the
 * standard per-sandbox traffic token. The upstream E2B SDK remains the owner
 * of sandbox lifecycle and identity; this class only supplies the token on
 * file and command requests made by the provider.
 */
export class E2BSecureDataPlane {
  private readonly token: string
  private readonly requestTimeoutMs: number
  private readonly maxFileBytes: number
  private readonly maxCommandOutputBytes: number
  private readonly fetch: FetchImplementation

  constructor(private readonly sandbox: SandboxEndpoint, options: SecureDataPlaneOptions = {}) {
    this.token = opaqueToken(sandbox.trafficAccessToken)
    this.requestTimeoutMs = positiveInteger('provider request timeout', options.requestTimeoutMs ?? 120_000, 20 * 60_000)
    this.maxFileBytes = positiveInteger('provider file limit', options.maxFileBytes ?? 256 * 1024 * 1024, 1024 * 1024 * 1024)
    this.maxCommandOutputBytes = positiveInteger('provider command output limit',
      options.maxCommandOutputBytes ?? 4 * 1024 * 1024, 64 * 1024 * 1024)
    this.fetch = options.fetch ?? (globalThis.fetch as FetchImplementation)
  }

  private endpoint(pathname: string, parameters?: URLSearchParams): URL {
    const host = this.sandbox.getHost(ENVD_PORT)
    if (!host || /[\s/?#@]/u.test(host)) throw new Error('invalid provider data-plane host')
    const result = new URL(`https://${host}${pathname}`)
    if (parameters) result.search = parameters.toString()
    return result
  }

  private headers(additional: Record<string, string> = {}): Headers {
    return new Headers({ 'e2b-traffic-access-token': this.token, ...additional })
  }

  private async request(pathname: string, init: RequestInit, parameters?: URLSearchParams): Promise<FetchResponse> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs)
    try {
      return await this.fetch(this.endpoint(pathname, parameters), { ...init, redirect: 'error', signal })
    } catch {
      throw new Error('secured provider data-plane request failed')
    }
  }

  readonly files = {
    write: async (path: string, data: ArrayBuffer): Promise<void> => {
      if (!(data instanceof ArrayBuffer) || data.byteLength > this.maxFileBytes) throw new Error('provider file limit exceeded')
      const parameters = new URLSearchParams({ path: safePath(path), username: 'root' })
      const response = await this.request('/files', {
        method: 'POST', headers: this.headers({ 'content-type': 'application/octet-stream' }), body: data,
      }, parameters)
      if (response.status < 200 || response.status >= 300) throw new Error(`provider file write failed (${response.status})`)
    },
    read: async (path: string, options: { format: 'bytes' }): Promise<Uint8Array> => {
      if (options.format !== 'bytes') throw new Error('invalid provider file format')
      const parameters = new URLSearchParams({ path: safePath(path), username: 'root' })
      const response = await this.request('/files', { method: 'GET', headers: this.headers() }, parameters)
      if (response.status !== 200) throw new Error(`provider file read failed (${response.status})`)
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > this.maxFileBytes) throw new Error('provider file limit exceeded')
      return readBounded(response.body, this.maxFileBytes)
    },
  }

  readonly commands = {
    run: async (command: string, options: SecureCommandOptions = {}): Promise<SecureCommandResult> => {
      if (!command || Buffer.byteLength(command) > 1024 * 1024 || /\u0000/u.test(command)) {
        throw new Error('invalid provider command')
      }
      const timeoutMs = options.timeoutMs === undefined ? this.requestTimeoutMs
        : positiveInteger('provider command timeout', options.timeoutMs, 20 * 60_000)
      const user = options.user ?? 'root'
      const payload = Buffer.from(JSON.stringify({ process: {
        cmd: '/bin/bash', args: ['-l', '-c', command], envs: options.envs ?? {},
        ...(options.cwd === undefined ? {} : { cwd: safePath(options.cwd) }),
      }, stdin: false }))
      const response = await this.request('/process.Process/Start', {
        method: 'POST',
        headers: this.headers({
          'content-type': CONNECT_CONTENT_TYPE,
          'connect-protocol-version': '1',
          'connect-content-encoding': 'identity',
          'connect-timeout-ms': String(timeoutMs),
          authorization: basicUser(user),
        }),
        body: connectEnvelope(payload),
      })
      if (response.status < 200 || response.status >= 300 || !response.body) {
        throw new Error(`provider command failed (${response.status})`)
      }
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let exitCode: number | undefined
      for await (const frame of connectFrames(response.body)) {
        if ((frame.flags & CONNECT_COMPRESSED) !== 0) throw new Error('unsupported provider command compression')
        if ((frame.flags & CONNECT_END_STREAM) !== 0) {
          if (frame.payload.byteLength > 0) {
            const trailer = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as { error?: unknown }
            if (trailer.error) throw new Error('provider command stream failed')
          }
          break
        }
        const decoded = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as {
          event?: { data?: { stdout?: string; stderr?: string }; end?: {
            exitCode?: number; exit_code?: number; status?: string; error?: unknown; exited?: boolean
          } }
        }
        for (const [encoded, target] of [[decoded.event?.data?.stdout, stdout], [decoded.event?.data?.stderr, stderr]] as const) {
          if (!encoded) continue
          const chunk = Buffer.from(encoded, 'base64')
          outputBytes += chunk.byteLength
          if (outputBytes > this.maxCommandOutputBytes) throw new Error('provider command output limit exceeded')
          target.push(chunk)
        }
        const end = decoded.event?.end
        if (end) exitCode = end.exitCode ?? end.exit_code ?? exitCodeFromStatus(end.status)
          ?? (end.exited ? 0 : undefined)
        if (end?.error && exitCode === undefined) throw new Error('provider command failed')
      }
      if (exitCode === undefined) throw new Error('provider command response missing exit code')
      return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode }
    },
  }
}
