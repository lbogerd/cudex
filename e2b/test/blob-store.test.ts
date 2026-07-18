import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BlobStore } from '../src/blob-store.js'

test('development object store is content-addressed and verifies reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-objects-'))
  const store = new BlobStore(directory)
  const bytes = new TextEncoder().encode('workspace bytes')
  const id = await store.put(bytes)
  assert.match(id, /^[a-f0-9]{64}$/)
  assert.deepEqual(Buffer.from(await store.get(id)), Buffer.from(bytes))

  await writeFile(join(directory, id), 'corrupt')
  await assert.rejects(store.get(id), /checksum mismatch/)
  await assert.rejects(store.get('../state.json'), /invalid object identifier/)
})
