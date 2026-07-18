import assert from 'node:assert/strict'
import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BlobStore, S3BlobStore } from '../src/blob-store.js'

test('development object store is content-addressed and verifies reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-objects-'))
  const store = new BlobStore(directory)
  const bytes = new TextEncoder().encode('workspace bytes')
  const id = await store.put(bytes)
  assert.match(id, /^[a-f0-9]{64}$/)
  assert.deepEqual(Buffer.from(await store.get(id)), Buffer.from(bytes))
  assert.deepEqual(store.location(id), { storageBucket: 'development-filesystem', storageKey: id })

  await store.delete(id)
  await store.delete(id)
  await assert.rejects(access(join(directory, id)))
  await assert.rejects(store.delete('../state.json'), /invalid object identifier/)

  await store.put(bytes)

  await writeFile(join(directory, id), 'corrupt')
  await assert.rejects(store.get(id), /checksum mismatch/)
  await assert.rejects(store.get('../state.json'), /invalid object identifier/)
})

test('S3 object locations and deletion use the exact configured content-addressed key', async () => {
  const store = new S3BlobStore({ bucket: 'hosted-agent-test', prefix: '/tenant-data/v1/' })
  const id = 'a'.repeat(64)
  assert.deepEqual(store.location(id), {
    storageBucket: 'hosted-agent-test',
    storageKey: `tenant-data/v1/sha256/aa/${id}`,
  })
  assert.throws(() => store.location('../escape'))
  const commands: unknown[] = []
  ;(store as unknown as { client: { send(command: unknown): Promise<void> } }).client = {
    async send(command: unknown) { commands.push(command) },
  }
  await store.delete(id)
  const input = (commands[0] as { input: { Bucket: string; Key: string } }).input
  assert.deepEqual(input, { Bucket: 'hosted-agent-test', Key: `tenant-data/v1/sha256/aa/${id}` })
  await assert.rejects(store.delete('../escape'), /invalid object identifier/)
})
