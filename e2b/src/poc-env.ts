import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'
import { explicitBoolean, httpUrl, invalidEnvironment, nonemptyString, positiveInteger, scopedRuntimeEnv } from './config/shared.js'

export const pocEnvKeys = [
  'E2B_API_KEY', 'E2B_API_URL', 'E2B_DOMAIN', 'E2B_VALIDATE_API_KEY', 'POC_PROVIDER_CA_CERTIFICATE',
  'POC_TEMPLATE_METADATA',
  'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_JSON_FILE', 'POC_CODEX_MODEL',
  'POC_CONTROL_PORT', 'POC_POSTGRES_PORT', 'POC_GARAGE_PORT',
  'POC_KEEP_ON_FAILURE', 'POC_VERIFY_TEMPLATE',
] as const

export interface PocEnvironment {
  e2bApiKey: string
  e2bApiUrl: string
  e2bDomain: string
  e2bValidateApiKey: boolean
  providerCaCertificate?: string
  templateMetadata: string
  accessToken?: string
  authJsonFile?: string
  codexModel?: string
  controlPort: number
  postgresPort: number
  garagePort: number
  keepOnFailure: boolean
  verifyTemplate: boolean
  workspaceMode?: 'git-working-set'
}

type RawEnvironment = Record<string, string | undefined>
const allowed = new Set<string>(pocEnvKeys)

const tcpPort = (fallback: number) => positiveInteger(fallback).refine(value => value <= 65_535, 'must be a TCP port')

export function validatePocEnvironment(raw: RawEnvironment): PocEnvironment {
  for (const key of Object.keys(raw)) {
    if ((key.startsWith('POC_') || key.startsWith('E2B_') || key.startsWith('CODEX_')) && !allowed.has(key)) {
      throw new Error(`unknown POC configuration key: ${key}`)
    }
  }
  for (const key of ['E2B_VALIDATE_API_KEY', 'POC_KEEP_ON_FAILURE', 'POC_VERIFY_TEMPLATE'] as const) {
    if (raw[key] !== undefined && raw[key] !== 'true' && raw[key] !== 'false') throw new Error(`${key} must be true or false`)
  }
  for (const key of ['POC_CONTROL_PORT', 'POC_POSTGRES_PORT', 'POC_GARAGE_PORT'] as const) {
    if (raw[key] !== undefined && (!/^[1-9]\d{0,4}$/u.test(raw[key]) || Number(raw[key]) > 65_535)) {
      throw new Error(`${key} must be a TCP port`)
    }
  }
  if (raw.CODEX_ACCESS_TOKEN?.trim() && raw.CODEX_ACCESS_TOKEN !== raw.CODEX_ACCESS_TOKEN.trim()) {
    throw new Error('CODEX_ACCESS_TOKEN must not have surrounding whitespace')
  }
  const absentWhenEmpty = z.preprocess(value => value === '' ? undefined : value, nonemptyString.optional())
  const env = createEnv({ server: {
    E2B_API_KEY: nonemptyString, E2B_API_URL: httpUrl, E2B_DOMAIN: nonemptyString.default('cube.app'),
    E2B_VALIDATE_API_KEY: explicitBoolean.default(true), POC_PROVIDER_CA_CERTIFICATE: nonemptyString.optional(),
    POC_TEMPLATE_METADATA: nonemptyString, CODEX_ACCESS_TOKEN: absentWhenEmpty,
    CODEX_AUTH_JSON_FILE: absentWhenEmpty, POC_CODEX_MODEL: absentWhenEmpty,
    POC_CONTROL_PORT: tcpPort(18_443), POC_POSTGRES_PORT: tcpPort(15_432), POC_GARAGE_PORT: tcpPort(13_900),
    POC_KEEP_ON_FAILURE: explicitBoolean.default(false), POC_VERIFY_TEMPLATE: explicitBoolean.default(false),
  }, runtimeEnv: scopedRuntimeEnv(raw, pocEnvKeys), onValidationError: invalidEnvironment })
  if (Boolean(env.CODEX_ACCESS_TOKEN) === Boolean(env.CODEX_AUTH_JSON_FILE)) {
    throw new Error('configure exactly one of CODEX_ACCESS_TOKEN and CODEX_AUTH_JSON_FILE')
  }
  const ports = { controlPort: env.POC_CONTROL_PORT, postgresPort: env.POC_POSTGRES_PORT,
    garagePort: env.POC_GARAGE_PORT }
  if (new Set(Object.values(ports)).size !== 3) throw new Error('POC ports must be distinct')
  return {
    e2bApiKey: env.E2B_API_KEY, e2bApiUrl: env.E2B_API_URL, e2bDomain: env.E2B_DOMAIN,
    e2bValidateApiKey: env.E2B_VALIDATE_API_KEY,
    ...(env.POC_PROVIDER_CA_CERTIFICATE ? { providerCaCertificate: env.POC_PROVIDER_CA_CERTIFICATE } : {}),
    templateMetadata: env.POC_TEMPLATE_METADATA,
    ...(env.CODEX_ACCESS_TOKEN ? { accessToken: env.CODEX_ACCESS_TOKEN } : {}),
    ...(env.CODEX_AUTH_JSON_FILE ? { authJsonFile: env.CODEX_AUTH_JSON_FILE } : {}),
    ...(env.POC_CODEX_MODEL ? { codexModel: env.POC_CODEX_MODEL } : {}),
    ...ports,
    keepOnFailure: env.POC_KEEP_ON_FAILURE, verifyTemplate: env.POC_VERIFY_TEMPLATE,
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
