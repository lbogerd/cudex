import type { TrustedProvisionRole } from './postgres-provision.js'
import { contractLimits, validateToolPolicy } from './validation.js'

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

function name(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > maximum
    || Buffer.from(value, 'utf8').toString('utf8') !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('invalid trusted role configuration')
  }
  return value
}

export function validateTrustedRoles(value: unknown): Record<string, TrustedRole> {
  const input = record(value)
  const entries = Object.entries(input)
  if (entries.length === 0 || entries.length > 128) {
    throw new Error('invalid trusted role configuration')
  }
  const roles: Record<string, TrustedRole> = Object.create(null) as Record<string, TrustedRole>
  const templates = new Set<string>()
  for (const [untrustedAgentType, untrustedRole] of entries) {
    const agentType = name(untrustedAgentType, contractLimits.maxNameBytes)
    const role = record(untrustedRole, [
      'sandboxTemplate', 'providerTemplateId', 'toolPolicy', 'policyVersion',
    ])
    const sandboxTemplate = name(role.sandboxTemplate, contractLimits.maxNameBytes)
    const providerTemplateId = name(role.providerTemplateId, 512)
    if (templates.has(sandboxTemplate) || !Number.isSafeInteger(role.policyVersion)
      || Number(role.policyVersion) < 1 || Number(role.policyVersion) > 2_147_483_647) {
      throw new Error('invalid trusted role configuration')
    }
    templates.add(sandboxTemplate)
    let toolPolicy
    try { toolPolicy = validateToolPolicy(role.toolPolicy) }
    catch { throw new Error('invalid trusted role configuration') }
    roles[agentType] = {
      sandboxTemplate, providerTemplateId, toolPolicy,
      policyVersion: Number(role.policyVersion),
    }
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
