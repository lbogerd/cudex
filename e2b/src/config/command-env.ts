import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'
import { invalidEnvironment, nonemptyString, scopedRuntimeEnv, type RuntimeEnvironment } from './shared.js'

export function loadMigrationEnv(runtimeEnv: RuntimeEnvironment = process.env): { databaseUrl: string } {
  if (runtimeEnv.DATABASE_URL && !runtimeEnv.HOSTED_AGENT_DATABASE_URL) throw new Error('DATABASE_URL is not supported; use HOSTED_AGENT_DATABASE_URL')
  const env = createEnv({ server: { HOSTED_AGENT_DATABASE_URL: z.url() },
    runtimeEnv: scopedRuntimeEnv(runtimeEnv, ['HOSTED_AGENT_DATABASE_URL']), onValidationError: invalidEnvironment })
  return { databaseUrl: env.HOSTED_AGENT_DATABASE_URL }
}

export function loadSqlGenerationEnv(runtimeEnv: RuntimeEnvironment = process.env): { databaseUrl: string } {
  const env = createEnv({ server: { HOSTED_AGENT_TEST_DATABASE_URL: z.url() },
    runtimeEnv: scopedRuntimeEnv(runtimeEnv, ['HOSTED_AGENT_TEST_DATABASE_URL']), onValidationError: invalidEnvironment })
  return { databaseUrl: env.HOSTED_AGENT_TEST_DATABASE_URL }
}

export function loadSourceSnapshotCommandEnv(runtimeEnv: RuntimeEnvironment, bearerVariable: string) {
  const env = createEnv({ server: { value: nonemptyString }, runtimeEnv: { value: runtimeEnv[bearerVariable] },
    onValidationError: invalidEnvironment })
  return { bearerToken: env.value, path: runtimeEnv.PATH }
}

export function loadCommandOsEnv(runtimeEnv: RuntimeEnvironment = process.env) {
  const env = createEnv({ server: {
    PATH: z.string().min(1).default('/usr/local/bin:/usr/bin:/bin'),
    DOCKER_HOST: nonemptyString.optional(), DOCKER_CONTEXT: nonemptyString.optional(),
    NODE_EXTRA_CA_CERTS: nonemptyString.optional(), E2B_VALIDATE_API_KEY: nonemptyString.optional(),
  }, runtimeEnv: scopedRuntimeEnv(runtimeEnv,
    ['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'NODE_EXTRA_CA_CERTS', 'E2B_VALIDATE_API_KEY']), onValidationError: invalidEnvironment })
  return Object.freeze({ path: env.PATH, dockerHost: env.DOCKER_HOST,
    dockerContext: env.DOCKER_CONTEXT, nodeExtraCaCerts: env.NODE_EXTRA_CA_CERTS,
    e2bValidateApiKey: env.E2B_VALIDATE_API_KEY })
}
