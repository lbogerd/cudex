import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { resolveCudexPaths } from '../src/cudex-config.js'
import { dispatchCudexCommand } from '../src/cudex-runner.js'

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
