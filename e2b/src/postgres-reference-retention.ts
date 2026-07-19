import type { Pool, PoolClient } from 'pg'
import type { RetentionRequest } from './types.js'
import { ServiceError } from './types.js'

function validId(value: string): boolean {
  return value.length > 0 && value === value.trim() && Buffer.byteLength(value) <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Synchronizes the exact durable snapshots/artifact currently held by one Codex thread. */
export class PostgresReferenceRetention {
  constructor(private readonly pool: Pool, private readonly tenantId: string) {
    if (!validId(tenantId)) throw new Error('invalid tenant ID')
  }

  async retain(input: RetentionRequest): Promise<void> {
    if (![input.agentId, input.leaseId, input.baseSnapshotId, input.latestSnapshotId]
      .every(validId) || (input.artifactId !== null && !validId(input.artifactId))) {
      throw new ServiceError(400, 'invalid retention request')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '30s'")
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`codex-reference:${this.tenantId}:${input.agentId}`])
      await this.authorizeLease(client, input)
      await this.authorizeSnapshot(client, input.agentId, input.baseSnapshotId)
      await this.authorizeSnapshot(client, input.agentId, input.latestSnapshotId)
      if (input.artifactId !== null) await this.authorizeArtifact(client, input.agentId, input.artifactId)
      await client.query(`
        INSERT INTO hosted_agent_codex_reference_sets
          (tenant_id, agent_id, lease_id, base_snapshot_id, latest_snapshot_id, artifact_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
          lease_id = EXCLUDED.lease_id,
          base_snapshot_id = EXCLUDED.base_snapshot_id,
          latest_snapshot_id = EXCLUDED.latest_snapshot_id, artifact_id = EXCLUDED.artifact_id
      `, [this.tenantId, input.agentId, input.leaseId, input.baseSnapshotId,
        input.latestSnapshotId, input.artifactId])
      await client.query(`
        INSERT INTO hosted_agent_snapshot_references (snapshot_id, reference_kind, reference_id)
        SELECT snapshot_id, 'codex_thread', $3 FROM hosted_agent_snapshots
        WHERE tenant_id = $1 AND snapshot_id = ANY($2::text[])
        ON CONFLICT (snapshot_id, reference_kind, reference_id) DO NOTHING
      `, [this.tenantId, [...new Set([input.baseSnapshotId, input.latestSnapshotId])], input.agentId])
      await client.query(`
        DELETE FROM hosted_agent_snapshot_references AS reference
        USING hosted_agent_snapshots AS snapshot
        WHERE reference.snapshot_id = snapshot.snapshot_id AND snapshot.tenant_id = $1
          AND reference.reference_kind = 'codex_thread' AND reference.reference_id = $2
          AND reference.snapshot_id <> ALL($3::text[])
      `, [this.tenantId, input.agentId,
        [...new Set([input.baseSnapshotId, input.latestSnapshotId])]])
      if (input.artifactId === null) {
        await client.query(`DELETE FROM hosted_agent_artifact_references AS reference
          USING hosted_agent_artifacts AS artifact
          WHERE reference.artifact_id = artifact.artifact_id AND artifact.tenant_id = $1
            AND reference.reference_kind = 'codex_thread' AND reference.reference_id = $2`,
        [this.tenantId, input.agentId])
      } else {
        await client.query(`
          INSERT INTO hosted_agent_artifact_references (artifact_id, reference_kind, reference_id)
          VALUES ($1, 'codex_thread', $2)
          ON CONFLICT (artifact_id, reference_kind, reference_id) DO NOTHING
        `, [input.artifactId, input.agentId])
        await client.query(`DELETE FROM hosted_agent_artifact_references AS reference
          USING hosted_agent_artifacts AS artifact
          WHERE reference.artifact_id = artifact.artifact_id AND artifact.tenant_id = $1
            AND reference.reference_kind = 'codex_thread' AND reference.reference_id = $2
            AND reference.artifact_id <> $3`, [this.tenantId, input.agentId, input.artifactId])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (error instanceof ServiceError) throw error
      throw new ServiceError(503, 'service unavailable')
    } finally { client.release() }
  }

  async assertSynchronized(client: PoolClient, leaseId: string): Promise<void> {
    const result = await client.query(`
      SELECT 1
      FROM hosted_agent_leases AS lease
      JOIN hosted_agent_codex_reference_sets AS retained
        ON retained.tenant_id = lease.tenant_id AND retained.lease_id = lease.lease_id
        AND retained.agent_id = lease.agent_id
      WHERE lease.tenant_id = $1 AND lease.lease_id = $2
        AND retained.latest_snapshot_id = lease.latest_snapshot_id
        AND EXISTS (
          SELECT 1 FROM hosted_agent_snapshot_references
          WHERE snapshot_id = retained.base_snapshot_id
            AND reference_kind = 'codex_thread' AND reference_id = retained.agent_id)
        AND EXISTS (
          SELECT 1 FROM hosted_agent_snapshot_references
          WHERE snapshot_id = retained.latest_snapshot_id
            AND reference_kind = 'codex_thread' AND reference_id = retained.agent_id)
        AND (retained.artifact_id IS NULL OR EXISTS (
          SELECT 1 FROM hosted_agent_artifact_references
          WHERE artifact_id = retained.artifact_id
            AND reference_kind = 'codex_thread' AND reference_id = retained.agent_id))
      FOR SHARE OF retained
    `, [this.tenantId, leaseId])
    if (result.rowCount !== 1) throw new ServiceError(409, 'durable references are not synchronized')
  }

  private async authorizeLease(client: PoolClient, input: RetentionRequest): Promise<void> {
    const result = await client.query(`SELECT 1 FROM hosted_agent_leases
      WHERE tenant_id = $1 AND lease_id = $2 AND agent_id = $3 FOR SHARE`,
    [this.tenantId, input.leaseId, input.agentId])
    if (result.rowCount !== 1) throw new ServiceError(404, 'lease missing')
  }

  private async authorizeSnapshot(client: PoolClient, agentId: string, snapshotId: string): Promise<void> {
    const result = await client.query(`SELECT 1 FROM hosted_agent_snapshots AS snapshot
      JOIN hosted_agent_leases AS lease ON lease.lease_id = snapshot.lease_id
      WHERE snapshot.tenant_id = $1 AND snapshot.snapshot_id = $2
        AND snapshot.state = 'available' AND lease.agent_id = $3 FOR SHARE OF snapshot`,
    [this.tenantId, snapshotId, agentId])
    if (result.rowCount !== 1) throw new ServiceError(404, 'snapshot missing')
  }

  private async authorizeArtifact(client: PoolClient, agentId: string, artifactId: string): Promise<void> {
    const result = await client.query(`SELECT 1 FROM hosted_agent_artifacts
      WHERE tenant_id = $1 AND artifact_id = $2 AND state = 'available'
        AND (agent_id = $3 OR owner_agent_id = $3) FOR SHARE`, [this.tenantId, artifactId, agentId])
    if (result.rowCount !== 1) throw new ServiceError(404, 'artifact missing')
  }
}
