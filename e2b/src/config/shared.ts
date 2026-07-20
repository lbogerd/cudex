import { z } from 'zod'

export type RuntimeEnvironment = Record<string, string | undefined>

export const explicitBoolean = z.enum(['true', 'false']).transform(value => value === 'true')

export function positiveInteger(defaultValue?: number) {
  const schema = z.string().regex(/^[1-9]\d*$/u).transform(Number)
    .refine(Number.isSafeInteger, 'must be a positive safe integer')
  return defaultValue === undefined ? schema : schema.default(defaultValue)
}

export const nonemptyString = z.string().min(1).refine(value => value === value.trim(),
  'must not have surrounding whitespace')

export const httpUrl = z.url().refine(value => {
  const parsed = new URL(value)
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password
}, 'must be an HTTP(S) URL without credentials')

export function scopedRuntimeEnv(runtimeEnv: RuntimeEnvironment, keys: readonly string[]): RuntimeEnvironment {
  return Object.fromEntries(keys.map(key => [key, runtimeEnv[key]]))
}

export function invalidEnvironment(): never { throw new Error('Invalid environment variables') }
