import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, lstat, mkdir, mkdtemp, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const e2bRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('installer writes an isolated runnable CLI under temporary HOME without copying secrets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cudex-install-home-'))
  const shared = join(home, 'shared'); await mkdir(shared)
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: resolve(e2bRoot, '..') })).stdout.trim()
  const codex = Buffer.from('#!/bin/sh\nexit 0\n'); const host = Buffer.from('#!/bin/sh\nexit 0\n# host\n')
  await writeFile(join(shared, 'codex'), codex); await chmod(join(shared, 'codex'), 0o755)
  await writeFile(join(shared, 'codex-code-mode-host'), host); await chmod(join(shared, 'codex-code-mode-host'), 0o755)
  const codexSha256 = createHash('sha256').update(codex).digest('hex')
  const codeModeHostSha256 = createHash('sha256').update(host).digest('hex')
  const template = { templateId: 'tpl-install', revision: 'b'.repeat(40), codexSha256, codeModeHostSha256,
    cpuMillicores: 2000, memoryMb: 2048 }
  const templateBytes = Buffer.from(`${JSON.stringify(template)}\n`); await writeFile(join(shared, 'template.json'), templateBytes)
  const manifest = { version: 1, releaseId: 'install-test', cudexRevision: revision, codexRevision: template.revision,
    platform: 'linux-x86_64', minimumNodeVersion: '22.0.0', binaries: {
      codex: { sizeBytes: codex.byteLength, sha256: codexSha256 },
      'codex-code-mode-host': { sizeBytes: host.byteLength, sha256: codeModeHostSha256 } },
    template: { sizeBytes: templateBytes.byteLength, sha256: createHash('sha256').update(templateBytes).digest('hex'),
      templateId: template.templateId }, cpuMillicores: 2000, memoryMb: 2048, createdAt: '2026-07-20T00:00:00Z' }
  const release = join(shared, 'release.json'); await writeFile(release, `${JSON.stringify(manifest)}\n`)
  const data = join(home, 'data'); const binary = join(home, 'bin'); const npmCache = join(home, 'npm-cache')
  const result = await exec(join(e2bRoot, 'scripts', 'install-cudex.sh'), ['--release', release], {
    cwd: resolve(e2bRoot, '..'), timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: data, XDG_BIN_HOME: binary,
      npm_config_cache: npmCache },
  })
  assert.match(result.stdout, /Installed cudex/)
  const launcher = join(binary, 'cudex'); assert.ok((await lstat(launcher)).isSymbolicLink())
  const target = resolve(dirname(launcher), await readlink(launcher)); await access(target)
  const current = join(data, 'cudex', 'cli', 'current')
  await access(join(current, 'dist', 'src', 'cudex-cli.js'))
  await access(join(current, 'node_modules'))
  await assert.rejects(access(join(current, 'poc', '.env')))
  await assert.rejects(access(join(current, 'poc', 'secrets', 'auth.json')))
})
