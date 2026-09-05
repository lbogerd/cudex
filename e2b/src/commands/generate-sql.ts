import { randomBytes } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { Pool } from 'pg'
import { loadSqlGenerationEnv } from '../config/command-env.js'
import { runMigrations } from '../migrate.js'

const here = dirname(fileURLToPath(import.meta.url))
// Commands run from dist/src/commands; assets and committed output remain in the package root.
const packageRoot = resolve(here, '../../..')
const sourceQueries = resolve(packageRoot, 'src/db/queries')
const committedConfig = resolve(packageRoot, 'pgtyped.config.json')

async function generatedFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name.endsWith('.queries.ts')) files.set(relative(root, path), await readFile(path))
    }
  }
  await visit(root)
  return files
}

async function normalizeGeneratedFiles(root: string): Promise<void> {
  for (const [name, contents] of await generatedFiles(root)) {
    const normalized = contents.toString('utf8').replace(/\n+$/u, '\n')
    if (!contents.equals(Buffer.from(normalized))) await writeFile(resolve(root, name), normalized)
  }
}

export async function assertGeneratedCurrent(expectedRoot: string, actualRoot: string): Promise<void> {
  const [expected, actual] = await Promise.all([generatedFiles(expectedRoot), generatedFiles(actualRoot)])
  const names = new Set([...expected.keys(), ...actual.keys()])
  const stale = [...names].filter(name => !expected.get(name)?.equals(actual.get(name) ?? Buffer.alloc(0)))
  if (stale.length > 0) throw new Error(`PgTyped output is stale: ${stale.sort().join(', ')}`)
}

function isolatedConnection(databaseUrl: string, database: string): string {
  const value = new URL(databaseUrl)
  value.pathname = `/${database}`
  value.searchParams.delete('options')
  return value.toString()
}

export async function generateSql(
  check: boolean,
  databaseUrl: string,
  hooks: { afterMigrate?(database: string): Promise<void> | void } = {},
): Promise<void> {
  const database = `pgtyped_${randomBytes(12).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl })
  let temporaryRoot: string | undefined
  try {
    // PgTyped uses its own wire client and ignores libpq PGOPTIONS/search_path.
    // An isolated database makes its default public schema unambiguous.
    await admin.query(`CREATE DATABASE ${database}`)
    const scopedUrl = isolatedConnection(databaseUrl, database)
    const scoped = new Pool({ connectionString: scopedUrl })
    try { await runMigrations(scoped) } finally { await scoped.end() }
    await hooks.afterMigrate?.(database)

    let configPath = committedConfig
    let generatedRoot = sourceQueries
    if (check) {
      temporaryRoot = await mkdtemp(resolve(tmpdir(), 'cudex-pgtyped-'))
      generatedRoot = resolve(temporaryRoot, 'src/db/queries')
      await cp(sourceQueries, generatedRoot, { recursive: true })
      configPath = resolve(temporaryRoot, 'pgtyped.config.json')
      await writeFile(configPath, JSON.stringify({
        srcDir: './src/db/queries', failOnError: true, camelCaseColumnNames: false,
        transforms: [{ mode: 'sql', include: '**/*.sql', emitTemplate: '{{dir}}/{{name}}.queries.ts' }],
      }))
    }
    const output = await execa(resolve(packageRoot, 'node_modules/.bin/pgtyped'), ['-c', configPath], {
      cwd: temporaryRoot ?? packageRoot, env: { PATH: process.env.PATH, PGURI: scopedUrl },
      extendEnv: false, reject: true,
    })
    // Some PgTyped worker failures are printed despite a zero process exit code.
    if (/Error (?:in query|processing)|Error:/u.test(`${output.stdout}\n${output.stderr}`)) {
      throw new Error('SQL generation reported query errors')
    }
    await normalizeGeneratedFiles(generatedRoot)
    if (check) await assertGeneratedCurrent(sourceQueries, generatedRoot)
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined)
    await admin.end()
  }
}

async function main(): Promise<void> {
  const { databaseUrl } = loadSqlGenerationEnv()
  await generateSql(process.argv.includes('--check'), databaseUrl)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) await main()
