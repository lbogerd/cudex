import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { E2BProvider } from '../src/e2b-provider.js'

async function withCreateApi(
  trafficAccessToken: string | undefined,
  run: (provider: E2BProvider, requestBody: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  let requestBody: Record<string, unknown> = {}
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST' || request.url !== '/sandboxes') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    response.writeHead(201, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      templateID: 'template-1',
      sandboxID: 'sandbox-1',
      clientID: 'client-1',
      envdVersion: '0.1.0',
      domain: 'cube.test',
      ...(trafficAccessToken === undefined ? {} : { trafficAccessToken }),
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const provider = new E2BProvider({
      apiKey: 'test-api-key',
      apiUrl: `http://127.0.0.1:${address.port}`,
      domain: 'cube.test',
      validateApiKey: false,
      requestTimeoutMs: 5_000,
    })
    await provider.create('template-1', { managedBy: 'test', tenantId: 'tenant-1' })
    await run(provider, requestBody)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('E2B provider requests authenticated public-port routing', async () => {
  await withCreateApi('traffic-token', async (provider, requestBody) => {
    assert.equal(requestBody.secure, true)
    assert.deepEqual(requestBody.network, { allowPublicTraffic: false })
    assert.deepEqual(await provider.execUpstream('sandbox-1'), {
      url: 'wss://22101-sandbox-1.cube.test/',
      accessToken: 'traffic-token',
    })
  })
})

test('E2B provider refuses public-port routing without a provider traffic token', async () => {
  await withCreateApi(undefined, async provider => {
    await assert.rejects(provider.execUpstream('sandbox-1'), /invalid exec upstream/)
  })
})
