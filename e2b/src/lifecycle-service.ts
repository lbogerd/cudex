import type {
  CheckpointRequest,
  ProvisionedAgent,
  ProvisionRequest,
  ReconnectRequest,
  ReleaseRequest,
} from './types.js'
import { ServiceError } from './types.js'

export interface AgentLifecycleService {
  provision(request: ProvisionRequest): Promise<ProvisionedAgent>
  reconnect(request: ReconnectRequest): Promise<ProvisionedAgent>
  checkpoint(request: CheckpointRequest): Promise<{ snapshotId: string }>
  release(request: ReleaseRequest): Promise<void>
}

interface ProvisionService {
  provision(request: ProvisionRequest): Promise<ProvisionedAgent>
}

export interface PostgresLifecycleServices {
  immutableSource: ProvisionService
  durableRestore: ProvisionService
  child?: ProvisionService
  reconnect: Pick<AgentLifecycleService, 'reconnect'>
  checkpoint: Pick<AgentLifecycleService, 'checkpoint'>
  release: Pick<AgentLifecycleService, 'release'>
}

/** Routes every production lifecycle request to its source-specific PostgreSQL coordinator. */
export class PostgresLifecycleService implements AgentLifecycleService {
  constructor(private readonly services: PostgresLifecycleServices) {}

  provision(request: ProvisionRequest): Promise<ProvisionedAgent> {
    switch (request.source.type) {
      case 'sourceSnapshot': return this.services.immutableSource.provision(request)
      case 'durableSnapshot': return this.services.durableRestore.provision(request)
      case 'agentEnvironment': {
        if (!this.services.child) {
          throw new ServiceError(503, 'durable child command gate is unavailable')
        }
        return this.services.child.provision(request)
      }
      case 'rootWorkspace': throw new ServiceError(400, 'local workspace ingress is disabled')
    }
  }

  reconnect(request: ReconnectRequest): Promise<ProvisionedAgent> {
    return this.services.reconnect.reconnect(request)
  }

  checkpoint(request: CheckpointRequest): Promise<{ snapshotId: string }> {
    return this.services.checkpoint.checkpoint(request)
  }

  release(request: ReleaseRequest): Promise<void> {
    return this.services.release.release(request)
  }
}
