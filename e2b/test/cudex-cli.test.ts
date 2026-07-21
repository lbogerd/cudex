import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyDiscoveredCodexAuth, discoverCodexAuth, parseCudexArguments } from '../src/cudex-cli.js'
import { resolveCudexPaths } from '../src/cudex-config.js'

test('CLI parses only the supported pilot surface', () => {
  assert.deepEqual(parseCudexArguments([], '/project'), { command: 'session', directory: '/project' })
  assert.deepEqual(parseCudexArguments(['--model', 'gpt-test', '-C', 'sub', 'fix it'], '/project'),
    { command: 'session', directory: '/project/sub', prompt: 'fix it', model: 'gpt-test' })
  assert.deepEqual(parseCudexArguments(['doctor', '--verify-template']), { command: 'doctor', verifyTemplate: true })
  assert.deepEqual(parseCudexArguments(['files', '-C', '/tmp/project']), { command: 'files', directory: '/tmp/project' })
  assert.throws(() => parseCudexArguments(['--full-auto']), /unsupported/)
  assert.throws(() => parseCudexArguments(['one', 'two']), /one prompt/)
  assert.throws(() => parseCudexArguments(['setup']), /usage/)
})

test('auth discovery prefers existing Codex auth and runtime copying preserves bytes with mode policy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cudex-auth-home-')); const paths = resolveCudexPaths({ HOME: home })
  await mkdir(join(home, '.codex'), { recursive: true }); const source = join(home, '.codex', 'auth.json')
  await writeFile(source, '{"tokens":{"access_token":"test-only"}}\n', { mode: 0o600 })
  assert.equal(await discoverCodexAuth(paths), source)
  const runtime = join(home, 'runtime'); const destination = await copyDiscoveredCodexAuth(paths, runtime)
  assert.equal(destination, join(runtime, 'auth.json'))
  await assert.rejects(copyDiscoveredCodexAuth(paths, runtime), /EEXIST/)
})
