import assert from 'node:assert/strict'
import { test } from 'node:test'
import { E2BSecureDataPlane } from '../src/e2b-secure-data-plane.js'

function response(status: number, body = new Uint8Array(0), headers: Record<string, string> = {}) {
  return {
    status,
    headers: new Headers(headers),
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body); controller.close() } }),
    async arrayBuffer() { return body.slice().buffer },
  }
}

function frame(payload: unknown, flags = 0): Uint8Array {
  const data = Buffer.from(JSON.stringify(payload))
  const result = Buffer.alloc(5 + data.byteLength)
  result[0] = flags
  result.writeUInt32BE(data.byteLength, 1)
  data.copy(result, 5)
  return result
}

test('secured data plane authenticates file traffic without exposing its token in errors', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const plane = new E2BSecureDataPlane({
    trafficAccessToken: 'provider-secret-token',
    getHost: port => `${port}-sandbox-1.cube.test`,
  }, { fetch: async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return response(204)
  } })
  await plane.files.write('/tmp/archive.tar', new Uint8Array([1, 2, 3]).buffer)
  assert.equal(new URL(calls[0]!.url).hostname, '49983-sandbox-1.cube.test')
  assert.equal(new Headers(calls[0]!.init.headers).get('e2b-traffic-access-token'), 'provider-secret-token')

  const failing = new E2BSecureDataPlane({
    trafficAccessToken: 'provider-secret-token', getHost: () => 'sandbox.cube.test',
  }, { fetch: async () => { throw new Error('https://sandbox.cube.test/?token=provider-secret-token') } })
  await assert.rejects(failing.files.read('/tmp/archive.tar', { format: 'bytes' }), error => {
    assert.equal((error as Error).message, 'secured provider data-plane request failed')
    assert.ok(!(error as Error).message.includes('provider-secret-token'))
    return true
  })
})

test('secured data plane decodes bounded Connect command results', async () => {
  const stdout = Buffer.from('ok\n').toString('base64')
  const stream = Buffer.concat([
    frame({ event: { data: { stdout } } }),
    frame({ event: { end: { exitCode: 0 } } }),
    frame({}, 0x02),
  ])
  let headers = new Headers()
  const plane = new E2BSecureDataPlane({
    trafficAccessToken: 'provider-token', getHost: () => 'sandbox.cube.test',
  }, { fetch: async (_url, init = {}) => {
    headers = new Headers(init.headers)
    return response(200, stream)
  } })
  assert.deepEqual(await plane.commands.run('printf ok', { user: 'root', cwd: '/workspace' }), {
    stdout: 'ok\n', stderr: '', exitCode: 0,
  })
  assert.equal(headers.get('content-type'), 'application/connect+json')
  assert.equal(headers.get('e2b-traffic-access-token'), 'provider-token')
})

test('secured data plane rejects absent tokens and oversized file or command output', async () => {
  assert.throws(() => new E2BSecureDataPlane({ getHost: () => 'sandbox.cube.test' }),
    /secured provider data plane is unavailable/)
  const stream = Buffer.concat([
    frame({ event: { data: { stdout: Buffer.from('too large').toString('base64') } } }),
    frame({ event: { end: { exitCode: 0 } } }),
  ])
  const plane = new E2BSecureDataPlane({
    trafficAccessToken: 'provider-token', getHost: () => 'sandbox.cube.test',
  }, { maxCommandOutputBytes: 2, fetch: async () => response(200, stream) })
  await assert.rejects(plane.commands.run('true'), /provider command output limit exceeded/)

  const files = new E2BSecureDataPlane({
    trafficAccessToken: 'provider-token', getHost: () => 'sandbox.cube.test',
  }, { maxFileBytes: 2, fetch: async () => response(200, new Uint8Array([1, 2, 3])) })
  await assert.rejects(files.files.read('/tmp/archive.tar', { format: 'bytes' }), /provider file limit exceeded/)
})
