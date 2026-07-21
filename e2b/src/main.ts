import { buildControlPlaneRuntime, startControlPlaneRuntime } from './bootstrap.js'
import { loadServiceEnv } from './config/service-env.js'
import { createServiceLogger } from './observability/logger.js'

const config = loadServiceEnv()
const logger = createServiceLogger({ level: config.logLevel })
const runtime = await buildControlPlaneRuntime(config, logger)
await startControlPlaneRuntime(runtime)
logger.info({ event: 'control_plane_started', host: config.http.host, port: config.http.port,
  tls: Boolean(config.tls.certificatePath) })
