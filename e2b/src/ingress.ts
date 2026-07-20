import { execa } from 'execa'
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ServiceError } from './types.js'

const run = execa
export interface WorkspaceArchive { bytes: Uint8Array; cwd: string; roots: string[]; sizeBytes: number; transferStartedAt: number }
export interface IngressLimits {
  maxBytes: number
  maxRoots: number
  maxExpandedBytes?: number
  maxEntries?: number
  maxFileBytes?: number
  maxPathDepth?: number
  maxExtractionRatio?: number
}

interface ExpandedWorkspace { entries: number; bytes: number }

function below(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function canonicalFileUri(uri: string): string {
  let parsed: URL
  try { parsed = new URL(uri) } catch { throw new ServiceError(400, 'workspace path must be a canonical file URI') }
  if (parsed.protocol !== 'file:' || parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ServiceError(400, 'workspace path must be a canonical local file URI')
  }
  let path: string
  try { path = fileURLToPath(parsed) } catch { throw new ServiceError(400, 'workspace path must be a canonical local file URI') }
  if (!isAbsolute(path) || pathToFileURL(path).href !== parsed.href) throw new ServiceError(400, 'workspace path must be canonical')
  return path
}

async function inspectRoot(root: string, limits: Required<Omit<IngressLimits, 'maxRoots' | 'maxBytes'>>): Promise<ExpandedWorkspace> {
  let entries = 0
  let bytes = 0
  const visit = async (path: string): Promise<void> => {
    const relativePath = relative(root, path)
    const depth = relativePath === '' ? 0 : relativePath.split(sep).length
    if (depth > limits.maxPathDepth) throw new ServiceError(429, 'workspace path depth quota exceeded')
    const metadata = await lstat(path)
    entries++
    if (entries > limits.maxEntries) throw new ServiceError(429, 'workspace entry quota exceeded')
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path)
      if (target.includes('\0') || isAbsolute(target)) throw new ServiceError(400, 'workspace contains an unsafe symbolic link')
      const resolvedTarget = resolve(dirname(path), normalize(target))
      if (!below(resolvedTarget, root)) throw new ServiceError(400, 'workspace contains an escaping symbolic link')
      return
    }
    if (metadata.isFile()) {
      if (metadata.size > limits.maxFileBytes) throw new ServiceError(429, 'workspace file quota exceeded')
      bytes += metadata.size
      if (bytes > limits.maxExpandedBytes) throw new ServiceError(429, 'workspace expanded-byte quota exceeded')
      return
    }
    if (!metadata.isDirectory()) throw new ServiceError(400, 'workspace contains an unsupported special file')
    for (const entry of await readdir(path)) await visit(resolve(path, entry))
  }
  await visit(root)
  return { entries, bytes }
}

export async function archiveWorkspace(
  cwdUri: string,
  rootUris: string[],
  allowedRoots: string[],
  limits: IngressLimits,
): Promise<WorkspaceArchive> {
  if (!Number.isSafeInteger(limits.maxRoots) || limits.maxRoots <= 0 || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
    throw new Error('invalid ingress limits')
  }
  if (rootUris.length === 0 || rootUris.length > limits.maxRoots) throw new ServiceError(429, 'workspace root quota exceeded')
  const requestedRoots = rootUris.map(canonicalFileUri)
  const requestedCwd = canonicalFileUri(cwdUri)
  if (new Set(requestedRoots).size !== requestedRoots.length) throw new ServiceError(400, 'workspace roots must be unique')
  for (const [index, root] of requestedRoots.entries()) {
    if (requestedRoots.some((candidate, candidateIndex) => candidateIndex !== index && (below(root, candidate) || below(candidate, root)))) {
      throw new ServiceError(400, 'workspace roots must not overlap')
    }
  }
  const allowlist = await Promise.all(allowedRoots.map(root => realpath(resolve(root))))
  const roots: string[] = []
  for (const requested of requestedRoots) {
    const metadata = await lstat(requested).catch(() => { throw new ServiceError(400, 'workspace root is unavailable') })
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ServiceError(400, 'workspace root must be a directory')
    roots.push(await realpath(requested))
  }
  const cwd = await realpath(requestedCwd).catch(() => { throw new ServiceError(400, 'workspace cwd is unavailable') })
  if (roots.some(root => !allowlist.some(allowed => below(root, allowed))) || !roots.some(root => below(cwd, root))) {
    throw new ServiceError(403, 'workspace path is outside the ingress allowlist')
  }
  const expandedLimits = {
    maxExpandedBytes: limits.maxExpandedBytes ?? limits.maxBytes,
    maxEntries: limits.maxEntries ?? 100_000,
    maxFileBytes: limits.maxFileBytes ?? limits.maxBytes,
    maxPathDepth: limits.maxPathDepth ?? 64,
    maxExtractionRatio: limits.maxExtractionRatio ?? 4,
  }
  for (const [name, value] of Object.entries(expandedLimits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ingress limit: ${name}`)
  }
  let expandedBytes = 0
  let expandedEntries = 0
  for (const root of roots) {
    const inspected = await inspectRoot(root, expandedLimits)
    expandedBytes += inspected.bytes
    expandedEntries += inspected.entries
    if (expandedBytes > expandedLimits.maxExpandedBytes) throw new ServiceError(429, 'workspace expanded-byte quota exceeded')
    if (expandedEntries > expandedLimits.maxEntries) throw new ServiceError(429, 'workspace entry quota exceeded')
  }
  const temporary = await mkdtemp(`${tmpdir()}/cudex-ingress-`)
  try {
    const staging = `${temporary}/stage`; await mkdir(`${staging}/roots`, { recursive: true })
    const sandboxRoots: string[] = []
    for (const [index, root] of roots.entries()) {
      const name = basename(root) || 'root'; const destination = `${staging}/roots/${index}/${name}`
      await mkdir(dirname(destination), { recursive: true })
      await run('cp', ['-a', '--reflink=auto', '--', root, destination])
      sandboxRoots.push(`/workspace/roots/${index}/${name}`)
    }
    const containing = roots.findIndex(root => below(cwd, root))
    const sandboxCwd = resolve(sandboxRoots[containing]!, relative(roots[containing]!, cwd))
    const archivePath = `${temporary}/workspace.tar`
    await run('tar', ['-cf', archivePath, '-C', staging, 'roots'])
    const archiveStat = await stat(archivePath)
    if (archiveStat.size > limits.maxBytes) throw new ServiceError(429, 'workspace archive quota exceeded')
    if (expandedBytes / Math.max(archiveStat.size, 1) > expandedLimits.maxExtractionRatio) throw new ServiceError(429, 'workspace extraction-ratio quota exceeded')
    return {
      bytes: await readFile(archivePath), cwd: pathToFileURL(sandboxCwd).href,
      roots: sandboxRoots.map(root => pathToFileURL(root).href), sizeBytes: archiveStat.size,
      transferStartedAt: Date.now(),
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
