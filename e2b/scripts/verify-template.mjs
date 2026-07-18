import fs from 'node:fs/promises'
import process from 'node:process'
import { Sandbox } from 'e2b'
import WebSocket from 'ws'

const metadataPath = process.argv[2]
if (!metadataPath) {
  throw new Error('usage: node scripts/verify-template.mjs <template-metadata.json>')
}
const expected = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
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

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
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
    secure: false,
    lifecycle: { onTimeout: 'kill', autoResume: false },
  })

  const installed = JSON.parse(await sandbox.files.read('/etc/cudex/codex-build.json'))
  if (installed.revision !== expected.revision || installed.sha256 !== expected.codexSha256) {
    throw new Error('sandbox Codex metadata does not match template metadata')
  }

  const checksum = await sandbox.commands.run('sha256sum /usr/local/bin/codex')
  if (checksum.exitCode !== 0 || checksum.stdout.split(/\s+/)[0] !== expected.codexSha256) {
    throw new Error('sandbox Codex checksum does not match template metadata')
  }

  const stderr = []
  await sandbox.commands.run('codex exec-server --listen ws://0.0.0.0:22101', {
    background: true,
    timeoutMs: 10_000,
    onStderr: data => stderr.push(data),
  })
  await new Promise(resolve => setTimeout(resolve, 500))

  const url = `wss://22101-${sandbox.sandboxId}.${sandbox.sandboxDomain}`
  const socket = await openWebSocket(url)
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
    sha256: installed.sha256,
    sessionId: initialized.sessionId,
    output,
    verified: true,
  }, null, 2))
} finally {
  if (sandbox) await Sandbox.kill(sandbox.sandboxId, connection).catch(() => false)
}
