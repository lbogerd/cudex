import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'
import { httpUrl, invalidEnvironment, nonemptyString, scopedRuntimeEnv, type RuntimeEnvironment } from './shared.js'

const keys = ['CUDEX_API_URL', 'CUDEX_API_KEY', 'CUDEX_DOMAIN', 'CUDEX_PROVIDER_CA_CERTIFICATE',
  'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'PATH'] as const

/** Scoped OS and setup inputs for the Cudex CLI and runner. */
export function loadCudexEnv(runtimeEnv: RuntimeEnvironment = process.env) {
  return createEnv({ server: {
    CUDEX_API_URL: httpUrl.optional(), CUDEX_API_KEY: nonemptyString.optional(),
    CUDEX_DOMAIN: nonemptyString.default('cube.app'), CUDEX_PROVIDER_CA_CERTIFICATE: nonemptyString.optional(),
    CODEX_HOME: nonemptyString.optional(), XDG_CONFIG_HOME: nonemptyString.optional(),
    XDG_STATE_HOME: nonemptyString.optional(), XDG_CACHE_HOME: nonemptyString.optional(),
    PATH: z.string().min(1).default('/usr/local/bin:/usr/bin:/bin'),
  }, runtimeEnv: scopedRuntimeEnv(runtimeEnv, keys), onValidationError: invalidEnvironment })
}
