import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const sourceRoot = resolve(import.meta.dirname, '../../src')
const approved = new Set(['migrate.ts', 'commands/generate-sql.ts', 'db/primitives.ts'])

async function typescriptFiles(directory: string, prefix = ''): Promise<Array<{ name: string; path: string }>> {
  const result: Array<{ name: string; path: string }> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await typescriptFiles(path, name))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.queries.ts')) result.push({ name, path })
  }
  return result
}

test('production raw SQL is confined to migrations, generation, and database primitives', async () => {
  const offenders: string[] = []
  for (const file of await typescriptFiles(sourceRoot)) {
    const source = await readFile(file.path, 'utf8')
    if (/\.query\s*(?:<[^;]+>)?\s*\(/u.test(source) && !approved.has(file.name)) {
      offenders.push(file.name)
    }
  }
  assert.deepEqual(offenders, [])
})
