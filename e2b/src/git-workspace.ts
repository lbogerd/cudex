import { execa } from 'execa'
import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captureArchiveManifest, defaultArchiveManifestLimits, type ArchiveManifestLimits,
  type CapturedArchiveManifest } from './archive-manifest.js'
import type { WorkspaceArchive } from './ingress.js'
import { loadCommandOsEnv } from './config/command-env.js'

const exec = execa
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface GitWorkspaceProjection extends WorkspaceArchive {
  localDirectory: string
  files: string[]
  captured: CapturedArchiveManifest
}

function below(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function nulPaths(bytes: Buffer, label: string): string[] {
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0) throw new Error(`${label} returned a non-NUL-delimited result`)
  const result: string[] = []
  let start = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue
    const value = decoder.decode(bytes.subarray(start, index)); start = index + 1
    if (!value || value.includes('\0')) throw new Error(`${label} returned an invalid path`)
    result.push(value)
  }
  return result
}

async function gitBytes(directory: string, args: string[]): Promise<Buffer> {
  try {
    const result = await exec('git', ['-C', directory, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    return Buffer.from(result.stdout)
  } catch { throw new Error('Git workspace inspection failed') }
}

async function validateRepository(directory: string): Promise<void> {
  // TODO(internal-release, PILOT-005): The pilot requires a Git worktree because selection and
  // three-way safety use Git semantics. Replace this with a specified safe non-Git workspace model.
  const inside = (await gitBytes(directory, ['rev-parse', '--is-inside-work-tree'])).toString('utf8').trim()
  if (inside !== 'true') throw new Error('Cudex requires a Git working tree')
  const stage = nulPaths(await gitBytes(directory, ['ls-files', '--stage', '-z', '--']), 'git ls-files --stage')
  // TODO(internal-release, PILOT-007): The pilot rejects submodules and nested repositories because
  // recursive trust and credentials are undefined. Replace this with reviewed recursive behavior.
  if (stage.some(record => record.startsWith('160000 '))) throw new Error('Cudex does not support submodules')
  const directories = nulPaths(await gitBytes(directory,
    ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z', '--']),
  'git untracked directory inspection')
  for (const candidate of directories) {
    if (!candidate.endsWith('/')) continue
    const nestedGit = join(directory, candidate, '.git')
    if (await lstat(nestedGit).catch(() => undefined)) throw new Error('Cudex does not support nested repositories')
  }
  const special = nulPaths(Buffer.from((await exec('find', [directory, '-path', join(directory, '.git'), '-prune', '-o',
    '!', '-type', 'd', '!', '-type', 'f', '!', '-type', 'l', '-print0'],
  { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout), 'special-file inspection')
  for (const absolute of special) {
    const candidate = relative(directory, absolute)
    try { await exec('git', ['-C', directory, 'check-ignore', '-q', '--', candidate]) }
    catch { throw new Error('workspace contains an unsupported special file') }
  }
}

function validateRelativePath(path: string): void {
  if (isAbsolute(path) || path === '.' || path === '..' || path.startsWith(`..${sep}`)
    || normalize(path) !== path || path.split(sep).includes('.git')) {
    throw new Error('Git returned an unsafe workspace path')
  }
}

function mode(metadata: Stats): number {
  return metadata.mode & 0o777
}

async function copyEntry(source: string, destination: string, root: string): Promise<number> {
  const before = await lstat(source).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!before) return 0 // A deleted tracked file is represented by its absence from the projection.
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
  if (before.isSymbolicLink()) {
    const target = await readlink(source)
    if (target.includes('\0') || isAbsolute(target) || normalize(target).split(sep).includes('.git')
      || !below(resolve(dirname(source), normalize(target)), root)) {
      throw new Error('workspace contains an unsafe symbolic link')
    }
    await symlink(target, destination)
  } else if (before.isFile()) {
    const bytes = await readFile(source)
    const afterRead = await lstat(source)
    if (afterRead.ino !== before.ino || afterRead.size !== before.size || afterRead.mtimeMs !== before.mtimeMs) {
      throw new Error('workspace changed while it was being projected')
    }
    await writeFile(destination, bytes, { mode: mode(before), flag: 'wx' }); await chmod(destination, mode(before))
  } else {
    throw new Error('workspace contains an unsupported special file')
  }
  const after = await lstat(source)
  if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || after.mode !== before.mode) throw new Error('workspace changed while it was being projected')
  return before.isFile() ? before.size : 0
}

function limitsValid(limits: ArchiveManifestLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid Git workspace limit: ${name}`)
  }
}

export async function projectGitWorkspace(selectedDirectory: string,
  limits: ArchiveManifestLimits = defaultArchiveManifestLimits): Promise<GitWorkspaceProjection> {
  limitsValid(limits)
  const requested = resolve(selectedDirectory)
  const requestedMetadata = await lstat(requested).catch(() => undefined)
  if (!requestedMetadata?.isDirectory() || requestedMetadata.isSymbolicLink()) throw new Error('selected workspace is not a safe directory')
  const localDirectory = await realpath(requested)
  await validateRepository(localDirectory)
  // TODO(internal-release, PILOT-008): The pilot uses Git's tracked-plus-non-ignored selection and
  // excludes ignored untracked files. Replace this with an explicit reviewable ignored-file policy.
  const listed = nulPaths(await gitBytes(localDirectory,
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--']), 'git ls-files')
  for (const path of listed) validateRelativePath(path)
  const files = [...new Set(listed)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (files.length > limits.maxFiles) throw new Error('workspace file quota exceeded')
  const temporary = await mkdtemp(join(tmpdir(), 'cudex-git-workspace-'))
  const projectName = basename(localDirectory) || 'project'
  const stage = join(temporary, 'stage'); const projectedRoot = join(stage, 'roots', '0', projectName)
  let expandedBytes = 0
  try {
    await mkdir(projectedRoot, { recursive: true, mode: mode(requestedMetadata) })
    for (const path of files) {
      const source = join(localDirectory, path); const destination = join(projectedRoot, path)
      if (!below(source, localDirectory) || !below(destination, projectedRoot)) throw new Error('workspace path escaped its root')
      expandedBytes += await copyEntry(source, destination, localDirectory)
      if (expandedBytes > limits.maxTotalBytes) throw new Error('workspace expanded-byte quota exceeded')
    }
    const archivePath = join(temporary, 'workspace.tar')
    await exec('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '--format=pax', '--pax-option=delete=atime,delete=ctime', '-cf', archivePath, '-C', stage, 'roots'],
    { extendEnv: false, env: { PATH: loadCommandOsEnv().path, LC_ALL: 'C' } })
    const archiveMetadata = await stat(archivePath)
    if (archiveMetadata.size > limits.maxArchiveBytes) throw new Error('workspace archive quota exceeded')
    const bytes = new Uint8Array(await readFile(archivePath))
    const captured = await captureArchiveManifest(bytes, 'cudex-local-base', {
      async put(body) { return (await import('node:crypto')).createHash('sha256').update(body).digest('hex') },
      async get() { throw new Error('projection object store is write-only') }, async delete() {},
      location(id) { return { storageBucket: 'projection', storageKey: id } },
    }, limits)
    const sandboxRoot = `/workspace/roots/0/${projectName}`
    return { bytes, cwd: pathToFileURL(sandboxRoot).href, roots: [pathToFileURL(sandboxRoot).href],
      sizeBytes: archiveMetadata.size, transferStartedAt: Date.now(), localDirectory, files, captured }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
