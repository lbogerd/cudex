import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { projectGitWorkspace } from '../src/git-workspace.js'

const exec = promisify(execFile)

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cudex-git-project-'))
  await exec('git', ['init', '-q', root]); await exec('git', ['-C', root, 'config', 'user.email', 'test@invalid'])
  await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
  return root
}

test('Git projection deterministically preserves tracked and non-ignored files with hostile valid names', async () => {
  const root = await repository()
  await writeFile(join(root, '.gitignore'), 'ignored*\ntracked-ignored\n')
  await writeFile(join(root, 'tracked.txt'), 'tracked\n'); await writeFile(join(root, 'tracked-ignored'), 'kept because tracked\n')
  await writeFile(join(root, 'deleted.txt'), 'delete locally\n'); await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'run.sh'), '#!/bin/sh\n'); await chmod(join(root, 'src', 'run.sh'), 0o755)
  await exec('git', ['-C', root, 'add', '-f', '.']); await exec('git', ['-C', root, 'commit', '-qm', 'base'])
  await import('node:fs/promises').then(fs => fs.rm(join(root, 'deleted.txt')))
  const names = ['space name', 'unicodé-雪', 'line\nbreak', '-leading-dash']
  for (const name of names) await writeFile(join(root, name), `value:${name}`)
  await writeFile(join(root, 'binary.bin'), Uint8Array.from([0, 255, 1, 2]))
  await symlink('tracked.txt', join(root, 'safe-link')); await writeFile(join(root, 'ignored-secret'), 'excluded')

  const first = await projectGitWorkspace(root); const second = await projectGitWorkspace(root)
  assert.deepEqual(first.bytes, second.bytes)
  assert.deepEqual(first.files, [...first.files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
  for (const name of [...names, 'binary.bin', 'safe-link', 'tracked.txt', 'tracked-ignored']) assert.ok(first.files.includes(name))
  assert.ok(!first.files.includes('ignored-secret'))
  const paths = new Map(first.captured.manifest.entries.map(entry => [entry.path, entry]))
  const prefix = `roots/0/${root.split('/').at(-1)}`
  assert.equal(paths.get(`${prefix}/src/run.sh`)?.mode, 0o755)
  assert.equal(paths.get(`${prefix}/safe-link`)?.type, 'symlink')
  assert.equal(paths.has(`${prefix}/deleted.txt`), false)
  const binary = paths.get(`${prefix}/binary.bin`); assert.equal(binary?.type, 'file')
  assert.deepEqual(await readFile(join(root, 'binary.bin')), Buffer.from([0, 255, 1, 2]))
})

test('selected subdirectory remains the sole projected root', async () => {
  const root = await repository(); await mkdir(join(root, 'packages', 'one'), { recursive: true })
  await writeFile(join(root, 'outside'), 'outside'); await writeFile(join(root, 'packages', 'one', 'inside'), 'inside')
  await exec('git', ['-C', root, 'add', '.']); await exec('git', ['-C', root, 'commit', '-qm', 'base'])
  const projection = await projectGitWorkspace(join(root, 'packages', 'one'))
  assert.deepEqual(projection.files, ['inside'])
  assert.match(projection.cwd, /\/workspace\/roots\/0\/one$/u)
})

test('Git projection rejects submodules, nested repositories, special files, and unsafe symlinks', async () => {
  const withSubmodule = await repository(); const child = await repository(); await writeFile(join(child, 'value'), 'x')
  await exec('git', ['-C', child, 'add', '.']); await exec('git', ['-C', child, 'commit', '-qm', 'child'])
  await exec('git', ['-C', withSubmodule, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'child'])
  await assert.rejects(projectGitWorkspace(withSubmodule), /submodules/)

  const nested = await repository(); await mkdir(join(nested, 'nested')); await exec('git', ['init', '-q', join(nested, 'nested')])
  await assert.rejects(projectGitWorkspace(nested), /nested repositories/)

  const special = await repository(); await exec('mkfifo', [join(special, 'pipe')])
  await assert.rejects(projectGitWorkspace(special), /special file/)

  const unsafe = await repository(); await symlink('../outside', join(unsafe, 'link'))
  await assert.rejects(projectGitWorkspace(unsafe), /unsafe symbolic link/)

  const gitLink = await repository(); await symlink('.git/config', join(gitLink, 'link'))
  await assert.rejects(projectGitWorkspace(gitLink), /unsafe symbolic link/)
})
