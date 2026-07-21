import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveCudexPaths } from '../src/cudex-config.js'
import { installSharedRelease, loadReleaseManifest, validateCachedRelease, validateReleaseManifest,
  validateReleasePlatform } from '../src/cudex-release.js'

async function releaseFixture(): Promise<{ directory: string; manifestPath: string; manifest: Record<string, unknown> }> {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-release-'))
  const codex = Buffer.from('#!/bin/sh\nexit 0\n'); const host = Buffer.from('#!/bin/sh\nexit 0\n# host\n')
  await writeFile(join(directory, 'codex'), codex); await chmod(join(directory, 'codex'), 0o755)
  await writeFile(join(directory, 'codex-code-mode-host'), host); await chmod(join(directory, 'codex-code-mode-host'), 0o755)
  const template = { templateId: 'tpl-pilot', revision: 'b'.repeat(40),
    codexSha256: createHash('sha256').update(codex).digest('hex'),
    codeModeHostSha256: createHash('sha256').update(host).digest('hex'), cpuMillicores: 2000, memoryMb: 2048 }
  const templateBytes = Buffer.from(`${JSON.stringify(template)}\n`); await writeFile(join(directory, 'template.json'), templateBytes)
  const manifest = { version: 1, releaseId: 'pilot-1', cudexRevision: 'a'.repeat(40), codexRevision: 'b'.repeat(40),
    platform: 'linux-x86_64', minimumNodeVersion: '22.0.0', binaries: {
      codex: { sizeBytes: codex.byteLength, sha256: template.codexSha256 },
      'codex-code-mode-host': { sizeBytes: host.byteLength, sha256: template.codeModeHostSha256 } },
    template: { sizeBytes: templateBytes.byteLength, sha256: createHash('sha256').update(templateBytes).digest('hex'),
      templateId: template.templateId }, cpuMillicores: 2000, memoryMb: 2048, createdAt: '2026-07-20T00:00:00Z' }
  const manifestPath = join(directory, 'release.json'); await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  return { directory, manifestPath, manifest }
}

test('shared release installs atomically and validates every declared byte and mode', async () => {
  const fixture = await releaseFixture(); const home = await mkdtemp(join(tmpdir(), 'cudex-release-home-'))
  const paths = resolveCudexPaths({ HOME: home })
  const first = await installSharedRelease(fixture.manifestPath, paths)
  assert.equal(first.manifest.releaseId, 'pilot-1')
  assert.deepEqual(await validateCachedRelease(first.directory), first.manifest)
  assert.equal((await stat(join(first.directory, 'codex'))).mode & 0o777, 0o755)
  assert.equal((await stat(join(first.directory, 'release.json'))).mode & 0o777, 0o600)
  const second = await installSharedRelease(fixture.manifestPath, paths)
  assert.equal(second.directory, first.directory)
})

test('release validation rejects revisions, checksums, sizes, symlinks, and platform mismatch', async () => {
  const fixture = await releaseFixture()
  for (const mutation of [
    (value: any) => { value.codexRevision = 'wrong' },
    (value: any) => { value.binaries.codex.sha256 = 'bad' },
    (value: any) => { value.template.sizeBytes = 0 },
    (value: any) => { value.extra = true },
  ]) {
    const value = structuredClone(fixture.manifest); mutation(value)
    assert.throws(() => validateReleaseManifest(value), /release manifest/)
  }
  const linked = join(fixture.directory, 'linked-release.json'); await symlink(fixture.manifestPath, linked)
  await assert.rejects(loadReleaseManifest(linked), /unsafe/)
  assert.throws(() => validateReleasePlatform(validateReleaseManifest(fixture.manifest), 'darwin', 'x64', '22.0.0'), /Linux/)
  await writeFile(join(fixture.directory, 'codex'), 'changed')
  await assert.rejects(validateCachedRelease(fixture.directory), /codex failed/)
  assert.ok((await readFile(fixture.manifestPath)).byteLength > 0)
})
