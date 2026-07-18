import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { exportWorkspaceArchive, uploadWorkspaceArchive, type WorkspaceTransferSandbox } from '../src/workspace-transfer.js'

const execute = promisify(execFile)

class LocalSandbox implements WorkspaceTransferSandbox {
  private commandCount = 0
  writes = 0
  commandsRun = 0
  constructor(private readonly interruptFirstCommand?: () => Promise<void>) {}
  readonly files = {
    write: async (path: string, data: ArrayBuffer) => { this.writes += 1; await writeFile(path, new Uint8Array(data)) },
    read: async (path: string) => new Uint8Array(await readFile(path)),
  }
  readonly commands = {
    run: async (command: string) => {
      this.commandsRun += 1
      if (this.commandCount++ === 0 && this.interruptFirstCommand) {
        await this.interruptFirstCommand(); return { exitCode: 1 }
      }
      try { await execute('/bin/bash', ['-c', command]); return { exitCode: 0 } }
      catch { return { exitCode: 1 } }
    },
  }
}

async function archiveFixture(directory: string): Promise<Uint8Array> {
  const source = join(directory, 'source'); const roots = join(source, 'roots')
  await mkdir(join(roots, 'project'), { recursive: true })
  await writeFile(join(roots, 'project', 'binary'), Uint8Array.from([0, 255, 1, 2]))
  await writeFile(join(roots, 'project', 'executable'), '#!/bin/sh\n')
  await chmod(join(roots, 'project', 'executable'), 0o755)
  await symlink('binary', join(roots, 'project', 'link'))
  const archive = join(directory, 'fixture.tar')
  await execute('tar', ['-cf', archive, '-C', source, 'roots'])
  return new Uint8Array(await readFile(archive))
}

function options(directory: string, id: string) {
  return {
    workspaceDirectory: join(directory, 'workspace'), temporaryDirectory: join(directory, 'temporary'),
    owner: `${process.getuid!()}:${process.getgid!()}`, id: () => id,
  }
}

test('workspace upload replaces roots exactly and preserves Linux files, modes, and symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-transfer-'))
  const workspace = join(directory, 'workspace'); const temporary = join(directory, 'temporary')
  await mkdir(join(workspace, 'roots', 'old'), { recursive: true }); await mkdir(temporary)
  await writeFile(join(workspace, 'roots', 'old', 'stale'), 'stale')
  const transfer = options(directory, 'a'.repeat(32))
  await uploadWorkspaceArchive(new LocalSandbox(), await archiveFixture(directory), transfer)

  assert.deepEqual(await readFile(join(workspace, 'roots', 'project', 'binary')), Buffer.from([0, 255, 1, 2]))
  assert.equal((await lstat(join(workspace, 'roots', 'project', 'executable'))).mode & 0o777, 0o755)
  assert.equal(await readlink(join(workspace, 'roots', 'project', 'link')), 'binary')
  assert.deepEqual(await readdir(join(workspace, 'roots')), ['project'])
  assert.deepEqual((await readdir(workspace)).filter(name => name.startsWith('.cudex-')), [])
  assert.deepEqual(await readdir(temporary), [])
})

test('failed workspace upload preserves existing roots, cleans temporary state, and redacts errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-transfer-fail-'))
  const workspace = join(directory, 'workspace'); const temporary = join(directory, 'temporary')
  await mkdir(join(workspace, 'roots'), { recursive: true }); await mkdir(temporary)
  await writeFile(join(workspace, 'roots', 'existing'), 'preserved')
  const secret = new TextEncoder().encode('not a tar: secret-must-not-leak')
  const sandbox = new LocalSandbox()
  await assert.rejects(
    uploadWorkspaceArchive(sandbox, secret, options(directory, 'b'.repeat(32))),
    error => error instanceof Error && error.message === 'workspace materialization failed'
      && !error.message.includes('secret-must-not-leak'),
  )
  assert.equal(await readFile(join(workspace, 'roots', 'existing'), 'utf8'), 'preserved')
  assert.equal(sandbox.writes, 0); assert.equal(sandbox.commandsRun, 0)
  assert.deepEqual((await readdir(workspace)).filter(name => name.startsWith('.cudex-')), [])
  assert.deepEqual(await readdir(temporary), [])
})

test('fallback cleanup restores roots when a transfer stops after creating its backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-transfer-rollback-'))
  const workspace = join(directory, 'workspace'); const temporary = join(directory, 'temporary')
  const transferId = 'd'.repeat(32); const roots = join(workspace, 'roots')
  const backup = join(workspace, `.cudex-backup-${transferId}`)
  await mkdir(roots, { recursive: true }); await mkdir(temporary)
  await writeFile(join(roots, 'existing'), 'preserved')
  const sandbox = new LocalSandbox(async () => { await rename(roots, backup) })

  await assert.rejects(
    uploadWorkspaceArchive(sandbox, await archiveFixture(directory), options(directory, transferId)),
    /workspace materialization failed/,
  )
  assert.equal(await readFile(join(roots, 'existing'), 'utf8'), 'preserved')
  assert.deepEqual((await readdir(workspace)).filter(name => name.startsWith('.cudex-')), [])
  assert.deepEqual(await readdir(temporary), [])
})

test('workspace export returns an exact archive and unconditionally cleans its unique temporary path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-transfer-export-'))
  const workspace = join(directory, 'workspace'); const temporary = join(directory, 'temporary')
  await mkdir(join(workspace, 'roots'), { recursive: true }); await mkdir(temporary)
  await writeFile(join(workspace, 'roots', 'value'), 'captured')
  const bytes = await exportWorkspaceArchive(new LocalSandbox(), options(directory, 'c'.repeat(32)))
  const archive = join(directory, 'export.tar'); await writeFile(archive, bytes)
  const listing = await execute('tar', ['-tf', archive])
  assert.match(listing.stdout, /^roots\/?$/mu); assert.match(listing.stdout, /^roots\/value$/mu)
  assert.deepEqual(await readdir(temporary), [])
})
