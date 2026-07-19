import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generateRuntimeSecrets, pocRunPaths, prepareRunFiles } from '../src/poc-config.js'
import type { PocEnvironment } from '../src/poc-env.js'

test('POC runtime files contain distinct generated secrets with mode 0600', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'cudex-poc-config-'))
  const e2bRoot = join(repositoryRoot, 'e2b')
  await import('node:fs/promises').then(fs => fs.mkdir(join(e2bRoot, 'poc'), { recursive: true }))
  await writeFile(join(e2bRoot, 'poc', 'garage.toml.template'), 'replication_factor = 1\n')
  const paths = pocRunPaths(repositoryRoot, '20260719120000-123456abcdef')
  const env: PocEnvironment = {
    e2bApiKey: 'key', e2bApiUrl: 'https://e2b.invalid', e2bDomain: 'cube.app',
    templateMetadata: 'metadata.json', accessToken: 'auth', controlPort: 18443,
    postgresPort: 15432, garagePort: 13900, keepOnFailure: false, verifyTemplate: false,
  }
  const secrets = generateRuntimeSecrets()
  await prepareRunFiles(paths, env, secrets)
  for (const path of [paths.runtimeEnv, paths.composeEnv, paths.garageConfig]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
  const values = Object.values(secrets)
  assert.equal(new Set(values).size, values.length)
  const runtime = await readFile(paths.runtimeEnv, 'utf8')
  assert.ok(runtime.includes(secrets.serviceBearer))
  assert.ok(!runtime.includes(env.accessToken!))
})
