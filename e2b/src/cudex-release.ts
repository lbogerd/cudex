import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { CudexPaths } from './cudex-config.js'

export interface ReleaseFile {
  sizeBytes: number
  sha256: string
}

export interface CudexReleaseManifest {
  version: 1
  releaseId: string
  cudexRevision: string
  codexRevision: string
  platform: 'linux-x86_64'
  minimumNodeVersion: string
  binaries: { codex: ReleaseFile; 'codex-code-mode-host': ReleaseFile }
  template: ReleaseFile & { templateId: string }
  cpuMillicores: number
  memoryMb: number
  createdAt: string
}

const digest = /^[0-9a-f]{64}$/u

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort(); const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`)
  }
}

function text(value: unknown, label: string, pattern: RegExp, max = 256): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || !pattern.test(value)) {
    throw new Error(`release manifest has invalid ${label}`)
  }
  return value
}

function positive(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new Error(`release manifest has invalid ${label}`)
  }
  return Number(value)
}

function releaseFile(value: unknown, label: string): ReleaseFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`release manifest has invalid ${label}`)
  const record = value as Record<string, unknown>; exactKeys(record, ['sizeBytes', 'sha256'], label)
  return { sizeBytes: positive(record.sizeBytes, `${label} size`, 512 * 1024 * 1024),
    sha256: text(record.sha256, `${label} checksum`, digest, 64) }
}

export function validateReleaseManifest(value: unknown): CudexReleaseManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('release manifest is invalid')
  const record = value as Record<string, unknown>
  exactKeys(record, ['version', 'releaseId', 'cudexRevision', 'codexRevision', 'platform', 'minimumNodeVersion',
    'binaries', 'template', 'cpuMillicores', 'memoryMb', 'createdAt'], 'release manifest')
  if (record.version !== 1) throw new Error('release manifest version is unsupported')
  if (record.binaries === null || typeof record.binaries !== 'object' || Array.isArray(record.binaries)) {
    throw new Error('release manifest has invalid binaries')
  }
  const binaries = record.binaries as Record<string, unknown>
  exactKeys(binaries, ['codex', 'codex-code-mode-host'], 'release binaries')
  if (record.template === null || typeof record.template !== 'object' || Array.isArray(record.template)) {
    throw new Error('release manifest has invalid template')
  }
  const templateRecord = record.template as Record<string, unknown>
  exactKeys(templateRecord, ['sizeBytes', 'sha256', 'templateId'], 'release template')
  const createdAt = text(record.createdAt, 'creation time', /^\d{4}-\d{2}-\d{2}T[^\s]+Z$/u)
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('release manifest has invalid creation time')
  if (record.platform !== 'linux-x86_64') throw new Error('release manifest has unsupported platform')
  return {
    version: 1, releaseId: text(record.releaseId, 'release ID', /^[A-Za-z0-9._-]{1,128}$/u),
    cudexRevision: text(record.cudexRevision, 'Cudex revision', /^[0-9a-f]{40}$/u, 40),
    codexRevision: text(record.codexRevision, 'Codex revision', /^[0-9a-f]{40}$/u, 40),
    platform: 'linux-x86_64', minimumNodeVersion: text(record.minimumNodeVersion,
      'minimum Node version', /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
    binaries: { codex: releaseFile(binaries.codex, 'codex'),
      'codex-code-mode-host': releaseFile(binaries['codex-code-mode-host'], 'codex-code-mode-host') },
    template: { sizeBytes: positive(templateRecord.sizeBytes, 'template size', 1024 * 1024),
      sha256: text(templateRecord.sha256, 'template checksum', digest, 64),
      templateId: text(templateRecord.templateId, 'template ID', /^[A-Za-z0-9._-]{1,512}$/u, 512) },
    cpuMillicores: positive(record.cpuMillicores, 'CPU limit', 1_000_000),
    memoryMb: positive(record.memoryMb, 'memory limit', 1_000_000), createdAt,
  }
}

async function safeFile(path: string, label: string, maximum = 512 * 1024 * 1024) {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximum) {
    throw new Error(`${label} is missing, unsafe, or unbounded`)
  }
  return metadata
}

async function checksum(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export async function loadReleaseManifest(path: string): Promise<CudexReleaseManifest> {
  const metadata = await safeFile(path, 'release manifest', 64 * 1024)
  if (metadata.size > 64 * 1024) throw new Error('release manifest is too large')
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('release manifest is not valid JSON') }
  return validateReleaseManifest(parsed)
}

function nodeAtLeast(actual: string, minimum: string): boolean {
  const left = actual.split('.').map(Number); const right = minimum.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true
    if (left[index]! < right[index]!) return false
  }
  return true
}

export function validateReleasePlatform(manifest: CudexReleaseManifest,
  platform = process.platform, architecture = process.arch, nodeVersion = process.versions.node): void {
  // TODO(internal-release, PILOT-001): The pilot selects only Linux/x86_64 artifacts because all named
  // coworker machines match it. Replace this with a tested platform matrix and artifact selector.
  if (platform !== 'linux' || architecture !== 'x64' || manifest.platform !== 'linux-x86_64') {
    throw new Error('this Cudex pilot release requires Linux/x86_64')
  }
  if (!nodeAtLeast(nodeVersion, manifest.minimumNodeVersion)) {
    throw new Error(`this Cudex release requires Node.js ${manifest.minimumNodeVersion} or newer`)
  }
}

export async function validateCachedRelease(directory: string, expected?: CudexReleaseManifest): Promise<CudexReleaseManifest> {
  const manifest = await loadReleaseManifest(join(directory, 'release.json'))
  if (expected && JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error('cached release manifest does not match source')
  for (const name of ['codex', 'codex-code-mode-host'] as const) {
    const path = join(directory, name); const metadata = await safeFile(path, name)
    const declared = manifest.binaries[name]
    if (metadata.size !== declared.sizeBytes || await checksum(path) !== declared.sha256 || (metadata.mode & 0o111) === 0) {
      throw new Error(`${name} failed release validation`)
    }
  }
  const templatePath = join(directory, 'template.json'); const templateMetadata = await safeFile(templatePath, 'template metadata', 1024 * 1024)
  if (templateMetadata.size !== manifest.template.sizeBytes || await checksum(templatePath) !== manifest.template.sha256) {
    throw new Error('template metadata failed release validation')
  }
  const template = JSON.parse(await readFile(templatePath, 'utf8')) as Record<string, unknown>
  if (template.templateId !== manifest.template.templateId || template.revision !== manifest.codexRevision
    || template.codexSha256 !== manifest.binaries.codex.sha256
    || template.codeModeHostSha256 !== manifest.binaries['codex-code-mode-host'].sha256
    || template.cpuMillicores !== manifest.cpuMillicores || template.memoryMb !== manifest.memoryMb) {
    throw new Error('template metadata does not match release manifest')
  }
  validateReleasePlatform(manifest)
  return manifest
}

export async function installSharedRelease(manifestPath: string, paths: CudexPaths): Promise<{
  manifest: CudexReleaseManifest; directory: string }> {
  const sourceManifest = resolve(manifestPath)
  if (basename(sourceManifest) !== 'release.json') throw new Error('shared release path must name release.json')
  // TODO(internal-release, PILOT-002): The trusted shared filesystem is the unsigned pilot trust root
  // because access is limited to the coworker LAN. Replace it with signed authenticated distribution.
  const manifest = await loadReleaseManifest(sourceManifest)
  validateReleasePlatform(manifest)
  const sourceDirectory = dirname(sourceManifest)
  const destination = join(paths.releasesDirectory, manifest.releaseId)
  const existing = await lstat(destination).catch(() => undefined)
  if (existing) return { manifest: await validateCachedRelease(destination, manifest), directory: destination }
  await mkdir(paths.releasesDirectory, { recursive: true, mode: 0o700 }); await chmod(paths.releasesDirectory, 0o700)
  const temporary = join(paths.releasesDirectory, `.${manifest.releaseId}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  try {
    await mkdir(temporary, { mode: 0o700 })
    for (const name of ['release.json', 'codex', 'codex-code-mode-host', 'template.json'] as const) {
      const source = join(sourceDirectory, name)
      await safeFile(source, `shared release ${name}`, name.endsWith('.json') ? 1024 * 1024 : undefined)
      await copyFile(source, join(temporary, name), 1)
      await chmod(join(temporary, name), name.startsWith('codex') ? 0o755 : 0o600)
    }
    await validateCachedRelease(temporary, manifest)
    try { await rename(temporary, destination) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
    }
    return { manifest: await validateCachedRelease(destination, manifest), directory: destination }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
