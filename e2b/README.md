# Custom Codex CubeSandbox template

See [ARCHITECTURE.md](ARCHITECTURE.md) for the package's dependency,
configuration, HTTP, logging, subprocess, and PostgreSQL boundaries.

For the Linux-only real-client owner/child proof, start with
[`poc/README.md`](poc/README.md).

Run these commands from the repository root. The pipeline builds the local Codex fork, creates an OCI image, publishes a CubeSandbox template, and verifies it through the E2B TypeScript SDK.

## One-time setup

1. Start CubeSandbox, its KVM backend, and the registry at `127.0.0.1:5000`.
2. Install build tools and the target used by the Codex fork:

   ```bash
   sudo apt-get install jq musl-tools
   cd codex/codex-rs
   toolchain=$(rustup show active-toolchain | awk '{print $1}')
   rustup target add --toolchain "${toolchain}" x86_64-unknown-linux-musl
   cd ../..
   ```

3. Install the pinned SDK dependencies:

   ```bash
   npm ci --prefix e2b
   ```

Passwordless `sudo` is required for Docker and `cubemastercli`.

## Build and publish

Run the stages in order:

```bash
./e2b/scripts/build-codex-artifact.sh
./e2b/scripts/build-template-image.sh
./e2b/scripts/publish-template.sh
```

Record the `build_id` and `template_id` printed by the scripts. Publishing waits until every CubeSandbox node reports the template ready.

| Output | Location |
| --- | --- |
| Static Codex binary and provenance | `e2b/.artifacts/codex/<build_id>/` |
| Image reference and digest | `e2b/.artifacts/images/<build_id>.json` |
| Template ID and provenance | `e2b/.artifacts/templates/<build_id>.json` |

Artifacts are ignored by Git. Distributable binaries are stripped by default; set `CODEX_STRIP_ARTIFACT=false` when symbols are needed.

## Verify

Load the local development credentials without printing them, then run the canary with the metadata created above:

```bash
set -a
source <(sudo cat /etc/cubesandbox/auth.env)
set +a
export E2B_API_KEY="${CUBESANDBOX_FULL_KEY}"
export E2B_API_URL=http://127.0.0.1:3000
export E2B_DOMAIN=cube.app
export E2B_VALIDATE_API_KEY=false
export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/mkcert_development_CA_246626769331356599751110303311906475686.crt
unset CUBESANDBOX_FULL_KEY CUBESANDBOX_READONLY_KEY CUBESANDBOX_API_KEY

npm run verify:template --prefix e2b -- e2b/.artifacts/templates/<build_id>.json
```

The canary checks the revision and binary checksum, starts `codex exec-server` on port `22101`, executes a process over its WSS protocol, and kills the sandbox. Success ends with `"verified": true`.

Run the lifecycle, recovery, and child-isolation canary with the same environment:

```bash
npm run lifecycle:canary --prefix e2b -- <template_id>
```

The external TypeScript control plane is under `e2b/src`. Build and run its
provider-independent contract/failure suite with `npm test --prefix e2b`. Runtime
configuration is supplied through scoped, validated `HOSTED_AGENT_*` variables; see
`e2b/src/config/service-env.ts` for the service configuration boundary. Boolean
values must be exactly `true` or `false`, and numeric values must be positive safe
integers rather than empty strings, fractions, or permissively coerced values. The
loader validates cross-field production, TLS, gateway, ticket, and archive-limit
requirements before infrastructure is constructed. Architecture results and remaining production work are in
[`../ARCHIVE.md`](../ARCHIVE.md) and [`../TODO.md`](../TODO.md).

Production deployments must set `HOSTED_AGENT_OBJECT_BUCKET`,
`HOSTED_AGENT_DATABASE_URL`, and the trusted single-tenant
identity `HOSTED_AGENT_TENANT_ID`. Every replica must also have a unique stable
`HOSTED_AGENT_WORKER_ID` for durable operation fencing. They may set
`HOSTED_AGENT_OBJECT_PREFIX`, `HOSTED_AGENT_OBJECT_REGION`, and
`HOSTED_AGENT_OBJECT_ENDPOINT` for an S3-compatible service. The standard AWS
credential provider chain supplies authenticated access; objects are encrypted
server-side, addressed by SHA-256, and verified on read. `HOSTED_AGENT_BLOB_PATH`
selects the development-only local store when no bucket is configured.

Production startup applies the checksummed PostgreSQL migrations under a
database-scoped advisory lock. They can also be applied explicitly before a
rollout:

```bash
HOSTED_AGENT_DATABASE_URL=postgresql://... npm run migrate --prefix e2b
```

Migrations are checksummed, serialized across replicas, and transactional. Set
`HOSTED_AGENT_TEST_DATABASE_URL` to include the live constraint and concurrent
migration test in `npm test`.

Service and infrastructure logs are newline-delimited Pino JSON on stdout. The
default level is `info`; deployments may select another Pino level with
`HOSTED_AGENT_LOG_LEVEL`. Records include a stable service field and component
child loggers add their component context. Authorization values, tokens, API
keys, credentials, database and connection URLs, command environments, and
request bodies are redacted. Failure records contain only bounded error
name/code metadata: arbitrary messages, causes, stacks, headers, bodies, and
URLs are never logged. Production does not include a pretty-printing transport;
operators may format JSON externally. Human-facing Cudex and POC command output
remains ordinary stdout and stderr presentation.

Application subprocesses are launched with Execa using executable/argument
arrays; shell execution is disabled. Commands that receive a scoped environment
do not implicitly inherit unrelated service secrets. Timeouts and output limits
remain explicit at each call site, while interactive Codex processes inherit
the terminal and forward termination signals. Template verification, release
verification, and the live lifecycle canary are compiled TypeScript commands
exposed through the `verify:template`, `verify:release`, and
`lifecycle:canary` npm scripts.

Trusted deployment tooling creates immutable source IDs with
`POST /v1/source-snapshots` and content type
`application/vnd.codex.source-snapshot.v1`. Its body is a four-byte big-endian
JSON metadata length, the metadata
`{checksum,cwdUri,workspaceRootUris,expiresAt}`, then the tar bytes. The bearer
maps to `HOSTED_AGENT_TENANT_ID`; tenant identity is never accepted in the body.
Use the returned `sourceSnapshotId` and checksum in
`[hosted_agents.source_snapshot]` so root provisioning contains no client-host
path.

Patch export and application are served from the same durable runtime at
`POST /v1/agents/patch/export` and `POST /v1/agents/patch/apply`; neither falls
back to the JSON control plane. Apply returns the exact tagged `applied`,
`conflict`, or `rejected` result, and a normal conflict is HTTP 200.
Lifecycle wire types are inferred from the strict Zod schemas in
`src/contracts/lifecycle.ts`, and those same schemas parse HTTP requests and
service responses. They enforce exact JSON shapes, UTF-8 byte limits, canonical
file URLs, workspace containment, and sorted unique collections. Invalid input
is reported as a sanitized `400`; invalid service output is a sanitized `503`.
`HOSTED_AGENT_ARTIFACT_TTL_MS` controls artifact retention and defaults to seven
days. The apply-only reconciler claims no other operation types;
`HOSTED_AGENT_PATCH_APPLY_STALE_MS` and
`HOSTED_AGENT_PATCH_APPLY_RECONCILE_MS` default to five minutes and 30 seconds.

Production mode requires a TLS certificate/key pair and a `wss:`
`HOSTED_AGENT_GATEWAY_URL`. Plain HTTP and `ws:` are accepted only when
`HOSTED_AGENT_DEVELOPMENT=true`; that switch also identifies the local filesystem
object store and co-located path ingress as non-production adapters. Gateway
payload, connection, pending-message, and backpressure limits have bounded
defaults and corresponding `HOSTED_AGENT_GATEWAY_MAX_*` overrides.

## Overrides

## Typed SQL generation

PostgreSQL migrations remain the schema source of truth. Production data queries are authored as
named SQL under `src/db/queries`; PgTyped validates them against a randomly named temporary schema
and emits reviewed `*.queries.ts` beside each source file. Set `HOSTED_AGENT_TEST_DATABASE_URL`, run
`npm run sql:generate --prefix e2b`, and commit the SQL and generated TypeScript together. CI and
reviewers use `npm run sql:check --prefix e2b`, which generates in an isolated directory and compares
the bytes without exposing the database URL.

- `CODEX_BUILD_TARGET`, `CODEX_BUILD_PROFILE`, `CODEX_ARTIFACT_DIR`: artifact build settings.
- `CODEX_BUILD_ID`: select an existing artifact explicitly.
- `CUBE_BASE_IMAGE`: CubeSandbox/envd base image; default `cubesandbox-codex:0.1.0`.
- `CUBE_IMAGE_REF`: registry and image tag.
- `CUBE_PUSH_IMAGE=0`: build without pushing.
- `CUBE_IMAGE_METADATA`: image metadata used for publishing.
- `CUBE_WRITABLE_LAYER_SIZE`: writable sandbox disk; default `20Gi`.

The template exposes envd on `49983` and Codex on `22101`. The backend must start `codex exec-server --listen ws://0.0.0.0:22101` after sandbox creation; it is intentionally not an image entrypoint.

## Remove a development template

```bash
sudo cubemastercli tpl delete --template-id <template_id>
```

This setup assumes the current trusted private development network. Revisit credentials, TLS, network exposure, and sandbox policy before using it in another environment.
