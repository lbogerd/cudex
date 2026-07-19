import type { PoolClient } from 'pg'
import type { PostgresDurableState } from './postgres-state.js'
import type { PostgresJournal } from './postgres-store.js'

export type LeaseInteractionKind = 'process' | 'filesystem'
export type LeaseInteractionState = 'active' | 'detached' | 'finished'

export interface LeaseInteractionIdentity {
  tenantId: string
  leaseId: string
  interactionId: string
  connectionGeneration: number
  sessionId: string
  kind: LeaseInteractionKind
  processId: string | null
}

export interface LeaseInteraction extends LeaseInteractionIdentity {
  state: LeaseInteractionState
  createdAt: Date
  updatedAt: Date
  detachedAt: Date | null
  finishedAt: Date | null
}

export interface LeaseQuiescenceGate {
  assertQuiescent(tenantId: string, leaseId: string, expectedGeneration: number,
    executor: Pick<PoolClient, 'query'>): Promise<void>
}

interface InteractionRow {
  interaction_id: string
  tenant_id: string
  lease_id: string
  connection_generation: string
  session_id: string
  interaction_kind: LeaseInteractionKind
  process_id: string | null
  state: LeaseInteractionState
  created_at: Date
  updated_at: Date
  detached_at: Date | null
  finished_at: Date | null
}

export class LeaseInteractionConflictError extends Error {
  constructor() { super('lease interaction identity conflict') }
}

export class LeaseNotQuiescentError extends Error {
  constructor() { super('lease has unfinished command interactions') }
}

const columns = `
  interaction_id, tenant_id, lease_id, connection_generation::text,
  session_id, interaction_kind, process_id, state, created_at, updated_at,
  detached_at, finished_at
`

function bounded(label: string, value: string): string {
  if (!value.trim() || value !== value.trim() || Buffer.byteLength(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}

function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid connection generation')
  return value
}

function validate(identity: LeaseInteractionIdentity): LeaseInteractionIdentity {
  bounded('tenant ID', identity.tenantId)
  bounded('lease ID', identity.leaseId)
  bounded('interaction ID', identity.interactionId)
  bounded('session ID', identity.sessionId)
  generation(identity.connectionGeneration)
  if (!['process', 'filesystem'].includes(identity.kind)
    || (identity.kind === 'process') !== (identity.processId !== null)) {
    throw new Error('invalid lease interaction kind')
  }
  if (identity.processId !== null) bounded('process ID', identity.processId)
  return identity
}

function interaction(row: InteractionRow): LeaseInteraction {
  return {
    interactionId: row.interaction_id, tenantId: row.tenant_id, leaseId: row.lease_id,
    connectionGeneration: Number(row.connection_generation), sessionId: row.session_id,
    kind: row.interaction_kind, processId: row.process_id, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at,
    detachedAt: row.detached_at, finishedAt: row.finished_at,
  }
}

function exact(value: LeaseInteraction, identity: LeaseInteractionIdentity): boolean {
  return value.interactionId === identity.interactionId
    && value.tenantId === identity.tenantId && value.leaseId === identity.leaseId
    && value.connectionGeneration === identity.connectionGeneration
    && value.sessionId === identity.sessionId && value.kind === identity.kind
    && value.processId === identity.processId
}

/** Durable command admission that shares the lifecycle advisory lease gate. */
export class PostgresLeaseInteractionGate implements LeaseQuiescenceGate {
  constructor(
    private readonly journal: Pick<PostgresJournal, 'withLeaseLocks'>,
    private readonly state: Pick<PostgresDurableState, 'getLease'>,
  ) {}

  async begin(untrusted: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    const identity = validate(untrusted)
    try {
      return await this.journal.withLeaseLocks(identity.tenantId, [identity.leaseId], async client => {
        const lease = await this.state.getLease(identity.tenantId, identity.leaseId, client)
        if (!lease || lease.state !== 'active'
          || lease.connectionGeneration !== identity.connectionGeneration) {
          throw new LeaseInteractionConflictError()
        }
        const inserted = await client.query<InteractionRow>(`
          INSERT INTO hosted_agent_lease_interactions
            (interaction_id, tenant_id, lease_id, connection_generation,
             session_id, interaction_kind, process_id, state)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
          ON CONFLICT (interaction_id) DO NOTHING
          RETURNING ${columns}
        `, [identity.interactionId, identity.tenantId, identity.leaseId,
          identity.connectionGeneration, identity.sessionId, identity.kind, identity.processId])
        if (inserted.rows[0]) return interaction(inserted.rows[0])
        const existing = await this.select(identity.interactionId, client)
        if (!existing || !exact(existing, identity) || existing.state !== 'active') {
          throw new LeaseInteractionConflictError()
        }
        return existing
      })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new LeaseInteractionConflictError()
      throw error
    }
  }

  async resume(untrusted: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    const identity = validate(untrusted)
    return this.journal.withLeaseLocks(identity.tenantId, [identity.leaseId], async client => {
      const lease = await this.state.getLease(identity.tenantId, identity.leaseId, client)
      if (!lease || lease.state !== 'active'
        || lease.connectionGeneration !== identity.connectionGeneration) {
        throw new LeaseInteractionConflictError()
      }
      const value = await this.transition(identity, 'active', client)
      if (value.state !== 'active') throw new LeaseInteractionConflictError()
      return value
    })
  }

  detach(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    return this.finishLike(validate(identity), 'detached')
  }

  finish(identity: LeaseInteractionIdentity): Promise<LeaseInteraction> {
    return this.finishLike(validate(identity), 'finished')
  }

  /** Caller must already hold the common advisory lease lock on this executor. */
  async assertQuiescent(tenantId: string, leaseId: string, expectedGeneration: number,
    executor: Pick<PoolClient, 'query'>): Promise<void> {
    bounded('tenant ID', tenantId)
    bounded('lease ID', leaseId)
    generation(expectedGeneration)
    const lease = await this.state.getLease(tenantId, leaseId, executor)
    if (!lease || !['active', 'paused'].includes(lease.state)
      || lease.connectionGeneration !== expectedGeneration) {
      throw new LeaseInteractionConflictError()
    }
    const result = await executor.query(`
      SELECT 1 FROM hosted_agent_lease_interactions
      WHERE tenant_id = $1 AND lease_id = $2 AND state <> 'finished'
      LIMIT 1
    `, [tenantId, leaseId])
    if (result.rowCount !== 0) throw new LeaseNotQuiescentError()
  }

  private async finishLike(identity: LeaseInteractionIdentity,
    state: 'detached' | 'finished'): Promise<LeaseInteraction> {
    return this.journal.withLeaseLocks(identity.tenantId, [identity.leaseId], client =>
      this.transition(identity, state, client))
  }

  private async transition(identity: LeaseInteractionIdentity,
    state: LeaseInteractionState, client: PoolClient): Promise<LeaseInteraction> {
    const current = await this.select(identity.interactionId, client)
    if (!current || !exact(current, identity)) throw new LeaseInteractionConflictError()
    if (current.state === 'finished') {
      if (state === 'finished') return current
      throw new LeaseInteractionConflictError()
    }
    if (current.state === state) return current
    if (state === 'active' && current.state !== 'detached') throw new LeaseInteractionConflictError()
    const result = await client.query<InteractionRow>(`
      UPDATE hosted_agent_lease_interactions
      SET state = $2,
          detached_at = CASE WHEN $2 = 'detached' THEN now()
            WHEN $2 = 'active' THEN NULL ELSE detached_at END,
          finished_at = CASE WHEN $2 = 'finished' THEN now() ELSE NULL END
      WHERE interaction_id = $1
      RETURNING ${columns}
    `, [identity.interactionId, state])
    if (!result.rows[0]) throw new LeaseInteractionConflictError()
    return interaction(result.rows[0])
  }

  private async select(interactionId: string,
    executor: Pick<PoolClient, 'query'>): Promise<LeaseInteraction | null> {
    const result = await executor.query<InteractionRow>(`
      SELECT ${columns} FROM hosted_agent_lease_interactions
      WHERE interaction_id = $1
      FOR UPDATE
    `, [interactionId])
    return result.rows[0] ? interaction(result.rows[0]) : null
  }
}
