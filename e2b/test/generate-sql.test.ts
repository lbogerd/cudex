import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { assertGeneratedCurrent, generateSql } from '../src/commands/generate-sql.js'

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL

async function schemaExists(pool: Pool, schema: string): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])
  return result.rowCount === 1
}

test('SQL checking is deterministic and drops its temporary schema on success', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  let schema = ''
  await generateSql(true, databaseUrl!, { afterMigrate(value) { schema = value } })
  assert.match(schema, /^pgtyped_[0-9a-f]{24}$/)
  const pool = new Pool({ connectionString: databaseUrl })
  try { assert.equal(await schemaExists(pool, schema), false) } finally { await pool.end() }
})

test('SQL generation drops its schema on failure without exposing credentials', {
  skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set',
}, async () => {
  let schema = ''
  const marker = new Error('injected generation failure')
  await assert.rejects(generateSql(true, databaseUrl!, { afterMigrate(value) {
    schema = value
    throw marker
  } }), error => error === marker && !String(error).includes(databaseUrl!))
  const pool = new Pool({ connectionString: databaseUrl })
  try { assert.equal(await schemaExists(pool, schema), false) } finally { await pool.end() }
})

test('SQL checking detects changed, missing, and unexpected generated output by bytes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'cudex-sql-check-test-'))
  const expected = resolve(root, 'expected'); const actual = resolve(root, 'actual')
  try {
    await mkdir(expected); await mkdir(actual)
    await writeFile(resolve(expected, 'one.queries.ts'), 'expected\n')
    await writeFile(resolve(actual, 'one.queries.ts'), 'changed\n')
    await writeFile(resolve(actual, 'extra.queries.ts'), 'extra\n')
    await assert.rejects(assertGeneratedCurrent(expected, actual),
      /extra\.queries\.ts, one\.queries\.ts/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
