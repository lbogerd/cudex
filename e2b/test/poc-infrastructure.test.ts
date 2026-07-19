import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { S3BlobStore } from '../src/blob-store.js'
import { createRunId, generateRuntimeSecrets, pocRunPaths, prepareRunFiles } from '../src/poc-config.js'
import type { PocEnvironment } from '../src/poc-env.js'
import { detectDocker, readRuntimeEnvironment, runCompose, runMigrations, startCompose, stopCompose, verifyGarage } from '../src/poc-infrastructure.js'

const live = process.env.POC_DOCKER_TEST === 'true'

test('POC Compose provides repeatable PostgreSQL migrations and Garage object storage', { skip: !live }, async () => {
  const e2bRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
  const repositoryRoot = resolve(e2bRoot, '..')
  const paths = pocRunPaths(repositoryRoot, createRunId())
  const env: PocEnvironment = {
    e2bApiKey: 'e2b_0000000000000000000000000000000000000000', e2bApiUrl: 'https://e2b.invalid',
    e2bDomain: 'cube.app', templateMetadata: 'unused.json', accessToken: 'unused',
    controlPort: 18443, postgresPort: 15432, garagePort: 13900,
    keepOnFailure: false, verifyTemplate: false,
  }
  const docker = await detectDocker()
  await prepareRunFiles(paths, env, generateRuntimeSecrets())
  try {
    await startCompose(docker, paths)
    const runtime = await readRuntimeEnvironment(paths)
    await verifyGarage(env, runtime)
    await runMigrations(paths, runtime.POC_DATABASE_URL!)
    await runMigrations(paths, runtime.POC_DATABASE_URL!)
    const previousAccess = process.env.AWS_ACCESS_KEY_ID
    const previousSecret = process.env.AWS_SECRET_ACCESS_KEY
    process.env.AWS_ACCESS_KEY_ID = runtime.POC_GARAGE_ACCESS_KEY
    process.env.AWS_SECRET_ACCESS_KEY = runtime.POC_GARAGE_SECRET_KEY
    try {
      const blobs = new S3BlobStore({ bucket: runtime.POC_GARAGE_BUCKET!,
        endpoint: `http://127.0.0.1:${env.garagePort}`, region: 'garage', forcePathStyle: true })
      const body = new TextEncoder().encode('garage-poc-round-trip')
      const id = await blobs.put(body)
      assert.deepEqual(await blobs.get(id), body)
      await blobs.delete(id)
    } finally {
      if (previousAccess === undefined) delete process.env.AWS_ACCESS_KEY_ID
      else process.env.AWS_ACCESS_KEY_ID = previousAccess
      if (previousSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY
      else process.env.AWS_SECRET_ACCESS_KEY = previousSecret
    }
  } finally {
    await stopCompose(docker, paths)
  }
  assert.equal((await runCompose(docker, paths, ['ps', '-q'])).trim(), '')
  await rm(paths.runDirectory, { recursive: true, force: true })
})
