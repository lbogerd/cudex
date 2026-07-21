import {
  CheckpointRequestSchema, CheckpointResponseSchema, ProvisionedAgentSchema, ProvisionRequestSchema,
  ReconnectRequestSchema, ReleaseRequestSchema,
} from '../../contracts/lifecycle.js'

export const lifecycleRouteDefinitions = [
  ['/v1/agents/provision', 'provision', ProvisionRequestSchema, ProvisionedAgentSchema],
  ['/v1/agents/reconnect', 'reconnect', ReconnectRequestSchema, ProvisionedAgentSchema],
  ['/v1/agents/checkpoint', 'checkpoint', CheckpointRequestSchema, CheckpointResponseSchema],
  ['/v1/agents/release', 'release', ReleaseRequestSchema, undefined],
] as const
