import { timingSafeEqual } from 'node:crypto'

export function hasValidBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
