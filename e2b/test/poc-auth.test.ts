import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyAuthJsonToRuntime, createCodexProcessEnvironment, redactSecrets, validateAuthJsonFile } from '../src/poc-auth.js'

test('auth JSON validation rejects missing, symlinked, malformed, array, and empty inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cudex-poc-auth-'))
  await assert.rejects(validateAuthJsonFile(root, 'missing.json'), /unavailable/)
  await writeFile(join(root, 'malformed.json'), '{')
  await assert.rejects(validateAuthJsonFile(root, 'malformed.json'), /invalid/)
  await writeFile(join(root, 'array.json'), '[]')
  await assert.rejects(validateAuthJsonFile(root, 'array.json'), /non-empty JSON object/)
  await writeFile(join(root, 'empty.json'), '{}')
  await assert.rejects(validateAuthJsonFile(root, 'empty.json'), /non-empty JSON object/)
  await writeFile(join(root, 'real.json'), '{"tokens":{"access_token":"secret"}}')
  await symlink('real.json', join(root, 'link.json'))
  await assert.rejects(validateAuthJsonFile(root, 'link.json'), /symbolic links/)
  await mkdir(join(root, 'real-dir'))
  await symlink('real-dir', join(root, 'linked-dir'))
  await assert.rejects(validateAuthJsonFile(root, 'linked-dir/auth.json'), /symbolic links/)
})

test('Codex subprocess environment contains only auth, hosted bearer, CA, home, and PATH', () => {
  const env = createCodexProcessEnvironment({ codexHome: '/run/codex', caBundlePath: '/run/ca.pem',
    hostedBearer: 'hosted-secret', accessToken: 'codex-secret' })
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_ACCESS_TOKEN', 'CODEX_CA_CERTIFICATE',
    'CODEX_HOME', 'CODEX_HOSTED_AGENT_TOKEN', 'PATH'])
  assert.ok(!Object.hasOwn(env, 'E2B_API_KEY'))
  assert.ok(!Object.hasOwn(env, 'AWS_SECRET_ACCESS_KEY'))
  assert.ok(!Object.hasOwn(env, 'HOSTED_AGENT_DATABASE_URL'))
})

test('auth JSON runtime copy is byte-identical mode 0600 and errors redact exact secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cudex-poc-auth-'))
  const source = join(root, 'auth.json')
  const bytes = '{"tokens":{"access_token":"top-secret-value"}}\n'
  await writeFile(source, bytes)
  const validated = await validateAuthJsonFile(root, source)
  const destination = await copyAuthJsonToRuntime(validated, join(root, 'runtime'))
  assert.equal(await readFile(destination, 'utf8'), bytes)
  assert.equal((await stat(destination)).mode & 0o777, 0o600)
  assert.equal(redactSecrets('prefix top-secret-value suffix', ['top-secret-value']), 'prefix [REDACTED] suffix')
})
