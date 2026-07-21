import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino'

export type ServiceLogger = Logger

export interface LoggerFactoryOptions {
  level?: string
  service?: string
  destination?: DestinationStream
}

export interface InfrastructureLoggers {
  http: ServiceLogger
  gateway: ServiceLogger
  reconciliation: ServiceLogger
  provider: ServiceLogger
  workspaceTransfer: ServiceLogger
}

const redactionPaths = [
  'authorization', '*.authorization', 'headers.authorization', '*.headers.authorization',
  'token', '*.token', '*.*.token', 'apiKey', '*.apiKey', '*.*.apiKey',
  'credentials', '*.credentials', '*.*.credentials',
  'databaseUrl', '*.databaseUrl', '*.*.databaseUrl',
  'connectionUrl', '*.connectionUrl', '*.*.connectionUrl',
  'commandEnv', '*.commandEnv', '*.*.commandEnv',
  'request.body', '*.request.body', 'body', '*.body',
]

export function createServiceLogger(options: LoggerFactoryOptions = {}): ServiceLogger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service ?? 'hosted-agent-control-plane' },
    redact: { paths: redactionPaths, censor: '[Redacted]' },
  }
  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions)
}

export function createSilentLogger(): ServiceLogger {
  return pino({ level: 'silent' })
}

export function componentLogger(logger: ServiceLogger, component: string): ServiceLogger {
  return logger.child({ component })
}

export function createInfrastructureLoggers(logger: ServiceLogger): InfrastructureLoggers {
  return {
    http: componentLogger(logger, 'http'),
    gateway: componentLogger(logger, 'gateway'),
    reconciliation: componentLogger(logger, 'reconciliation'),
    provider: componentLogger(logger, 'provider'),
    workspaceTransfer: componentLogger(logger, 'workspace-transfer'),
  }
}

export function safeFailureDiagnostic(error: unknown): { errorType: string; errorCode?: string } {
  let current = error
  let errorType = 'UnknownError'
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as { name?: unknown; code?: unknown; cause?: unknown }
    if (typeof record.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(record.name)) {
      errorType = record.name
    }
    if (typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(record.code)) {
      return { errorType, errorCode: record.code }
    }
    current = record.cause
  }
  return { errorType }
}
