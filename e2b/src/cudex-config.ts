import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface CudexPaths {
  home: string
  configDirectory: string
  dataDirectory: string
  stateDirectory: string
  runtimeDirectory: string
  configFile: string
  credentialsFile: string
  releasesDirectory: string
  runsDirectory: string
  lockFile: string
  currentRunFile: string
  isolatedCodexHome: string
}

export interface CudexConfig {
  version: 1
  releaseId: string
  releaseDirectory: string
  apiUrl: string
  domain: string
  validateApiKey: boolean
  providerCaCertificate?: string
  controlPort: number
  postgresPort: number
  garagePort: number
}

export interface CudexCredentials {
  version: 1
  e2bApiKey: string
}

type Environment = Record<string, string | undefined>

function absoluteEnvironmentPath(value: string | undefined, fallback: string, label: string): string {
  const selected = value?.trim() || fallback
  if (!isAbsolute(selected)) throw new Error(`${label} must be an absolute path`)
  return resolve(selected)
}

export function resolveCudexPaths(environment: Environment = process.env, suppliedHome?: string): CudexPaths {
  const home = absoluteEnvironmentPath(suppliedHome ?? environment.HOME, homedir(), 'HOME')
  const configRoot = absoluteEnvironmentPath(environment.XDG_CONFIG_HOME, join(home, '.config'), 'XDG_CONFIG_HOME')
  const dataRoot = absoluteEnvironmentPath(environment.XDG_DATA_HOME, join(home, '.local', 'share'), 'XDG_DATA_HOME')
  const stateRoot = absoluteEnvironmentPath(environment.XDG_STATE_HOME, join(home, '.local', 'state'), 'XDG_STATE_HOME')
  const runtimeRoot = absoluteEnvironmentPath(environment.XDG_RUNTIME_DIR, join(stateRoot, 'runtime'), 'XDG_RUNTIME_DIR')
  const configDirectory = join(configRoot, 'cudex')
  const dataDirectory = join(dataRoot, 'cudex')
  const stateDirectory = join(stateRoot, 'cudex')
  const runtimeDirectory = join(runtimeRoot, 'cudex')
  return {
    home, configDirectory, dataDirectory, stateDirectory, runtimeDirectory,
    configFile: join(configDirectory, 'config.json'), credentialsFile: join(configDirectory, 'credentials.json'),
    releasesDirectory: join(dataDirectory, 'releases'), runsDirectory: join(stateDirectory, 'runs'),
    lockFile: join(runtimeDirectory, 'run.lock'), currentRunFile: join(stateDirectory, 'current.json'),
    isolatedCodexHome: join(dataDirectory, 'codex-home'),
  }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`)
  }
}

function safeString(value: unknown, label: string, pattern: RegExp, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > max || !pattern.test(value)) {
    throw new Error(`Cudex configuration has invalid ${label}`)
  }
  return value
}

function port(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`Cudex configuration has invalid ${label}`)
  }
  return Number(value)
}

export function validateCudexConfig(value: unknown): CudexConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cudex configuration is invalid')
  const record = value as Record<string, unknown>
  const optionalCa = record.providerCaCertificate !== undefined
  exactKeys(record, ['version', 'releaseId', 'releaseDirectory', 'apiUrl', 'domain', 'validateApiKey',
    'controlPort', 'postgresPort', 'garagePort', ...(optionalCa ? ['providerCaCertificate'] : [])], 'Cudex configuration')
  if (record.version !== 1) throw new Error('Cudex configuration version is unsupported')
  const apiUrlText = safeString(record.apiUrl, 'API URL', /^https:\/\/[^\s]+$/u)
  const apiUrl = new URL(apiUrlText)
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) throw new Error('Cudex configuration has invalid API URL')
  const ports = {
    controlPort: port(record.controlPort, 'control port'), postgresPort: port(record.postgresPort, 'PostgreSQL port'),
    garagePort: port(record.garagePort, 'Garage port'),
  }
  if (new Set(Object.values(ports)).size !== 3) throw new Error('Cudex local ports must be distinct')
  if (typeof record.validateApiKey !== 'boolean') throw new Error('Cudex configuration has invalid API-key policy')
  const releaseDirectory = safeString(record.releaseDirectory, 'release directory', /^\//u)
  if (!isAbsolute(releaseDirectory)) throw new Error('Cudex configuration has invalid release directory')
  return {
    version: 1,
    releaseId: safeString(record.releaseId, 'release ID', /^[A-Za-z0-9._-]{1,128}$/u),
    releaseDirectory: resolve(releaseDirectory), apiUrl: apiUrl.href.replace(/\/$/u, ''),
    domain: safeString(record.domain, 'sandbox domain', /^(?=.{1,253}$)[A-Za-z0-9.-]+$/u),
    validateApiKey: record.validateApiKey, ...ports,
    ...(optionalCa ? { providerCaCertificate: resolve(safeString(record.providerCaCertificate,
      'provider CA certificate', /^\//u)) } : {}),
  }
}

export function validateCudexCredentials(value: unknown): CudexCredentials {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cudex credentials are invalid')
  const record = value as Record<string, unknown>
  exactKeys(record, ['version', 'e2bApiKey'], 'Cudex credentials')
  if (record.version !== 1) throw new Error('Cudex credentials version is unsupported')
  return { version: 1, e2bApiKey: safeString(record.e2bApiKey, 'API key', /^[^\s\u0000-\u001f\u007f]{1,4096}$/u) }
}

async function readOwnerFile(path: string, label: string): Promise<string> {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is missing or unsafe: ${path}`)
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0600: ${path}`)
  if (metadata.size > 64 * 1024) throw new Error(`${label} is too large`)
  return readFile(path, 'utf8')
}

export async function loadCudexConfig(paths: CudexPaths): Promise<CudexConfig> {
  let parsed: unknown
  try { parsed = JSON.parse(await readOwnerFile(paths.configFile, 'Cudex configuration')) }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Cudex configuration is not valid JSON')
    throw error
  }
  return validateCudexConfig(parsed)
}

export async function loadCudexCredentials(paths: CudexPaths): Promise<CudexCredentials> {
  let parsed: unknown
  try { parsed = JSON.parse(await readOwnerFile(paths.credentialsFile, 'Cudex credentials')) }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Cudex credentials are not valid JSON')
    throw error
  }
  return validateCudexCredentials(parsed)
}

async function atomicOwnerJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

export async function saveCudexSetup(paths: CudexPaths, config: CudexConfig,
  credentials: CudexCredentials): Promise<void> {
  await atomicOwnerJson(paths.configFile, validateCudexConfig(config))
  await atomicOwnerJson(paths.credentialsFile, validateCudexCredentials(credentials))
}

export function createPilotConfig(input: {
  releaseId: string
  releaseDirectory: string
  apiUrl: string
  domain?: string
  validateApiKey?: boolean
  providerCaCertificate?: string
  controlPort?: number
  postgresPort?: number
  garagePort?: number
}): CudexConfig {
  // TODO(internal-release, PILOT-015): The pilot uses configurable but fixed default local ports because
  // every user has one serialized run. Replace this with collision-free allocation and durable discovery.
  return validateCudexConfig({ version: 1, releaseId: input.releaseId, releaseDirectory: input.releaseDirectory,
    apiUrl: input.apiUrl, domain: input.domain ?? 'cube.app', validateApiKey: input.validateApiKey ?? true,
    controlPort: input.controlPort ?? 18_443, postgresPort: input.postgresPort ?? 15_432,
    garagePort: input.garagePort ?? 13_900,
    ...(input.providerCaCertificate ? { providerCaCertificate: input.providerCaCertificate } : {}) })
}
