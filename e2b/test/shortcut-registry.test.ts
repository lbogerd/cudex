import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const idPattern = /PILOT-\d{3}/gu
const commentPattern = /TODO\(internal-release, (PILOT-\d{3})\)/gu

function tableIds(source: string, columns: number): string[] {
  return source.split('\n')
    .filter(line => line.startsWith('| PILOT-'))
    .map(line => {
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
      assert.equal(cells.length, columns, `pilot registry row has ${cells.length} columns: ${line}`)
      assert.match(cells[0]!, /^PILOT-\d{3}$/u)
      return cells[0]!
    })
}

function unique(ids: readonly string[], label: string): void {
  assert.equal(new Set(ids).size, ids.length, `${label} contains duplicate shortcut IDs`)
}

test('pilot shortcut registries and active code comments stay consistent', async () => {
  const [readme, todo, archive, tracked] = await Promise.all([
    readFile(resolve(repositoryRoot, 'README.md'), 'utf8'),
    readFile(resolve(repositoryRoot, 'TODO.md'), 'utf8'),
    readFile(resolve(repositoryRoot, 'ARCHIVE.md'), 'utf8'),
    exec('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'buffer' }),
  ])
  const readmeIds = tableIds(readme, 4)
  const todoIds = tableIds(todo, 5)
  unique(readmeIds, 'README registry')
  unique(todoIds, 'TODO registry')

  const openIds = todo.split('\n')
    .filter(line => line.startsWith('| PILOT-') && line.endsWith('| open |'))
    .map(line => line.split('|')[1]!.trim())
  assert.deepEqual([...readmeIds].sort(), [...openIds].sort(), 'every open shortcut must appear in README')

  const fileNames = tracked.stdout.toString('utf8').split('\0').filter(Boolean)
    .filter(path => /\.(?:ts|mts|cts|js|mjs|cjs|sh)$/u.test(path))
  const activeIds: string[] = []
  for (const path of fileNames) {
    const source = await readFile(resolve(repositoryRoot, path), 'utf8')
    activeIds.push(...Array.from(source.matchAll(commentPattern), match => match[1]!))
  }
  const todoSet = new Set(todoIds)
  for (const id of activeIds) assert.ok(todoSet.has(id), `${id} code comment is missing from TODO.md`)
  unique(activeIds, 'active pilot code comments')
  assert.deepEqual([...activeIds].sort(), [...openIds].sort(),
    'every open shortcut must have one exact active code comment')

  const completedIds = todo.split('\n')
    .filter(line => line.startsWith('| PILOT-') && line.endsWith('| completed |'))
    .map(line => line.split('|')[1]!.trim())
  for (const id of completedIds) {
    assert.ok(!activeIds.includes(id), `${id} is completed but remains in active code comments`)
    assert.match(archive, new RegExp(`\\b${id}\\b`, 'u'), `${id} completion is missing from ARCHIVE.md`)
  }

  assert.ok(Array.from(todo.matchAll(idPattern)).length >= todoIds.length)
})
