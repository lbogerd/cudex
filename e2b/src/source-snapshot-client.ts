import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'

const contentType = 'application/vnd.codex.source-snapshot.v1'
const maxArchiveBytes = 512 * 1024 * 1024
const maxMetadataBytes = 64 * 1024
const maxResponseBytes = 64 * 1024
const timeoutMs = 120_000
const checksumPattern = /^sha256:[0-9a-f]{64}$/u
const sourceIdPattern = /^source_[0-9a-f]{32}$/u

export interface SourceSnapshotUploadRequest {
  serviceUrl: URL
  bearerToken: string
  caBundlePath: string
  archive: Uint8Array
  cwdUri: string
  workspaceRootUris: string[]
  expiresAt: Date
}

export interface UploadedSourceSnapshot {
  sourceSnapshotId: string
  checksum: string
  expiresAt: string
  manifestChecksum: string
  sizeBytes: number
}

function exactObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('source snapshot upload failed')
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = ['checksum', 'expiresAt', 'manifestChecksum', 'sizeBytes', 'sourceSnapshotId'].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('source snapshot upload failed')
  }
  return record
}

function canonicalDate(value: unknown): string {
  if (typeof value !== 'string') throw new Error('source snapshot upload failed')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error('source snapshot upload failed')
  return value
}

export function createSourceSnapshotEnvelope(request: Pick<SourceSnapshotUploadRequest,
  'archive' | 'cwdUri' | 'workspaceRootUris' | 'expiresAt'>): { envelope: Buffer; checksum: string } {
  if (!(request.archive instanceof Uint8Array) || request.archive.byteLength === 0 || request.archive.byteLength > maxArchiveBytes) {
    throw new Error('source snapshot archive is invalid')
  }
  if (!(request.expiresAt instanceof Date) || !Number.isFinite(request.expiresAt.getTime())) throw new Error('source snapshot expiry is invalid')
  const checksum = `sha256:${createHash('sha256').update(request.archive).digest('hex')}`
  const metadata = Buffer.from(JSON.stringify({
    checksum, cwdUri: request.cwdUri, workspaceRootUris: request.workspaceRootUris,
    expiresAt: request.expiresAt.toISOString(),
  }), 'utf8')
  if (metadata.byteLength === 0 || metadata.byteLength > maxMetadataBytes) throw new Error('source snapshot metadata is invalid')
  const length = Buffer.alloc(4); length.writeUInt32BE(metadata.byteLength)
  return { envelope: Buffer.concat([length, metadata, Buffer.from(request.archive)]), checksum }
}

function endpoint(base: URL): URL {
  if (base.protocol !== 'https:' || !base.hostname || base.username || base.password || base.search || base.hash) {
    throw new Error('source snapshot service URL is invalid')
  }
  const normalized = new URL(base.href)
  if (!normalized.pathname.endsWith('/')) normalized.pathname += '/'
  return new URL('v1/source-snapshots', normalized)
}

export async function uploadSourceSnapshot(request: SourceSnapshotUploadRequest): Promise<UploadedSourceSnapshot> {
  if (!request.bearerToken || request.bearerToken !== request.bearerToken.trim()
    || /[\u0000-\u001f\u007f]/u.test(request.bearerToken)) throw new Error('source snapshot bearer is invalid')
  const url = endpoint(request.serviceUrl)
  const { envelope, checksum } = createSourceSnapshotEnvelope(request)
  const ca = await readFile(request.caBundlePath).catch(() => { throw new Error('source snapshot CA bundle is unavailable') })
  const response = await new Promise<{ status: number; contentType?: string; body: Buffer }>((resolve, reject) => {
    const req = httpsRequest(url, { method: 'POST', ca, rejectUnauthorized: true,
      headers: { authorization: `Bearer ${request.bearerToken}`, 'content-type': contentType,
        'content-length': String(envelope.byteLength), accept: 'application/json' } }, res => {
      const chunks: Buffer[] = []; let size = 0; let overflow = false
      res.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > maxResponseBytes) { overflow = true; res.destroy(); return }
        chunks.push(Buffer.from(chunk))
      })
      res.on('end', () => {
        if (overflow) reject(new Error('source snapshot response is too large'))
        else resolve({ status: res.statusCode ?? 0,
          ...(typeof res.headers['content-type'] === 'string' ? { contentType: res.headers['content-type'] } : {}),
          body: Buffer.concat(chunks, size) })
      })
      res.on('error', () => reject(new Error('source snapshot upload failed')))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', () => reject(new Error('source snapshot upload failed')))
    req.end(envelope)
  })
  if (response.status >= 300 && response.status < 400) throw new Error('source snapshot upload rejected a redirect')
  if (response.status !== 201 || response.contentType?.split(';', 1)[0] !== 'application/json') throw new Error('source snapshot upload failed')
  let parsed: unknown
  try { parsed = JSON.parse(response.body.toString('utf8')) } catch { throw new Error('source snapshot upload failed') }
  const body = exactObject(parsed)
  if (typeof body.sourceSnapshotId !== 'string' || !sourceIdPattern.test(body.sourceSnapshotId)
    || typeof body.checksum !== 'string' || !checksumPattern.test(body.checksum)
    || typeof body.manifestChecksum !== 'string' || !checksumPattern.test(body.manifestChecksum)
    || !Number.isSafeInteger(body.sizeBytes) || Number(body.sizeBytes) !== request.archive.byteLength) {
    throw new Error('source snapshot upload failed')
  }
  const expiresAt = canonicalDate(body.expiresAt)
  if (body.checksum !== checksum || expiresAt !== request.expiresAt.toISOString()) throw new Error('source snapshot response identity mismatch')
  return { sourceSnapshotId: body.sourceSnapshotId, checksum: body.checksum, expiresAt,
    manifestChecksum: body.manifestChecksum, sizeBytes: Number(body.sizeBytes) }
}
