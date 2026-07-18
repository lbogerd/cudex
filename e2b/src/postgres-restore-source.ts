import { createHash } from 'node:crypto'
import type { ObjectStore } from './blob-store.js'
import {
  DurableStateConflictError,
  DurableStateNotFoundError,
  type AuthorizedRestoreSource,
  type PostgresDurableState,
  type RestoreSourceAuthorization,
} from './postgres-state.js'
import { ServiceError } from './types.js'

export interface ResolvedDurableRestoreSource extends AuthorizedRestoreSource {
  archive: Uint8Array
}

type RestoreState = Pick<PostgresDurableState, 'lockAuthorizedRestoreSource'>

/** Loads only the content-addressed workspace archive authorized by durable restore lineage. */
export class PostgresRestoreSourceResolver {
  constructor(private readonly state: RestoreState, private readonly objects: ObjectStore) {}

  async resolve(input: RestoreSourceAuthorization): Promise<ResolvedDurableRestoreSource> {
    try {
      const authorized = await this.state.lockAuthorizedRestoreSource(input)
      const physicalObjectId = authorized.archiveObject.checksum.slice('sha256:'.length)
      if (!/^[a-f0-9]{64}$/u.test(physicalObjectId)) throw new Error('invalid restore archive checksum')
      const expected = this.objects.location(physicalObjectId)
      if (expected.storageBucket !== authorized.archiveObject.storageBucket
        || expected.storageKey !== authorized.archiveObject.storageKey) {
        throw new Error('restore archive locator mismatch')
      }
      const archive = await this.objects.get(physicalObjectId)
      const checksum = `sha256:${createHash('sha256').update(archive).digest('hex')}`
      if (checksum !== authorized.archiveObject.checksum
        || archive.byteLength !== authorized.archiveObject.sizeBytes) {
        throw new Error('restore archive content mismatch')
      }
      return { ...authorized, archive }
    } catch (error) {
      if (error instanceof DurableStateConflictError) {
        throw new ServiceError(409, error.message)
      }
      if (error instanceof DurableStateNotFoundError) throw new ServiceError(404, 'snapshot missing')
      if (error instanceof ServiceError) throw error
      throw new ServiceError(503, 'durable restore source unavailable')
    }
  }
}
