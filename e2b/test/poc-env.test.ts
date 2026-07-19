import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePocEnvironment } from '../src/poc-env.js'

const base = {
  E2B_API_KEY: 'e2b-key', E2B_API_URL: 'http://127.0.0.1:3000',
  POC_TEMPLATE_METADATA: 'e2b/.artifacts/templates/build.json', CODEX_ACCESS_TOKEN: 'codex-token',
}

test('POC environment applies strict defaults', () => {
  const env = validatePocEnvironment(base)
  assert.equal(env.e2bDomain, 'cube.app')
  assert.equal(env.e2bValidateApiKey, true)
  assert.deepEqual([env.controlPort, env.postgresPort, env.garagePort], [18443, 15432, 13900])
  assert.equal(env.keepOnFailure, false)
})

test('POC environment rejects unknown scoped keys and invalid ports', () => {
  assert.throws(() => validatePocEnvironment({ ...base, POC_GARAGE_POTR: '12' }), /unknown/)
  assert.throws(() => validatePocEnvironment({ ...base, POC_CONTROL_PORT: '0' }), /TCP port/)
  assert.throws(() => validatePocEnvironment({ ...base, POC_CONTROL_PORT: '15432' }), /distinct/)
  assert.throws(() => validatePocEnvironment({ ...base, E2B_VALIDATE_API_KEY: 'no' }), /true or false/)
  assert.throws(() => validatePocEnvironment({ ...base, CODEX_ACCESS_TOKEN: ' token ' }), /whitespace/)
})

test('POC environment accepts explicit provider trust configuration', () => {
  const env = validatePocEnvironment({ ...base, E2B_VALIDATE_API_KEY: 'false',
    POC_PROVIDER_CA_CERTIFICATE: '/etc/cudex/provider-ca.pem' })
  assert.equal(env.e2bValidateApiKey, false)
  assert.equal(env.providerCaCertificate, '/etc/cudex/provider-ca.pem')
})

test('POC environment requires exactly one authentication source', () => {
  assert.throws(() => validatePocEnvironment({ ...base, CODEX_ACCESS_TOKEN: '' }), /exactly one/)
  assert.throws(() => validatePocEnvironment({ ...base, CODEX_AUTH_JSON_FILE: 'auth.json' }), /exactly one/)
  const env = validatePocEnvironment({ ...base, CODEX_ACCESS_TOKEN: '', CODEX_AUTH_JSON_FILE: 'auth.json' })
  assert.equal(env.authJsonFile, 'auth.json')
})
