import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ServiceError } from './types.js'

const run = promisify(execFile)
export interface WorkspaceArchive { bytes: Uint8Array; cwd: string; roots: string[]; sizeBytes: number; transferStartedAt: number }
export interface IngressLimits { maxBytes: number; maxRoots: number }

function below(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

export async function archiveWorkspace(
  cwdUri: string,
  rootUris: string[],
  allowedRoots: string[],
  limits: IngressLimits,
): Promise<WorkspaceArchive> {
  if (rootUris.length === 0 || rootUris.length > limits.maxRoots) throw new ServiceError(429, 'workspace root quota exceeded')
  const roots = rootUris.map(uri => resolve(fileURLToPath(uri)))
  const cwd = resolve(fileURLToPath(cwdUri))
  const allowlist = allowedRoots.map(root => resolve(root))
  if (roots.some(root => !allowlist.some(allowed => below(root, allowed))) || !roots.some(root => below(cwd, root))) {
    throw new ServiceError(403, 'workspace path is outside the ingress allowlist')
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
    await run('tar', ['-cf', archivePath, '-C', staging, '.'])
    const archiveStat = await stat(archivePath)
    if (archiveStat.size > limits.maxBytes) throw new ServiceError(429, 'workspace archive quota exceeded')
    return {
      bytes: await readFile(archivePath), cwd: pathToFileURL(sandboxCwd).href,
      roots: sandboxRoots.map(root => pathToFileURL(root).href), sizeBytes: archiveStat.size,
      transferStartedAt: Date.now(),
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
