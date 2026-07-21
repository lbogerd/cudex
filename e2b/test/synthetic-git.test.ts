import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { validateWorkspaceArchive } from '../src/archive-manifest.js'
import { projectGitWorkspace } from '../src/git-workspace.js'
import { exportWorkspaceArchive, uploadWorkspaceArchive, type WorkspaceTransferSandbox } from '../src/workspace-transfer.js'

const exec = promisify(execFile)

class LocalSandbox implements WorkspaceTransferSandbox {
  readonly files = {
    write: async (path: string, data: ArrayBuffer) => writeFile(path, new Uint8Array(data)),
    read: async (path: string) => new Uint8Array(await readFile(path)),
  }
  readonly commands = {
    run: async (command: string) => {
      try { await exec('/bin/bash', ['-c', command]); return { exitCode: 0 } }
      catch { return { exitCode: 1 } }
    },
  }
}

test('git-working-set upload creates one synthetic baseline and export filters ignored output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-synthetic-')); const source = join(directory, 'project')
  await exec('git', ['init', '-q', source]); await exec('git', ['-C', source, 'config', 'user.email', 'test@invalid'])
  await exec('git', ['-C', source, 'config', 'user.name', 'Test'])
  await writeFile(join(source, '.gitignore'), 'generated/\n'); await writeFile(join(source, 'change'), 'before')
  await writeFile(join(source, 'delete'), 'delete'); await exec('git', ['-C', source, 'add', '.'])
  await exec('git', ['-C', source, 'commit', '-qm', 'real history'])
  const projection = await projectGitWorkspace(source)
  const workspace = join(directory, 'workspace'); const temporary = join(directory, 'temporary')
  await mkdir(workspace); await mkdir(temporary)
  const options = { workspaceDirectory: workspace, temporaryDirectory: temporary,
    owner: `${process.getuid!()}:${process.getgid!()}`, workspaceMode: 'git-working-set' as const }
  await uploadWorkspaceArchive(new LocalSandbox(), projection.bytes, { ...options, id: () => 'a'.repeat(32) })
  const hosted = join(workspace, 'roots', '0', 'project')
  assert.equal((await lstat(join(hosted, '.git'))).isFile(), true)
  assert.equal((await exec('git', ['-C', hosted, 'rev-list', '--count', 'HEAD'])).stdout.trim(), '1')
  assert.equal((await exec('git', ['-C', hosted, 'status', '--porcelain=v1'])).stdout, '')

  await writeFile(join(hosted, 'change'), 'after'); await chmod(join(hosted, 'change'), 0o755)
  await rm(join(hosted, 'delete')); await writeFile(join(hosted, 'added'), 'new')
  await mkdir(join(hosted, 'generated')); await writeFile(join(hosted, 'generated', 'ignored'), 'noise')
  const exported = await exportWorkspaceArchive(new LocalSandbox(), { ...options, id: () => 'b'.repeat(32) })
  const captured = await validateWorkspaceArchive(exported)
  const entries = new Map(captured.manifest.entries.map(entry => [entry.path, entry]))
  assert.equal(entries.get('roots/0/project/change')?.mode, 0o755)
  assert.equal(entries.has('roots/0/project/added'), true)
  assert.equal(entries.has('roots/0/project/delete'), false)
  assert.equal(entries.has('roots/0/project/generated/ignored'), false)
  assert.equal(entries.has('roots/0/project/.git'), false)
})
