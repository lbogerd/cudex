import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { archiveWorkspace, type IngressLimits } from '../src/ingress.js'

const run = promisify(execFile)
const generous: IngressLimits = {
  maxBytes: 10_000_000,
  maxRoots: 4,
  maxExpandedBytes: 10_000_000,
  maxEntries: 100,
  maxFileBytes: 1_000_000,
  maxPathDepth: 16,
  maxExtractionRatio: 4,
}

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cudex-ingress-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('ingress preserves roots, cwd, binary bytes, modes, and safe symlinks', async t => {
  const allowed = await directory(t)
  const first = join(allowed, 'first')
  const second = join(allowed, 'second')
  await mkdir(first); await mkdir(join(second, 'nested'), { recursive: true })
  await writeFile(join(first, 'binary'), Buffer.from([0, 255, 1, 2]))
  await chmod(join(first, 'binary'), 0o755)
  await symlink('binary', join(first, 'link'))
  await writeFile(join(second, 'nested', 'dirty.txt'), 'untracked state')

  const archive = await archiveWorkspace(
    pathToFileURL(join(second, 'nested')).href,
    [pathToFileURL(first).href, pathToFileURL(second).href],
    [allowed],
    generous,
  )
  assert.deepEqual(archive.roots, [
    'file:///workspace/roots/0/first',
    'file:///workspace/roots/1/second',
  ])
  assert.equal(archive.cwd, 'file:///workspace/roots/1/second/nested')

  const extracted = join(allowed, 'extracted'); await mkdir(extracted)
  const tarPath = join(allowed, 'workspace.tar'); await writeFile(tarPath, archive.bytes)
  await run('tar', ['-xf', tarPath, '-C', extracted])
  const binary = join(extracted, 'roots', '0', 'first', 'binary')
  assert.deepEqual(await readFile(binary), Buffer.from([0, 255, 1, 2]))
  assert.equal((await lstat(binary)).mode & 0o777, 0o755)
  assert.equal(await readlink(join(extracted, 'roots', '0', 'first', 'link')), 'binary')
})

test('ingress rejects duplicate, overlapping, and symlink roots', async t => {
  const allowed = await directory(t)
  const root = join(allowed, 'root'); const nested = join(root, 'nested')
  await mkdir(nested, { recursive: true })
  const uri = pathToFileURL(root).href
  await assert.rejects(archiveWorkspace(uri, [uri, uri], [allowed], generous), /roots must be unique/)
  await assert.rejects(archiveWorkspace(uri, [uri, pathToFileURL(nested).href], [allowed], generous), /must not overlap/)
  const rootLink = join(allowed, 'root-link'); await symlink('root', rootLink)
  await assert.rejects(archiveWorkspace(pathToFileURL(rootLink).href, [pathToFileURL(rootLink).href], [allowed], generous), /root must be a directory/)
})

test('ingress rejects escaping links and special files', async t => {
  const allowed = await directory(t)
  const root = join(allowed, 'root'); await mkdir(root)
  await symlink('../../outside', join(root, 'escape'))
  await assert.rejects(archiveWorkspace(pathToFileURL(root).href, [pathToFileURL(root).href], [allowed], generous), /escaping symbolic link/)
  await rm(join(root, 'escape'))

  const fifo = join(root, 'pipe'); await run('mkfifo', [fifo])
  await assert.rejects(archiveWorkspace(pathToFileURL(root).href, [pathToFileURL(root).href], [allowed], generous), /unsupported special file/)
})

test('ingress enforces file, expanded-byte, entry, and path-depth quotas', async t => {
  const allowed = await directory(t)
  const root = join(allowed, 'root'); await mkdir(root)
  await writeFile(join(root, 'large'), Buffer.alloc(32))
  const uri = pathToFileURL(root).href
  await assert.rejects(archiveWorkspace(uri, [uri], [allowed], { ...generous, maxFileBytes: 16 }), /file quota/)
  await assert.rejects(archiveWorkspace(uri, [uri], [allowed], { ...generous, maxExpandedBytes: 16 }), /expanded-byte quota/)
  await assert.rejects(archiveWorkspace(uri, [uri], [allowed], { ...generous, maxEntries: 1 }), /entry quota/)

  await mkdir(join(root, 'one', 'two'), { recursive: true })
  await assert.rejects(archiveWorkspace(uri, [uri], [allowed], { ...generous, maxPathDepth: 1 }), /path depth quota/)
})
