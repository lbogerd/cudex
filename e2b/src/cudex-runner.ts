import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CudexArguments } from './cudex-cli.js'
import { copyDiscoveredCodexAuth, discoverCodexAuth } from './cudex-cli.js'
import { loadCudexConfig, loadCudexCredentials, type CudexConfig, type CudexPaths } from './cudex-config.js'
import { validateCachedRelease, type CudexReleaseManifest } from './cudex-release.js'
import { projectGitWorkspace, type GitWorkspaceProjection } from './git-workspace.js'
import { createCodexProcessEnvironment } from './poc-auth.js'
import { initializeAndReadAccount, startPocAppServer } from './poc-app-server-client.js'
import { createRunId, generateCodexConfiguration, generateRuntimeSecrets, prepareRunFiles,
  validateGeneratedCodexConfiguration, type PocProvenance, type PocRunPaths } from './poc-config.js'
import type { PocEnvironment } from './poc-env.js'
import { assertPocPortsAvailable, detectDocker, readRuntimeEnvironment, runCompose, runMigrations,
  startCompose, startControlService, stopCompose, stopControlService, tcpConnects, verifyControlService,
  verifyGarage, type DockerCommand } from './poc-infrastructure.js'
import { openPocDatabaseInspector, type PocLeaseInspection } from './poc-inspector.js'
import { exactCleanup, existingTlsMaterial } from './poc-runner.js'
import { generatePocTls, type PocTlsMaterial } from './poc-tls.js'
import { uploadSourceSnapshot, type UploadedSourceSnapshot } from './source-snapshot-client.js'
import { writeCudexPhaseReport, type CudexResultStatus } from './run-report.js'

const e2bRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repositoryRoot = resolve(e2bRoot, '..')

interface CurrentRunState {
  version: 1
  runId: string
  pid: number
  startedAt: string
  selectedDirectory: string
  phase: 'preparing' | 'tui' | 'finalizing' | 'cleanup' | 'recovery'
}

export interface PreparedCudexRun {
  config: CudexConfig
  env: PocEnvironment
  release: CudexReleaseManifest
  provenance: PocProvenance
  paths: PocRunPaths
  docker: DockerCommand
  tls: PocTlsMaterial
  runtime: Record<string, string>
  projection: GitWorkspaceProjection
  source: UploadedSourceSnapshot
  startedAt: string
}

function pilotRunPaths(paths: CudexPaths, runId: string): PocRunPaths {
  if (!/^\d{14}-[0-9a-f]{12}$/u.test(runId)) throw new Error('invalid Cudex run ID')
  const runDirectory = join(paths.runsDirectory, runId)
  return { repositoryRoot, e2bRoot, runId, runDirectory, runtimeEnv: join(runDirectory, 'runtime.env'),
    composeEnv: join(runDirectory, 'compose.env'), garageConfig: join(runDirectory, 'garage.toml'),
    tlsDirectory: join(runDirectory, 'tls'), codexHome: join(runDirectory, 'codex-home'),
    logsDirectory: join(runDirectory, 'logs'), report: join(runDirectory, 'legacy-report.json') }
}

function environment(config: CudexConfig, credentials: { e2bApiKey: string }, model?: string): PocEnvironment {
  return { e2bApiKey: credentials.e2bApiKey, e2bApiUrl: config.apiUrl, e2bDomain: config.domain,
    e2bValidateApiKey: config.validateApiKey, templateMetadata: join(config.releaseDirectory, 'template.json'),
    controlPort: config.controlPort, postgresPort: config.postgresPort, garagePort: config.garagePort,
    keepOnFailure: false, verifyTemplate: false, workspaceMode: 'git-working-set',
    ...(config.providerCaCertificate ? { providerCaCertificate: config.providerCaCertificate } : {}),
    ...(model ? { codexModel: model } : {}) }
}

function provenance(config: CudexConfig, release: CudexReleaseManifest): PocProvenance {
  return { buildId: release.releaseId, revision: release.codexRevision,
    codexSha256: release.binaries.codex.sha256,
    codeModeHostSha256: release.binaries['codex-code-mode-host'].sha256,
    templateId: release.template.templateId, cpuMillicores: release.cpuMillicores, memoryMb: release.memoryMb,
    binaryPath: join(config.releaseDirectory, 'codex'),
    codeModeHostPath: join(config.releaseDirectory, 'codex-code-mode-host'),
    metadataPath: join(config.releaseDirectory, 'template.json') }
}

async function ownerJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600); await rename(temporary, path)
}

function validateState(value: unknown): CurrentRunState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('current Cudex run state is invalid')
  const state = value as CurrentRunState
  if (state.version !== 1 || !/^\d{14}-[0-9a-f]{12}$/u.test(state.runId)
    || !Number.isSafeInteger(state.pid) || state.pid <= 1 || !Number.isFinite(Date.parse(state.startedAt))
    || !resolve(state.selectedDirectory).startsWith('/')
    || !['preparing', 'tui', 'finalizing', 'cleanup', 'recovery'].includes(state.phase)) {
    throw new Error('current Cudex run state is invalid')
  }
  return state
}

async function currentState(paths: CudexPaths): Promise<CurrentRunState | undefined> {
  const metadata = await lstat(paths.currentRunFile).catch(() => undefined)
  if (!metadata) return undefined
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 64 * 1024) {
    throw new Error('current Cudex run pointer is unsafe')
  }
  try { return validateState(JSON.parse(await readFile(paths.currentRunFile, 'utf8'))) }
  catch (error) { if (error instanceof SyntaxError) throw new Error('current Cudex run pointer is invalid'); throw error }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function acquireLock(paths: CudexPaths): Promise<FileHandle> {
  // TODO(internal-release, PILOT-004): The pilot has one lock and one selected root per local user
  // because coworkers serialize sessions. Replace this with isolated concurrent runs and bounded roots.
  await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 }); await chmod(paths.runtimeDirectory, 0o700)
  if (await currentState(paths)) throw new Error('a Cudex run requires cleanup before another session can start')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(paths.lockFile, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`)
      return handle
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const lock = await readFile(paths.lockFile, 'utf8').then(JSON.parse).catch(() => undefined) as { pid?: unknown } | undefined
      if (lock && Number.isSafeInteger(lock.pid) && pidAlive(Number(lock.pid))) throw new Error('another Cudex process is active')
      if (attempt === 0) { await rm(paths.lockFile, { force: true }); continue }
      throw new Error('unable to acquire the Cudex run lock')
    }
  }
  throw new Error('unable to acquire the Cudex run lock')
}

async function clearOwnership(paths: CudexPaths, lock?: FileHandle): Promise<void> {
  await lock?.close().catch(() => undefined)
  await rm(paths.currentRunFile, { force: true }); await rm(paths.lockFile, { force: true })
}

async function saveBase(runPaths: PocRunPaths, projection: GitWorkspaceProjection): Promise<void> {
  await Promise.all([
    writeFile(join(runPaths.runDirectory, 'base.tar'), projection.bytes, { mode: 0o600, flag: 'wx' }),
    writeFile(join(runPaths.runDirectory, 'base-manifest.json'),
      `${JSON.stringify(projection.captured.manifest)}\n`, { mode: 0o600, flag: 'wx' }),
  ])
}

async function prepareSession(parsed: Extract<CudexArguments, { command: 'session' }>, paths: CudexPaths,
  state: CurrentRunState): Promise<PreparedCudexRun> {
  const startedAt = state.startedAt
  const [config, credentials] = await Promise.all([loadCudexConfig(paths), loadCudexCredentials(paths)])
  const release = await validateCachedRelease(config.releaseDirectory)
  if (release.releaseId !== config.releaseId) throw new Error('configured release identity is inconsistent')
  if (!await discoverCodexAuth(paths)) throw new Error('Codex authentication is unavailable; run cudex login')
  const env = environment(config, credentials, parsed.model)
  const [docker, projection] = await Promise.all([detectDocker(), projectGitWorkspace(parsed.directory)])
  await assertPocPortsAvailable(env)
  const runPaths = pilotRunPaths(paths, state.runId)
  await prepareRunFiles(runPaths, env, generateRuntimeSecrets())
  await saveBase(runPaths, projection)
  const tls = await generatePocTls(runPaths.tlsDirectory, config.providerCaCertificate)
  let composeStarted = false
  try {
    await startCompose(docker, runPaths); composeStarted = true
    const runtime = await readRuntimeEnvironment(runPaths)
    await verifyGarage(env, runtime); await runMigrations(runPaths, runtime.POC_DATABASE_URL!)
    await startControlService(runPaths, env, runtime, tls); await verifyControlService(env, runtime, tls)
    const source = await uploadSourceSnapshot({ serviceUrl: new URL(`https://localhost:${env.controlPort}/`),
      bearerToken: runtime.POC_SERVICE_BEARER!, caBundlePath: tls.combinedCaBundlePath,
      archive: projection.bytes, cwdUri: projection.cwd, workspaceRootUris: projection.roots,
      expiresAt: new Date(Date.now() + 4 * 60 * 60_000) })
    const releaseProvenance = provenance(config, release)
    await generateCodexConfiguration(runPaths, env, source, releaseProvenance)
    await copyDiscoveredCodexAuth(paths, runPaths.codexHome)
    await validateGeneratedCodexConfiguration(releaseProvenance, runPaths, tls.combinedCaBundlePath,
      runtime.POC_SERVICE_BEARER!)
    return { config, env, release, provenance: releaseProvenance, paths: runPaths, docker, tls, runtime,
      projection, source, startedAt }
  } catch (error) {
    await stopControlService(runPaths).catch(() => undefined)
    if (composeStarted) await stopCompose(docker, runPaths).catch(() => undefined)
    await Promise.all([rm(tls.caKeyPath, { force: true }), rm(tls.serverKeyPath, { force: true }),
      rm(runPaths.codexHome, { recursive: true, force: true })])
    throw error
  }
}

async function launchTui(run: PreparedCudexRun, parsed: Extract<CudexArguments, { command: 'session' }>): Promise<{
  exitCode: number | null; signal?: 'SIGINT' | 'SIGTERM' }> {
  // TODO(internal-release, PILOT-010): The isolated pilot fixes approval to never because CubeSandbox
  // is the approval boundary. Replace this with the reviewed internal approval and policy model.
  const args = ['--strict-config', '-C', run.projection.localDirectory, '-a', 'never',
    ...(parsed.model ? ['--model', parsed.model] : []), ...(parsed.prompt ? [parsed.prompt] : [])]
  const child = spawn(run.provenance.binaryPath, args, { cwd: run.projection.localDirectory,
    env: createCodexProcessEnvironment({ codexHome: run.paths.codexHome,
      caBundlePath: run.tls.combinedCaBundlePath, hostedBearer: run.runtime.POC_SERVICE_BEARER! }), stdio: 'inherit' })
  let received: 'SIGINT' | 'SIGTERM' | undefined
  const sigint = () => { received = 'SIGINT'; child.kill('SIGINT') }
  const sigterm = () => { received = 'SIGTERM'; child.kill('SIGTERM') }
  process.once('SIGINT', sigint); process.once('SIGTERM', sigterm)
  try {
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject); child.once('exit', resolveExit)
    })
    return { exitCode, ...(received ? { signal: received } : {}) }
  } finally { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm) }
}

async function rootLease(run: Pick<PreparedCudexRun, 'runtime' | 'paths'>): Promise<PocLeaseInspection | undefined> {
  const opened = await openPocDatabaseInspector(run.runtime.POC_DATABASE_URL!, `poc-${run.paths.runId}`)
  try {
    const deadline = Date.now() + 30_000
    do {
      const roots = (await opened.inspector.leases()).filter(lease => lease.ownerLeaseId === null)
      if (roots.length > 1) throw new Error('Cudex run has ambiguous hosted roots')
      if (roots.length === 1) return roots[0]
      if (Date.now() >= deadline) return undefined
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    } while (true)
  } finally { await opened.close() }
}

async function deleteRootThread(run: Pick<PreparedCudexRun, 'provenance' | 'paths' | 'tls' | 'runtime'>,
  root: PocLeaseInspection | undefined): Promise<boolean> {
  if (!root) return true
  const appServer = startPocAppServer({ provenance: run.provenance, paths: run.paths,
    caBundlePath: run.tls.combinedCaBundlePath, hostedBearer: run.runtime.POC_SERVICE_BEARER!,
    stderrLogPath: join(run.paths.logsDirectory, 'cleanup-app-server.log') })
  try {
    await initializeAndReadAccount(appServer)
    await appServer.client.request('thread/delete', { threadId: root.agentId }, 120_000)
    return true
  } catch { return false }
  finally { await appServer.stop().catch(() => undefined) }
}

async function cleanupPrepared(run: PreparedCudexRun, root: PocLeaseInspection | undefined) {
  const deleted = await deleteRootThread(run, root)
  const outcome = await exactCleanup(run, undefined, undefined, false)
  return { ...outcome, deleted }
}

function reportPath(run: Pick<PreparedCudexRun, 'paths'>, phase: 'session' | 'apply' | 'cleanup'): string {
  return join(run.paths.runDirectory, `${phase}-report.json`)
}

async function record(run: PreparedCudexRun, phase: 'session' | 'apply' | 'cleanup', status: CudexResultStatus,
  details: Record<string, string | number | boolean | null>, startedAt = run.startedAt): Promise<void> {
  await writeCudexPhaseReport(reportPath(run, phase), { version: 1, runId: run.paths.runId, phase, status,
    startedAt, finishedAt: new Date().toISOString(), details })
}

async function runSession(parsed: Extract<CudexArguments, { command: 'session' }>, paths: CudexPaths): Promise<number> {
  const lock = await acquireLock(paths)
  const state: CurrentRunState = { version: 1, runId: createRunId(), pid: process.pid,
    startedAt: new Date().toISOString(), selectedDirectory: parsed.directory, phase: 'preparing' }
  await ownerJson(paths.currentRunFile, state)
  let run: PreparedCudexRun | undefined
  try {
    run = await prepareSession(parsed, paths, state)
  } catch (error) {
    await clearOwnership(paths, lock)
    await rm(pilotRunPaths(paths, state.runId).runDirectory, { recursive: true, force: true })
    throw error
  }
  state.phase = 'tui'; await ownerJson(paths.currentRunFile, state)
  let tui: Awaited<ReturnType<typeof launchTui>> = { exitCode: null }
  let sessionFailure: unknown
  try { tui = await launchTui(run, parsed) } catch (error) { sessionFailure = error }
  await record(run, 'session', tui.signal ? 'interrupted' : tui.exitCode === 0 ? 'succeeded' : 'failed',
    { tuiExitCode: tui.exitCode, interrupted: Boolean(tui.signal), projectedFiles: run.projection.files.length })

  state.phase = 'finalizing'; await ownerJson(paths.currentRunFile, state)
  const root = await rootLease(run).catch(error => { sessionFailure ??= error; return undefined })
  // Root result resolution and local application are added in the next delivery chunk. Until then a
  // successful hosted TUI is still reported separately and never mutates the local checkout.
  const applySucceeded = false
  await record(run, 'apply', 'failed', { applied: false, conflict: false, reason: 'patch-return-pending' })

  state.phase = 'cleanup'; await ownerJson(paths.currentRunFile, state)
  const cleanupStarted = new Date().toISOString()
  const cleanup = await cleanupPrepared(run, root).catch(error => {
    sessionFailure ??= error
    return { serviceCleanupComplete: false, forcedProviderCleanup: false, dockerVolumesRemoved: false, deleted: false }
  })
  const cleanupComplete = cleanup.deleted && cleanup.serviceCleanupComplete && cleanup.dockerVolumesRemoved
  await record(run, 'cleanup', cleanupComplete ? 'succeeded' : 'manual-recovery', {
    threadDeleted: cleanup.deleted, serviceCleanupComplete: cleanup.serviceCleanupComplete,
    forcedProviderCleanup: cleanup.forcedProviderCleanup, dockerVolumesRemoved: cleanup.dockerVolumesRemoved,
  }, cleanupStarted)
  if (cleanupComplete) await clearOwnership(paths, lock)
  else { state.phase = 'recovery'; await ownerJson(paths.currentRunFile, state); await lock.close().catch(() => undefined) }
  console.log(JSON.stringify({ runId: run.paths.runId, tuiExitCode: tui.exitCode, applySucceeded,
    cleanupComplete, reports: run.paths.runDirectory }))
  if (!cleanupComplete) return 3
  if (tui.signal === 'SIGINT') return 130
  if (tui.signal === 'SIGTERM') return 143
  if (sessionFailure || tui.exitCode !== 0 || !applySucceeded) return 1
  return 0
}

async function cleanupCurrent(paths: CudexPaths): Promise<number> {
  const state = await currentState(paths)
  if (!state) { console.log(JSON.stringify({ active: false, cleaned: true })); await rm(paths.lockFile, { force: true }); return 0 }
  if (state.pid !== process.pid && pidAlive(state.pid)) throw new Error('the active Cudex process must finish its own cleanup')
  const [config, credentials, docker] = await Promise.all([loadCudexConfig(paths), loadCudexCredentials(paths), detectDocker()])
  const runPaths = pilotRunPaths(paths, state.runId); const runtime = await readRuntimeEnvironment(runPaths)
  const release = await validateCachedRelease(config.releaseDirectory); const env = environment(config, credentials)
  const partial = { config, env, release, provenance: provenance(config, release), paths: runPaths, docker,
    tls: existingTlsMaterial(runPaths), runtime, projection: undefined, source: undefined, startedAt: state.startedAt }
  const root = await rootLease(partial).catch(() => undefined)
  const deleted = await deleteRootThread(partial, root)
  const outcome = await exactCleanup(partial, undefined, undefined, false)
  const complete = deleted && outcome.serviceCleanupComplete && outcome.dockerVolumesRemoved
  if (complete) await clearOwnership(paths)
  console.log(JSON.stringify({ runId: state.runId, cleaned: complete, threadDeleted: deleted,
    forcedProviderCleanup: outcome.forcedProviderCleanup, dockerVolumesRemoved: outcome.dockerVolumesRemoved }))
  return complete ? (outcome.forcedProviderCleanup ? 3 : 0) : 3
}

async function showStatus(paths: CudexPaths): Promise<number> {
  const state = await currentState(paths)
  if (!state) { console.log(JSON.stringify({ active: false })); return 0 }
  const config = await loadCudexConfig(paths); const runPaths = pilotRunPaths(paths, state.runId)
  const runtime = await readRuntimeEnvironment(runPaths).catch(() => undefined)
  let lifecycle: Record<string, unknown> | undefined
  if (runtime?.POC_DATABASE_URL) {
    const opened = await openPocDatabaseInspector(runtime.POC_DATABASE_URL, `poc-${state.runId}`).catch(() => undefined)
    if (opened) {
      try {
        const inspected = await opened.inspector.inspect()
        lifecycle = { leases: inspected.leases.map(lease => ({ leaseId: lease.leaseId, state: lease.state })),
          liveTickets: inspected.liveTicketCount, unfinishedInteractions: inspected.unfinishedInteractionCount }
      } finally { await opened.close() }
    }
  }
  const docker = await detectDocker().catch(() => undefined)
  const compose = docker ? await runCompose(docker, runPaths, ['ps', '--format', 'json']).catch(() => '') : ''
  console.log(JSON.stringify({ active: pidAlive(state.pid), runId: state.runId, phase: state.phase,
    selectedDirectory: state.selectedDirectory, serviceReachable: await tcpConnects(config.controlPort), lifecycle,
    composeServices: compose.split('\n').filter(Boolean).length }, null, 2))
  return 0
}

export async function dispatchCudexCommand(parsed: CudexArguments, paths: CudexPaths): Promise<number> {
  if (parsed.command === 'status') return showStatus(paths)
  if (parsed.command === 'cleanup') return cleanupCurrent(paths)
  if (parsed.command === 'files') {
    const projection = await projectGitWorkspace(parsed.directory)
    console.log(JSON.stringify({ directory: projection.localDirectory, files: projection.files,
      fileCount: projection.files.length, archiveBytes: projection.sizeBytes }))
    return 0
  }
  if (parsed.command === 'session') return runSession(parsed, paths)
  throw new Error(`unsupported runner command: ${parsed.command}`)
}
