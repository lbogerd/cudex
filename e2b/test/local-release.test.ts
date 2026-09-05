import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { packageLocalRelease } from '../src/local-release.js'
import { validateCachedRelease } from '../src/cudex-release.js'

test('local packaging validates executable provenance and produces an idempotent installer bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cudex-local-release-'))
  try {
    const buildId = 'test-build'
    const artifacts = join(root, 'e2b', '.artifacts', 'codex', buildId)
    await mkdir(artifacts, { recursive: true })
    const binary = Buffer.alloc(64)
    binary.write('\x7fELF'); binary[4] = 2; binary[5] = 1; binary.writeUInt16LE(0x3e, 18)
    for (const name of ['codex', 'codex-code-mode-host']) {
      await writeFile(join(artifacts, name), binary)
      await chmod(join(artifacts, name), 0o755)
    }
    const sha = createHash('sha256').update(binary).digest('hex')
    const templatePath = join(root, 'template.json')
    const template = { buildId, revision: 'a'.repeat(40), templateId: 'tpl-test',
      codexSha256: sha, codeModeHostSha256: sha, cpuMillicores: 2000, memoryMb: 2000 }
    await writeFile(templatePath, JSON.stringify(template))
    const path = await packageLocalRelease(root, templatePath, 'b'.repeat(40), template)
    const manifest = await validateCachedRelease(join(path, '..'))
    assert.equal(manifest.codexRevision, 'a'.repeat(40))
    assert.equal(manifest.cudexRevision, 'b'.repeat(40))
    assert.equal(await packageLocalRelease(root, templatePath, 'b'.repeat(40), template), path)
    await assert.rejects(packageLocalRelease(root, templatePath, 'b'.repeat(40),
      { ...template, buildId: 'wrong' }), /selected build/)
    const serialized = await readFile(path, 'utf8')
    assert.ok(!serialized.includes('API_KEY'))
    await writeFile(templatePath, JSON.stringify({ ...template, templateId: 'changed' }))
    await assert.rejects(packageLocalRelease(root, templatePath, 'b'.repeat(40), template), /does not match/)
    await writeFile(join(artifacts, 'codex'), 'tampered')
    await assert.rejects(packageLocalRelease(root, templatePath, 'c'.repeat(40), template), /bounded|binary|checksum/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
