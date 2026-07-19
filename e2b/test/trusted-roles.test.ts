import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTrustedRoles, validateTrustedRoles } from '../src/trusted-roles.js'

const policy = {
  allowedDomains: ['agentEnvironment', 'controlPlane'],
  allowedTools: [{ name: 'exec_command', namespace: null }],
}

test('trusted role configuration accepts an exact bounded role map', () => {
  assert.deepEqual({ ...parseTrustedRoles(JSON.stringify({
    default: {
      sandboxTemplate: 'general-v1', providerTemplateId: 'provider-general-v1',
      toolPolicy: policy, policyVersion: 3,
    },
  })) }, {
    default: {
      sandboxTemplate: 'general-v1', providerTemplateId: 'provider-general-v1',
      toolPolicy: policy, policyVersion: 3,
    },
  })
})

test('trusted role configuration rejects extra fields, invalid policies, and ambiguous templates', () => {
  const role = {
    sandboxTemplate: 'general-v1', providerTemplateId: 'provider-general-v1',
    toolPolicy: policy, policyVersion: 1,
  }
  assert.throws(() => validateTrustedRoles({ default: { ...role, credential: 'secret' } }))
  assert.throws(() => validateTrustedRoles({
    default: { ...role, toolPolicy: { allowedDomains: ['unknown'], allowedTools: [] } },
  }))
  assert.throws(() => validateTrustedRoles({ default: role, second: { ...role } }))
  assert.throws(() => validateTrustedRoles({}))
  assert.throws(() => parseTrustedRoles('{'))
})
