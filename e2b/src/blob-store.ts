import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

export interface ObjectStore {
  put(bytes: Uint8Array): Promise<string>
  get(id: string): Promise<Uint8Array>
  /** Idempotently removes the exact content-addressed object. */
  delete(id: string): Promise<void>
  location(id: string): { storageBucket: string; storageKey: string }
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function validateId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid object identifier')
}

/** Development-only filesystem object store. Production uses S3BlobStore. */
export class BlobStore implements ObjectStore {
  constructor(private readonly directory: string) {}
  async put(bytes: Uint8Array): Promise<string> {
    const id = digest(bytes); await mkdir(this.directory, { recursive: true })
    await writeFile(join(this.directory, id), bytes, { flag: 'wx', mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    return id
  }
  async get(id: string): Promise<Uint8Array> {
    validateId(id)
    const bytes = await readFile(join(this.directory, id))
    if (digest(bytes) !== id) throw new Error('object checksum mismatch')
    return bytes
  }
  async delete(id: string): Promise<void> {
    validateId(id)
    await rm(join(this.directory, id), { force: true })
  }
  location(id: string): { storageBucket: string; storageKey: string } {
    validateId(id)
    return { storageBucket: 'development-filesystem', storageKey: id }
  }
}

export interface S3BlobStoreOptions {
  bucket: string
  prefix?: string
  region?: string
  endpoint?: string
  forcePathStyle?: boolean
  maxObjectBytes?: number
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
}

/** Authenticated, content-addressed storage for archives, manifests, and artifacts. */
export class S3BlobStore implements ObjectStore {
  private readonly client: S3Client
  private readonly prefix: string
  private readonly maxObjectBytes: number

  constructor(private readonly options: S3BlobStoreOptions) {
    if (!options.bucket.trim()) throw new Error('object-store bucket is required')
    this.prefix = options.prefix?.replace(/^\/+|\/+$/g, '') ?? 'hosted-agent/v1'
    this.maxObjectBytes = options.maxObjectBytes ?? 1024 * 1024 * 1024
    this.client = new S3Client({
      region: options.region ?? 'us-east-1',
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    })
  }

  async put(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > this.maxObjectBytes) throw new Error('object exceeds storage limit')
    const id = digest(bytes)
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: this.key(id),
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: 'application/octet-stream',
      Metadata: { sha256: id },
      ServerSideEncryption: 'AES256',
    }))
    return id
  }

  async get(id: string): Promise<Uint8Array> {
    validateId(id)
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: this.key(id) }))
    if (!response.Body) throw new Error('object body missing')
    if (response.ContentLength !== undefined && response.ContentLength > this.maxObjectBytes) throw new Error('object exceeds storage limit')
    const bytes = await response.Body.transformToByteArray()
    if (bytes.byteLength > this.maxObjectBytes) throw new Error('object exceeds storage limit')
    if (digest(bytes) !== id || (response.Metadata?.sha256 && response.Metadata.sha256 !== id)) throw new Error('object checksum mismatch')
    return bytes
  }

  async delete(id: string): Promise<void> {
    validateId(id)
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.key(id) }))
  }

  location(id: string): { storageBucket: string; storageKey: string } {
    validateId(id)
    return { storageBucket: this.options.bucket, storageKey: this.key(id) }
  }

  private key(id: string): string {
    validateId(id)
    return `${this.prefix}/sha256/${id.slice(0, 2)}/${id}`
  }
}
