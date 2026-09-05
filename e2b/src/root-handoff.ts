import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PocLeaseInspection } from './poc-inspector.js'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid root handoff journal')
  return value as Record<string, unknown>
}

/** A zero TUI exit alone does not prove its final checkpoint succeeded. */
export async function assertRootHandoff(codexHome: string, root: PocLeaseInspection,
  sourceSnapshotId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(root.agentId)) {
    throw new Error('invalid root handoff thread identity')
  }
  const path = join(codexHome, 'cudex-runtime', 'hosted-runtime-v1', `${root.agentId}.json`)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024
    || (metadata.mode & 0o077) !== 0) throw new Error('unsafe root handoff journal')
  const journal = object(JSON.parse(await readFile(path, 'utf8')))
  const request = object(journal.request)
  const source = object(request.source)
  const record = object(journal.record)
  if (journal.version !== 1 || journal.deleting !== false || journal.deleted !== false
    || journal.pending !== null || journal.finalization !== null
    || journal.handoffSnapshotId !== root.latestSnapshotId || !root.latestSnapshotId
    || request.agentId !== root.agentId || request.ownerAgentId !== null
    || source.type !== 'sourceSnapshot' || source.sourceSnapshotId !== sourceSnapshotId
    || record.ownerAgentId !== null || record.leaseId !== root.leaseId
    || record.environmentId !== root.environmentId || record.latestSnapshotId !== root.latestSnapshotId
    || record.lifecycleState !== 'active' || !Number.isSafeInteger(record.referenceRevision)
    || Number(record.referenceRevision) <= 0) {
    throw new Error('root did not complete an exact durable shutdown handoff')
  }
}
