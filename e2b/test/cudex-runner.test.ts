import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { resolveCudexPaths } from '../src/cudex-config.js'
import { cudexSessionExitCode, dispatchCudexCommand, launchTui, RunSignals,
  type PreparedCudexRun } from '../src/cudex-runner.js'

const exec = promisify(execFile)

test('status and cleanup are idempotent before any run exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cudex-runner-home-')); const paths = resolveCudexPaths({ HOME: home })
  await mkdir(paths.runtimeDirectory, { recursive: true }); await writeFile(paths.lockFile, 'stale')
  const lines: string[] = []; const original = console.log; console.log = value => { lines.push(String(value)) }
  try {
    assert.equal(await dispatchCudexCommand({ command: 'status' }, paths), 0)
    assert.equal(await dispatchCudexCommand({ command: 'cleanup' }, paths), 0)
  } finally { console.log = original }
  assert.deepEqual(lines.map(line => JSON.parse(line).active), [false, false])
  await assert.rejects(access(paths.lockFile))
})

test('files dispatch uses the canonical Git projection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cudex-runner-files-')); const project = join(home, 'project')
  await exec('git', ['init', '-q', project]); await writeFile(join(project, 'tracked'), 'value')
  await exec('git', ['-C', project, 'add', 'tracked'])
  const output: string[] = []; const original = console.log; console.log = value => { output.push(String(value)) }
  try {
    assert.equal(await dispatchCudexCommand({ command: 'files', directory: project }, resolveCudexPaths({ HOME: home })), 0)
  } finally { console.log = original }
  assert.deepEqual(JSON.parse(output[0]!).files, ['tracked'])
})

async function fakeTui(directory: string): Promise<PreparedCudexRun> {
  const codexHome = join(directory, 'codex-home'); await mkdir(codexHome)
  const binary = join(directory, 'codex')
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path')
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'args.json'), JSON.stringify(process.argv.slice(2)))
const prompt = process.argv.at(-1)
if (prompt === 'wait' || prompt === 'ignore') {
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'ready'), 'ready')
  process.on('SIGTERM', () => { if (prompt === 'wait') process.exit(0) })
  setInterval(() => {}, 1000)
}
`, { mode: 0o755 }); await chmod(binary, 0o755)
  return { provenance: { binaryPath: binary }, projection: { localDirectory: directory },
    paths: { codexHome }, tls: { combinedCaBundlePath: join(directory, 'ca.pem') },
    runtime: { POC_SERVICE_BEARER: 'fake-hosted-bearer' } } as unknown as PreparedCudexRun
}

async function ready(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await access(path).then(() => true).catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('fake TUI did not become ready')
}

test('TUI launcher forwards only the pilot argument surface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-fake-tui-'))
  try {
    const run = await fakeTui(directory); const signals = new RunSignals()
    const result = await launchTui(run, { command: 'session', directory, model: 'model-test', prompt: 'do work' }, signals)
    assert.deepEqual(result, { exitCode: 0 })
    assert.deepEqual(JSON.parse(await readFile(join(run.paths.codexHome, 'args.json'), 'utf8')),
      ['--strict-config', '-C', directory, '-a', 'never', '--model', 'model-test', 'do work'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('TUI signals are forwarded and an ignoring child is killed after the grace period', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-fake-tui-signal-'))
  try {
    const run = await fakeTui(directory)
    const forwarded = new RunSignals(); const waiting = launchTui(run,
      { command: 'session', directory, prompt: 'wait' }, forwarded, 100)
    await ready(join(run.paths.codexHome, 'ready')); forwarded.request('SIGTERM')
    assert.deepEqual(await waiting, { exitCode: 0, signal: 'SIGTERM' })

    await rm(join(run.paths.codexHome, 'ready'), { force: true })
    const ignored = new RunSignals(); const hanging = launchTui(run,
      { command: 'session', directory, prompt: 'ignore' }, ignored, 25)
    await ready(join(run.paths.codexHome, 'ready')); ignored.request('SIGTERM')
    assert.deepEqual(await hanging, { exitCode: null, signal: 'SIGTERM' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('session exit precedence keeps manual recovery and conflicts distinct from ordinary failures', () => {
  const base = { cleanupComplete: true, ownershipCleared: true, resultCode: 0,
    operationalFailure: false, reportFailure: false, tuiExitCode: 0 }
  assert.equal(cudexSessionExitCode(base), 0)
  assert.equal(cudexSessionExitCode({ ...base, resultCode: 1 }), 1)
  assert.equal(cudexSessionExitCode({ ...base, resultCode: 4 }), 4)
  assert.equal(cudexSessionExitCode({ ...base, signal: 'SIGINT' }), 130)
  assert.equal(cudexSessionExitCode({ ...base, signal: 'SIGTERM' }), 143)
  assert.equal(cudexSessionExitCode({ ...base, signal: 'SIGINT', resultCode: 3 }), 3)
  assert.equal(cudexSessionExitCode({ ...base, cleanupComplete: false, signal: 'SIGTERM' }), 3)
  assert.equal(cudexSessionExitCode({ ...base, ownershipCleared: false }), 3)
  assert.equal(cudexSessionExitCode({ ...base, operationalFailure: true }), 1)
  assert.equal(cudexSessionExitCode({ ...base, reportFailure: true }), 1)
  assert.equal(cudexSessionExitCode({ ...base, tuiExitCode: 7 }), 1)
})
