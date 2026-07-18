import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Database } from './types.js'

const emptyDatabase = (): Database => ({ leases: {}, snapshots: {}, operations: {}, tickets: {} })
export class JsonStore {
  private database: Database = emptyDatabase()
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}
  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try { this.database = JSON.parse(await readFile(this.path, 'utf8')) as Database }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.persist()
    }
  }
  async transaction<T>(fn: (database: Database) => Promise<T> | T): Promise<T> {
    let resolve!: () => void
    const previous = this.queue
    this.queue = new Promise<void>(done => { resolve = done })
    await previous
    try { const result = await fn(this.database); await this.persist(); return result }
    finally { resolve() }
  }
  async read<T>(fn: (database: Database) => T): Promise<T> { await this.queue; return fn(this.database) }
  private async persist(): Promise<void> {
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.database, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
