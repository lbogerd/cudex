import { ServiceError } from '../../types.js'

export function enforceContentLength(request: Request, maximum: number): void {
  const raw = request.headers.get('content-length')
  if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) > maximum)) {
    throw new ServiceError(/^\d+$/.test(raw) ? 413 : 400, /^\d+$/.test(raw) ? 'request too large' : 'invalid content length')
  }
}

export async function boundedBytes(request: Request, maximum: number): Promise<Uint8Array> {
  enforceContentLength(request, maximum)
  const value = new Uint8Array(await request.arrayBuffer())
  if (value.byteLength > maximum) throw new ServiceError(413, 'request too large')
  return value
}

export async function requiredJson(request: Request, maximum: number): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new ServiceError(415, 'unsupported media type')
  const body = await boundedBytes(request, maximum)
  try { return JSON.parse(Buffer.from(body).toString('utf8')) }
  catch { throw new ServiceError(400, 'invalid JSON') }
}
