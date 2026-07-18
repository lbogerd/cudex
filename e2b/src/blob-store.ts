import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class BlobStore {
  constructor(private readonly directory: string) {}
  async put(bytes: Uint8Array): Promise<string> {
    const id = createHash('sha256').update(bytes).digest('hex'); await mkdir(this.directory, { recursive: true })
    await writeFile(join(this.directory, id), bytes, { flag: 'wx', mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    return id
  }
  async get(id: string): Promise<Uint8Array> { return readFile(join(this.directory, id)) }
}
