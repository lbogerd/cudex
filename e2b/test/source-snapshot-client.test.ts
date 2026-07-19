import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generatePocTls } from '../src/poc-tls.js'
import { createSourceSnapshotEnvelope, uploadSourceSnapshot } from '../src/source-snapshot-client.js'

const archive = new TextEncoder().encode('archive-bytes')
const cwdUri = 'file:///workspace/roots/0/fixture'
const workspaceRootUris = [cwdUri]

test('source envelope uses a four-byte length and exact metadata', () => {
  const expiresAt = new Date('2026-07-19T12:00:00.000Z')
  const result = createSourceSnapshotEnvelope({ archive, cwdUri, workspaceRootUris, expiresAt })
  const metadataLength = result.envelope.readUInt32BE(0)
  assert.deepEqual(JSON.parse(result.envelope.subarray(4, 4 + metadataLength).toString('utf8')), {
    checksum: result.checksum, cwdUri, workspaceRootUris, expiresAt: expiresAt.toISOString(),
  })
  assert.deepEqual(result.envelope.subarray(4 + metadataLength), Buffer.from(archive))
})

async function withServer(handler: Parameters<typeof createServer>[1], run: (url: URL, ca: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-poc-upload-'))
  const tls = await generatePocTls(directory)
  const server = createServer({ key: await readFile(tls.serverKeyPath), cert: await readFile(tls.serverCertificatePath) }, handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try { await run(new URL(`https://localhost:${address.port}/`), tls.combinedCaBundlePath) }
  finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('source upload validates exact response identity without sending tenant data', async () => {
  const expiresAt = new Date('2026-07-19T12:00:00.000Z')
  await withServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      assert.equal(request.headers.authorization, 'Bearer bearer-value')
      assert.equal(request.headers['content-type'], 'application/vnd.codex.source-snapshot.v1')
      const envelope = Buffer.concat(chunks); const length = envelope.readUInt32BE(0)
      const metadata = JSON.parse(envelope.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>
      assert.ok(!Object.hasOwn(metadata, 'tenantId'))
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ sourceSnapshotId: `source_${'a'.repeat(32)}`, checksum: metadata.checksum,
        expiresAt: metadata.expiresAt, manifestChecksum: `sha256:${'b'.repeat(64)}`, sizeBytes: archive.byteLength }))
    })
  }, async (serviceUrl, caBundlePath) => {
    const uploaded = await uploadSourceSnapshot({ serviceUrl, bearerToken: 'bearer-value', caBundlePath,
      archive, cwdUri, workspaceRootUris, expiresAt })
    assert.equal(uploaded.sourceSnapshotId, `source_${'a'.repeat(32)}`)
  })
})

test('source upload rejects redirects, malformed/oversized responses, and mismatched identity without leaks', async () => {
  const expiresAt = new Date('2026-07-19T12:00:00.000Z')
  for (const kind of ['redirect', 'malformed', 'oversized', 'mismatch'] as const) {
    await withServer((request, response) => {
      request.resume()
      if (kind === 'redirect') { response.writeHead(302, { location: 'https://secret.invalid/ticket' }); response.end(); return }
      if (kind === 'malformed') { response.writeHead(201, { 'content-type': 'application/json' }); response.end('{private-response'); return }
      if (kind === 'oversized') { response.writeHead(201, { 'content-type': 'application/json' }); response.end('x'.repeat(70 * 1024)); return }
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ sourceSnapshotId: `source_${'a'.repeat(32)}`, checksum: `sha256:${'c'.repeat(64)}`,
        expiresAt: expiresAt.toISOString(), manifestChecksum: `sha256:${'b'.repeat(64)}`, sizeBytes: archive.byteLength }))
    }, async (serviceUrl, caBundlePath) => {
      await assert.rejects(uploadSourceSnapshot({ serviceUrl, bearerToken: 'do-not-leak-bearer', caBundlePath,
        archive, cwdUri, workspaceRootUris, expiresAt }), error => {
        const text = String(error)
        assert.ok(!text.includes('do-not-leak-bearer'))
        assert.ok(!text.includes(serviceUrl.href))
        assert.ok(!text.includes('private-response'))
        return true
      })
    })
  }
})
