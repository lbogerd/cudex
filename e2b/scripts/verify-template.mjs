import fs from 'node:fs/promises'
import process from 'node:process'
import { Sandbox } from 'e2b'
import WebSocket from 'ws'
import { E2BSecureDataPlane } from '../dist/src/e2b-secure-data-plane.js'

const metadataPath = process.argv[2]
if (!metadataPath) {
  throw new Error('usage: node scripts/verify-template.mjs <template-metadata.json>')
}
const expected = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
const digestPattern = /^[0-9a-f]{64}$/u
if (!expected || typeof expected !== 'object' || Array.isArray(expected)
  || typeof expected.revision !== 'string' || !/^[0-9a-f]{40}$/u.test(expected.revision)
  || typeof expected.codexSha256 !== 'string' || !digestPattern.test(expected.codexSha256)
  || typeof expected.codeModeHostSha256 !== 'string' || !digestPattern.test(expected.codeModeHostSha256)
  || typeof expected.templateId !== 'string' || !expected.templateId) {
  throw new Error('template metadata is invalid')
}
if (!Number.isSafeInteger(expected.cpuMillicores) || expected.cpuMillicores <= 0
  || !Number.isSafeInteger(expected.memoryMb) || expected.memoryMb <= 0) {
  throw new Error('template metadata has invalid resource limits')
}
if (!process.env.E2B_API_KEY || !process.env.E2B_API_URL) {
  throw new Error('E2B_API_KEY and E2B_API_URL are required')
}
const connection = {
  apiKey: process.env.E2B_API_KEY,
  apiUrl: process.env.E2B_API_URL,
  domain: process.env.E2B_DOMAIN ?? 'cube.app',
  validateApiKey: process.env.E2B_VALIDATE_API_KEY !== 'false',
  requestTimeoutMs: 120_000,
}

function openWebSocket(url, accessToken) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken !== accessToken.trim()
    || Buffer.byteLength(accessToken, 'utf8') > 4096 || /[\u0000-\u001f\u007f]/u.test(accessToken)) {
    throw new Error('sandbox traffic access token is unavailable')
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { 'E2b-Traffic-Access-Token': accessToken } })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function rpc(socket, id, method, params) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10_000)
    const receive = data => {
      const message = JSON.parse(data.toString())
      if (message.id !== id) return
      clearTimeout(timeout)
      socket.off('message', receive)
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    }
    socket.on('message', receive)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

let sandbox
try {
  sandbox = await Sandbox.create(expected.templateId, {
    ...connection,
    timeoutMs: 120_000,
    secure: true,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: 'kill', autoResume: false },
  })
  const dataPlane = new E2BSecureDataPlane(sandbox, { requestTimeoutMs: 120_000 })

  const installed = JSON.parse(Buffer.from(await dataPlane.files.read(
    '/etc/cudex/codex-build.json', { format: 'bytes' },
  )).toString('utf8'))
  const installedBinaries = installed?.binaries
  if (installed.revision !== expected.revision || installedBinaries?.codex?.sha256 !== expected.codexSha256
    || installedBinaries?.['codex-code-mode-host']?.sha256 !== expected.codeModeHostSha256
    || Object.hasOwn(installed, 'sha256')) {
    throw new Error('sandbox binary metadata does not match template metadata')
  }

  const binaryInspection = await dataPlane.commands.run(
    "set -eu; for p in /usr/local/bin/codex /usr/local/bin/codex-code-mode-host; do test -f \"$p\"; test ! -L \"$p\"; test -x \"$p\"; s=$(stat -c %s \"$p\"); test \"$s\" -ge 20; test \"$s\" -le 536870912; h=$(od -An -tx1 -N20 \"$p\" | tr -d ' \\n'); test \"${h#7f454c460201}\" != \"$h\"; test \"$(printf %s \"$h\" | cut -c37-40)\" = \"3e00\"; done; sha256sum /usr/local/bin/codex /usr/local/bin/codex-code-mode-host",
  )
  const checksums = binaryInspection.stdout.trim().split(/\n/u).map(line => line.trim().split(/\s+/u)[0])
  if (binaryInspection.exitCode !== 0 || checksums.length !== 2
    || checksums[0] !== expected.codexSha256 || checksums[1] !== expected.codeModeHostSha256) {
    throw new Error('sandbox binary validation failed')
  }
  const hostCheck = await dataPlane.commands.run('/usr/local/bin/codex-code-mode-host --help >/dev/null', {
    timeoutMs: 10_000,
  })
  if (hostCheck.exitCode !== 0) {
    throw new Error('sandbox code-mode host self-check failed')
  }

  const stderr = []
  const started = await dataPlane.commands.run(
    'nohup codex exec-server --listen ws://0.0.0.0:22101 >/tmp/cudex-template-canary.log 2>&1 </dev/null &',
    { timeoutMs: 10_000 },
  )
  if (started.exitCode !== 0) throw new Error('exec-server canary failed to start')
  await new Promise(resolve => setTimeout(resolve, 500))

  const host = sandbox.getHost(22101)
  const url = `wss://${host}/`
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'wss:' || endpoint.hostname !== host || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || endpoint.href !== url) {
    throw new Error('sandbox exec endpoint is invalid')
  }
  const socket = await openWebSocket(url, sandbox.trafficAccessToken)
  const initialized = await rpc(socket, 1, 'initialize', { clientName: 'cudex-template-canary' })
  socket.send(JSON.stringify({ method: 'initialized', params: {} }))
  await rpc(socket, 2, 'process/start', {
    processId: 'canary',
    argv: ['bash', '-lc', 'printf cudex-template-ok'],
    cwd: 'file:///workspace',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    tty: false,
    pipeStdin: false,
    arg0: null,
  })
  await new Promise(resolve => setTimeout(resolve, 200))
  const read = await rpc(socket, 3, 'process/read', {
    processId: 'canary',
    afterSeq: null,
    maxBytes: 65536,
    waitMs: 1000,
  })
  socket.close()

  const output = read.chunks
    .filter(chunk => chunk.stream === 'stdout')
    .map(chunk => Buffer.from(chunk.chunk, 'base64').toString('utf8'))
    .join('')
  if (!initialized.sessionId || read.exitCode !== 0 || output !== 'cudex-template-ok') {
    throw new Error(`exec-server canary failed: ${stderr.join('')}`)
  }

  console.log(JSON.stringify({
    templateId: expected.templateId,
    sandboxId: sandbox.sandboxId,
    revision: installed.revision,
    codexSha256: installedBinaries.codex.sha256,
    codeModeHostSha256: installedBinaries['codex-code-mode-host'].sha256,
    sessionId: initialized.sessionId,
    output,
    verified: true,
  }, null, 2))
} finally {
  if (sandbox) await Sandbox.kill(sandbox.sandboxId, connection).catch(() => false)
}
