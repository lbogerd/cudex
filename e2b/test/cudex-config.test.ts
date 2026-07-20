import assert from 'node:assert/strict'
import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPilotConfig, loadCudexConfig, loadCudexCredentials, resolveCudexPaths, saveCudexSetup } from '../src/cudex-config.js'

test('XDG paths are deterministic, absolute, and do not escape their roots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cudex-home-'))
  const paths = resolveCudexPaths({ HOME: home, XDG_CONFIG_HOME: join(home, 'cfg'),
    XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_RUNTIME_DIR: join(home, 'run') })
  assert.equal(paths.configFile, join(home, 'cfg', 'cudex', 'config.json'))
  assert.equal(paths.releasesDirectory, join(home, 'data', 'cudex', 'releases'))
  assert.equal(paths.lockFile, join(home, 'run', 'cudex', 'run.lock'))
  assert.throws(() => resolveCudexPaths({ HOME: 'relative' }), /absolute/)
})

test('setup files round-trip exact schemas with owner-only permissions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cudex-config-'))
  const paths = resolveCudexPaths({ HOME: home })
  const releaseDirectory = join(home, '.local', 'share', 'cudex', 'releases', 'pilot-1')
  await mkdir(releaseDirectory, { recursive: true })
  const config = createPilotConfig({ releaseId: 'pilot-1', releaseDirectory, apiUrl: 'https://cube.invalid',
    domain: 'sandbox.invalid', providerCaCertificate: join(home, 'ca.pem') })
  await saveCudexSetup(paths, config, { version: 1, e2bApiKey: 'secret-api-key' })
  assert.deepEqual(await loadCudexConfig(paths), config)
  assert.deepEqual(await loadCudexCredentials(paths), { version: 1, e2bApiKey: 'secret-api-key' })
  assert.equal((await stat(paths.configDirectory)).mode & 0o777, 0o700)
  assert.equal((await stat(paths.configFile)).mode & 0o777, 0o600)
  assert.equal((await stat(paths.credentialsFile)).mode & 0o777, 0o600)
})

test('configuration rejects unknown fields, unsafe URLs, ports, and credential shapes', () => {
  const base = { releaseId: 'pilot', releaseDirectory: '/tmp/release', apiUrl: 'https://cube.invalid' }
  assert.throws(() => createPilotConfig({ ...base, apiUrl: 'http://cube.invalid' }), /API URL/)
  assert.throws(() => createPilotConfig({ ...base, controlPort: 15432, postgresPort: 15432 }), /distinct/)
  assert.throws(() => createPilotConfig({ ...base, domain: 'bad domain' }), /sandbox domain/)
})
