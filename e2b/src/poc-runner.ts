import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { createRunId, generateRuntimeSecrets, pocRunPaths, prepareRunFiles, resolveRepositoryPath } from './poc-config.js'
import { loadPocEnvironment, type PocEnvironment } from './poc-env.js'
import {
  assertPocPortsAvailable, detectDocker, readRuntimeEnvironment, runCompose, runMigrations,
  startCompose, startControlService, stopCompose, stopControlService, tcpConnects,
  verifyControlService, verifyGarage, writeCurrentPointer,
} from './poc-infrastructure.js'
import { generatePocTls } from './poc-tls.js'

const e2bRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const repositoryRoot = resolve(e2bRoot, '..')
const envPath = `${e2bRoot}/poc/.env`
const pointerPath = `${e2bRoot}/.state/poc/current`

function usage(): never {
  console.error('usage: poc-runner <auth|preflight|up|automated|interactive|status|down>')
  process.exit(2)
}

async function configuration(): Promise<PocEnvironment> {
  const loaded = await loadPocEnvironment(envPath)
  return { ...loaded, templateMetadata: resolveRepositoryPath(repositoryRoot, loaded.templateMetadata),
    ...(loaded.authJsonFile ? { authJsonFile: resolveRepositoryPath(repositoryRoot, loaded.authJsonFile) } : {}) }
}

async function preflight(configured?: PocEnvironment): Promise<void> {
  const env = configured ?? await configuration()
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('the POC requires x86_64 Linux')
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('the POC requires Node.js 22 or newer')
  await Promise.all([readFile(env.templateMetadata), detectDocker()])
  await assertPocPortsAvailable(env)
  console.log(JSON.stringify({ ready: true, platform: `${process.platform}-${process.arch}`,
    ports: { control: env.controlPort, postgres: env.postgresPort, garage: env.garagePort },
    authentication: env.accessToken ? 'access_token' : 'auth_json' }))
}

async function currentRun() {
  let stat
  try { stat = await lstat(pointerPath) } catch { throw new Error('no current POC run exists') }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('current POC run pointer is ambiguous')
  const runId = (await readFile(pointerPath, 'utf8')).trim()
  return pocRunPaths(repositoryRoot, runId)
}

async function up(): Promise<void> {
  const env = await configuration()
  await preflight(env)
  const runId = createRunId()
  const paths = pocRunPaths(repositoryRoot, runId)
  await mkdir(dirname(pointerPath), { recursive: true, mode: 0o700 })
  const secrets = generateRuntimeSecrets()
  await prepareRunFiles(paths, env, secrets)
  const docker = await detectDocker()
  let started = false
  try {
    const tls = await generatePocTls(paths.tlsDirectory)
    await startCompose(docker, paths); started = true
    const runtime = await readRuntimeEnvironment(paths)
    await verifyGarage(env, runtime)
    await runMigrations(paths, runtime.POC_DATABASE_URL!)
    await startControlService(paths, env, runtime, tls)
    await verifyControlService(env, runtime, tls)
    await writeCurrentPointer(paths)
    console.log(JSON.stringify({ runId, status: 'running', serviceUrl: `https://localhost:${env.controlPort}/`,
      runDirectory: paths.runDirectory }))
  } catch (error) {
    await stopControlService(paths).catch(() => undefined)
    if (started) await stopCompose(docker, paths).catch(() => undefined)
    await rm(`${paths.tlsDirectory}/ca.key`, { force: true }).catch(() => undefined)
    await rm(`${paths.tlsDirectory}/server.key`, { force: true }).catch(() => undefined)
    throw error
  }
}

async function status(): Promise<void> {
  const paths = await currentRun()
  const runtime = await readRuntimeEnvironment(paths)
  const env = await configuration()
  const docker = await detectDocker()
  const compose = await runCompose(docker, paths, ['ps', '--format', 'json']).catch(() => '')
  console.log(JSON.stringify({ runId: paths.runId, serviceReachable: await tcpConnects(env.controlPort),
    servicePid: Number(runtime.POC_SERVICE_PID ?? 0), compose: compose.split('\n').filter(Boolean).map(line => {
      try { const value = JSON.parse(line) as Record<string, unknown>; return { service: value.Service, state: value.State, health: value.Health } }
      catch { return { state: 'unknown' } }
    }) }, null, 2))
}

async function down(): Promise<void> {
  const paths = await currentRun()
  const docker = await detectDocker()
  const graceful = await stopControlService(paths)
  await stopCompose(docker, paths)
  await Promise.all([
    rm(`${paths.codexHome}/auth.json`, { force: true }), rm(`${paths.tlsDirectory}/ca.key`, { force: true }),
    rm(`${paths.tlsDirectory}/server.key`, { force: true }), rm(pointerPath, { force: true }),
  ])
  console.log(JSON.stringify({ runId: paths.runId, stopped: true, graceful, dockerVolumesRemoved: true }))
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (!command) usage()
  if (command === 'preflight') return preflight()
  if (command === 'up') return up()
  if (command === 'status') return status()
  if (command === 'down') return down()
  if (command === 'auth' || command === 'automated' || command === 'interactive') {
    throw new Error(`${command} is added by the next POC implementation chunk`)
  }
  usage()
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'POC command failed')
  process.exitCode = 2
})
