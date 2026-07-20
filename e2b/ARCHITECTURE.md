# E2B package architecture

PostgreSQL migrations remain the schema source of truth, and repositories remain
the future persistence-replacement seam.

## Dependency ownership

- Zod owns wire, persisted-data, manifest, and command-input schemas; boundary
  types are inferred from those schemas.
- T3 Env owns entry-point-specific environment parsing. Validated immutable
  configuration is passed into composition.
- Hono owns routing, middleware, errors, and HTTP messages;
  `@hono/node-server` owns the Node HTTP/HTTPS adapter.
- Pino owns operational service logs. Human-facing CLI output remains ordinary
  stdout/stderr.
- Execa owns child launch and lifecycle plumbing. Process-identity checks and
  bounded graceful-then-forced termination remain domain policy.
- PgTyped owns production data queries; `pg` owns pools, clients, transaction
  sessions, migrations, and generated-query execution.

## Configuration, HTTP, and contracts

Scoped loaders under `src/config` accept injectable environment mappings, apply
primitive and cross-field rules, and do not force unrelated commands to provide
service secrets. `main.ts` is the executable boundary and `bootstrap.ts` composes
the runtime from validated configuration and an injected logger.

Schemas under `src/contracts` are the single source for JSON wires. The pure
`createControlPlaneApp` interface never opens a socket. Routes are grouped by
lifecycle, source-snapshot, and POC inspection. The Node listener attaches the
WebSocket gateway before listening. JSON routes require `application/json`; the
source route retains its bounded binary envelope. Errors expose sanitized client
or service failures only.

## Logging and subprocesses

The root logger emits JSON with stable service context and component children.
Authorization, credentials, connection material, database URLs, command
environments, and request bodies are redacted. Failure diagnostics contain only
bounded error name/code metadata.

Subprocesses use executable/argument arrays without a shell. Explicit child
environments are allowlisted; output and time are bounded where appropriate; and
long-lived children use graceful termination followed by bounded escalation.

## PostgreSQL and PgTyped

SQL sources and committed generated TypeScript live under `src/db/queries`.
`sql:generate` creates an isolated migrated schema and invokes the local PgTyped
CLI without exposing its connection. `sql:check` regenerates into a temporary
tree and byte-compares output. Runtime builds require neither generation nor a
database.

Coordinators own transaction boundaries where atomicity is a lifecycle property.
Generated queries receive the active `PoolClient`. Raw SQL is approved only for
migrations, tests, and transaction, session-setting, or advisory-lock operations
isolated in `src/db/primitives.ts`. Blob operations stay outside SQL repositories;
JSONB values are decoded with their owning Zod schemas.

OpenAPI and ORM adoption are deferred. OpenAPI evaluation must cover
schema-to-document tooling, route metadata, document validation, and client
generation. ORM evaluation—including Drizzle—must demonstrate a material
repository/transaction improvement without adding parallel schema or migration
authority.
