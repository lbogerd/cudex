import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as scheduleTimeout } from 'node:timers'
import type { PocEnvironment } from './poc-env.js'
import type { UploadedSourceSnapshot } from './source-snapshot-client.js'

export interface PocRunPaths {
  repositoryRoot: string
  e2bRoot: string
  runId: string
  runDirectory: string
  runtimeEnv: string
  composeEnv: string
  garageConfig: string
  tlsDirectory: string
  codexHome: string
  logsDirectory: string
  report: string
}

export interface PocRuntimeSecrets {
  postgresPassword: string
  garageRpcSecret: string
  garageAdminToken: string
  garageMetricsToken: string
  garageAccessKey: string
  garageSecretKey: string
  serviceBearer: string
}

export interface PocProvenance {
  buildId: string
  revision: string
  codexSha256: string
  templateId: string
  binaryPath: string
  metadataPath: string
}

export function createRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}-${randomBytes(6).toString('hex')}`
}

export function pocRunPaths(repositoryRoot: string, runId: string): PocRunPaths {
  if (!/^\d{14}-[0-9a-f]{12}$/u.test(runId)) throw new Error('invalid POC run ID')
  const root = resolve(repositoryRoot)
  const e2bRoot = join(root, 'e2b')
  const runDirectory = join(e2bRoot, '.state', 'poc', runId)
  return {
    repositoryRoot: root, e2bRoot, runId, runDirectory,
    runtimeEnv: join(runDirectory, 'runtime.env'), composeEnv: join(runDirectory, 'compose.env'),
    garageConfig: join(runDirectory, 'garage.toml'), tlsDirectory: join(runDirectory, 'tls'),
    codexHome: join(runDirectory, 'codex-home'), logsDirectory: join(runDirectory, 'logs'),
    report: join(runDirectory, 'report.json'),
  }
}

export function generateRuntimeSecrets(): PocRuntimeSecrets {
  return {
    postgresPassword: randomBytes(32).toString('hex'), garageRpcSecret: randomBytes(32).toString('hex'),
    garageAdminToken: randomBytes(32).toString('base64url'), garageMetricsToken: randomBytes(32).toString('base64url'),
    garageAccessKey: `GK${randomBytes(16).toString('hex')}`, garageSecretKey: randomBytes(32).toString('hex'),
    serviceBearer: randomBytes(32).toString('base64url'),
  }
}

function envLine(key: string, value: string | number): string {
  const text = String(value)
  if (!/^[A-Za-z0-9_./:@+-]+$/u.test(text)) throw new Error(`unsafe generated value for ${key}`)
  return `${key}=${text}`
}

export async function prepareRunFiles(paths: PocRunPaths, env: PocEnvironment, secrets: PocRuntimeSecrets): Promise<void> {
  await mkdir(paths.logsDirectory, { recursive: true, mode: 0o700 })
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 })
  await mkdir(paths.tlsDirectory, { recursive: true, mode: 0o700 })
  const template = await readFile(join(paths.e2bRoot, 'poc', 'garage.toml.template'), 'utf8')
  await writeFile(paths.garageConfig, template, { mode: 0o600, flag: 'wx' })
  const databaseUrl = `postgresql://cudex_poc:${secrets.postgresPassword}@127.0.0.1:${env.postgresPort}/cudex_poc`
  const runtime = [
    envLine('POC_RUN_ID', paths.runId), envLine('POC_DATABASE_URL', databaseUrl),
    envLine('POC_GARAGE_BUCKET', `cudex-poc-${paths.runId}`),
    envLine('POC_GARAGE_ACCESS_KEY', secrets.garageAccessKey), envLine('POC_GARAGE_SECRET_KEY', secrets.garageSecretKey),
    envLine('POC_SERVICE_BEARER', secrets.serviceBearer), envLine('POC_SERVICE_PID', '0'),
  ].join('\n') + '\n'
  const compose = [
    envLine('POC_COMPOSE_PROJECT', `cudex-poc-${paths.runId}`),
    envLine('POC_POSTGRES_PORT', env.postgresPort), envLine('POC_POSTGRES_PASSWORD', secrets.postgresPassword),
    envLine('POC_GARAGE_PORT', env.garagePort), envLine('POC_GARAGE_CONFIG', paths.garageConfig),
    envLine('POC_GARAGE_RPC_SECRET', secrets.garageRpcSecret), envLine('POC_GARAGE_ADMIN_TOKEN', secrets.garageAdminToken),
    envLine('POC_GARAGE_METRICS_TOKEN', secrets.garageMetricsToken), envLine('POC_GARAGE_ACCESS_KEY', secrets.garageAccessKey),
    envLine('POC_GARAGE_SECRET_KEY', secrets.garageSecretKey), envLine('POC_GARAGE_BUCKET', `cudex-poc-${paths.runId}`),
  ].join('\n') + '\n'
  await writeFile(paths.runtimeEnv, runtime, { mode: 0o600, flag: 'wx' })
  await writeFile(paths.composeEnv, compose, { mode: 0o600, flag: 'wx' })
  await Promise.all([chmod(paths.runtimeEnv, 0o600), chmod(paths.composeEnv, 0o600), chmod(paths.garageConfig, 0o600)])
}

export async function updateRuntimeValue(path: string, key: string, value: string): Promise<void> {
  const source = await readFile(path, 'utf8')
  const line = envLine(key, value)
  const next = source.match(new RegExp(`^${key}=`, 'mu'))
    ? source.replace(new RegExp(`^${key}=.*$`, 'mu'), line)
    : `${source}${line}\n`
  await writeFile(path, next, { mode: 0o600 })
}

export function resolveRepositoryPath(repositoryRoot: string, path: string): string {
  return resolve(repositoryRoot, path)
}

function metadataString(value: unknown, label: string, pattern: RegExp, max = 512): string {
  if (typeof value !== 'string' || !pattern.test(value) || Buffer.byteLength(value) > max) {
    throw new Error(`template metadata has an invalid ${label}`)
  }
  return value
}

export async function validatePocProvenance(repositoryRoot: string, metadataPath: string): Promise<PocProvenance> {
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(metadataPath, 'utf8')) } catch { throw new Error('template metadata is not valid JSON') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('template metadata is invalid')
  const record = parsed as Record<string, unknown>
  const buildId = metadataString(record.buildId, 'build ID', /^[A-Za-z0-9._-]{1,128}$/u)
  const revision = metadataString(record.revision, 'Codex revision', /^[0-9a-f]{40}$/u)
  const codexSha256 = metadataString(record.codexSha256, 'Codex checksum', /^[0-9a-f]{64}$/u)
  const templateId = metadataString(record.templateId, 'template ID', /^[A-Za-z0-9._-]{1,512}$/u)
  const binaryPath = resolve(repositoryRoot, 'e2b', '.artifacts', 'codex', buildId, 'codex')
  let binary: Buffer
  let metadata
  try { [binary, metadata] = await Promise.all([readFile(binaryPath), stat(binaryPath)]) }
  catch { throw new Error('matching local Codex artifact is unavailable') }
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) throw new Error('matching local Codex artifact is not executable')
  if (binary.byteLength < 20 || binary[0] !== 0x7f || binary.subarray(1, 4).toString('ascii') !== 'ELF'
    || binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== 0x3e) {
    throw new Error('matching local Codex artifact is not an x86_64 Linux binary')
  }
  const actual = createHash('sha256').update(binary).digest('hex')
  if (actual !== codexSha256) throw new Error('local Codex artifact checksum does not match template metadata')
  return { buildId, revision, codexSha256, templateId, binaryPath, metadataPath }
}

export function createTrustedRoles(templateId: string): Record<string, unknown> {
  const tools = (names: string[]): Array<{ name: string; namespace: null }> => names.map(name => ({ name, namespace: null }))
  return {
    root: { sandboxTemplate: 'poc-root-v1', providerTemplateId: templateId, policyVersion: 1,
      toolPolicy: { allowedDomains: ['agentEnvironment', 'controlPlane'],
        allowedTools: tools(['exec_command', 'write_stdin', 'spawn_agent', 'wait_agent', 'apply_agent_patch']) } },
    child: { sandboxTemplate: 'poc-child-v1', providerTemplateId: templateId, policyVersion: 1,
      toolPolicy: { allowedDomains: ['agentEnvironment'], allowedTools: tools(['exec_command', 'write_stdin']) } },
  }
}

function toml(value: string): string { return JSON.stringify(value) }

export async function generateCodexConfiguration(
  paths: PocRunPaths, env: PocEnvironment, source: UploadedSourceSnapshot, provenance: PocProvenance,
): Promise<{ configPath: string; trustedRolesPath: string }> {
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 })
  const configPath = join(paths.codexHome, 'config.toml')
  const trustedRolesPath = join(paths.runDirectory, 'trusted-roles.json')
  const model = env.codexModel ? `model = ${toml(env.codexModel)}\n` : ''
  const config = `${model}cli_auth_credentials_store = "file"

[features]
hosted_agents = true

[features.multi_agent_v2]
enabled = true

[hosted_agents]
enabled = true
service_url = ${toml(`https://localhost:${env.controlPort}/`)}
default_agent_type = "root"

[hosted_agents.source_snapshot]
source_snapshot_id = ${toml(source.sourceSnapshotId)}
checksum = ${toml(source.checksum)}

[agents.root]
description = "Local POC owner"
sandbox_template = "poc-root-v1"

[agents.child]
description = "Local POC hosted child"
sandbox_template = "poc-child-v1"
`
  await writeFile(configPath, config, { mode: 0o600 })
  await writeFile(trustedRolesPath, `${JSON.stringify(createTrustedRoles(provenance.templateId), null, 2)}\n`, { mode: 0o600 })
  return { configPath, trustedRolesPath }
}

export async function validateGeneratedCodexConfiguration(
  provenance: PocProvenance, paths: PocRunPaths, caBundlePath: string, hostedBearer: string,
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', CODEX_HOME: paths.codexHome,
    CODEX_CA_CERTIFICATE: caBundlePath, CODEX_HOSTED_AGENT_TOKEN: hostedBearer,
  }
  const child = spawn(provenance.binaryPath, ['app-server', '--listen', 'stdio://', '--strict-config'], {
    cwd: paths.repositoryRoot, env: environment, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const errors: Buffer[] = []
  child.stderr.on('data', chunk => {
    if (Buffer.concat(errors).byteLength < 64 * 1024) errors.push(Buffer.from(chunk))
  })
  const exited = new Promise<number | null>(resolveExit => child.once('exit', resolveExit))
  const result = await Promise.race([exited.then(code => ({ exited: true as const, code })),
    new Promise<{ exited: false }>(resolveWait => { const timer = scheduleTimeout(() => resolveWait({ exited: false }), 500); timer.unref() })])
  if (result.exited) {
    const detail = Buffer.concat(errors).toString('utf8').split(hostedBearer).join('[REDACTED]').trim().slice(0, 4096)
    throw new Error(`generated Codex configuration failed strict validation (exit ${result.code ?? 'signal'})${detail ? `: ${detail}` : ''}`)
  }
  child.kill('SIGTERM')
  const code = await Promise.race([exited, new Promise<undefined>(resolveWait => { const timer = scheduleTimeout(() => resolveWait(undefined), 3_000); timer.unref() })])
  if (code === undefined) { child.kill('SIGKILL'); await exited }
}
