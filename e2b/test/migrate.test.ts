import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { loadMigrations, runMigrations } from '../src/migrate.js'

test('migration files load in version order with stable checksums', async () => {
  const migrations = await loadMigrations()
  assert.deepEqual(migrations.map(migration => migration.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(migrations[0]!.filename, '0001_control_plane.sql')
  assert.match(migrations[0]!.checksum, /^sha256:[0-9a-f]{64}$/)
})

const databaseUrl = process.env.HOSTED_AGENT_TEST_DATABASE_URL
test('PostgreSQL migrations are transactional, repeatable, and enforce identity constraints', { skip: databaseUrl ? false : 'HOSTED_AGENT_TEST_DATABASE_URL is not set' }, async () => {
  const schema = `hosted_agent_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await Promise.all([runMigrations(pool), runMigrations(pool)])
    const applied = await pool.query<{ version: number }>('SELECT version FROM hosted_agent_schema_migrations ORDER BY version')
    assert.deepEqual(applied.rows.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

    const tableNames = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'hosted_agent_%'
    `)
    const names = new Set(tableNames.rows.map(row => row.table_name))
    for (const expected of [
      'hosted_agent_leases', 'hosted_agent_snapshots', 'hosted_agent_artifacts',
      'hosted_agent_operations', 'hosted_agent_operation_allocations', 'hosted_agent_tickets',
      'hosted_agent_objects', 'hosted_agent_object_references', 'hosted_agent_source_snapshots',
      'hosted_agent_workspace_preparations', 'hosted_agent_workspace_preparation_objects',
      'hosted_agent_patch_applications',
    ]) assert.equal(names.has(expected), true, `${expected} should exist`)

    const digest = `sha256:${'a'.repeat(64)}`
    await pool.query(`
      INSERT INTO hosted_agent_operations
        (operation, idempotency_key, tenant_id, request_hash, state, heartbeat_at)
      VALUES ('provision', 'same-key', 'tenant', $1, 'in_progress', now())
    `, [digest])
    await assert.rejects(pool.query(`
      INSERT INTO hosted_agent_operations
        (operation, idempotency_key, tenant_id, request_hash, state, heartbeat_at)
      VALUES ('provision', 'same-key', 'tenant', $1, 'in_progress', now())
    `, [digest]), error => (error as { code?: string }).code === '23505')
    await assert.rejects(pool.query(`
      INSERT INTO hosted_agent_operations
        (operation, idempotency_key, tenant_id, request_hash, state, heartbeat_at)
      VALUES ('provision', 'bad-hash', 'tenant', 'not-a-checksum', 'in_progress', now())
    `), error => (error as { code?: string }).code === '23514')
    await pool.query(`
      INSERT INTO hosted_agent_leases
        (lease_id, environment_id, tenant_id, agent_id, sandbox_template, cwd_uri,
         workspace_root_uris, state, tool_policy, policy_version)
      VALUES ('child-owner', 'child-owner-environment', 'tenant', 'owner-agent', 'owner-v1',
        'file:///workspace/root', '["file:///workspace/root"]'::jsonb,
        'provisioning', '{}'::jsonb, 1)
    `)
    await pool.query(`
      INSERT INTO hosted_agent_operations
        (operation, idempotency_key, tenant_id, request_hash, state, heartbeat_at,
         operation_subtype, primary_lease_id)
      VALUES ('provision', 'child-key', 'tenant', $1, 'in_progress', now(), 'child', 'child-owner')
    `, [digest])
    await assert.rejects(pool.query(`
      INSERT INTO hosted_agent_operations
        (operation, idempotency_key, tenant_id, request_hash, state, heartbeat_at, operation_subtype)
      VALUES ('provision', 'invalid-subtype', 'tenant', $1, 'in_progress', now(), 'restore')
    `, [digest]), error => (error as { code?: string }).code === '23514')
    await assert.rejects(pool.query(`
      UPDATE hosted_agent_operations SET operation_subtype = NULL
      WHERE operation = 'provision' AND idempotency_key = 'child-key'
    `), /operation subtype is immutable/)
    await assert.rejects(pool.query(`
      INSERT INTO hosted_agent_operations
        (operation, idempotency_key, tenant_id, request_hash, state, heartbeat_at,
         operation_subtype, primary_lease_id)
      VALUES ('release', 'invalid-child-operation', 'tenant', $1, 'in_progress', now(), 'child', 'child-owner')
    `, [digest]), error => (error as { code?: string }).code === '23514')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
