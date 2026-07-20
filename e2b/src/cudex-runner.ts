import { execa } from 'execa'
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CudexArguments } from './cudex-cli.js'
import { copyDiscoveredCodexAuth, discoverCodexAuth } from './cudex-cli.js'
import { loadCudexConfig, loadCudexCredentials, validateCudexConfig, validateCudexCredentials,
  type CudexConfig, type CudexCredentials, type CudexPaths } from './cudex-config.js'
import { validateCachedRelease, type CudexReleaseManifest } from './cudex-release.js'
import { projectGitWorkspace, type GitWorkspaceProjection } from './git-workspace.js'
import { applyLocalRootPatch, type LocalPatchApplyResult } from './local-patch-apply.js'
import { resolveRootPatch } from './local-patch-source.js'
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

class PreparationFailure extends Error {
  constructor(message: string, readonly recoveryRequired: boolean, readonly allocated: boolean) {
    super(message); this.name = 'PreparationFailure'
  }
}

export class RunSignals {
  signal: 'SIGINT' | 'SIGTERM' | undefined
  private forward: ((signal: 'SIGINT' | 'SIGTERM') => void) | undefined
  private readonly sigint = () => this.receive('SIGINT')
  private readonly sigterm = () => this.receive('SIGTERM')
  install(): void { process.on('SIGINT', this.sigint); process.on('SIGTERM', this.sigterm) }
  dispose(): void { process.off('SIGINT', this.sigint); process.off('SIGTERM', this.sigterm) }
  request(signal: 'SIGINT' | 'SIGTERM'): void { this.receive(signal) }
  setForward(value: ((signal: 'SIGINT' | 'SIGTERM') => void) | undefined): void { this.forward = value }
  private receive(signal: 'SIGINT' | 'SIGTERM'): void {
    this.signal ??= signal
    this.forward?.(signal)
  }
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

async function saveRecovery(runPaths: PocRunPaths, config: CudexConfig,
  credentials: CudexCredentials): Promise<void> {
  await ownerJson(join(runPaths.runDirectory, 'recovery-config.json'),
    { version: 1, config, credentials })
}

async function loadRecovery(runPaths: PocRunPaths): Promise<{ config: CudexConfig;
  credentials: CudexCredentials }> {
  const path = join(runPaths.runDirectory, 'recovery-config.json')
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || metadata.size > 64 * 1024) throw new Error('Cudex recovery configuration is unsafe')
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if (!value || value.version !== 1 || Reflect.ownKeys(value).length !== 3) {
    throw new Error('Cudex recovery configuration is invalid')
  }
  return { config: validateCudexConfig(value.config), credentials: validateCudexCredentials(value.credentials) }
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
  await saveRecovery(runPaths, config, credentials)
  await saveBase(runPaths, projection)
  const tls = await generatePocTls(runPaths.tlsDirectory, config.providerCaCertificate)
  let allocationAttempted = false
  try {
    allocationAttempted = true
    await startCompose(docker, runPaths)
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
    if (!allocationAttempted) throw error
    let cleanupProven = true
    const serviceStopped = await stopControlService(runPaths).catch(() => { cleanupProven = false; return false })
    if (!serviceStopped) cleanupProven = false
    await stopCompose(docker, runPaths).catch(() => { cleanupProven = false })
    if (cleanupProven) {
      await rm(runPaths.runDirectory, { recursive: true, force: true })
    }
    throw new PreparationFailure(error instanceof Error ? error.message : 'Cudex preparation failed',
      !cleanupProven, true)
  }
}

export async function launchTui(run: PreparedCudexRun,
  parsed: Extract<CudexArguments, { command: 'session' }>, signals: RunSignals,
  killGraceMs = 10_000): Promise<{
  exitCode: number | null; signal?: 'SIGINT' | 'SIGTERM' }> {
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 60_000) {
    throw new Error('invalid TUI signal grace period')
  }
  // TODO(internal-release, PILOT-010): The isolated pilot fixes approval to never because CubeSandbox
  // is the approval boundary. Replace this with the reviewed internal approval and policy model.
  const args = ['--strict-config', '-C', run.projection.localDirectory, '-a', 'never',
    ...(parsed.model ? ['--model', parsed.model] : []), ...(parsed.prompt ? [parsed.prompt] : [])]
  const child = execa(run.provenance.binaryPath, args, { cwd: run.projection.localDirectory, extendEnv: false,
    env: createCodexProcessEnvironment({ codexHome: run.paths.codexHome,
      caBundlePath: run.tls.combinedCaBundlePath, hostedBearer: run.runtime.POC_SERVICE_BEARER! }), stdio: 'inherit', reject: false })
  let killTimer: NodeJS.Timeout | undefined
  signals.setForward(signal => {
    child.kill(signal)
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), killGraceMs)
    killTimer.unref()
  })
  if (signals.signal) child.kill(signals.signal)
  try {
    const result = await child
    return { exitCode: result.exitCode ?? null, ...(signals.signal ? { signal: signals.signal } : {}) }
  } finally { signals.setForward(undefined); if (killTimer) clearTimeout(killTimer) }
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
  const cleanupRoot = root ?? await rootLease(run).catch(() => undefined)
  const deleted = await deleteRootThread(run, cleanupRoot)
  if (!deleted) return { serviceCleanupComplete: false, forcedProviderCleanup: false,
    dockerVolumesRemoved: false, deleted }
  const outcome = await exactCleanup(run, undefined, undefined, false, true)
  if (deleted && outcome.serviceCleanupComplete && outcome.dockerVolumesRemoved) {
    await Promise.all([
      rm(run.paths.runtimeEnv, { force: true }), rm(run.paths.composeEnv, { force: true }),
      rm(run.paths.garageConfig, { force: true }), rm(run.paths.codexHome, { recursive: true, force: true }),
      rm(run.paths.tlsDirectory, { recursive: true, force: true }),
      rm(join(run.paths.runDirectory, 'base.tar'), { force: true }),
      rm(join(run.paths.runDirectory, 'base-manifest.json'), { force: true }),
      rm(join(run.paths.runDirectory, 'recovery-config.json'), { force: true }),
    ])
  }
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

async function resolveAndApply(run: PreparedCudexRun,
  root: PocLeaseInspection, signals: RunSignals): Promise<LocalPatchApplyResult> {
  if (!root.baseSnapshotId || !root.latestSnapshotId || !root.providerSandboxId) {
    throw new Error('hosted root did not finalize an exact workspace lineage')
  }
  const required = (name: string): string => {
    const value = run.runtime[name]
    if (!value) throw new Error('Cudex patch storage configuration is incomplete')
    return value
  }
  // TODO(internal-release, PILOT-011): The pilot resolves root artifact bytes directly from its
  // disposable PostgreSQL and Garage because no stable return boundary exists. Replace this with
  // a supported authenticated patch-return API or formalize this exact internal boundary.
  const patch = await resolveRootPatch({ runId: run.paths.runId,
    databaseUrl: required('POC_DATABASE_URL'), sourceSnapshotId: run.source.sourceSnapshotId, root,
    provider: { apiKey: run.env.e2bApiKey, apiUrl: run.env.e2bApiUrl, domain: run.env.e2bDomain,
      validateApiKey: run.env.e2bValidateApiKey },
    objectStore: { bucket: required('POC_GARAGE_BUCKET'), endpoint: `http://127.0.0.1:${run.env.garagePort}`,
      accessKeyId: required('POC_GARAGE_ACCESS_KEY'), secretAccessKey: required('POC_GARAGE_SECRET_KEY') } })
  if (signals.signal) return { type: 'failed', reason: 'interrupted before local application' }
  return applyLocalRootPatch({ runId: run.paths.runId, selectedDirectory: run.projection.localDirectory,
    immutableBaseManifest: run.projection.captured.manifest, patch })
}

function applyReport(result: LocalPatchApplyResult): { status: CudexResultStatus;
  details: Record<string, string | number | boolean | null>; code: number } {
  switch (result.type) {
    case 'applied': return { status: 'succeeded', details: { applied: true,
      conflict: false, changedFiles: result.changedFiles }, code: 0 }
    case 'no-change': return { status: 'succeeded', details: { applied: false,
      conflict: false, changedFiles: 0 }, code: 0 }
    case 'conflict': return { status: 'conflict', details: { applied: false,
      conflict: true, conflictCount: result.total, conflictPathsTruncated: result.truncated }, code: 4 }
    case 'manual-recovery': return { status: 'manual-recovery', details: { applied: false,
      conflict: false, recoveryJournalRetained: true, reason: result.reason }, code: 3 }
    case 'failed': return { status: 'failed', details: { applied: false,
      conflict: false, reason: result.reason }, code: 1 }
  }
}

export function cudexSessionExitCode(input: { cleanupComplete: boolean; ownershipCleared: boolean;
  resultCode: number; signal?: 'SIGINT' | 'SIGTERM'; operationalFailure: boolean;
  reportFailure: boolean; tuiExitCode: number | null }): number {
  if (!input.cleanupComplete || !input.ownershipCleared || input.resultCode === 3) return 3
  if (input.signal === 'SIGINT') return 130
  if (input.signal === 'SIGTERM') return 143
  if (input.resultCode === 4) return 4
  if (input.operationalFailure || input.reportFailure || input.tuiExitCode !== 0) return 1
  return input.resultCode
}

async function runSession(parsed: Extract<CudexArguments, { command: 'session' }>, paths: CudexPaths): Promise<number> {
  const signals = new RunSignals(); signals.install()
  const lock = await acquireLock(paths).catch(error => { signals.dispose(); throw error })
  const state: CurrentRunState = { version: 1, runId: createRunId(), pid: process.pid,
    startedAt: new Date().toISOString(), selectedDirectory: parsed.directory, phase: 'preparing' }
  try { await ownerJson(paths.currentRunFile, state) }
  catch (error) { await clearOwnership(paths, lock); signals.dispose(); throw error }
  let run: PreparedCudexRun | undefined
  try {
    run = await prepareSession(parsed, paths, state)
  } catch (error) {
    if (error instanceof PreparationFailure && error.recoveryRequired) {
      state.phase = 'recovery'; await ownerJson(paths.currentRunFile, state).catch(() => undefined)
      await lock.close().catch(() => undefined); signals.dispose()
      console.error(error.message); return 3
    }
    await clearOwnership(paths, lock)
    await rm(pilotRunPaths(paths, state.runId).runDirectory, { recursive: true, force: true })
    const interrupted = signals.signal; signals.dispose()
    if (interrupted) return interrupted === 'SIGINT' ? 130 : 143
    if (error instanceof PreparationFailure && error.allocated) { console.error(error.message); return 1 }
    throw error
  }
  let tui: Awaited<ReturnType<typeof launchTui>> = { exitCode: null }
  let root: PocLeaseInspection | undefined
  let result: LocalPatchApplyResult = { type: 'failed', reason: 'hosted session did not complete' }
  let resultCode = 1
  let operationalFailure: unknown
  let reportFailure = false
  let cleanup = { serviceCleanupComplete: false, forcedProviderCleanup: false,
    dockerVolumesRemoved: false, deleted: false }
  const cleanupStarted = new Date().toISOString()
  try {
    state.phase = 'tui'; await ownerJson(paths.currentRunFile, state)
    if (signals.signal) tui = { exitCode: null, signal: signals.signal }
    else tui = await launchTui(run, parsed, signals)
    await record(run, 'session', signals.signal ? 'interrupted' : tui.exitCode === 0 ? 'succeeded' : 'failed',
      { tuiExitCode: tui.exitCode, interrupted: Boolean(signals.signal),
        projectedFiles: run.projection.files.length }).catch(error => { reportFailure = true; operationalFailure ??= error })

    state.phase = 'finalizing'; await ownerJson(paths.currentRunFile, state)
    if (!signals.signal && tui.exitCode === 0) {
      root = await rootLease(run)
      if (!root) throw new Error('hosted root lease was not durably visible')
      if (!signals.signal) result = await resolveAndApply(run, root, signals)
      else result = { type: 'failed', reason: 'interrupted before local application' }
    } else {
      result = { type: 'failed', reason: signals.signal ? 'interrupted before local application' : 'hosted TUI failed' }
    }
    const reported = applyReport(result); resultCode = reported.code
    await record(run, 'apply', signals.signal ? 'interrupted' : reported.status,
      reported.details).catch(error => { reportFailure = true; operationalFailure ??= error })
  } catch (error) {
    operationalFailure ??= error; resultCode = 1
    await record(run, 'apply', signals.signal ? 'interrupted' : 'failed', { applied: false,
      conflict: false, reason: error instanceof Error ? error.message : 'root patch resolution failed' })
      .catch(() => { reportFailure = true })
  } finally {
    state.phase = 'cleanup'; await ownerJson(paths.currentRunFile, state).catch(error => { operationalFailure ??= error })
    cleanup = await cleanupPrepared(run, root).catch(error => {
      operationalFailure ??= error
      return { serviceCleanupComplete: false, forcedProviderCleanup: false,
        dockerVolumesRemoved: false, deleted: false }
    })
  }
  const cleanupComplete = cleanup.deleted && cleanup.serviceCleanupComplete && cleanup.dockerVolumesRemoved
  await record(run, 'cleanup', cleanupComplete ? 'succeeded' : 'manual-recovery', {
    threadDeleted: cleanup.deleted, serviceCleanupComplete: cleanup.serviceCleanupComplete,
    forcedProviderCleanup: cleanup.forcedProviderCleanup, dockerVolumesRemoved: cleanup.dockerVolumesRemoved,
  }, cleanupStarted).catch(() => { reportFailure = true })
  let ownershipCleared = false
  if (cleanupComplete) {
    try { await clearOwnership(paths, lock); ownershipCleared = true } catch { /* Retain recovery state below. */ }
  }
  if (!ownershipCleared) {
    state.phase = 'recovery'; await ownerJson(paths.currentRunFile, state).catch(() => undefined)
    await lock.close().catch(() => undefined)
  }
  signals.dispose()
  console.log(JSON.stringify({ runId: run.paths.runId, tuiExitCode: tui.exitCode,
    applyResult: result,
    cleanupComplete, reports: run.paths.runDirectory }))
  return cudexSessionExitCode({ cleanupComplete, ownershipCleared, resultCode,
    ...(signals.signal ? { signal: signals.signal } : {}), operationalFailure: Boolean(operationalFailure),
    reportFailure, tuiExitCode: tui.exitCode })
}

async function cleanupCurrent(paths: CudexPaths): Promise<number> {
  const state = await currentState(paths)
  if (!state) { console.log(JSON.stringify({ active: false, cleaned: true })); await rm(paths.lockFile, { force: true }); return 0 }
  if (state.pid !== process.pid && pidAlive(state.pid)) throw new Error('the active Cudex process must finish its own cleanup')
  const cleanupLockPath = `${paths.lockFile}.cleanup`
  const cleanupLock = await open(cleanupLockPath, 'wx', 0o600).catch(() => undefined)
  if (!cleanupLock) { console.error('another Cudex cleanup is active'); return 3 }
  try {
    const runPaths = pilotRunPaths(paths, state.runId)
    const [{ config, credentials }, docker, runtime] = await Promise.all([
      loadRecovery(runPaths), detectDocker(), readRuntimeEnvironment(runPaths),
    ])
    const release = await validateCachedRelease(config.releaseDirectory); const env = environment(config, credentials)
    const partial = { config, env, release, provenance: provenance(config, release), paths: runPaths, docker,
      tls: existingTlsMaterial(runPaths), runtime, projection: undefined, source: undefined, startedAt: state.startedAt }
    const root = await rootLease(partial).catch(() => undefined)
    const deleted = await deleteRootThread(partial, root)
    const outcome = deleted
      ? await exactCleanup(partial, undefined, undefined, false, true)
      : { serviceCleanupComplete: false, forcedProviderCleanup: false, dockerVolumesRemoved: false }
    const complete = deleted && outcome.serviceCleanupComplete && outcome.dockerVolumesRemoved
    if (complete) {
      await Promise.all([rm(runPaths.runtimeEnv, { force: true }), rm(runPaths.composeEnv, { force: true }),
        rm(runPaths.garageConfig, { force: true }), rm(runPaths.codexHome, { recursive: true, force: true }),
        rm(runPaths.tlsDirectory, { recursive: true, force: true }),
        rm(join(runPaths.runDirectory, 'base.tar'), { force: true }),
        rm(join(runPaths.runDirectory, 'base-manifest.json'), { force: true }),
        rm(join(runPaths.runDirectory, 'recovery-config.json'), { force: true })])
      await clearOwnership(paths)
    }
    console.log(JSON.stringify({ runId: state.runId, cleaned: complete, threadDeleted: deleted,
      forcedProviderCleanup: outcome.forcedProviderCleanup, dockerVolumesRemoved: outcome.dockerVolumesRemoved }))
    return complete ? 0 : 3
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cudex cleanup failed')
    return 3
  } finally {
    await cleanupLock.close().catch(() => undefined); await rm(cleanupLockPath, { force: true })
  }
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
