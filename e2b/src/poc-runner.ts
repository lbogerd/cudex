import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseEnv } from 'node:util'
import { copyAuthJsonToRuntime, createCodexProcessEnvironment, redactSecrets, removeRuntimeAuth, validateAuthJsonFile } from './poc-auth.js'
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
import { generatePocTls, validateProviderCaCertificate, type PocTlsMaterial } from './poc-tls.js'
import { archiveWorkspace } from './ingress.js'
import { uploadSourceSnapshot } from './source-snapshot-client.js'
import { deleteThreadTree, initializeAndReadAccount, runAutomatedTurn, startPocAppServer,
  type PocAppServerEvidence, type PocAppServerProcess } from './poc-app-server-client.js'
import { evaluatePocCleanupInspection, evaluatePocFunctionalInspection, openPocDatabaseInspector,
  PocProviderInspector, retainedFilesAreRedacted, serializePocReport,
  type PocDatabaseInspection, type PocFunctionalInspection } from './poc-inspector.js'

const e2bRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const repositoryRoot = resolve(e2bRoot, '..')
const envPath = `${e2bRoot}/poc/.env`
const pointerPath = `${e2bRoot}/.state/poc/current`
const exec = promisify(execFile)

function existingTlsMaterial(paths: PocRunPaths): PocTlsMaterial {
  return { caCertificatePath: `${paths.tlsDirectory}/ca.crt`, caKeyPath: `${paths.tlsDirectory}/ca.key`,
    serverCertificatePath: `${paths.tlsDirectory}/server.crt`, serverKeyPath: `${paths.tlsDirectory}/server.key`,
    combinedCaBundlePath: `${paths.tlsDirectory}/combined-ca.pem` }
}

function usage(): never {
  console.error('usage: poc-runner <auth|preflight|up|automated|interactive|status|down>')
  process.exit(2)
}

async function configuration(): Promise<PocEnvironment> {
  const loaded = await loadPocEnvironment(envPath)
  return { ...loaded, templateMetadata: resolveRepositoryPath(repositoryRoot, loaded.templateMetadata),
    ...(loaded.authJsonFile ? { authJsonFile: resolveRepositoryPath(repositoryRoot, loaded.authJsonFile) } : {}),
    ...(loaded.providerCaCertificate
      ? { providerCaCertificate: resolveRepositoryPath(repositoryRoot, loaded.providerCaCertificate) } : {}) }
}

async function ensureProviderProcessEnvironment(env: PocEnvironment, command: string): Promise<boolean> {
  if (command === 'auth') return false
  const providerCa = env.providerCaCertificate
    ? await validateProviderCaCertificate(repositoryRoot, env.providerCaCertificate) : undefined
  const validateApiKey = String(env.e2bValidateApiKey)
  if ((providerCa === undefined || process.env.NODE_EXTRA_CA_CERTS === providerCa)
    && process.env.E2B_VALIDATE_API_KEY === validateApiKey) return false
  const child = spawn(process.execPath, [process.argv[1]!, command], { cwd: repositoryRoot, stdio: 'inherit',
    env: { ...process.env, E2B_VALIDATE_API_KEY: validateApiKey,
      ...(providerCa ? { NODE_EXTRA_CA_CERTS: providerCa } : {}) } })
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject); child.once('exit', resolveExit)
  })
  process.exitCode = code ?? 1
  return true
}

async function preflight(configured?: PocEnvironment): Promise<void> {
  const env = configured ?? await configuration()
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('the POC requires x86_64 Linux')
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('the POC requires Node.js 22 or newer')
  const [provenance] = await Promise.all([validatePocProvenance(repositoryRoot, env.templateMetadata), detectDocker(),
    env.authJsonFile ? validateAuthJsonFile(repositoryRoot, env.authJsonFile) : Promise.resolve(),
    env.providerCaCertificate
      ? validateProviderCaCertificate(repositoryRoot, env.providerCaCertificate) : Promise.resolve()])
  await assertPocPortsAvailable(env)
  await mkdir(`${e2bRoot}/.state/poc`, { recursive: true, mode: 0o700 })
  const temporaryRoot = await mkdtemp(`${e2bRoot}/.state/poc/preflight-`)
  try {
    const paths = pocRunPaths(repositoryRoot, createRunId())
    paths.runDirectory = temporaryRoot; paths.codexHome = `${temporaryRoot}/codex-home`; paths.tlsDirectory = `${temporaryRoot}/tls`
    const fakeSource = { sourceSnapshotId: `source_${'a'.repeat(32)}`, checksum: `sha256:${'b'.repeat(64)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), manifestChecksum: `sha256:${'c'.repeat(64)}`, sizeBytes: 1 }
    const tls = await generatePocTls(paths.tlsDirectory, env.providerCaCertificate)
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
      E2B_DOMAIN: env.e2bDomain, E2B_VALIDATE_API_KEY: String(env.e2bValidateApiKey),
        ...(env.providerCaCertificate ? { NODE_EXTRA_CA_CERTS: env.providerCaCertificate } : {}) },
    })
  }
  console.log(JSON.stringify({ ready: true, platform: `${process.platform}-${process.arch}`,
    ports: { control: env.controlPort, postgres: env.postgresPort, garage: env.garagePort },
    authentication: env.accessToken ? 'access_token' : 'auth_json', provenance: {
      buildId: provenance.buildId, revision: provenance.revision, codexSha256: provenance.codexSha256,
      codeModeHostSha256: provenance.codeModeHostSha256,
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
  provenance: { buildId: string; revision: string; codexSha256: string; codeModeHostSha256: string; templateId: string }
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
  const tls = await generatePocTls(paths.tlsDirectory, env.providerCaCertificate)
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

type CleanupRun = Pick<CompleteRun, 'env' | 'paths' | 'docker' | 'tls' | 'runtime'>

function providerInspector(run: CleanupRun): PocProviderInspector {
  return new PocProviderInspector({ apiKey: run.env.e2bApiKey, apiUrl: run.env.e2bApiUrl,
    domain: run.env.e2bDomain, validateApiKey: run.env.e2bValidateApiKey },
  `cudex-poc-${run.paths.runId}`, `poc-${run.paths.runId}`)
}

interface FunctionalRunInspection {
  database?: PocDatabaseInspection
  functional?: PocFunctionalInspection
  workspaceVerified: boolean
}

async function inspectFunctionalRun(run: CompleteRun, evidence: PocAppServerEvidence | undefined): Promise<FunctionalRunInspection> {
  const opened = await openPocDatabaseInspector(run.runtime.POC_DATABASE_URL!, `poc-${run.paths.runId}`)
  try {
    const database = await opened.inspector.inspect()
    const functional = evaluatePocFunctionalInspection(database, evidence)
    const workspaceVerified = functional.rootLease
      ? await verifyRootWorkspace(run, functional.rootLease.providerSandboxId).catch(() => false) : false
    return { database, functional, workspaceVerified }
  } finally { await opened.close() }
}

async function verifyRootWorkspace(run: CompleteRun, providerSandboxId: string | null): Promise<boolean> {
  if (!providerSandboxId) return false
  // A terminal hosted checkpoint can briefly pause the E2B command channel just
  // after turn/completed. Retry only this fixed, read-only probe across that
  // bounded lifecycle transition.
  const deadline = Date.now() + 60_000
  do {
    try {
      const response = await callPocService(run, '/v1/poc/workspace-verification', { providerSandboxId })
      if (response && typeof response === 'object' && !Array.isArray(response)
        && Reflect.ownKeys(response).length === 1 && (response as Record<string, unknown>).verified === true) return true
    } catch { /* The exact probe is safe to repeat while the root lease remains active. */ }
    if (Date.now() >= deadline) return false
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  } while (true)
}

async function callPocService(run: CleanupRun, path: string, input: Record<string, unknown>): Promise<unknown> {
  const body = Buffer.from(JSON.stringify(input))
  const ca = await readFile(run.tls.combinedCaBundlePath)
  const response = await new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
    const request = httpsRequest({ hostname: 'localhost', port: run.env.controlPort,
      path, method: 'POST', ca, rejectUnauthorized: true,
      headers: { authorization: `Bearer ${run.runtime.POC_SERVICE_BEARER!}`,
        'content-type': 'application/json', 'content-length': String(body.byteLength) } }, incoming => {
      const chunks: Buffer[] = []; let size = 0
      incoming.on('data', chunk => {
        size += chunk.length
        if (size <= 1024) chunks.push(Buffer.from(chunk))
        else request.destroy(new Error('POC service response is too large'))
      })
      incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, bytes: Buffer.concat(chunks) }))
    })
    request.setTimeout(120_000, () => request.destroy(new Error('POC service operation timed out')))
    request.once('error', reject)
    request.end(body)
  })
  if (response.status !== 200 || response.bytes.byteLength === 0) throw new Error('POC service operation failed')
  let value: unknown
  try { value = JSON.parse(response.bytes.toString('utf8')) } catch { throw new Error('POC service response is invalid') }
  return value
}

async function environmentIdForThread(run: CompleteRun, threadId: string): Promise<string> {
  const opened = await openPocDatabaseInspector(run.runtime.POC_DATABASE_URL!, `poc-${run.paths.runId}`)
  try {
    const deadline = Date.now() + 30_000
    do {
      const lease = (await opened.inspector.leases()).find(item => item.agentId === threadId)
      if (lease) return lease.environmentId
      if (Date.now() >= deadline) throw new Error('hosted root lease was not durably visible')
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    } while (true)
  } finally { await opened.close() }
}

interface CleanupOutcome {
  serviceCleanupComplete: boolean
  forcedProviderCleanup: boolean
  dockerVolumesRemoved: boolean
  assertions: Record<string, boolean>
  database?: PocDatabaseInspection
}

async function exactCleanup(run: CleanupRun, appServer: PocAppServerProcess | undefined,
  evidence: PocAppServerEvidence | undefined, preserve: boolean): Promise<CleanupOutcome> {
  let deletionComplete = !evidence
  if (appServer && evidence && !evidence.deletedThreadIds.includes(evidence.rootThreadId)) {
    try { await deleteThreadTree(appServer, evidence); deletionComplete = true } catch { deletionComplete = false }
  }
  if (appServer) await appServer.stop().catch(() => { deletionComplete = false })

  let database: PocDatabaseInspection | undefined
  let provider = { managedSandboxIds: [] as string[], knownProviderSnapshotIds: [] as string[] }
  let cleanupAssertions: Record<string, boolean> = { threadDeletionCompleted: deletionComplete,
    databaseInspectionCompleted: false, providerInspectionCompleted: false }
  let forcedProviderCleanup = false
  let opened: Awaited<ReturnType<typeof openPocDatabaseInspector>> | undefined
  try {
    opened = await openPocDatabaseInspector(run.runtime.POC_DATABASE_URL!, `poc-${run.paths.runId}`)
    const deadline = Date.now() + 60_000
    do {
      database = await opened.inspector.inspect()
      const databaseSettled = database.leases.every(lease => lease.state === 'released')
        && database.operations.every(operation => operation.state !== 'in_progress')
        && database.allocations.every(allocation => allocation.state !== 'allocated'
          && allocation.state !== 'reclaim_pending')
        && database.liveTicketCount === 0 && database.unfinishedInteractionCount === 0
      if (databaseSettled || Date.now() >= deadline) break
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    } while (true)
    cleanupAssertions.databaseInspectionCompleted = true
    if (!preserve) {
      await callPocService(run, '/v1/poc/provider-snapshots/cleanup', {})
      database = await opened.inspector.inspect()
    }
    try {
      provider = await providerInspector(run).inspect(database)
      cleanupAssertions.providerInspectionCompleted = true
    } catch { cleanupAssertions.providerInspectionCompleted = false }
    cleanupAssertions = { threadDeletionCompleted: deletionComplete,
      databaseInspectionCompleted: true, providerInspectionCompleted: cleanupAssertions.providerInspectionCompleted!,
      ...evaluatePocCleanupInspection(database, provider) }
    const serviceCleanupComplete = Object.values(cleanupAssertions).every(Boolean)
    if (!preserve && (!serviceCleanupComplete || provider.managedSandboxIds.length > 0
      || provider.knownProviderSnapshotIds.length > 0)) {
      forcedProviderCleanup = await providerInspector(run).forceCleanup(database).catch(() => false)
    }
  } catch { /* Teardown below remains mandatory after an inspection failure. */ }
  finally { await opened?.close().catch(() => undefined) }

  const serviceCleanupComplete = Object.values(cleanupAssertions).every(Boolean)
  if (preserve) return { serviceCleanupComplete, forcedProviderCleanup: false,
    dockerVolumesRemoved: false, assertions: cleanupAssertions, ...(database ? { database } : {}) }

  let serviceStopped = true
  await stopControlService(run.paths).catch(() => { serviceStopped = false })
  let dockerVolumesRemoved = true
  await stopCompose(run.docker, run.paths).catch(() => { dockerVolumesRemoved = false })
  await Promise.all([removeRuntimeAuth(run.paths.codexHome), rm(run.tls.caKeyPath, { force: true }),
    rm(run.tls.serverKeyPath, { force: true }), removeCurrentPointer(run.paths)])
  return { serviceCleanupComplete: serviceCleanupComplete && serviceStopped, forcedProviderCleanup,
    dockerVolumesRemoved, assertions: cleanupAssertions, ...(database ? { database } : {}) }
}

function appAssertions(evidence: PocAppServerEvidence | undefined): Record<string, boolean> {
  return {
    rootThreadStarted: evidence?.rootThreadStarted === true,
    rootEnvironmentReady: evidence?.rootEnvironmentReady === true,
    spawnAgentCompleted: evidence?.spawnAgentCompleted === true,
    spawnAgentCalledExactlyOnce: evidence?.spawnAgentCount === 1,
    distinctChildThread: Boolean(evidence?.childThreadId && evidence.childThreadId !== evidence.rootThreadId),
    waitCompleted: evidence?.waitCompleted === true,
    rootPatchAvailable: evidence?.rootPatchAvailable === true,
    childPatchAvailable: evidence?.childPatchAvailable === true,
    rootTurnCompleted: evidence?.rootTurnCompleted === true,
    finalMarkerObserved: evidence?.finalMarker === true,
  }
}

function deletionAssertions(evidence: PocAppServerEvidence | undefined): Record<string, boolean> {
  return { rootThreadDeleted: Boolean(evidence && evidence.deletedThreadIds.includes(evidence.rootThreadId)),
    childThreadDeleted: Boolean(evidence?.childThreadId && evidence.deletedThreadIds.includes(evidence.childThreadId)) }
}

async function reportSecretValues(run: CompleteRun): Promise<string[]> {
  const compose = parseEnv(await readFile(run.paths.composeEnv, 'utf8'))
  const values = [run.env.e2bApiKey, run.env.accessToken ?? '', run.runtime.POC_DATABASE_URL ?? '',
    run.runtime.POC_GARAGE_ACCESS_KEY ?? '', run.runtime.POC_GARAGE_SECRET_KEY ?? '', run.runtime.POC_SERVICE_BEARER ?? '']
  for (const [key, value] of Object.entries(compose)) {
    if (value && /(?:PASSWORD|SECRET|TOKEN|KEY)/u.test(key)) values.push(value)
  }
  return [...new Set(values.filter(value => value.length >= 8))]
}

function nestedStringValues(value: unknown, result: string[]): void {
  if (typeof value === 'string') { if (value.length >= 8) result.push(value); return }
  if (Array.isArray(value)) { for (const item of value) nestedStringValues(item, result); return }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) nestedStringValues(item, result)
  }
}

async function safeAgentDiagnostic(run: CompleteRun, evidence: PocAppServerEvidence | undefined): Promise<string | undefined> {
  const message = evidence?.lastRootAgentMessage?.trim()
  if (!message) return undefined
  const secrets = await reportSecretValues(run)
  if (run.env.authJsonFile) {
    const runtimeAuth = await readFile(`${run.paths.codexHome}/auth.json`, 'utf8').catch(() => '')
    if (runtimeAuth) {
      try { nestedStringValues(JSON.parse(runtimeAuth), secrets) } catch { /* Auth was already validated. */ }
    }
  }
  return redactSecrets(message, secrets)
    .replace(/(?:https?|wss):\/\/\S+/gu, '[REDACTED_URL]')
    .replace(/\b(?:eyJ[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)\b/gu, '[REDACTED_TOKEN]')
    .replace(/[A-Za-z0-9_-]{80,}/gu, '[REDACTED_OPAQUE]')
    .slice(0, 2_048)
}

async function writeReport(run: CompleteRun, mode: 'automated' | 'interactive', startedAt: string,
  status: HostedCodexPocReport['status'], evidence: PocAppServerEvidence | undefined,
  functional: PocFunctionalInspection | undefined, assertions: Record<string, boolean>, cleanup: CleanupOutcome): Promise<void> {
  const report: HostedCodexPocReport = { version: 1, runId: run.paths.runId, mode, startedAt,
    finishedAt: new Date().toISOString(), status,
    provenance: { buildId: run.provenance.buildId, revision: run.provenance.revision,
      codexSha256: run.provenance.codexSha256, codeModeHostSha256: run.provenance.codeModeHostSha256,
      templateId: run.provenance.templateId },
    identities: { ...(evidence ? { rootThreadId: evidence.rootThreadId } : {}),
      ...(evidence?.childThreadId ? { childThreadId: evidence.childThreadId } : {}),
      ...(!evidence && functional?.rootLease ? { rootThreadId: functional.rootLease.agentId } : {}),
      ...(!evidence && functional?.childLease ? { childThreadId: functional.childLease.agentId } : {}),
      ...(functional?.rootLease ? { rootLeaseId: functional.rootLease.leaseId } : {}),
      ...(functional?.childLease ? { childLeaseId: functional.childLease.leaseId } : {}),
      ...(functional?.artifactId ? { artifactId: functional.artifactId }
        : evidence?.artifactId ? { artifactId: evidence.artifactId } : {}) },
    assertions, cleanup: { serviceCleanupComplete: cleanup.serviceCleanupComplete,
      forcedProviderCleanup: cleanup.forcedProviderCleanup, dockerVolumesRemoved: cleanup.dockerVolumesRemoved },
    logFiles: ['control-service.log', ...(mode === 'automated' ? ['app-server.log'] : [])],
  }
  await writeFile(run.paths.report, serializePocReport(report, await reportSecretValues(run)), { mode: 0o600 })
}

async function automated(): Promise<void> {
  const startedAt = new Date().toISOString()
  const env = await configuration()
  const run = await prepareCompleteRun(env)
  let appServer: PocAppServerProcess | undefined
  let evidence: PocAppServerEvidence | undefined
  let inspection: FunctionalRunInspection = { workspaceVerified: false }
  let functional = false
  let failure: unknown
  let agentDiagnostic: string | undefined
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
    evidence = await Promise.race([runAutomatedTurn({ process: appServer, codexHome: run.paths.codexHome,
      prompt: await readFile(`${e2bRoot}/poc/prompts/automated.md`, 'utf8'),
      ...(env.codexModel ? { model: env.codexModel } : {}), deadlineMs: 20 * 60_000,
      environmentIdForThread: threadId => environmentIdForThread(run, threadId),
      onEvidence: value => { evidence = value } }), interrupted])
    inspection = await inspectFunctionalRun(run, evidence)
    functional = Object.values({ ...appAssertions(evidence), ...(inspection.functional?.assertions ?? {}),
      rootWorkspaceVerified: inspection.workspaceVerified }).every(Boolean)
    if (!functional) {
      agentDiagnostic = await safeAgentDiagnostic(run, evidence)
      failure = new Error('automated app-server evidence is incomplete')
    }
  } catch (error) { failure = error }
  finally { process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm) }
  const preserve = !functional && env.keepOnFailure
  const cleanup = await exactCleanup(run, appServer, evidence, preserve)
  const logPaths = [`${run.paths.logsDirectory}/control-service.log`, `${run.paths.logsDirectory}/app-server.log`]
  const logsRedacted = await retainedFilesAreRedacted(logPaths, await reportSecretValues(run)).catch(() => false)
  const assertions = { ...appAssertions(evidence), ...(inspection.functional?.assertions ?? {}),
    rootWorkspaceVerified: inspection.workspaceVerified, ...deletionAssertions(evidence), ...cleanup.assertions,
    retainedLogsRedacted: logsRedacted }
  functional = Object.values({ ...appAssertions(evidence), ...(inspection.functional?.assertions ?? {}),
    rootWorkspaceVerified: inspection.workspaceVerified }).every(Boolean) && logsRedacted
  const passed = functional && cleanup.serviceCleanupComplete && cleanup.dockerVolumesRemoved && !cleanup.forcedProviderCleanup
  const status = passed ? 'passed' : functional && cleanup.forcedProviderCleanup ? 'cleanup_intervention' : 'failed'
  await writeReport(run, 'automated', startedAt, status, evidence, inspection.functional, assertions, cleanup)
  console.log(JSON.stringify({ runId: run.paths.runId, status, report: run.paths.report }))
  if (!passed) {
    console.error(failure instanceof Error ? failure.message : 'automated POC failed')
    if (agentDiagnostic) console.error(`Redacted root response: ${agentDiagnostic}`)
    process.exitCode = status === 'cleanup_intervention' ? 3 : 1
  }
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
  const inspection = await inspectFunctionalRun(run, undefined).catch(() => ({ workspaceVerified: false } as FunctionalRunInspection))
  const functional = exitCode === 0 && inspection.functional !== undefined && inspection.workspaceVerified
    && Object.values(inspection.functional.assertions).every(Boolean)
  const cleanup = await exactCleanup(run, undefined, undefined, !functional && env.keepOnFailure)
  const logsRedacted = await retainedFilesAreRedacted([`${run.paths.logsDirectory}/control-service.log`],
    await reportSecretValues(run)).catch(() => false)
  const assertions = { cliExitedSuccessfully: exitCode === 0, ...(inspection.functional?.assertions ?? {}),
    rootWorkspaceVerified: inspection.workspaceVerified, ...cleanup.assertions, retainedLogsRedacted: logsRedacted }
  const passed = functional && logsRedacted && cleanup.serviceCleanupComplete && cleanup.dockerVolumesRemoved
    && !cleanup.forcedProviderCleanup
  const status = passed ? 'passed' : functional && logsRedacted && cleanup.forcedProviderCleanup
    ? 'cleanup_intervention' : 'failed'
  await writeReport(run, 'interactive', startedAt, status, undefined, inspection.functional, assertions, cleanup)
  console.log(JSON.stringify({ runId: run.paths.runId, mode: 'interactive', status,
    cliExitCode: exitCode, report: run.paths.report }))
  if (childFailure instanceof Error) console.error(childFailure.message)
  if (!passed) process.exitCode = status === 'cleanup_intervention' ? 3 : 1
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
    const tls = await generatePocTls(paths.tlsDirectory, env.providerCaCertificate)
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
  const opened = await openPocDatabaseInspector(runtime.POC_DATABASE_URL!, `poc-${paths.runId}`)
  let database: PocDatabaseInspection
  try { database = await opened.inspector.inspect() } finally { await opened.close() }
  const run: CleanupRun = { env, paths, docker, tls: existingTlsMaterial(paths), runtime }
  const provider = await providerInspector(run).inspect(database).catch(() => undefined)
  console.log(JSON.stringify({ runId: paths.runId, serviceReachable: await tcpConnects(env.controlPort),
    servicePid: Number(runtime.POC_SERVICE_PID ?? 0), lifecycle: {
      leases: database.leases.map(lease => ({ leaseId: lease.leaseId, state: lease.state })),
      liveTickets: database.liveTicketCount, unfinishedInteractions: database.unfinishedInteractionCount,
      managedProviderSandboxes: provider?.managedSandboxIds.length,
      knownProviderSnapshots: provider?.knownProviderSnapshotIds.length,
    }, compose: compose.split('\n').filter(Boolean).map(line => {
      try { const value = JSON.parse(line) as Record<string, unknown>; return { service: value.Service, state: value.State, health: value.Health } }
      catch { return { state: 'unknown' } }
    }) }, null, 2))
}

async function down(): Promise<void> {
  const paths = await currentRun()
  const env = await configuration()
  const runtime = await readRuntimeEnvironment(paths)
  const docker = await detectDocker()
  const cleanup = await exactCleanup({ env, paths, docker, tls: existingTlsMaterial(paths), runtime },
    undefined, undefined, false)
  console.log(JSON.stringify({ runId: paths.runId, stopped: true,
    serviceCleanupComplete: cleanup.serviceCleanupComplete,
    forcedProviderCleanup: cleanup.forcedProviderCleanup, dockerVolumesRemoved: cleanup.dockerVolumesRemoved }))
  if (!cleanup.dockerVolumesRemoved) process.exitCode = 1
  else if (cleanup.forcedProviderCleanup) process.exitCode = 3
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (!command) usage()
  if (command !== 'auth' && await ensureProviderProcessEnvironment(await configuration(), command)) return
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
