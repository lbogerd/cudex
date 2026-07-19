import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { collectAppServerNotification, initializeAndReadAccount, PocAppServerClient, startPocAppServer,
  type PocAppServerEvidence } from '../src/poc-app-server-client.js'
import { pocRunPaths } from '../src/poc-config.js'

function harness() {
  const requests = new PassThrough(); const responses = new PassThrough()
  const client = new PocAppServerClient(requests, responses)
  let buffer = ''
  const read = async (): Promise<Record<string, unknown>> => new Promise(resolve => {
    const consume = (chunk: Buffer) => {
      buffer += chunk.toString('utf8'); const newline = buffer.indexOf('\n')
      if (newline < 0) return
      requests.off('data', consume)
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      resolve(JSON.parse(line))
    }
    requests.on('data', consume)
  })
  return { requests, responses, client, read }
}

test('JSON-RPC client handles interleaved responses and notifications', async () => {
  const { client, responses, read } = harness()
  const first = client.request('first', { value: 1 }); const firstWire = await read()
  const second = client.request('second', { value: 2 }); const secondWire = await read()
  responses.write(`${JSON.stringify({ method: 'turn/started', params: { id: 'turn' } })}\n`)
  responses.write(`${JSON.stringify({ id: secondWire.id, result: { order: 2 } })}\n`)
  responses.write(`${JSON.stringify({ id: firstWire.id, result: { order: 1 } })}\n`)
  assert.deepEqual(await first, { order: 1 }); assert.deepEqual(await second, { order: 2 })
  assert.deepEqual(await client.nextNotification(100), { method: 'turn/started', params: { id: 'turn' } })
})

test('JSON-RPC client handles errors, EOF, and timeouts without response detail leaks', async () => {
  const errorHarness = harness()
  const failed = errorHarness.client.request('secret/method', { bearer: 'request-secret' })
  const wire = await errorHarness.read()
  errorHarness.responses.write(`${JSON.stringify({ id: wire.id,
    error: { code: -32603, message: 'response-secret hosted-agent service Unavailable: service rejected the request' } })}\n`)
  await assert.rejects(failed, error => !String(error).includes('response-secret') && !String(error).includes('request-secret'))
  await failed.catch(error => assert.match(String(error), /hosted-agent unavailable, JSON-RPC -32603/))

  const eofHarness = harness(); const eof = eofHarness.client.request('pending', {})
  await eofHarness.read(); eofHarness.responses.end()
  await assert.rejects(eof, /EOF/)

  const timeoutHarness = harness(); const timeout = timeoutHarness.client.request('slow', {}, 10)
  await timeoutHarness.read(); await assert.rejects(timeout, /timed out/)
  await assert.rejects(timeoutHarness.client.nextNotification(10), /timed out/)
})

test('JSON-RPC client rejects malformed and oversized server messages', async () => {
  const malformed = harness(); const pending = malformed.client.request('pending', {})
  await malformed.read(); malformed.responses.write('{\n')
  await assert.rejects(pending, /invalid JSON/)

  const oversized = harness(); const waiting = oversized.client.request('pending', {})
  await oversized.read(); oversized.responses.write('x'.repeat(1024 * 1024 + 1))
  await assert.rejects(waiting, /too large/)
})

test('event collector accepts interleaved root/child evidence and terminal ordering', () => {
  const evidence: PocAppServerEvidence = { rootThreadId: 'root', rootThreadStarted: true, rootEnvironmentReady: true,
    spawnAgentCompleted: false, spawnAgentCount: 0, spawnCallIds: [], waitCompleted: false, rootPatchAvailable: false,
    childPatchAvailable: false, rootTurnCompleted: false, finalMarker: false, deletedThreadIds: [] }
  const event = (method: string, params: unknown) => collectAppServerNotification(evidence, { method, params })
  assert.equal(event('item/completed', { threadId: 'root', item: { type: 'collabAgentToolCall',
    id: 'spawn-call', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['child'] } }), false)
  event('item/completed', { threadId: 'root', item: { type: 'subAgentActivity',
    id: 'spawn-call', kind: 'started', agentThreadId: 'child', agentPath: '/root/child' } })
  event('agent/patchAvailable', { threadId: 'root', artifact: { artifactId: 'artifact', agentId: 'child' } })
  event('item/completed', { threadId: 'child', item: { type: 'agentMessage', text: 'child done' } })
  event('item/completed', { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'wait', status: 'completed' } })
  event('item/completed', { threadId: 'root', item: { type: 'agentMessage', text: 'done\nHOSTED_CODEX_POC_OK' } })
  assert.equal(event('turn/completed', { threadId: 'root', turn: { status: 'completed' } }), true)
  event('thread/deleted', { threadId: 'child' }); event('thread/deleted', { threadId: 'root' })
  assert.deepEqual(evidence, { rootThreadId: 'root', childThreadId: 'child', artifactId: 'artifact',
    rootThreadStarted: true, rootEnvironmentReady: true, spawnAgentCompleted: true, spawnAgentCount: 1,
    spawnCallIds: ['spawn-call'], waitCompleted: true,
    rootPatchAvailable: true, childPatchAvailable: true, rootTurnCompleted: true, finalMarker: true,
    lastRootAgentMessage: 'done\nHOSTED_CODEX_POC_OK', deletedThreadIds: ['child', 'root'] })
})

test('app-server startup performs initialize and ChatGPT account preflight in isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cudex-poc-app-server-'))
  const binary = join(root, 'codex')
  await writeFile(binary, `#!/usr/bin/env node
const readline = require('node:readline').createInterface({ input: process.stdin })
readline.on('line', line => {
  const request = JSON.parse(line)
  if (!Object.hasOwn(request, 'id')) return
  const result = request.method === 'account/read'
    ? { account: { type: 'chatgpt', email: null, planType: 'unknown' }, requiresOpenaiAuth: false }
    : {}
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
})
`)
  await chmod(binary, 0o755)
  const paths = pocRunPaths(root, '20260719120000-111111111111')
  await Promise.all([mkdir(paths.codexHome, { recursive: true }), mkdir(paths.logsDirectory, { recursive: true })])
  const stderrLogPath = join(paths.logsDirectory, 'app-server.log')
  const app = startPocAppServer({ provenance: { buildId: 'build', revision: 'a'.repeat(40),
    codexSha256: 'b'.repeat(64), templateId: 'template', binaryPath: binary, metadataPath: 'metadata' },
  paths, caBundlePath: '/tmp/ca.pem', hostedBearer: 'hosted', accessToken: 'access', stderrLogPath })
  try { await initializeAndReadAccount(app) } finally { await app.stop() }
  assert.equal(await readFile(stderrLogPath, 'utf8'), '')
})
