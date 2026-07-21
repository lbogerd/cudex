import assert from 'node:assert/strict'
import test from 'node:test'
import { loadServiceEnv } from '../src/config/service-env.js'

const development = {
  HOSTED_AGENT_DEVELOPMENT: 'true', HOSTED_AGENT_GATEWAY_URL: 'ws://127.0.0.1:8443/',
  HOSTED_AGENT_TEMPLATES: '{"root":"template"}', HOSTED_AGENT_ALLOWED_ROOTS: '/workspace',
  E2B_API_KEY: 'key', CODEX_HOSTED_AGENT_TOKEN: 'token',
}

test('service environment applies typed development defaults', () => {
  const config = loadServiceEnv(development)
  assert.equal(config.development, true)
  assert.deepEqual(config.http, { host: '127.0.0.1', port: 8443, bearerToken: 'token' })
  assert.equal(config.ingress.maxRoots, 8)
  assert.equal(config.gateway.url, 'ws://127.0.0.1:8443/')
  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.gateway))
})

test('service environment accepts complete production configuration', () => {
  const config = loadServiceEnv({ E2B_API_KEY: 'key', CODEX_HOSTED_AGENT_TOKEN: 'token',
    HOSTED_AGENT_GATEWAY_URL: 'wss://gateway.example/', HOSTED_AGENT_OBJECT_BUCKET: 'objects',
    HOSTED_AGENT_DATABASE_URL: 'postgresql://database.example/cudex', HOSTED_AGENT_TENANT_ID: 'tenant',
    HOSTED_AGENT_WORKER_ID: 'worker', HOSTED_AGENT_ROLES: '{}', HOSTED_AGENT_TLS_CERT: '/cert.pem',
    HOSTED_AGENT_TLS_KEY: '/key.pem' })
  assert.equal(config.development, false)
  assert.equal(config.durability.databaseUrl, 'postgresql://database.example/cudex')
  assert.deepEqual(config.tls, { certificatePath: '/cert.pem', keyPath: '/key.pem' })
})

test('service environment rejects permissive booleans and malformed integers', () => {
  assert.throws(() => loadServiceEnv({ ...development, HOSTED_AGENT_DEVELOPMENT: '1' }))
  for (const value of ['', '0', '-1', '1.5', '9007199254740992']) {
    assert.throws(() => loadServiceEnv({ ...development, HOSTED_AGENT_PORT: value }))
  }
})

test('service environment validates cross-field requirements before infrastructure', () => {
  assert.throws(() => loadServiceEnv({ ...development, HOSTED_AGENT_TLS_CERT: '/cert' }), /together/)
  assert.throws(() => loadServiceEnv({ ...development, HOSTED_AGENT_GATEWAY_URL: 'wss://user@gateway.example/' }), /credentials/)
  assert.throws(() => loadServiceEnv({ ...development, HOSTED_AGENT_MAX_ROOTS: '65' }), /must not exceed/)
  assert.throws(() => loadServiceEnv({ ...development, HOSTED_AGENT_TEMPLATES: '' }), /required in development/)
})

test('service environment does not accept the DATABASE_URL compatibility alias', () => {
  assert.throws(() => loadServiceEnv({ ...development, DATABASE_URL: 'postgresql://database.example/cudex' }),
    /DATABASE_URL is not supported/)
})
