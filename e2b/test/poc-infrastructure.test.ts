import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { S3BlobStore } from '../src/blob-store.js'
import { defaultArchiveManifestLimits } from '../src/archive-manifest.js'
import { archiveWorkspace } from '../src/ingress.js'
import { startServer } from '../src/http-server.js'
import { createRunId, generateRuntimeSecrets, pocRunPaths, prepareRunFiles } from '../src/poc-config.js'
import type { PocEnvironment } from '../src/poc-env.js'
import { detectDocker, readRuntimeEnvironment, runCompose, runMigrations, startCompose, stopCompose, verifyGarage } from '../src/poc-infrastructure.js'
import { createSourceSnapshotRuntime } from '../src/source-runtime.js'
import { uploadSourceSnapshot } from '../src/source-snapshot-client.js'
import { generatePocTls } from '../src/poc-tls.js'

const live = process.env.POC_DOCKER_TEST === 'true'

test('POC Compose provides repeatable PostgreSQL migrations and Garage object storage', { skip: !live }, async () => {
  const e2bRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
  const repositoryRoot = resolve(e2bRoot, '..')
  const paths = pocRunPaths(repositoryRoot, createRunId())
  const env: PocEnvironment = {
    e2bApiKey: 'e2b_0000000000000000000000000000000000000000', e2bApiUrl: 'https://e2b.invalid',
    e2bDomain: 'cube.app', e2bValidateApiKey: true, templateMetadata: 'unused.json', accessToken: 'unused',
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

      const sourceRuntime = await createSourceSnapshotRuntime({ databaseUrl: runtime.POC_DATABASE_URL!,
        tenantId: `poc-test-${paths.runId}`, required: true, objects: blobs,
        archiveLimits: defaultArchiveManifestLimits, maxRoots: 1, maxTtlMs: 4 * 60 * 60_000 })
      assert.ok(sourceRuntime)
      const tls = await generatePocTls(paths.tlsDirectory)
      const server = await startServer({} as never, { attach() {} } as never, {
        host: '127.0.0.1', port: env.controlPort, bearerToken: runtime.POC_SERVICE_BEARER!,
        tlsCertPath: tls.serverCertificatePath, tlsKeyPath: tls.serverKeyPath,
        sourceSnapshots: { principal: sourceRuntime.principal, api: sourceRuntime.api,
          maxArchiveBytes: defaultArchiveManifestLimits.maxArchiveBytes },
      })
      try {
        const fixture = resolve(e2bRoot, 'poc', 'fixture')
        const fixtureUri = pathToFileURL(fixture).href
        const archived = await archiveWorkspace(fixtureUri, [fixtureUri], [fixture], {
          maxBytes: defaultArchiveManifestLimits.maxArchiveBytes, maxRoots: 1,
        })
        const uploaded = await uploadSourceSnapshot({ serviceUrl: new URL(`https://localhost:${env.controlPort}/`),
          bearerToken: runtime.POC_SERVICE_BEARER!, caBundlePath: tls.combinedCaBundlePath,
          archive: archived.bytes, cwdUri: archived.cwd, workspaceRootUris: archived.roots,
          expiresAt: new Date(Date.now() + 60 * 60_000) })
        const resolved = await sourceRuntime.lifecycle.resolve(sourceRuntime.principal,
          uploaded.sourceSnapshotId, uploaded.checksum)
        assert.equal(resolved.checksum, uploaded.checksum)
        assert.equal(resolved.cwdUri, 'file:///workspace/roots/0/fixture')
      } finally {
        await new Promise<void>(resolveClose => server.close(() => resolveClose()))
        await sourceRuntime.close()
      }
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
