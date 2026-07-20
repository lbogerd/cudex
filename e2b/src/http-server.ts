import type { ExecGateway } from './gateway.js'
import type { AgentLifecycleService } from './lifecycle-service.js'
import { createSilentLogger, type ServiceLogger } from './observability/logger.js'
import {
  createControlPlaneApp, sourceSnapshotContentType, type ControlPlaneDependencies,
} from './http/app.js'
import { startControlPlaneServer, type ListenerOptions } from './http/server.js'

export { createControlPlaneApp, sourceSnapshotContentType, startControlPlaneServer }

export interface ServerOptions extends ListenerOptions, Omit<ControlPlaneDependencies, 'lifecycle'> {
  bearerToken: string
  logger?: ServiceLogger
}

/** @deprecated Compose createControlPlaneApp and startControlPlaneServer directly. */
export async function startServer(
  lifecycle: AgentLifecycleService,
  gateway: ExecGateway,
  options: ServerOptions,
) {
  const { bearerToken, logger = createSilentLogger(), host, port, tlsCertPath, tlsKeyPath,
    allowInsecureHttp, ...dependencies } = options
  if (dependencies.sourceSnapshots && (!Number.isSafeInteger(dependencies.sourceSnapshots.maxArchiveBytes)
    || dependencies.sourceSnapshots.maxArchiveBytes <= 0
    || !Number.isSafeInteger(dependencies.sourceSnapshots.maxArchiveBytes + 64 * 1024 + 4))) {
    throw new Error('invalid source snapshot HTTP limit')
  }
  const app = createControlPlaneApp({ lifecycle, ...dependencies }, { bearerToken }, logger)
  return startControlPlaneServer(app, gateway, {
    host, port, ...(tlsCertPath ? { tlsCertPath } : {}), ...(tlsKeyPath ? { tlsKeyPath } : {}),
    ...(allowInsecureHttp === undefined ? {} : { allowInsecureHttp }),
  })
}
