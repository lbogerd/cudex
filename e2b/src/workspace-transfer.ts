import { randomUUID } from 'node:crypto'

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

export async function uploadWorkspaceArchive(
  sandbox: WorkspaceTransferSandbox,
  archiveBytes: Uint8Array,
  options: WorkspaceTransferOptions = {},
): Promise<void> {
  const paths = transferPaths(options)
  const owner = options.owner ?? '1000:1000'
  if (!/^\d+:\d+$/u.test(owner)) throw new Error('invalid workspace owner')
  const cleanup = cleanupScript(paths)
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
    await sandbox.files.write(paths.archive, copy.buffer)
    const result = await sandbox.commands.run(script, { user: 'root' })
    if (result.exitCode !== 0) throw new Error('workspace materialization failed')
  } catch {
    throw new Error('workspace materialization failed')
  } finally {
    await sandbox.commands.run(cleanup, { user: 'root' }).catch(() => undefined)
  }
}

export async function exportWorkspaceArchive(
  sandbox: WorkspaceTransferSandbox,
  options: WorkspaceTransferOptions = {},
): Promise<Uint8Array> {
  const paths = transferPaths(options)
  const cleanup = cleanupScript(paths)
  try {
    const result = await sandbox.commands.run(
      `tar -cf ${shell(paths.archive)} -C ${shell(paths.workspace)} roots`, { user: 'root' })
    if (result.exitCode !== 0) throw new Error('workspace capture failed')
    const bytes = await sandbox.files.read(paths.archive, { format: 'bytes' })
    if (!(bytes instanceof Uint8Array)) throw new Error('workspace capture failed')
    return Uint8Array.from(bytes)
  } catch {
    throw new Error('workspace capture failed')
  } finally {
    await sandbox.commands.run(cleanup, { user: 'root' }).catch(() => undefined)
  }
}
