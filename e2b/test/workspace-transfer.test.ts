import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { defaultArchiveManifestLimits } from '../src/archive-manifest.js'
import { archiveWorkspace } from '../src/ingress.js'
import {
  exportWorkspaceArchive,
  uploadWorkspaceArchive,
  type WorkspaceTransferMetric,
  type WorkspaceTransferSandbox,
} from '../src/workspace-transfer.js'

const execute = promisify(execFile)

class LocalSandbox implements WorkspaceTransferSandbox {
  private commandCount = 0
  writes = 0
  reads = 0
  commandsRun = 0
  constructor(private readonly interruptFirstCommand?: () => Promise<void>) {}
  readonly files = {
    write: async (path: string, data: ArrayBuffer) => { this.writes += 1; await writeFile(path, new Uint8Array(data)) },
    read: async (path: string) => { this.reads += 1; return new Uint8Array(await readFile(path)) },
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

async function archiveFixture(directory: string, rootCount = 1): Promise<Uint8Array> {
  const source = join(directory, 'source'); const roots = join(source, 'roots')
  await mkdir(join(roots, '0', 'project'), { recursive: true })
  await writeFile(join(roots, '0', 'project', 'binary'), Uint8Array.from([0, 255, 1, 2]))
  await writeFile(join(roots, '0', 'project', 'executable'), '#!/bin/sh\n')
  await chmod(join(roots, '0', 'project', 'executable'), 0o755)
  await symlink('binary', join(roots, '0', 'project', 'link'))
  for (let index = 1; index < rootCount; index += 1) {
    await mkdir(join(roots, String(index), `project-${index}`), { recursive: true })
  }
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

  assert.deepEqual(await readFile(join(workspace, 'roots', '0', 'project', 'binary')), Buffer.from([0, 255, 1, 2]))
  assert.equal((await lstat(join(workspace, 'roots', '0', 'project', 'executable'))).mode & 0o777, 0o755)
  assert.equal(await readlink(join(workspace, 'roots', '0', 'project', 'link')), 'binary')
  assert.deepEqual(await readdir(join(workspace, 'roots')), ['0'])
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
  const metrics: WorkspaceTransferMetric[] = []

  await assert.rejects(
    uploadWorkspaceArchive(sandbox, await archiveFixture(directory), {
      ...options(directory, transferId), observe: metric => metrics.push(metric),
    }),
    /workspace materialization failed/,
  )
  assert.equal(await readFile(join(roots, 'existing'), 'utf8'), 'preserved')
  assert.deepEqual((await readdir(workspace)).filter(name => name.startsWith('.cudex-')), [])
  assert.deepEqual(await readdir(temporary), [])
  assert.deepEqual(metrics.map(metric => [metric.phase, metric.success]), [
    ['validation', true], ['transfer', true], ['extraction', false], ['cleanup', true],
  ])
})

test('workspace export returns an exact archive and unconditionally cleans its unique temporary path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-transfer-export-'))
  const workspace = join(directory, 'workspace'); const temporary = join(directory, 'temporary')
  await mkdir(join(workspace, 'roots', '0', 'project'), { recursive: true }); await mkdir(temporary)
  await writeFile(join(workspace, 'roots', '0', 'project', 'value'), 'captured')
  const bytes = await exportWorkspaceArchive(new LocalSandbox(), options(directory, 'c'.repeat(32)))
  const archive = join(directory, 'export.tar'); await writeFile(archive, bytes)
  const listing = await execute('tar', ['-tf', archive])
  assert.match(listing.stdout, /^roots\/?$/mu); assert.match(listing.stdout, /^roots\/0\/project\/value$/mu)
  assert.deepEqual(await readdir(temporary), [])
})

test('workspace transfer emits bounded path-free phase metrics and ignores observer failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-transfer-metrics-secret-'))
  const workspace = join(directory, 'workspace'); const temporary = join(directory, 'temporary')
  await mkdir(workspace, { recursive: true }); await mkdir(temporary)
  const metrics: WorkspaceTransferMetric[] = []; let time = 0
  const metricOptions = {
    ...options(directory, 'e'.repeat(32)),
    now: () => time++,
    observe: (metric: WorkspaceTransferMetric) => { metrics.push(metric); throw new Error('observer unavailable') },
  }
  await uploadWorkspaceArchive(new LocalSandbox(), await archiveFixture(directory), metricOptions)
  await exportWorkspaceArchive(new LocalSandbox(), { ...metricOptions, id: () => 'f'.repeat(32) })

  assert.deepEqual(metrics.map(metric => `${metric.direction}:${metric.phase}`), [
    'upload:validation', 'upload:transfer', 'upload:extraction', 'upload:cleanup',
    'export:capture', 'export:transfer', 'export:validation', 'export:cleanup',
  ])
  for (const metric of metrics) {
    assert.deepEqual(Object.keys(metric).sort(), ['bytes', 'direction', 'durationMs', 'phase', 'success'])
    assert.equal(metric.durationMs, 1); assert.equal(metric.success, true)
    assert.ok(Number.isSafeInteger(metric.bytes) && metric.bytes >= 0)
  }
  const serialized = JSON.stringify(metrics)
  assert.equal(serialized.includes(directory), false)
  assert.equal(serialized.includes('e'.repeat(32)), false)
  assert.equal(serialized.includes('metrics-secret'), false)
})

test('workspace upload enforces configured archive and indexed-root limits before provider I/O', async () => {
  const archiveDirectory = await mkdtemp(join(tmpdir(), 'cudex-transfer-archive-limit-'))
  await mkdir(join(archiveDirectory, 'workspace')); await mkdir(join(archiveDirectory, 'temporary'))
  const archiveSandbox = new LocalSandbox(); const archiveMetrics: WorkspaceTransferMetric[] = []
  await assert.rejects(uploadWorkspaceArchive(
    archiveSandbox,
    await archiveFixture(archiveDirectory),
    {
      ...options(archiveDirectory, '1'.repeat(32)),
      archiveLimits: { ...defaultArchiveManifestLimits, maxArchiveBytes: 1 },
      observe: metric => archiveMetrics.push(metric),
    },
  ), /workspace materialization failed/)
  assert.equal(archiveSandbox.writes, 0); assert.equal(archiveSandbox.commandsRun, 0)
  assert.deepEqual(archiveMetrics.map(metric => [metric.phase, metric.success]), [['validation', false]])

  const rootDirectory = await mkdtemp(join(tmpdir(), 'cudex-transfer-root-limit-'))
  await mkdir(join(rootDirectory, 'workspace')); await mkdir(join(rootDirectory, 'temporary'))
  const rootSandbox = new LocalSandbox(); const rootMetrics: WorkspaceTransferMetric[] = []
  await assert.rejects(uploadWorkspaceArchive(
    rootSandbox,
    await archiveFixture(rootDirectory, 2),
    { ...options(rootDirectory, '2'.repeat(32)), maxRoots: 1, observe: metric => rootMetrics.push(metric) },
  ), /workspace materialization failed/)
  assert.equal(rootSandbox.writes, 0); assert.equal(rootSandbox.commandsRun, 0)
  assert.deepEqual(rootMetrics.map(metric => [metric.phase, metric.success]), [['validation', false]])
})

test('workspace export rejects an oversized remote archive before reading it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-transfer-export-limit-'))
  const workspace = join(directory, 'workspace'); const temporary = join(directory, 'temporary')
  await mkdir(join(workspace, 'roots', '0', 'project'), { recursive: true }); await mkdir(temporary)
  await writeFile(join(workspace, 'roots', '0', 'project', 'value'), 'captured')
  const sandbox = new LocalSandbox(); const metrics: WorkspaceTransferMetric[] = []
  await assert.rejects(exportWorkspaceArchive(sandbox, {
    ...options(directory, '3'.repeat(32)),
    archiveLimits: { ...defaultArchiveManifestLimits, maxArchiveBytes: 1 },
    observe: metric => metrics.push(metric),
  }), /workspace capture failed/)
  assert.equal(sandbox.reads, 0)
  assert.deepEqual(metrics.map(metric => [metric.phase, metric.success]), [['capture', false], ['cleanup', true]])
})

test('development ingress archives canonical indexed roots accepted by materialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-transfer-ingress-'))
  const source = join(directory, 'source', 'project'); const workspace = join(directory, 'workspace')
  const temporary = join(directory, 'temporary')
  await mkdir(source, { recursive: true }); await mkdir(workspace); await mkdir(temporary)
  await writeFile(join(source, 'value'), 'from ingress')
  const archived = await archiveWorkspace(
    pathToFileURL(source).href,
    [pathToFileURL(source).href],
    [directory],
    { maxBytes: 1024 * 1024, maxRoots: 1 },
  )
  await uploadWorkspaceArchive(new LocalSandbox(), archived.bytes, options(directory, '4'.repeat(32)))
  assert.equal(await readFile(join(workspace, 'roots', '0', 'project', 'value'), 'utf8'), 'from ingress')
})
