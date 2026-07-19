import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { PocEnvironment } from './poc-env.js'

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
