import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import test from 'node:test'
import {
  componentLogger,
  createInfrastructureLoggers,
  createServiceLogger,
  safeFailureDiagnostic,
} from '../src/observability/logger.js'

function capture() {
  const lines: string[] = []
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  return { lines, destination }
}

test('service logger emits JSON with stable service, level, event, and child context', () => {
  const output = capture()
  const logger = createServiceLogger({ service: 'test-control-plane', level: 'debug', destination: output.destination })
  componentLogger(logger, 'gateway').info({ event: 'gateway_started', leaseId: 'lease-1' })
  const record = JSON.parse(output.lines.join('')) as Record<string, unknown>
  assert.equal(record.service, 'test-control-plane')
  assert.equal(record.component, 'gateway')
  assert.equal(record.event, 'gateway_started')
  assert.equal(record.level, 30)
  assert.equal(record.leaseId, 'lease-1')
})

test('service logger redacts representative secrets and request bodies', () => {
  const output = capture()
  const logger = createServiceLogger({ destination: output.destination })
  logger.error({
    event: 'redaction_test', authorization: 'Bearer secret', token: 'ticket-secret', apiKey: 'key-secret',
    credentials: { password: 'credential-secret' }, databaseUrl: 'postgresql://user:pass@db/database',
    connectionUrl: 'wss://gateway.invalid/?ticket=url-secret', commandEnv: { ACCESS_TOKEN: 'env-secret' },
    request: { body: { prompt: 'body-secret' } },
  })
  const encoded = output.lines.join('')
  for (const secret of ['Bearer secret', 'ticket-secret', 'key-secret', 'credential-secret', 'user:pass',
    'url-secret', 'env-secret', 'body-secret']) assert.equal(encoded.includes(secret), false, secret)
  assert.match(encoded, /\[Redacted\]/)
})

test('safe failure diagnostics expose bounded names and codes, never messages or stacks', () => {
  const inner = Object.assign(new Error('database URL postgresql://user:pass@db/private'), { code: 'ECONNRESET' })
  const diagnostic = safeFailureDiagnostic(new Error('outer bearer secret', { cause: inner }))
  assert.deepEqual(diagnostic, { errorType: 'Error', errorCode: 'ECONNRESET' })
  assert.equal(JSON.stringify(diagnostic).includes('secret'), false)
  assert.deepEqual(safeFailureDiagnostic({ name: 'bad name', code: 'lowercase', message: 'secret' }), {
    errorType: 'UnknownError',
  })
})

test('configured level filters lower-severity records', () => {
  const output = capture()
  const logger = createServiceLogger({ level: 'warn', destination: output.destination })
  logger.info({ event: 'filtered' })
  logger.warn({ event: 'retained' })
  assert.equal(output.lines.length, 1)
  assert.equal((JSON.parse(output.lines[0]!) as { event: string }).event, 'retained')
})

test('infrastructure logger factory supplies the supported component children', () => {
  const output = capture()
  const loggers = createInfrastructureLoggers(createServiceLogger({ destination: output.destination }))
  loggers.http.info({ event: 'request_completed' })
  loggers.gateway.info({ event: 'gateway_attached' })
  loggers.reconciliation.warn({ event: 'reconciliation_failed' })
  loggers.provider.info({ event: 'provider_operation_completed' })
  loggers.workspaceTransfer.info({ event: 'workspace_transfer_completed' })
  assert.deepEqual(output.lines.map(line => (JSON.parse(line) as { component: string }).component), [
    'http', 'gateway', 'reconciliation', 'provider', 'workspace-transfer',
  ])
})
