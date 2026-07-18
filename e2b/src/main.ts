import process from 'node:process'
import { resolve } from 'node:path'
import { JsonStore } from './store.js'
import { TicketIssuer } from './tickets.js'
import { E2BProvider } from './e2b-provider.js'
import { ControlPlane } from './service.js'
import { ExecGateway } from './gateway.js'
import { startServer } from './http-server.js'
import { BlobStore } from './blob-store.js'

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
const host = process.env.HOSTED_AGENT_HOST ?? '127.0.0.1'; const port = Number(process.env.HOSTED_AGENT_PORT ?? '8443')
const store = new JsonStore(resolve(process.env.HOSTED_AGENT_STATE_PATH ?? 'e2b/.state/control-plane.json')); await store.open()
const blobs = new BlobStore(resolve(process.env.HOSTED_AGENT_BLOB_PATH ?? 'e2b/.state/blobs'))
const connection = {
  apiKey: required('E2B_API_KEY'),
  ...(process.env.E2B_API_URL ? { apiUrl: process.env.E2B_API_URL } : {}),
  ...(process.env.E2B_DOMAIN ? { domain: process.env.E2B_DOMAIN } : {}),
  validateApiKey: process.env.E2B_VALIDATE_API_KEY !== 'false', requestTimeoutMs: 120_000,
}
const provider = new E2BProvider(connection)
const tickets = new TicketIssuer(store, required('HOSTED_AGENT_GATEWAY_URL'), Number(process.env.HOSTED_AGENT_TICKET_TTL_MS ?? '60000'))
const templates = JSON.parse(required('HOSTED_AGENT_TEMPLATES')) as Record<string, string>
const allowedRoots = required('HOSTED_AGENT_ALLOWED_ROOTS').split(':').map(root => resolve(root))
const service = new ControlPlane(store, provider, tickets, blobs, { templates, allowedRoots, ingress: { maxBytes: Number(process.env.HOSTED_AGENT_MAX_ARCHIVE_BYTES ?? 536_870_912), maxRoots: Number(process.env.HOSTED_AGENT_MAX_ROOTS ?? 8) } })
await service.reconcile()
const gateway = new ExecGateway(tickets, store, provider)
await startServer(service, gateway, { host, port, bearerToken: required('CODEX_HOSTED_AGENT_TOKEN'),
  ...(process.env.HOSTED_AGENT_TLS_CERT ? { tlsCertPath: process.env.HOSTED_AGENT_TLS_CERT } : {}),
  ...(process.env.HOSTED_AGENT_TLS_KEY ? { tlsKeyPath: process.env.HOSTED_AGENT_TLS_KEY } : {}) })
console.log(JSON.stringify({ event: 'control_plane_started', host, port, tls: Boolean(process.env.HOSTED_AGENT_TLS_CERT) }))
