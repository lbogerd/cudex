# Hosted Agent Backend Integration Guide

This guide describes how to implement a real service behind Codex's hosted-agent
runtime, with E2B as the first target provider. It is an integration contract and
build sequence, not a replacement for the provider's SDK documentation.

The Codex-side sources of truth are:

- [`codex/codex-rs/hosted-agent/src/types.rs`](codex/codex-rs/hosted-agent/src/types.rs) for
  request, response, lifecycle, and service types;
- [`codex/codex-rs/hosted-agent/src/http.rs`](codex/codex-rs/hosted-agent/src/http.rs) for
  the HTTP routes, status mapping, authentication, and response limits;
- [`codex/codex-rs/hosted-agent/src/fake.rs`](codex/codex-rs/hosted-agent/src/fake.rs) for a
  reference implementation of idempotency, snapshot isolation, patch export,
  three-way application, and release behavior;
- [`codex/codex-rs/core/src/hosted_agent_runtime.rs`](codex/codex-rs/core/src/hosted_agent_runtime.rs)
  for Codex's provisioning, reconnect, restore, and tool-policy expectations;
- [`plan-for-hosted-full-agent-runtime.md`](plan-for-hosted-full-agent-runtime.md)
  for the completed Codex-side design.

## What to build

Do not add E2B SDK calls directly to `codex-core`. Codex already contains the
provider-neutral `HttpHostedAgentService`. Build an external HTTPS control plane
that implements its six operations, and keep E2B credentials and provider details
inside that service.

```text
                         HTTPS control requests
 Codex app-server  ─────────────────────────────────> Hosted-agent control plane
       │                                                       │
       │                                                       ├── database
       │                                                       ├── artifact store
       │                                                       └── E2B API
       │                                                               │
       │ transient, authenticated WSS                                  │ lifecycle
       └──────────────────────────────> Exec gateway ───────────────────┘
                                              │
                                              │ proxied WebSocket
                                              ▼
                                     codex exec-server in E2B
```

The control plane owns leases, E2B sandbox IDs, snapshots, patch artifacts,
idempotency records, and cleanup. The exec gateway owns authentication and
connectivity to the `codex exec-server` running inside a sandbox. These can be
one deployment initially, but they are separate trust boundaries.

## Resolve these integration gates first

Three details should be proven with a small E2B spike before building every
endpoint.

### 1. Initial workspace ingress

A root provision request contains canonical `file:` URIs for `cwd` and
`workspaceRoots`; it does not upload file contents. A remote control plane cannot
dereference paths on the Codex host.

Choose one of these designs before implementing root provisioning:

1. **Co-located bridge for the first integration.** Run the control plane with a
   read-only mount of the same workspace and an allowlist of roots it may copy.
   Materialize those roots into E2B with the filesystem SDK or an archive upload.
2. **Durable source service.** Have the product place a workspace snapshot in an
   authenticated object store and make the path URIs resolvable through trusted
   deployment metadata.
3. **Extend the Codex contract.** Add an explicit upload capability or opaque
   source-snapshot ID to root provisioning. This is the right long-term design
   when the hosting service cannot share the Codex filesystem.

Do not interpret arbitrary `file:` URIs on an unrelated service host, silently
create an empty workspace, or clone only the repository's last commit. All three
would run the agent against a different project state from the user.

### 2. Authenticated WebSocket transport

`ProvisionedAgent.connection.execServerUrl` is the only connection material Codex
accepts today. It must be a `wss://` URL. The exec client does not accept arbitrary
headers, although query parameters are allowed and the complete URL remains
transient.

E2B exposes a sandbox port at a host such as
`<port>-<sandbox-id>.e2b.app`. Current E2B APIs also return a traffic access token
when public traffic is restricted. Confirm the supported authentication transport
for WebSocket upgrades with the exact E2B SDK/API version you pin; the public docs
describe the token but do not currently define a URL-only WebSocket handshake for
this use case.

The recommended production design is a service-owned WSS gateway:

- Codex receives a short-lived, opaque URL such as
  `wss://exec.example/leases/<opaque>?ticket=<single-purpose-token>`.
- The gateway validates the ticket, identifies the lease, supplies any E2B proxy
  authentication, and forwards frames to the sandbox port.
- The ticket is scoped to one lease and connection purpose, rotates on reconnect,
  expires quickly, and is never logged.
- The raw `codex exec-server` port is not publicly reachable without either the
  service gateway or an in-sandbox authenticating proxy.

For a proof of concept, an in-sandbox proxy may validate a per-lease query token
and forward to `codex exec-server` on loopback. Do not expose the unauthenticated
exec server directly, even temporarily in a shared environment.

### 3. Snapshot disconnect recovery

E2B snapshots capture filesystem and memory state, but creating one briefly pauses
the sandbox and drops WebSocket connections. Codex checkpoints after every
successful hosted turn. Verify this sequence end to end:

1. execute a command through the registered environment;
2. call `checkpoint` and wait for E2B snapshot completion;
3. let the existing Codex exec client reconnect through the same logical lease;
4. execute another command without restarting the Codex thread.

Do the same while spawning a child, because `agentEnvironment` provisioning must
atomically snapshot the owner's current workspace. Treat failure of either canary
as an architecture issue, not a retryable test flake.

E2B documents the relevant behavior in its
[sandbox snapshots](https://e2b.dev/docs/sandbox/snapshots),
[persistence](https://e2b.dev/docs/sandbox/persistence), and
[connect](https://e2b.dev/docs/sandbox/connect) guides.

## HTTP contract

### Transport and authentication

Codex reads the service bearer token from `CODEX_HOSTED_AGENT_TOKEN`. Every request
is a JSON `POST` with:

```http
Authorization: Bearer <CODEX_HOSTED_AGENT_TOKEN>
Content-Type: application/json
```

The configured base URL must be absolute HTTPS with no credentials, query, or
fragment. Codex follows no redirects, uses a 10-second connect timeout and a
30-second overall request timeout, and rejects decoded response bodies larger than
1 MiB. Run the service behind TLS in development too; plain HTTP is accepted only
by Codex's unit-test constructor.

If `service_url` is `https://host/control/`, the routes are below that prefix, for
example `https://host/control/v1/agents/provision`.

### Routes

| Operation | Route | Successful response |
| --- | --- | --- |
| provision | `POST v1/agents/provision` | `ProvisionedAgent` JSON |
| reconnect | `POST v1/agents/reconnect` | `ProvisionedAgent` JSON |
| checkpoint | `POST v1/agents/checkpoint` | `AgentCheckpoint` JSON |
| export patch | `POST v1/agents/patch/export` | `AgentPatchArtifact` JSON |
| apply patch | `POST v1/agents/patch/apply` | tagged `PatchApplyResult` JSON |
| release | `POST v1/agents/release` | any empty successful response, preferably `204` |

All field and tagged-union names are camel case. `ThreadId` is a string, and a
path is a canonical `file:` URI rather than an operating-system path string.
Provision responses must return `cwd` and roots in the sandbox's filesystem
namespace. Do not echo host paths when the E2B workspace is mounted elsewhere.

### Provision

A new root looks like:

```json
{
  "agentId": "019c...",
  "ownerAgentId": null,
  "agentType": "default",
  "sandboxTemplate": "general-v1",
  "source": {
    "type": "rootWorkspace",
    "cwd": "file:///workspace/project",
    "workspaceRoots": ["file:///workspace/project"]
  },
  "idempotencyKey": "hosted-agent:019c...:provision"
}
```

A child, reviewer, or guardian delegate uses its owner's live lease:

```json
{
  "agentId": "019d...",
  "ownerAgentId": "019c...",
  "agentType": "researcher",
  "sandboxTemplate": "research-v1",
  "source": {
    "type": "agentEnvironment",
    "ownerLeaseId": "lease_abc"
  },
  "idempotencyKey": "hosted-agent:019d...:provision"
}
```

Restoring a missing lease uses:

```json
{
  "agentId": "019d...",
  "ownerAgentId": "019c...",
  "agentType": "researcher",
  "sandboxTemplate": "research-v1",
  "source": {
    "type": "durableSnapshot",
    "snapshotId": "snapshot_xyz"
  },
  "idempotencyKey": "hosted-agent:019d...:snapshot:snapshot_xyz:restore"
}
```

Return a unique lease and environment:

```json
{
  "leaseId": "lease_abc",
  "environmentId": "env_abc",
  "connection": {
    "execServerUrl": "wss://exec.example/leases/lease_abc?ticket=REDACTED"
  },
  "cwd": "file:///workspace/project",
  "workspaceRoots": ["file:///workspace/project"],
  "baseSnapshotId": "snapshot_base",
  "toolPolicy": {
    "allowedDomains": ["agentEnvironment", "controlPlane"],
    "allowedTools": [
      { "name": "exec_command", "namespace": null },
      { "name": "write_stdin", "namespace": null },
      { "name": "apply_patch", "namespace": null },
      { "name": "view_image", "namespace": null },
      { "name": "update_plan", "namespace": null },
      { "name": "spawn_agent", "namespace": null },
      { "name": "send_message", "namespace": null },
      { "name": "wait_agent", "namespace": null }
    ]
  }
}
```

The example policy is illustrative. Codex requires both the tool's exact name and
its coarse domain to be granted. An empty `allowedTools` set denies every tool,
even when domains are present. Start with a role-specific minimum and add exact
tools deliberately. The available domain strings are:

- `agentEnvironment`
- `controlPlane`
- `providerHosted`
- `environmentBoundMcp`
- `ambientMcp`
- `clientCallback`
- `extension`
- `orchestratorProcess`

Codex always denies ambient MCP in hosted mode and requires environment-bound MCP
tools to match the lease's environment ID. Avoid granting `orchestratorProcess`;
it represents execution outside the hosted agent environment.

Provisioning is one transaction from Codex's perspective. If E2B creates a
sandbox but workspace upload, exec-server startup, gateway registration, snapshot
creation, or response persistence fails, the control plane must kill the partial
sandbox before returning an error. Codex has no lease ID with which to clean up a
failed provision response.

### Reconnect

Request:

```json
{
  "leaseId": "lease_abc",
  "idempotencyKey": "hosted-agent:019c...:lease:lease_abc:reconnect"
}
```

Reconnect or resume the same E2B sandbox, verify that the exec-server is healthy,
rotate transient gateway credentials, and return a complete `ProvisionedAgent`.
Keep `leaseId`, `environmentId`, `cwd`, `workspaceRoots`, base snapshot, and tool
policy logically stable. Only connection material should normally rotate.

Return `404` only when the lease really cannot be resumed. Codex interprets that
as `LeaseMissing` and provisions a replacement from its latest durable snapshot.

### Checkpoint

Request and response:

```json
{
  "leaseId": "lease_abc",
  "idempotencyKey": "hosted-agent:019c...:turn:turn_007:checkpoint"
}
```

```json
{ "snapshotId": "snapshot_007" }
```

The snapshot must be durable after the active E2B sandbox is killed. Current E2B
snapshots satisfy this provider-level requirement and can seed a new sandbox;
they require a template using a sufficiently recent `envd`. Keep the logical
snapshot record until all Codex runtime records and artifacts that reference it
have expired. E2B's
[snapshot documentation](https://e2b.dev/docs/sandbox/snapshots) distinguishes
this reusable checkpoint from pausing a single sandbox.

### Export patch

Request and response:

```json
{
  "leaseId": "lease_child",
  "agentId": "019d...",
  "baseSnapshotId": "snapshot_base",
  "idempotencyKey": "hosted-agent:019d...:snapshot:snapshot_final:export-patch"
}
```

```json
{
  "artifactId": "artifact_123",
  "agentId": "019d...",
  "baseSnapshotId": "snapshot_base",
  "checksum": "sha256:...",
  "changedFiles": 12,
  "sizeBytes": 48192
}
```

Codex persists only this metadata. The service must retain the actual artifact.
Export against the exact immutable `baseSnapshotId`, using the lease's latest
checkpoint as the current state. Include additions, modifications, deletions,
binary content, executable bits, and safe symlink handling; do not assume every
workspace is a clean Git repository.

A practical representation is a content-addressed manifest:

- one sorted entry per path with type, mode, and content digest;
- immutable base and current manifests;
- blobs stored outside the sandbox;
- a canonical artifact document containing base and resulting entries;
- a checksum over the canonical document.

Enforce path, file-count, per-file, and total-byte limits before accepting an
artifact.

### Apply patch

Request:

```json
{
  "targetLeaseId": "lease_owner",
  "artifactId": "artifact_123",
  "idempotencyKey": "hosted-agent:019c...:lease:lease_owner:artifact:artifact_123:apply"
}
```

Return one of:

```json
{
  "type": "applied",
  "checkpoint": { "snapshotId": "snapshot_after_apply" }
}
```

```json
{
  "type": "conflict",
  "paths": ["file:///workspace/project/src/lib.rs"]
}
```

```json
{
  "type": "rejected",
  "reason": "artifact expired"
}
```

Implement a real three-way comparison for every changed path:

- artifact base = the child's immutable starting contents;
- artifact current = the child's exported contents;
- target current = the owner's contents at application time.

If target current differs from both artifact base and artifact current, report a
conflict. Detect every conflict before mutating the target. A conflict or rejection
must leave the target byte-for-byte unchanged. On success, apply the complete set
atomically and create the returned durable checkpoint before responding.

For E2B, create a rollback snapshot before mutation, stage changes away from the
live workspace, validate paths and quotas, then swap the staged result into place.
The rollback snapshot is an implementation safety net, not a substitute for
preflight conflict detection. Return no more than 256 conflict paths and keep a
rejection reason at or below 4 KiB.

### Release

Request:

```json
{
  "leaseId": "lease_child",
  "idempotencyKey": "hosted-agent:019d...:lease:lease_child:release"
}
```

Revoke gateway tickets, terminate active connections, kill the E2B sandbox, and
mark the lease released. Repeating the same request must return success. Do not
return `404` merely because the provider sandbox is already gone; reconcile the
logical lease and return success. Durable snapshots and patch artifacts have
separate retention and must survive lease release while referenced.

E2B's terminal operation is `kill`; a killed sandbox cannot be resumed. Its
[sandbox lifecycle guide](https://e2b.dev/docs/sandbox) documents timeout and
shutdown behavior.

## Idempotency and concurrency

Every operation includes an idempotency key. Use a database uniqueness constraint
on `(operation, idempotency_key)` and persist:

- a canonical request hash;
- operation state (`in_progress`, `succeeded`, or `failed_terminal`);
- the complete successful response;
- provider resources allocated while the operation is in progress.

An identical replay returns the exact prior logical result. Reusing a key with a
different request is a client error and must never allocate or mutate resources.
Serialize mutating operations per lease, and acquire lease locks in a deterministic
order when an operation touches both owner and child state.

Suggested logical tables are:

| Table | Important fields |
| --- | --- |
| `leases` | logical lease/environment IDs, E2B sandbox ID, agent/owner IDs, template, cwd/roots, base/latest snapshot, state, policy version |
| `snapshots` | logical snapshot ID, E2B snapshot ID, workspace manifest ID, state, references, timestamps |
| `artifacts` | artifact ID, agent/base/current manifest IDs, checksum, counts, blob location, expiry |
| `operations` | operation, idempotency key, request hash, state, response, allocated-resource journal |
| `connection_tickets` | hashed ticket, lease, expiry, revocation and single-purpose metadata |

Use opaque random public IDs no longer than 512 UTF-8 bytes. Never reuse an
environment ID for another lease. Never put E2B API keys, access tokens, traffic
tokens, gateway tickets, connection URLs, or response bodies containing them in
logs or Codex's durable runtime record.

## HTTP error mapping

Codex ignores service error bodies and maps status codes as follows:

| HTTP status | Codex category |
| --- | --- |
| `401`, `403` | unauthorized |
| `404` on reconnect | lease missing |
| `404` on other operations | snapshot missing |
| `409` | patch conflict |
| `422` | invalid template |
| `429` | quota exceeded |
| `502`, `503`, `504` | unavailable |
| anything else | connection failed |

Return `409` only for operation-level failures. A normal three-way patch conflict
is a successful `200` response with `{ "type": "conflict", ... }`.

## E2B implementation mapping

Pin a tested E2B SDK version. The examples below use TypeScript-shaped pseudocode;
adapt names to the pinned version and keep provider calls behind a small internal
adapter.

### Template

Build one E2B template for each trusted `sandboxTemplate`, or maintain an explicit
mapping from Codex template name to E2B template ID. Each template should contain:

- a `codex` binary built from a compatible revision and target platform;
- role-specific compilers, package managers, and tools;
- a fixed workspace parent such as `/workspace`;
- a non-root runtime user with only the required privileges;
- an exec gateway or proxy if it runs inside the sandbox;
- health-check tooling.

The instance must eventually run:

```sh
codex exec-server --listen ws://127.0.0.1:22101
```

and expose only an authenticated gateway on `0.0.0.0:22100`.

E2B template start commands run during template build and the running process is
captured in the template snapshot. Environment variables supplied to
`Sandbox.create` are therefore not available to that start command. Either start
the per-lease gateway and exec server after sandbox creation or have a snapshotted
supervisor wait for a secret file written at creation time. See E2B's
[start and ready command guide](https://e2b.dev/docs/template/start-ready-command)
and [template quickstart](https://e2b.dev/docs/template/quickstart).

### Provision mapping

The control plane's provider adapter will roughly perform:

```ts
const sandbox = await Sandbox.create(e2bTemplateId, {
  timeoutMs: ACTIVE_LEASE_TIMEOUT_MS,
  secure: true,
  lifecycle: { onTimeout: 'pause', autoResume: false },
  metadata: { leaseId, agentId, template: trustedTemplateName },
})

await materializeSource(sandbox, request.source)
const initial = await createDurableSnapshotAndManifest(sandbox)
await installPerLeaseGatewaySecret(sandbox, generatedSecret)
await startAndProbeExecServer(sandbox)
```

Prefer a service-owned gateway that keeps ticket validation and E2B traffic
credentials outside the sandbox. If a proof of concept writes a gateway secret
inside E2B, treat it as snapshot-resident: revoke and replace it whenever a
snapshot is restored, and never make it a long-lived control-plane credential.

Use E2B secure access for its controller APIs. E2B SDK 2.x enables it by default,
but set and test the intended policy explicitly; see
[secured access](https://e2b.dev/docs/sandbox/secured-access). Keep `E2B_API_KEY`
only in the control plane. E2B's [API key guide](https://e2b.dev/docs/api-key)
describes the SDK environment variable.

`Sandbox.createSnapshot()` is the natural provider primitive for base and durable
snapshots. `Sandbox.create(snapshotId)` creates a distinct sandbox, but an E2B
snapshot includes memory and running processes as well as files. That is useful for
restoring the same agent, but it is too much inheritance for a new child by itself.

For `agentEnvironment`, capture the active owner atomically, derive a workspace-only
manifest/archive from that capture, then materialize it into a clean sandbox built
from the child's trusted template. If the first implementation instead boots the
child directly from the owner snapshot, it must remove inherited exec-server
sessions, gateway state, secrets, background processes, and other runtime identity,
then rebootstrap the child's own environment before making it reachable. Prefer the
workspace-only path because it makes the isolation boundary auditable. Never give
two Codex threads the same E2B sandbox or live process state.

When restoring the same agent from `durableSnapshot`, restart or rekey the gateway
and exec-server before returning a connection URL. Snapshot-restored connection
state must not authenticate a new lease generation.

### Reconnect and lifetime mapping

Use `Sandbox.connect(sandboxId, { timeoutMs })` to resume a paused sandbox and
refresh its active timeout. E2B can auto-pause instead of killing on timeout, and
paused state preserves both filesystem and memory. Prefer explicit reconnect and
`autoResume: false` initially so lease state changes remain observable and
testable. E2B documents these controls under
[persistence](https://e2b.dev/docs/sandbox/persistence) and
[auto-resume](https://e2b.dev/docs/sandbox/auto-resume).

The logical lease must outlive a control-plane process restart. Reconstruct the
E2B handle from the persisted sandbox ID, not an in-memory SDK object. If E2B says
the sandbox is killed or missing, return `404` so Codex restores from its latest
snapshot.

### Files and artifacts

E2B exposes file read/write operations and upload/download URLs. Use SDK file APIs
for small manifests and bootstrap files, and object storage or archive transfer for
whole workspaces. Relevant provider references are
[upload](https://e2b.dev/docs/filesystem/upload),
[download](https://e2b.dev/docs/filesystem/download), and the general
[filesystem guide](https://e2b.dev/docs/filesystem).

Do not make E2B's live filesystem the only copy of a patch artifact. Release kills
the sandbox, but Codex may apply the exported artifact afterward. Persist the
artifact and referenced blobs in service-owned durable storage before returning
from export.

## Security checklist

- Authenticate every control-plane request and authorize it to the correct tenant.
- Resolve `sandboxTemplate` only through a server-side allowlist; never treat it as
  an image name or shell fragment.
- Bind the raw exec server to loopback and authenticate the externally exposed WSS
  hop.
- Make connection tickets short-lived, lease-scoped, revocable, and redacted.
- Validate every path stays below an approved workspace root after normalization;
  reject traversal, unsafe symlink targets, devices, sockets, and special files.
- Bound requests, responses, manifests, artifacts, conflict lists, and extraction
  ratios.
- Never place reusable service credentials in E2B metadata, command arguments,
  snapshots, patch artifacts, or application logs. Keep per-lease connection
  secrets out of snapshots when possible and revoke snapshot-resident secrets on
  restore.
- Keep E2B secure controller access enabled and restrict public traffic and egress
  according to the trusted role. The E2B create API exposes network policy fields
  including public traffic and outbound allow/deny rules in its
  [sandbox API](https://e2b.dev/docs/api-reference/sandboxes/create-sandbox).
- Treat a provider or gateway denial as final. The hosted runtime intentionally has
  no local execution fallback.
- Journal partially allocated provider resources and run a TTL reconciler for
  abandoned leases, snapshots, tickets, and in-progress operations.

## Build sequence

### Chunk 1: E2B transport spike

1. Build one E2B template containing the matching `codex` binary.
2. Start `codex exec-server` and an authenticated proxy in one sandbox.
3. Return a transient `wss://` URL that the existing
   `HostedEnvironmentConnection` can open;
4. run initialize, process, filesystem, disconnect, and reconnect canaries;
5. create an E2B snapshot and prove the connection recovers afterward;
6. decide and document the root workspace ingress design.

Exit criterion: a stock Codex build can execute two commands with a checkpoint
between them, without disabling transport authentication.

### Chunk 2: Provision, reconnect, and release

Implement the database, operation journal, template allowlist, and the three
lifecycle endpoints. Start with root provisioning under the chosen ingress model.
Add a reconciler that kills any E2B sandbox left by an incomplete transaction.

Exit criterion: duplicate requests are stable, service restarts preserve leases,
reconnect resumes them, and release is idempotent.

### Chunk 3: Checkpoint, child isolation, and restore

Implement durable snapshot records and manifest generation. Provision children
from an atomic owner snapshot, and restore killed leases from `durableSnapshot`.

Exit criterion: owner and child diverge independently, killing either sandbox does
not destroy its durable checkpoint, and Codex restores a missing active lease.

### Chunk 4: Patch export and application

Implement content-addressed artifacts, three-way preflight, atomic mutation,
conflict reporting, and post-apply checkpoints. Add expiry and reference counting
without deleting artifacts still referenced by Codex.

Exit criterion: additions, edits, deletions, binary files, modes, clean applies,
and conflicts all behave like the in-memory fake, with no target mutation on
conflict.

### Chunk 5: Production hardening

Add tenant authorization, quotas, retry budgets, rate limiting, audit events,
provider reconciliation, dashboards, alerts, and staged rollout by agent role.
Exercise provider outages and crash recovery before enabling the feature by
default anywhere.

## Contract and live test matrix

Port the behavior in `codex/codex-rs/hosted-agent/src/hosted_agent_tests.rs` to black-box
HTTP tests, then run these live E2B scenarios:

| Scenario | Required assertion |
| --- | --- |
| identical idempotent replay | same logical response and one provider mutation |
| changed request with reused key | rejected with no mutation |
| partial provision failure | E2B sandbox and tickets are reclaimed |
| duplicate lease/environment ID | never emitted for distinct provisions |
| root materialization | uncommitted and untracked files are present |
| child provision | child sees spawn-time owner state, then diverges independently |
| checkpoint | durable snapshot exists and exec connection recovers |
| service restart | reconnect works from persisted provider IDs |
| missing sandbox | reconnect returns `404`; durable restore creates a new lease |
| patch export | metadata matches stored artifact and checksum |
| clean apply | all changes applied and durable checkpoint returned |
| conflict apply | bounded paths returned and target is unchanged |
| release replay | repeated release succeeds and no active sandbox remains |
| leaked connection URL | absent from logs, errors, durable Codex state, and metrics |
| denied tool | invisible before model dispatch or rejected without local fallback |

Run the app-server hosted-agent flows against this service as the final acceptance
test. The fake proves Codex orchestration; only a live backend test proves that
workspace ingress, E2B lifecycle, snapshots, WSS transport, and artifacts compose
correctly.

## Codex configuration for a canary

```toml
[features]
hosted_agents = true

[hosted_agents]
enabled = true
service_url = "https://hosted-agent-canary.example/control/"
default_agent_type = "default"

[agents.default]
description = "General development agent in an E2B sandbox."
sandbox_template = "e2b-general-v1"
```

Set the service credential in the Codex process environment:

```sh
export CODEX_HOSTED_AGENT_TOKEN='<control-plane bearer token>'
```

Every configured agent role must have a non-empty `sandbox_template` while hosted
agents are enabled. Keep the feature disabled for users outside the canary until
the live matrix passes and cleanup reconciliation has been observed under failure.
