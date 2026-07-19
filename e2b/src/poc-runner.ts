import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyAuthJsonToRuntime, createCodexProcessEnvironment, removeRuntimeAuth, validateAuthJsonFile } from './poc-auth.js'
import { createRunId, generateCodexConfiguration, generateRuntimeSecrets, pocRunPaths, prepareRunFiles,
  resolveRepositoryPath, validateGeneratedCodexConfiguration, validatePocProvenance,
  type PocProvenance, type PocRunPaths } from './poc-config.js'
import { loadPocEnvironment, type PocEnvironment } from './poc-env.js'
import {
  assertPocPortsAvailable, detectDocker, readRuntimeEnvironment, runCompose, runMigrations,
  startCompose, startControlService, stopCompose, stopControlService, tcpConnects,
  verifyControlService, verifyGarage, writeCurrentPointer,
  type DockerCommand,
} from './poc-infrastructure.js'
import { generatePocTls, type PocTlsMaterial } from './poc-tls.js'
import { archiveWorkspace } from './ingress.js'
import { uploadSourceSnapshot } from './source-snapshot-client.js'
import { deleteThreadTree, initializeAndReadAccount, runAutomatedTurn, startPocAppServer,
  type PocAppServerEvidence, type PocAppServerProcess } from './poc-app-server-client.js'

const e2bRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const repositoryRoot = resolve(e2bRoot, '..')
const envPath = `${e2bRoot}/poc/.env`
const pointerPath = `${e2bRoot}/.state/poc/current`
const exec = promisify(execFile)

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
  const [provenance] = await Promise.all([validatePocProvenance(repositoryRoot, env.templateMetadata), detectDocker(),
    env.authJsonFile ? validateAuthJsonFile(repositoryRoot, env.authJsonFile) : Promise.resolve()])
  await assertPocPortsAvailable(env)
  await mkdir(`${e2bRoot}/.state/poc`, { recursive: true, mode: 0o700 })
  const temporaryRoot = await mkdtemp(`${e2bRoot}/.state/poc/preflight-`)
  try {
    const paths = pocRunPaths(repositoryRoot, createRunId())
    paths.runDirectory = temporaryRoot; paths.codexHome = `${temporaryRoot}/codex-home`; paths.tlsDirectory = `${temporaryRoot}/tls`
    const fakeSource = { sourceSnapshotId: `source_${'a'.repeat(32)}`, checksum: `sha256:${'b'.repeat(64)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), manifestChecksum: `sha256:${'c'.repeat(64)}`, sizeBytes: 1 }
    const tls = await generatePocTls(paths.tlsDirectory)
    await generateCodexConfiguration(paths, env, fakeSource, provenance)
    await validateGeneratedCodexConfiguration(provenance, paths, tls.combinedCaBundlePath, 'preflight-nonsecret-bearer')
    if (env.authJsonFile) await copyAuthJsonToRuntime(await validateAuthJsonFile(repositoryRoot, env.authJsonFile), paths.codexHome)
    const appServer = startPocAppServer({ provenance, paths, caBundlePath: tls.combinedCaBundlePath,
      hostedBearer: 'preflight-nonsecret-bearer', ...(env.accessToken ? { accessToken: env.accessToken } : {}),
      stderrLogPath: `${temporaryRoot}/app-server.log` })
    try { await initializeAndReadAccount(appServer) } finally { await appServer.stop() }
  } finally { await rm(temporaryRoot, { recursive: true, force: true }) }
  if (env.verifyTemplate) {
    await exec(process.execPath, [`${e2bRoot}/scripts/verify-template.mjs`, env.templateMetadata], {
      cwd: repositoryRoot, timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, E2B_API_KEY: env.e2bApiKey, E2B_API_URL: env.e2bApiUrl,
        E2B_DOMAIN: env.e2bDomain, ...(process.env.E2B_VALIDATE_API_KEY ? { E2B_VALIDATE_API_KEY: process.env.E2B_VALIDATE_API_KEY } : {}),
        ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}) },
    })
  }
  console.log(JSON.stringify({ ready: true, platform: `${process.platform}-${process.arch}`,
    ports: { control: env.controlPort, postgres: env.postgresPort, garage: env.garagePort },
    authentication: env.accessToken ? 'access_token' : 'auth_json', provenance: {
      buildId: provenance.buildId, revision: provenance.revision, codexSha256: provenance.codexSha256,
      templateId: provenance.templateId } }))
}

interface CompleteRun {
  env: PocEnvironment
  provenance: PocProvenance
  paths: PocRunPaths
  docker: DockerCommand
  tls: PocTlsMaterial
  runtime: Record<string, string>
}

interface HostedCodexPocReport {
  version: 1
  runId: string
  mode: 'automated' | 'interactive'
  startedAt: string
  finishedAt: string
  status: 'passed' | 'failed' | 'configuration_error' | 'cleanup_intervention'
  provenance: { buildId: string; revision: string; codexSha256: string; templateId: string }
  identities: { rootThreadId?: string; childThreadId?: string; rootLeaseId?: string; childLeaseId?: string; artifactId?: string }
  assertions: Record<string, boolean>
  cleanup: { serviceCleanupComplete: boolean; forcedProviderCleanup: boolean; dockerVolumesRemoved: boolean }
  logFiles: string[]
}

async function prepareCompleteRun(env: PocEnvironment): Promise<CompleteRun> {
  await preflight(env)
  const provenance = await validatePocProvenance(repositoryRoot, env.templateMetadata)
  const paths = pocRunPaths(repositoryRoot, createRunId())
  await mkdir(dirname(pointerPath), { recursive: true, mode: 0o700 })
  await prepareRunFiles(paths, env, generateRuntimeSecrets())
  const docker = await detectDocker()
  const tls = await generatePocTls(paths.tlsDirectory)
  let composeStarted = false
  try {
    await startCompose(docker, paths); composeStarted = true
    const runtime = await readRuntimeEnvironment(paths)
    await verifyGarage(env, runtime)
    await runMigrations(paths, runtime.POC_DATABASE_URL!)
    await startControlService(paths, env, runtime, tls)
    await verifyControlService(env, runtime, tls)
    const fixturePath = `${e2bRoot}/poc/fixture`
    const fixtureUri = pathToFileURL(fixturePath).href
    const archived = await archiveWorkspace(fixtureUri, [fixtureUri], [fixturePath], {
      maxBytes: 512 * 1024 * 1024, maxRoots: 1, maxExpandedBytes: 1024 * 1024 * 1024,
      maxEntries: 100_000, maxFileBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxExtractionRatio: 4,
    })
    const source = await uploadSourceSnapshot({ serviceUrl: new URL(`https://localhost:${env.controlPort}/`),
      bearerToken: runtime.POC_SERVICE_BEARER!, caBundlePath: tls.combinedCaBundlePath,
      archive: archived.bytes, cwdUri: archived.cwd, workspaceRootUris: archived.roots,
      expiresAt: new Date(Date.now() + 4 * 60 * 60_000) })
    await generateCodexConfiguration(paths, env, source, provenance)
    if (env.authJsonFile) await copyAuthJsonToRuntime(await validateAuthJsonFile(repositoryRoot, env.authJsonFile), paths.codexHome)
    await validateGeneratedCodexConfiguration(provenance, paths, tls.combinedCaBundlePath, runtime.POC_SERVICE_BEARER!)
    await writeCurrentPointer(paths)
    return { env, provenance, paths, docker, tls, runtime }
  } catch (error) {
    await stopControlService(paths).catch(() => undefined)
    if (composeStarted) await stopCompose(docker, paths).catch(() => undefined)
    await removeRuntimeAuth(paths.codexHome).catch(() => undefined)
    await Promise.all([rm(tls.caKeyPath, { force: true }), rm(tls.serverKeyPath, { force: true })])
    throw error
  }
}

async function removeCurrentPointer(paths: PocRunPaths): Promise<void> {
  const current = await readFile(pointerPath, 'utf8').catch(() => '')
  if (current.trim() === paths.runId) await rm(pointerPath, { force: true })
}

async function basicCleanup(run: CompleteRun, appServer: PocAppServerProcess | undefined,
  evidence: PocAppServerEvidence | undefined, preserve: boolean): Promise<{ serviceCleanupComplete: boolean; dockerVolumesRemoved: boolean }> {
  let serviceCleanupComplete = true
  if (appServer && evidence && !evidence.deletedThreadIds.includes(evidence.rootThreadId)) {
    try { await deleteThreadTree(appServer, evidence) } catch { serviceCleanupComplete = false }
  }
  if (appServer) await appServer.stop().catch(() => { serviceCleanupComplete = false })
  if (preserve) return { serviceCleanupComplete, dockerVolumesRemoved: false }
  await stopControlService(run.paths).catch(() => { serviceCleanupComplete = false })
  let dockerVolumesRemoved = true
  await stopCompose(run.docker, run.paths).catch(() => { dockerVolumesRemoved = false })
  await Promise.all([removeRuntimeAuth(run.paths.codexHome), rm(run.tls.caKeyPath, { force: true }),
    rm(run.tls.serverKeyPath, { force: true }), removeCurrentPointer(run.paths)])
  return { serviceCleanupComplete, dockerVolumesRemoved }
}

function appAssertions(evidence: PocAppServerEvidence | undefined): Record<string, boolean> {
  return {
    rootThreadStarted: evidence?.rootThreadStarted === true,
    spawnAgentCompleted: evidence?.spawnAgentCompleted === true,
    spawnAgentCalledExactlyOnce: evidence?.spawnAgentCount === 1,
    distinctChildThread: Boolean(evidence?.childThreadId && evidence.childThreadId !== evidence.rootThreadId),
    waitCompleted: evidence?.waitCompleted === true,
    rootPatchAvailable: evidence?.rootPatchAvailable === true,
    childPatchAvailable: evidence?.childPatchAvailable === true,
    rootTurnCompleted: evidence?.rootTurnCompleted === true,
    finalMarkerObserved: evidence?.finalMarker === true,
    rootThreadDeleted: Boolean(evidence && evidence.deletedThreadIds.includes(evidence.rootThreadId)),
    childThreadDeleted: Boolean(evidence?.childThreadId && evidence.deletedThreadIds.includes(evidence.childThreadId)),
  }
}

async function writeReport(run: CompleteRun, mode: 'automated' | 'interactive', startedAt: string,
  status: HostedCodexPocReport['status'], evidence: PocAppServerEvidence | undefined,
  assertions: Record<string, boolean>, cleanup: { serviceCleanupComplete: boolean; dockerVolumesRemoved: boolean }): Promise<void> {
  const report: HostedCodexPocReport = { version: 1, runId: run.paths.runId, mode, startedAt,
    finishedAt: new Date().toISOString(), status,
    provenance: { buildId: run.provenance.buildId, revision: run.provenance.revision,
      codexSha256: run.provenance.codexSha256, templateId: run.provenance.templateId },
    identities: { ...(evidence ? { rootThreadId: evidence.rootThreadId } : {}),
      ...(evidence?.childThreadId ? { childThreadId: evidence.childThreadId } : {}),
      ...(evidence?.artifactId ? { artifactId: evidence.artifactId } : {}) },
    assertions, cleanup: { ...cleanup, forcedProviderCleanup: false },
    logFiles: ['control-service.log', ...(mode === 'automated' ? ['app-server.log'] : [])],
  }
  await writeFile(run.paths.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

async function automated(): Promise<void> {
  const startedAt = new Date().toISOString()
  const env = await configuration()
  const run = await prepareCompleteRun(env)
  let appServer: PocAppServerProcess | undefined
  let evidence: PocAppServerEvidence | undefined
  let functional = false
  let failure: unknown
  let rejectSignal: ((error: Error) => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => { rejectSignal = reject })
  const onSigint = () => rejectSignal?.(new Error('automated POC interrupted by SIGINT'))
  const onSigterm = () => rejectSignal?.(new Error('automated POC interrupted by SIGTERM'))
  process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm)
  try {
    appServer = startPocAppServer({ provenance: run.provenance, paths: run.paths,
      caBundlePath: run.tls.combinedCaBundlePath, hostedBearer: run.runtime.POC_SERVICE_BEARER!,
      ...(env.accessToken ? { accessToken: env.accessToken } : {}),
      stderrLogPath: `${run.paths.logsDirectory}/app-server.log` })
    evidence = await Promise.race([runAutomatedTurn({ process: appServer,
      prompt: await readFile(`${e2bRoot}/poc/prompts/automated.md`, 'utf8'), fixturePath: `${e2bRoot}/poc/fixture`,
      ...(env.codexModel ? { model: env.codexModel } : {}), deadlineMs: 20 * 60_000,
      onEvidence: value => { evidence = value } }), interrupted])
    await deleteThreadTree(appServer, evidence)
    functional = Object.values(appAssertions(evidence)).every(Boolean)
    if (!functional) failure = new Error('automated app-server evidence is incomplete')
  } catch (error) { failure = error }
  finally { process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm) }
  const preserve = !functional && env.keepOnFailure
  const cleanup = await basicCleanup(run, appServer, evidence, preserve)
  const assertions = appAssertions(evidence)
  const passed = functional && cleanup.serviceCleanupComplete && cleanup.dockerVolumesRemoved
  await writeReport(run, 'automated', startedAt, passed ? 'passed' : 'failed', evidence, assertions, cleanup)
  console.log(JSON.stringify({ runId: run.paths.runId, status: passed ? 'passed' : 'failed', report: run.paths.report }))
  if (!passed) { console.error(failure instanceof Error ? failure.message : 'automated POC failed'); process.exitCode = 1 }
}

async function clipboardCommand(promptPath: string): Promise<string | undefined> {
  for (const [program, command] of [['wl-copy', `wl-copy < ${JSON.stringify(promptPath)}`],
    ['xclip', `xclip -selection clipboard < ${JSON.stringify(promptPath)}`]] as const) {
    try { await exec('sh', ['-c', `command -v ${program}`], { timeout: 2_000 }); return command } catch {}
  }
  return undefined
}

async function interactive(): Promise<void> {
  const startedAt = new Date().toISOString()
  const env = await configuration()
  const run = await prepareCompleteRun(env)
  const promptPath = `${e2bRoot}/poc/prompts/interactive.md`
  console.log(`Interactive prompt: ${promptPath}`)
  const clipboard = await clipboardCommand(promptPath)
  if (clipboard) console.log(`Clipboard: ${clipboard}`)
  const child = spawn(run.provenance.binaryPath, ['--strict-config', '-C', `${e2bRoot}/poc/fixture`, '-a', 'never',
    ...(env.codexModel ? ['-m', env.codexModel] : [])], { cwd: `${e2bRoot}/poc/fixture`,
    env: createCodexProcessEnvironment({ codexHome: run.paths.codexHome, caBundlePath: run.tls.combinedCaBundlePath,
      hostedBearer: run.runtime.POC_SERVICE_BEARER!, ...(env.accessToken ? { accessToken: env.accessToken } : {}) }),
    stdio: 'inherit' })
  const onSigint = () => child.kill('SIGINT')
  const onSigterm = () => child.kill('SIGTERM')
  process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm)
  let exitCode: number | null = null
  let childFailure: unknown
  try {
    exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject); child.once('exit', resolveExit)
    })
  } catch (error) { childFailure = error }
  finally { process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm) }
  const cleanup = await basicCleanup(run, undefined, undefined, exitCode !== 0 && env.keepOnFailure)
  const assertions = { cliExitedSuccessfully: exitCode === 0 }
  await writeReport(run, 'interactive', startedAt, 'failed', undefined, assertions, cleanup)
  console.log(JSON.stringify({ runId: run.paths.runId, mode: 'interactive', cliExitCode: exitCode, report: run.paths.report }))
  if (childFailure instanceof Error) console.error(childFailure.message)
  process.exitCode = 1
}

async function auth(): Promise<void> {
  const env = await configuration()
  const provenance = await validatePocProvenance(repositoryRoot, env.templateMetadata)
  const secretsDirectory = `${e2bRoot}/poc/secrets`
  await mkdir(secretsDirectory, { recursive: true, mode: 0o700 })
  const loginHome = await mkdtemp(`${secretsDirectory}/.device-login-`)
  const destination = `${secretsDirectory}/auth.json`
  try {
    await writeFile(`${loginHome}/config.toml`, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 })
    const child = spawn(provenance.binaryPath, ['login', '--device-auth'], { cwd: repositoryRoot,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', CODEX_HOME: loginHome }, stdio: 'inherit' })
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject); child.once('exit', resolveExit)
    })
    if (code !== 0) throw new Error('Codex device login did not complete')
    const validated = await validateAuthJsonFile(repositoryRoot, `${loginHome}/auth.json`)
    const existing = await lstat(destination).catch(() => undefined)
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('refusing to replace an unsafe auth JSON destination')
    await copyFile(validated.sourcePath, destination)
    await chmod(destination, 0o600)
    console.log(`Codex auth JSON saved to ${destination}`)
  } finally { await rm(loginHome, { recursive: true, force: true }) }
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
  if (command === 'auth') return auth()
  if (command === 'preflight') return preflight()
  if (command === 'up') return up()
  if (command === 'automated') return automated()
  if (command === 'interactive') return interactive()
  if (command === 'status') return status()
  if (command === 'down') return down()
  usage()
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'POC command failed')
  process.exitCode = 2
})
