import { createHash } from 'node:crypto'
import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const migrationPattern = /^(\d{4})_([a-z0-9_]+)\.sql$/

export interface Migration {
  version: number
  name: string
  filename: string
  checksum: string
  sql: string
}

async function defaultMigrationDirectory(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(here, '../migrations'), resolve(here, '../../migrations')]
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch { /* try the compiled layout */ }
  }
  throw new Error(`migration directory not found (checked ${candidates.join(', ')})`)
}

export async function loadMigrations(directory?: string): Promise<Migration[]> {
  const migrationDirectory = directory ?? await defaultMigrationDirectory()
  const filenames = (await readdir(migrationDirectory)).filter(filename => filename.endsWith('.sql')).sort()
  const migrations: Migration[] = []
  const versions = new Set<number>()
  for (const filename of filenames) {
    const match = migrationPattern.exec(filename)
    if (!match) throw new Error(`invalid migration filename: ${filename}`)
    const version = Number(match[1])
    if (versions.has(version)) throw new Error(`duplicate migration version: ${version}`)
    versions.add(version)
    const sql = await readFile(resolve(migrationDirectory, filename), 'utf8')
    if (!sql.trim()) throw new Error(`empty migration: ${filename}`)
    migrations.push({
      version,
      name: match[2]!,
      filename,
      checksum: `sha256:${createHash('sha256').update(sql).digest('hex')}`,
      sql,
    })
  }
  if (migrations.length === 0) throw new Error(`no migrations found in ${migrationDirectory}`)
  return migrations.sort((left, right) => left.version - right.version)
}

export async function runMigrations(pool: Pool, directory?: string): Promise<void> {
  const migrations = await loadMigrations(directory)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema(), 0))")
    await client.query(`
      CREATE TABLE IF NOT EXISTS hosted_agent_schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL,
        filename text NOT NULL UNIQUE,
        checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const result = await client.query<{ version: number; filename: string; checksum: string }>(
      'SELECT version, filename, checksum FROM hosted_agent_schema_migrations ORDER BY version',
    )
    const localByVersion = new Map(migrations.map(migration => [migration.version, migration]))
    for (const applied of result.rows) {
      const local = localByVersion.get(applied.version)
      if (!local) throw new Error(`database has unknown migration version ${applied.version} (${applied.filename})`)
      if (local.filename !== applied.filename || local.checksum !== applied.checksum) {
        throw new Error(`migration ${applied.version} differs from the applied migration`)
      }
    }
    const appliedVersions = new Set(result.rows.map(row => row.version))
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue
      await client.query(migration.sql)
      await client.query(
        'INSERT INTO hosted_agent_schema_migrations (version, name, filename, checksum) VALUES ($1, $2, $3, $4)',
        [migration.version, migration.name, migration.filename, migration.checksum],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.HOSTED_AGENT_DATABASE_URL ?? process.env.DATABASE_URL
  if (!connectionString) throw new Error('HOSTED_AGENT_DATABASE_URL or DATABASE_URL is required')
  const pool = new Pool({ connectionString })
  try { await runMigrations(pool) } finally { await pool.end() }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) await main()
