import { execFile } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { readFile, open, readlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import WebSocket from 'ws'
import { parseEnv } from 'node:util'
import { promisify } from 'node:util'
import type { PocEnvironment } from './poc-env.js'
import type { PocRunPaths } from './poc-config.js'
import { createTrustedRoles, updateRuntimeValue } from './poc-config.js'
import type { PocTlsMaterial } from './poc-tls.js'

const exec = promisify(execFile)

export interface DockerCommand { executable: string; prefix: string[] }

function baseEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'NODE_EXTRA_CA_CERTS'] as const) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

async function works(executable: string, args: string[]): Promise<boolean> {
  try { await exec(executable, args, { env: baseEnvironment(), timeout: 15_000 }); return true }
  catch { return false }
}

export async function detectDocker(): Promise<DockerCommand> {
  if (await works('docker', ['info'])) return { executable: 'docker', prefix: [] }
  if (await works('sudo', ['-n', 'docker', 'info'])) return { executable: 'sudo', prefix: ['-n', 'docker'] }
  throw new Error('Docker is unavailable (tried docker and sudo -n docker)')
}

function composeArgs(docker: DockerCommand, paths: PocRunPaths, args: string[]): string[] {
  return [...docker.prefix, 'compose', '--env-file', paths.composeEnv,
    '-f', `${paths.e2bRoot}/poc/compose.yaml`, ...args]
}

export async function runCompose(docker: DockerCommand, paths: PocRunPaths, args: string[]): Promise<string> {
  const result = await exec(docker.executable, composeArgs(docker, paths, args), {
    cwd: paths.repositoryRoot, env: baseEnvironment(), timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  })
  return result.stdout
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

export async function assertPocPortsAvailable(env: PocEnvironment): Promise<void> {
  for (const [name, port] of [['control', env.controlPort], ['PostgreSQL', env.postgresPort], ['Garage', env.garagePort]] as const) {
    if (!await portAvailable(port)) throw new Error(`${name} port ${port} is already occupied`)
  }
}

export async function startCompose(docker: DockerCommand, paths: PocRunPaths): Promise<void> {
  await runCompose(docker, paths, ['up', '-d', '--wait', '--wait-timeout', '120'])
}

export async function stopCompose(docker: DockerCommand, paths: PocRunPaths): Promise<void> {
  await runCompose(docker, paths, ['down', '--volumes', '--remove-orphans'])
}

export async function readRuntimeEnvironment(paths: PocRunPaths): Promise<Record<string, string>> {
  const parsed = parseEnv(await readFile(paths.runtimeEnv, 'utf8'))
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) if (value !== undefined) result[key] = value
  return result
}

export async function verifyGarage(env: PocEnvironment, runtime: Record<string, string>): Promise<void> {
  const accessKeyId = runtime.POC_GARAGE_ACCESS_KEY
  const secretAccessKey = runtime.POC_GARAGE_SECRET_KEY
  const bucket = runtime.POC_GARAGE_BUCKET
  if (!accessKeyId || !secretAccessKey || !bucket) throw new Error('POC Garage runtime configuration is incomplete')
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${env.garagePort}`, region: 'garage', forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1,
  })
  const deadline = Date.now() + 60_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try { await client.send(new HeadBucketCommand({ Bucket: bucket })); client.destroy(); return }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 500)) }
  }
  client.destroy()
  void lastError
  throw new Error('Garage did not pass the scoped S3 HeadBucket readiness check')
}

export async function runMigrations(paths: PocRunPaths, databaseUrl: string): Promise<void> {
  await exec(process.execPath, [`${paths.e2bRoot}/dist/src/migrate.js`], {
    cwd: paths.repositoryRoot, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: baseEnvironment().PATH, HOSTED_AGENT_DATABASE_URL: databaseUrl },
  })
}

interface TemplateIdentity { templateId: string }
async function templateIdentity(path: string): Promise<TemplateIdentity> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('template metadata is not valid JSON') }
  const templateId = (value as { templateId?: unknown } | null)?.templateId
  if (typeof templateId !== 'string' || !templateId.trim()) throw new Error('template metadata has no template ID')
  return { templateId }
}

export async function startControlService(
  paths: PocRunPaths, env: PocEnvironment, runtime: Record<string, string>, tls: PocTlsMaterial,
): Promise<number> {
  const metadata = await templateIdentity(env.templateMetadata)
  const databaseUrl = runtime.POC_DATABASE_URL
  const accessKeyId = runtime.POC_GARAGE_ACCESS_KEY
  const secretAccessKey = runtime.POC_GARAGE_SECRET_KEY
  const bucket = runtime.POC_GARAGE_BUCKET
  const bearer = runtime.POC_SERVICE_BEARER
  if (!databaseUrl || !accessKeyId || !secretAccessKey || !bucket || !bearer) throw new Error('POC runtime configuration is incomplete')
  const log = await open(`${paths.logsDirectory}/control-service.log`, 'a', 0o600)
  const serviceEnv: NodeJS.ProcessEnv = {
    PATH: baseEnvironment().PATH, NODE_ENV: 'production',
    E2B_API_KEY: env.e2bApiKey, E2B_API_URL: env.e2bApiUrl, E2B_DOMAIN: env.e2bDomain,
    HOSTED_AGENT_DATABASE_URL: databaseUrl, HOSTED_AGENT_OBJECT_BUCKET: bucket,
    HOSTED_AGENT_OBJECT_ENDPOINT: `http://127.0.0.1:${env.garagePort}`,
    HOSTED_AGENT_OBJECT_FORCE_PATH_STYLE: 'true', HOSTED_AGENT_OBJECT_REGION: 'garage',
    AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_REGION: 'garage',
    HOSTED_AGENT_TENANT_ID: `poc-${paths.runId}`, HOSTED_AGENT_WORKER_ID: `poc-worker-${paths.runId}`,
    HOSTED_AGENT_MANAGED_BY: `cudex-poc-${paths.runId}`, HOSTED_AGENT_ROLES: JSON.stringify(createTrustedRoles(metadata.templateId)),
    HOSTED_AGENT_POC_INSPECTION: 'true',
    CODEX_HOSTED_AGENT_TOKEN: bearer, HOSTED_AGENT_GATEWAY_URL: `wss://localhost:${env.controlPort}/`,
    HOSTED_AGENT_HOST: '127.0.0.1', HOSTED_AGENT_PORT: String(env.controlPort),
    HOSTED_AGENT_TLS_CERT: tls.serverCertificatePath, HOSTED_AGENT_TLS_KEY: tls.serverKeyPath,
    HOSTED_AGENT_STALE_MS: '20000', HOSTED_AGENT_RECONCILE_MS: '1000',
    HOSTED_AGENT_CHILD_STALE_MS: '20000', HOSTED_AGENT_CHILD_RECONCILE_MS: '1000',
    HOSTED_AGENT_PATCH_APPLY_STALE_MS: '20000', HOSTED_AGENT_PATCH_APPLY_RECONCILE_MS: '1000',
    HOSTED_AGENT_TICKET_TTL_MS: '60000', HOSTED_AGENT_SOURCE_MAX_TTL_MS: String(4 * 60 * 60_000),
  }
  if (env.workspaceMode === 'git-working-set') {
    // TODO(internal-release, PILOT-003): Each pilot user runs disposable PostgreSQL and Garage locally
    // because this reuses the proven POC. Replace it with the supported internal control-plane topology.
    serviceEnv.HOSTED_AGENT_WORKSPACE_MODE = 'git-working-set'
    // TODO(internal-release, PILOT-014): Pilot cleanup uses the POC inspection operations so exact
    // resources remain recoverable. Replace them with supported authenticated operational interfaces.
    serviceEnv.HOSTED_AGENT_POC_INSPECTION = 'true'
    // TODO(internal-release, PILOT-017): Production reconciliation, quotas, monitoring, backup, and
    // outage hardening are deferred for named pilot users. Complete that queue before broader rollout.
  }
  serviceEnv.E2B_VALIDATE_API_KEY = String(env.e2bValidateApiKey)
  if (env.providerCaCertificate) serviceEnv.NODE_EXTRA_CA_CERTS = env.providerCaCertificate
  const child = spawn(process.execPath, [`${paths.e2bRoot}/dist/src/main.js`], {
    cwd: paths.repositoryRoot, env: serviceEnv, detached: true, stdio: ['ignore', log.fd, log.fd],
  })
  await log.close()
  child.unref()
  if (!child.pid) throw new Error('failed to start POC control service')
  await updateRuntimeValue(paths.runtimeEnv, 'POC_SERVICE_PID', String(child.pid))
  return child.pid
}

async function httpsStatus(url: URL, bearer: string | undefined, ca: Buffer): Promise<number> {
  const { request } = await import('node:https')
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', ca, rejectUnauthorized: true,
      ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}) }, response => {
      response.resume(); resolve(response.statusCode ?? 0)
    })
    req.once('error', reject); req.end()
  })
}

export async function verifyControlService(env: PocEnvironment, runtime: Record<string, string>, tls: PocTlsMaterial): Promise<void> {
  const bearer = runtime.POC_SERVICE_BEARER
  if (!bearer) throw new Error('POC service bearer is unavailable')
  const ca = await readFile(tls.combinedCaBundlePath)
  const url = new URL(`https://localhost:${env.controlPort}/`)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if (await httpsStatus(url, undefined, ca) === 401) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (await httpsStatus(url, undefined, ca) !== 401) throw new Error('HTTPS unauthenticated readiness assertion failed')
  if (await httpsStatus(url, bearer, ca) !== 404) throw new Error('HTTPS authenticated readiness assertion failed')
  const gatewayStatus = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`wss://localhost:${env.controlPort}/`, { ca, rejectUnauthorized: true })
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('WSS readiness timed out')) }, 5_000)
    socket.once('unexpected-response', (_request, response) => { clearTimeout(timeout); response.resume(); resolve(response.statusCode ?? 0) })
    socket.once('open', () => { clearTimeout(timeout); socket.close(); reject(new Error('WSS gateway accepted a missing ticket')) })
    socket.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  if (gatewayStatus !== 401) throw new Error('WSS gateway readiness assertion failed')
}

export async function stopControlService(paths: PocRunPaths): Promise<boolean> {
  const runtime = await readRuntimeEnvironment(paths)
  const pid = Number(runtime.POC_SERVICE_PID ?? '0')
  if (!Number.isSafeInteger(pid) || pid <= 1) return true
  try {
    const [command, environment, cwd] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`), readFile(`/proc/${pid}/environ`), readlink(`/proc/${pid}/cwd`),
    ])
    const tenant = `HOSTED_AGENT_TENANT_ID=poc-${paths.runId}`
    if (!command.toString('utf8').includes('dist/src/main.js')
      || !environment.toString('utf8').split('\0').includes(tenant)
      || resolve(cwd) !== resolve(paths.repositoryRoot)) {
      throw new Error('refusing to stop a control service without the exact run identity')
    }
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 100)) }
    catch { return true }
  }
  process.kill(pid, 'SIGKILL')
  return false
}

export async function tcpConnects(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(1_000)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
  })
}

export async function writeCurrentPointer(paths: PocRunPaths): Promise<void> {
  const pointer = `${paths.e2bRoot}/.state/poc/current`
  await writeFile(pointer, `${paths.runId}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}
