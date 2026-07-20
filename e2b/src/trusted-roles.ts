import type { TrustedProvisionRole } from './postgres-provision.js'
import { contractLimits, validateToolPolicy } from './validation.js'
import { z } from 'zod'

export type TrustedRole = TrustedProvisionRole

function record(value: unknown, keys?: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('invalid trusted role configuration')
  }
  const result = value as Record<string, unknown>
  const ownKeys = Reflect.ownKeys(result)
  if (ownKeys.some(key => typeof key !== 'string')) throw new Error('invalid trusted role configuration')
  if (keys) {
    const actual = [...ownKeys as string[]].sort()
    const expected = [...keys].sort()
    if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
      throw new Error('invalid trusted role configuration')
    }
  }
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error('invalid trusted role configuration')
    }
  }
  return result
}

const name = (maximum: number) => z.string().min(1).refine(value => value === value.trim())
  .refine(value => Buffer.byteLength(value, 'utf8') <= maximum)
  .refine(value => Buffer.from(value, 'utf8').toString('utf8') === value)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value))

const roleSchema = z.strictObject({
  sandboxTemplate: name(contractLimits.maxNameBytes), providerTemplateId: name(512),
  toolPolicy: z.unknown().transform((value, context) => {
    try { return validateToolPolicy(value) } catch { context.addIssue({ code: 'custom' }); return z.NEVER }
  }),
  policyVersion: z.number().int().safe().min(1).max(2_147_483_647),
})

export function validateTrustedRoles(value: unknown): Record<string, TrustedRole> {
  const input = record(value)
  const entries = Object.entries(input)
  if (entries.length === 0 || entries.length > 128) {
    throw new Error('invalid trusted role configuration')
  }
  const roles: Record<string, TrustedRole> = Object.create(null) as Record<string, TrustedRole>
  const templates = new Set<string>()
  for (const [untrustedAgentType, untrustedRole] of entries) {
    const agentTypeResult = name(contractLimits.maxNameBytes).safeParse(untrustedAgentType)
    record(untrustedRole, ['sandboxTemplate', 'providerTemplateId', 'toolPolicy', 'policyVersion'])
    const roleResult = roleSchema.safeParse(untrustedRole)
    if (!agentTypeResult.success || !roleResult.success) throw new Error('invalid trusted role configuration')
    const agentType = agentTypeResult.data
    const { sandboxTemplate, providerTemplateId, toolPolicy, policyVersion } = roleResult.data
    if (templates.has(sandboxTemplate)) throw new Error('invalid trusted role configuration')
    templates.add(sandboxTemplate)
    roles[agentType] = { sandboxTemplate, providerTemplateId, toolPolicy, policyVersion }
  }
  return roles
}

export function parseTrustedRoles(value: string): Record<string, TrustedRole> {
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch { throw new Error('HOSTED_AGENT_ROLES must contain valid JSON') }
  try { return validateTrustedRoles(parsed) }
  catch { throw new Error('HOSTED_AGENT_ROLES is invalid') }
}
