import { readFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import type { Server as HttpServer } from 'node:http'
import { createAdaptorServer } from '@hono/node-server'
import type { Hono } from 'hono'
import type { ExecGateway } from '../gateway.js'

export interface ListenerOptions {
  host: string
  port: number
  tlsCertPath?: string
  tlsKeyPath?: string
  allowInsecureHttp?: boolean
}

export async function startControlPlaneServer(
  app: Pick<Hono<any>, 'fetch'>,
  gateway: ExecGateway,
  options: ListenerOptions,
): Promise<HttpServer | HttpsServer> {
  if (Boolean(options.tlsCertPath) !== Boolean(options.tlsKeyPath)) throw new Error('TLS certificate and key must be configured together')
  if (!options.tlsCertPath && !options.allowInsecureHttp) throw new Error('TLS is required unless development HTTP is explicitly enabled')
  const adapter = options.tlsCertPath && options.tlsKeyPath
    ? { createServer: createHttpsServer, serverOptions: {
      cert: await readFile(options.tlsCertPath), key: await readFile(options.tlsKeyPath),
    } }
    : {}
  const server = createAdaptorServer({ fetch: app.fetch, hostname: options.host, port: options.port,
    ...adapter }) as HttpServer | HttpsServer
  gateway.attach(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(options.port, options.host, resolve)
  })
  return server
}
