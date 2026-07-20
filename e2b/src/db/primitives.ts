import type { PoolClient } from 'pg'

type Executor = Pick<PoolClient, 'query'>

export async function begin(client: Executor): Promise<void> { await client.query('BEGIN') }
export async function beginRepeatableRead(client: Executor): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
}
export async function commit(client: Executor): Promise<void> { await client.query('COMMIT') }
export async function rollback(client: Executor): Promise<void> { await client.query('ROLLBACK') }
export async function rollbackQuietly(client: Executor): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined)
}
export async function lockLeaseTransaction(client: Executor, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
}
export const lockTransaction = lockLeaseTransaction
export async function lockLeaseSession(client: Executor, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key])
}
export async function unlockLeaseSessionQuietly(client: Executor, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => undefined)
}
export async function setLocalLockTimeout(client: Executor): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '30s'")
}
export async function setStatementTimeout(client: Executor): Promise<void> {
  await client.query("SET statement_timeout = '30s'")
}
export async function resetStatementTimeout(client: Executor): Promise<void> {
  await client.query('RESET statement_timeout')
}
export async function unlockLeaseSession(client: Executor, key: string): Promise<boolean> {
  const result = await client.query<{ unlocked: boolean }>(
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [key])
  return result.rows[0]?.unlocked === true
}
