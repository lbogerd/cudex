import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'

export const pocEnvKeys = [
  'E2B_API_KEY', 'E2B_API_URL', 'E2B_DOMAIN', 'POC_TEMPLATE_METADATA',
  'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_JSON_FILE', 'POC_CODEX_MODEL',
  'POC_CONTROL_PORT', 'POC_POSTGRES_PORT', 'POC_GARAGE_PORT',
  'POC_KEEP_ON_FAILURE', 'POC_VERIFY_TEMPLATE',
] as const

export interface PocEnvironment {
  e2bApiKey: string
  e2bApiUrl: string
  e2bDomain: string
  templateMetadata: string
  accessToken?: string
  authJsonFile?: string
  codexModel?: string
  controlPort: number
  postgresPort: number
  garagePort: number
  keepOnFailure: boolean
  verifyTemplate: boolean
}

type RawEnvironment = Record<string, string | undefined>
const allowed = new Set<string>(pocEnvKeys)

function value(raw: RawEnvironment, key: string): string | undefined {
  const result = raw[key]?.trim()
  return result ? result : undefined
}

function required(raw: RawEnvironment, key: string): string {
  const result = value(raw, key)
  if (!result) throw new Error(`${key} is required`)
  return result
}

function port(raw: RawEnvironment, key: string, fallback: number): number {
  const text = value(raw, key)
  if (text === undefined) return fallback
  if (!/^(?:[1-9]\d{0,4})$/u.test(text)) throw new Error(`${key} must be a TCP port`)
  const result = Number(text)
  if (result > 65_535) throw new Error(`${key} must be a TCP port`)
  return result
}

function bool(raw: RawEnvironment, key: string, fallback: boolean): boolean {
  const text = value(raw, key)
  if (text === undefined) return fallback
  if (text !== 'true' && text !== 'false') throw new Error(`${key} must be true or false`)
  return text === 'true'
}

export function validatePocEnvironment(raw: RawEnvironment): PocEnvironment {
  for (const key of Object.keys(raw)) {
    if ((key.startsWith('POC_') || key.startsWith('E2B_') || key.startsWith('CODEX_')) && !allowed.has(key)) {
      throw new Error(`unknown POC configuration key: ${key}`)
    }
  }
  const accessToken = value(raw, 'CODEX_ACCESS_TOKEN')
  const authJsonFile = value(raw, 'CODEX_AUTH_JSON_FILE')
  if (Boolean(accessToken) === Boolean(authJsonFile)) {
    throw new Error('configure exactly one of CODEX_ACCESS_TOKEN and CODEX_AUTH_JSON_FILE')
  }
  const ports = {
    controlPort: port(raw, 'POC_CONTROL_PORT', 18_443),
    postgresPort: port(raw, 'POC_POSTGRES_PORT', 15_432),
    garagePort: port(raw, 'POC_GARAGE_PORT', 13_900),
  }
  if (new Set(Object.values(ports)).size !== 3) throw new Error('POC ports must be distinct')
  return {
    e2bApiKey: required(raw, 'E2B_API_KEY'),
    e2bApiUrl: required(raw, 'E2B_API_URL'),
    e2bDomain: value(raw, 'E2B_DOMAIN') ?? 'cube.app',
    templateMetadata: required(raw, 'POC_TEMPLATE_METADATA'),
    ...(accessToken ? { accessToken } : {}),
    ...(authJsonFile ? { authJsonFile } : {}),
    ...(value(raw, 'POC_CODEX_MODEL') ? { codexModel: value(raw, 'POC_CODEX_MODEL')! } : {}),
    ...ports,
    keepOnFailure: bool(raw, 'POC_KEEP_ON_FAILURE', false),
    verifyTemplate: bool(raw, 'POC_VERIFY_TEMPLATE', false),
  }
}

export async function loadPocEnvironment(path: string): Promise<PocEnvironment> {
  let source: string
  try { source = await readFile(path, 'utf8') }
  catch { throw new Error(`POC configuration file is missing: ${path}`) }
  let parsed: RawEnvironment
  try { parsed = parseEnv(source) }
  catch { throw new Error(`POC configuration file is invalid: ${path}`) }
  return validatePocEnvironment(parsed)
}
