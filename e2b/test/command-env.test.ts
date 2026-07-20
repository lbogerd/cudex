import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCommandOsEnv } from '../src/config/command-env.js'

test('command OS environment exposes only explicitly inherited process inputs', () => {
  const env = loadCommandOsEnv({
    PATH: '/custom/bin', DOCKER_HOST: 'unix:///tmp/docker.sock', DOCKER_CONTEXT: 'test-context',
    NODE_EXTRA_CA_CERTS: '/tmp/ca.pem', E2B_VALIDATE_API_KEY: 'false',
    AWS_SECRET_ACCESS_KEY: 'must-not-be-forwarded', CODEX_ACCESS_TOKEN: 'must-not-be-forwarded',
  })
  assert.deepEqual(env, {
    path: '/custom/bin', dockerHost: 'unix:///tmp/docker.sock', dockerContext: 'test-context',
    nodeExtraCaCerts: '/tmp/ca.pem', e2bValidateApiKey: 'false',
  })
  assert.equal(Object.isFrozen(env), true)
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false)
  assert.equal('CODEX_ACCESS_TOKEN' in env, false)
})

test('command OS environment uses a deterministic minimal PATH default', () => {
  assert.deepEqual(loadCommandOsEnv({}), {
    path: '/usr/local/bin:/usr/bin:/bin', dockerHost: undefined, dockerContext: undefined,
    nodeExtraCaCerts: undefined, e2bValidateApiKey: undefined,
  })
})
