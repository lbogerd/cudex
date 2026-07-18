import { randomUUID } from 'node:crypto'
import {
  defaultArchiveManifestLimits,
  validateWorkspaceArchive,
  type ArchiveManifestLimits,
  type CapturedArchiveManifest,
} from './archive-manifest.js'

interface TransferFiles {
  write(path: string, data: ArrayBuffer): Promise<unknown>
  read(path: string, options: { format: 'bytes' }): Promise<Uint8Array>
}

interface TransferCommands {
  run(command: string, options: { user: string }): Promise<{ exitCode: number }>
}

export interface WorkspaceTransferSandbox {
  files: TransferFiles
  commands: TransferCommands
}

export interface WorkspaceTransferOptions {
  workspaceDirectory?: string
  temporaryDirectory?: string
  owner?: string
  id?: () => string
  archiveLimits?: ArchiveManifestLimits
  maxRoots?: number
  observe?: (metric: WorkspaceTransferMetric) => void
  now?: () => number
}

export type WorkspaceTransferDirection = 'upload' | 'export'
export type WorkspaceTransferPhase = 'validation' | 'transfer' | 'extraction' | 'capture' | 'cleanup'

export interface WorkspaceTransferMetric {
  direction: WorkspaceTransferDirection
  phase: WorkspaceTransferPhase
  durationMs: number
  bytes: number
  success: boolean
}

function shell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function path(directory: string, name: string): string {
  return `${directory.replace(/\/+$/u, '')}/${name}`
}

function transferPaths(options: WorkspaceTransferOptions) {
  const id = (options.id ?? (() => randomUUID().replaceAll('-', '')))()
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error('invalid workspace transfer ID')
  const workspace = options.workspaceDirectory ?? '/workspace'
  const temporary = options.temporaryDirectory ?? '/tmp'
  const archive = path(temporary, `cudex-workspace-${id}.tar`)
  return {
    archive,
    workspace,
    roots: path(workspace, 'roots'),
    stage: path(workspace, `.cudex-stage-${id}`),
    backup: path(workspace, `.cudex-backup-${id}`),
  }
}

function cleanupScript(paths: ReturnType<typeof transferPaths>): string {
  return `if [ -e ${shell(paths.backup)} ] && [ ! -e ${shell(paths.roots)} ]; then mv -- ${shell(paths.backup)} ${shell(paths.roots)} || true; fi
rm -f -- ${shell(paths.archive)}
rm -rf -- ${shell(paths.stage)}
if [ -e ${shell(paths.roots)} ]; then rm -rf -- ${shell(paths.backup)}; fi`
}

function boundedNumber(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

function clock(options: WorkspaceTransferOptions): number {
  try { return options.now?.() ?? Date.now() } catch { return 0 }
}

function observe(
  options: WorkspaceTransferOptions,
  direction: WorkspaceTransferDirection,
  phase: WorkspaceTransferPhase,
  startedAt: number,
  bytes: number,
  success: boolean,
): void {
  const metric: WorkspaceTransferMetric = {
    direction,
    phase,
    durationMs: boundedNumber(clock(options) - startedAt),
    bytes: boundedNumber(bytes),
    success,
  }
  try { options.observe?.(metric) } catch { /* telemetry must not affect workspace state */ }
}

async function measured<T>(
  options: WorkspaceTransferOptions,
  direction: WorkspaceTransferDirection,
  phase: WorkspaceTransferPhase,
  bytes: number | ((result: T) => number),
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = clock(options)
  try {
    const result = await operation()
    observe(options, direction, phase, startedAt, typeof bytes === 'function' ? bytes(result) : bytes, true)
    return result
  } catch (error) {
    observe(options, direction, phase, startedAt, typeof bytes === 'number' ? bytes : 0, false)
    throw error
  }
}

function validateIndexedRoots(captured: CapturedArchiveManifest, maxRoots: number): void {
  if (!Number.isSafeInteger(maxRoots) || maxRoots <= 0 || maxRoots > 64) throw new Error('invalid workspace root limit')
  const entries = new Map(captured.manifest.entries.map(entry => [entry.path, entry]))
  const indices = new Set<number>()
  for (const entry of captured.manifest.entries) {
    if (entry.path === 'roots') continue
    const match = /^roots\/(0|[1-9]\d*)(?:\/|$)/u.exec(entry.path)
    if (!match) throw new Error('invalid workspace root layout')
    const index = Number(match[1])
    if (index >= maxRoots) throw new Error('workspace root limit exceeded')
    indices.add(index)
  }
  if (indices.size === 0) throw new Error('workspace archive has no roots')
  for (let index = 0; index < indices.size; index += 1) {
    if (!indices.has(index) || entries.get(`roots/${index}`)?.type !== 'directory') {
      throw new Error('invalid workspace root layout')
    }
  }
}

async function cleanupTransfer(
  sandbox: WorkspaceTransferSandbox,
  cleanup: string,
  direction: WorkspaceTransferDirection,
  options: WorkspaceTransferOptions,
): Promise<void> {
  const startedAt = clock(options)
  let success = false
  try { success = (await sandbox.commands.run(cleanup, { user: 'root' })).exitCode === 0 } catch {}
  observe(options, direction, 'cleanup', startedAt, 0, success)
}

export async function uploadWorkspaceArchive(
  sandbox: WorkspaceTransferSandbox,
  archiveBytes: Uint8Array,
  options: WorkspaceTransferOptions = {},
): Promise<void> {
  const paths = transferPaths(options)
  const owner = options.owner ?? '1000:1000'
  if (!/^\d+:\d+$/u.test(owner)) throw new Error('invalid workspace owner')
  const cleanup = cleanupScript(paths)
  try {
    await measured(options, 'upload', 'validation', archiveBytes.byteLength, async () => {
      const captured = await validateWorkspaceArchive(archiveBytes, options.archiveLimits)
      validateIndexedRoots(captured, options.maxRoots ?? 8)
    })
  }
  catch { throw new Error('workspace materialization failed') }
  const script = `set -eu
archive=${shell(paths.archive)}
workspace=${shell(paths.workspace)}
roots=${shell(paths.roots)}
stage=${shell(paths.stage)}
backup=${shell(paths.backup)}
cleanup() {
  status=$?
  trap - EXIT
  if [ -e "$backup" ] && [ ! -e "$roots" ]; then mv -- "$backup" "$roots" || true; fi
  rm -f -- "$archive"
  rm -rf -- "$stage"
  if [ -e "$roots" ]; then rm -rf -- "$backup"; fi
  exit "$status"
}
trap cleanup EXIT
mkdir -p -- "$workspace" "$stage"
tar -xf "$archive" -C "$stage"
test -d "$stage/roots"
chown -hR ${owner} "$stage/roots"
if [ -e "$roots" ] || [ -L "$roots" ]; then mv -- "$roots" "$backup"; fi
mv -- "$stage/roots" "$roots"
rm -rf -- "$backup"`
  try {
    const copy = Uint8Array.from(archiveBytes)
    await measured(options, 'upload', 'transfer', archiveBytes.byteLength,
      () => sandbox.files.write(paths.archive, copy.buffer))
    await measured(options, 'upload', 'extraction', archiveBytes.byteLength, async () => {
      const result = await sandbox.commands.run(script, { user: 'root' })
      if (result.exitCode !== 0) throw new Error('workspace materialization failed')
    })
  } catch {
    throw new Error('workspace materialization failed')
  } finally {
    await cleanupTransfer(sandbox, cleanup, 'upload', options)
  }
}

export async function exportWorkspaceArchive(
  sandbox: WorkspaceTransferSandbox,
  options: WorkspaceTransferOptions = {},
): Promise<Uint8Array> {
  const paths = transferPaths(options)
  const cleanup = cleanupScript(paths)
  const maxArchiveBytes = options.archiveLimits?.maxArchiveBytes ?? defaultArchiveManifestLimits.maxArchiveBytes
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes <= 0) throw new Error('invalid workspace archive limit')
  try {
    await measured(options, 'export', 'capture', 0, async () => {
      const result = await sandbox.commands.run(
        `umask 077
tar -cf ${shell(paths.archive)} -C ${shell(paths.workspace)} roots
size=$(stat -c %s -- ${shell(paths.archive)})
test "$size" -le ${maxArchiveBytes}`, { user: 'root' })
      if (result.exitCode !== 0) throw new Error('workspace capture failed')
    })
    const bytes = await measured(options, 'export', 'transfer',
      result => result instanceof Uint8Array ? result.byteLength : 0,
      async () => {
        const result = await sandbox.files.read(paths.archive, { format: 'bytes' })
        if (!(result instanceof Uint8Array) || result.byteLength > maxArchiveBytes) throw new Error('workspace capture failed')
        return result
      })
    await measured(options, 'export', 'validation', bytes.byteLength, async () => {
      const captured = await validateWorkspaceArchive(bytes, options.archiveLimits)
      validateIndexedRoots(captured, options.maxRoots ?? 8)
    })
    return Uint8Array.from(bytes)
  } catch {
    throw new Error('workspace capture failed')
  } finally {
    await cleanupTransfer(sandbox, cleanup, 'export', options)
  }
}
