# Hosted Agent E2B Reference Archive

This document preserves the verified integration facts, stable backend contract,
architecture decisions, and spike results for the hosted-agent E2B backend. It
is reference material, not a work queue. Remaining implementation work is in
[`TODO.md`](TODO.md).

The Codex-side sources of truth are:

- `codex/codex-rs/hosted-agent/src/types.rs` for wire and lifecycle types;
- `codex/codex-rs/hosted-agent/src/http.rs` for routes, authentication, limits,
  and status mapping;
- `codex/codex-rs/hosted-agent/src/fake.rs` for reference idempotency, snapshot,
  patch, three-way apply, and release behavior;
- `codex/codex-rs/core/src/hosted_agent_runtime.rs` for provisioning, reconnect,
  restore, and tool-policy behavior;

## Completed Codex-side hosted runtime

All eight Codex runtime stages were completed on `feat/hosted-agents` by
2026-07-18. The experimental, default-off `hosted_agents` feature replaces
Codex-managed sandboxing for hosted threads with one full, independent Codex
thread per root or spawned agent. Every thread receives a unique hosted lease,
immutable creation snapshot, trusted role/template mapping, authoritative service
tool policy, and optional durable patch artifact.

Parent/child relationships retain only ownership, messaging, quotas, result
delivery, lineage, and lifecycle. They do not transfer environments, filesystem
state, cwd, approvals, execution policy, credentials, permission profiles, or
sandbox permissions. Explicit `fork_turns` transfers sanitized conversation
context only; it removes tool calls, environment IDs, inter-agent messages, and
transient runtime items.

### Crate, configuration, and public API

The small `codex-hosted-agent` crate owns the provider-neutral types, native
RPITIT `HostedAgentService` trait, production HTTP client, and bounded in-memory
fake. Its six operations are `provision`, `reconnect`, `checkpoint`,
`export_patch`, `apply_patch`, and `release`. The client enforces HTTPS control
transport, WSS executor transport, environment bearer authentication, bounded
timeouts/responses, disabled redirects, response validation, duplicate
lease/environment rejection, and redacted diagnostics.

Configuration adds the default-off feature and `[hosted_agents]` settings:

```toml
[hosted_agents]
enabled = true
service_url = "https://sandbox-service.example"
default_agent_type = "default"

[agents.default]
description = "General development agent."
sandbox_template = "general-v1"
```

Every role usable in hosted mode needs a non-empty `sandbox_template`. Templates
are resolved from trusted role configuration inside core and never selected as
raw model-provided image names. Service authentication comes from
`CODEX_HOSTED_AGENT_TOKEN`, never `config.toml`.

App-server v2 has an experimental nullable `thread/start.agentType`; omission
selects `hosted_agents.default_agent_type`. Existing collaboration
`spawn_agent.agent_type`, thread-source names, parent IDs, and agent paths remain
wire-compatible. Patch acceptance is exposed through the plain
`apply_agent_patch` collaboration tool and experimental `agent/patchApply` API.
Owners receive bounded, non-secret, guaranteed-delivery
`agent/patchAvailable` notifications. No new v1 API was added.

### Provisioning and environment ownership

Core owns `HostedAgentRuntime` and durable metadata containing agent type,
template, lease/environment IDs, base/latest snapshot IDs, last patch metadata,
owner lineage, and lifecycle state. Connection endpoints and credentials are
excluded from persistence and model context.

All thread creation surfaces—including roots, collaboration spawns, and direct
review/guardian delegates—use the manager-owned provisioning transaction:

1. allocate the thread ID;
2. resolve the trusted role/template;
3. provision from root workspace, owner lease, or durable snapshot;
4. register the returned dynamic environment;
5. construct the session bound only to that environment;
6. unregister and release on any later startup failure.

Environment removal aborts startup, closes transport, disconnects stale handles,
cancels authenticated recovery, and prevents later reconnect without affecting
other agents. Local, default, and static environments remain fail-closed.
Environment/lease collisions are rejected rather than replacing an existing
registration.

### External sandbox and tool authorization

Hosted threads permanently use `ExternalSandbox`, approval policy `Never`,
unrestricted Codex filesystem/network permissions, no managed network proxy, no
permission escalation, and no inherited approval cache. A provider denial is a
final external-sandbox failure; Codex neither retries locally nor escalates.
Non-hosted behavior remains unchanged while the feature is disabled.

Tool authorization is independent of model exposure and is enforced twice: denied
tools are removed before model specifications are sent, and policy is rechecked
immediately before dispatch. Both the exact tool name/namespace and domain must
be granted. Domains classify agent-environment execution, control-plane tools,
provider-hosted tools, exact-environment MCP, ambient MCP, client callbacks,
extensions, and orchestrator processes.

Hosted defaults allow minimal environment and control-plane tools. Legacy shell,
code mode/V8, permission requests, provider search, connectors, dynamic tools,
plugins, ambient/local MCP, and unclassified extensions are absent or denied by
default. Environment-bound MCP is usable only when bound to the thread's exact
environment ID. Hidden exposure never implies authorization.

### Persistence, recovery, finalization, and lifecycle

Codex checkpoints after every completed turn and before normal release. The last
completed-turn snapshot is authoritative; interrupted uncheckpointed work may be
discarded. Resume reads durable runtime metadata, tries reconnect, restores from
`latest_snapshot_id` on a genuinely missing lease, registers the fresh
environment, and continues the existing thread/history. If no durable snapshot
exists, resume fails rather than using unrelated current workspace state.

Agent completion is ordered as checkpoint, export relative to immutable base,
persist artifact metadata, deliver completion/notification, then release. It
never modifies the owner automatically. Explicit acceptance verifies ownership,
artifact/source identity, control-plane grant, and target environment before the
service performs atomic conflict-safe three-way apply and returns a checkpoint.

Durable lifecycle states include pending finalization and release pending. Service
failure during checkpoint/export preserves the lease for retry instead of
reporting patchless success. Release failure persists cleanup state and retries
asynchronously with bounded backoff and generation safety. Descendants shut down
deepest first; pending cleanup prevents destructive deletion; resumable hosted
threads are not released merely because they are idle.

Terminal behavior is defined as follows:

- provision/startup failure creates no usable thread and rolls back registration
  and every known lease;
- quota failure occurs before provisioning;
- cancellation discards uncheckpointed work and releases;
- completion finalizes durably before release;
- close/archive checkpoints only after a completed turn;
- parent close interrupts/finalizes descendants before releasing owned leases;
- process crash relies on service TTL cleanup and later snapshot restore;
- unavailable release becomes asynchronous cleanup pending;
- unavailable checkpoint/export becomes pending finalization.

Telemetry is bounded and covers provision/restore/checkpoint latency, active
leases, patch size/conflicts, denied domains, cleanup retries, and prevented local
fallback.

### Codex-side validation record

Final validation included all 17 `codex-hosted-agent` tests; focused core tests
for provision rollback, checkpoint/finalization/release recovery,
reconnect/restore, lineage, patch application, terminal follow-up rejection,
cleanup generation safety, policy, and telemetry; app-server protocol/schema
tests; and public app-server tests for experimental gating, validation, ownership
non-disclosure, notification scoping, response mapping, and subtree removal.
Scoped Clippy fixes and formatting passed after each landing chunk.

Earlier foundation runs also recorded 30 thread-manager tests, 61
environment-focused exec-server tests, 266 app-server-protocol tests, 79 combined
hosted tool-plan/unified-exec/shell/thread-manager tests, and 2,880 passing core
tests. The broader core run had 97 existing environment-sensitive failures and 12
skips; the broader exec-server run had 34 existing container filesystem-sandbox
`SIGABRT` failures alongside 301 passes. Hosted lifecycle coverage passed.
Configuration/app-server schemas, TypeScript fixtures, Bazel locks/queries, scoped
fixes, and final formatting were regenerated or validated.

Docker remote-executor validation was attempted again with passwordless `sudo`
on 2026-07-18. The standard Ubuntu harness built the Codex CLI, provisioned its
container, and reached a healthy remote exec-server. The focused `codex-core`
test could not link: the system linker terminated with `SIGBUS` while the host
root filesystem was 99% full with roughly 1.5 GiB free. No remote test assertion
ran, so this remains an explicit acceptance gap until safe build capacity is
restored. The focused local app-server patch-route suite passed. The standard
remote harness also cannot yet synthesize the service-owned WSS lease; Wine
coverage remains delegated to the repository Bazel CI matrix.

### Runtime success invariants and assumptions

- Root, spawned, review, and guardian agents share one provisioning path and each
  receive exactly one unique remote environment.
- Hosted mode never falls back to local execution and never prompts for approval.
- Unauthorized tools are absent from specifications and rejected at dispatch.
- Child state is an atomic spawn-time owner snapshot and diverges independently.
- Completion produces a durable patch without automatic owner mutation; explicit
  application is atomic, idempotent, and conflict-safe.
- Missing leases restore from the latest completed-turn snapshot.
- Existing non-hosted behavior is unchanged when the feature is disabled.
- Higher resource/provision latency and one sandbox per thread are accepted.
- The hosting service supplies atomic capture, durable checkpoints/artifacts,
  transactional partial-provision cleanup, and TTL cleanup after Codex crashes.
- Parent/child metadata is coordination lineage, not a distinct subagent runtime.
- Existing collaboration tool and thread-source wire names remain for
  compatibility.

## Verified foundation and spike

### Production storage foundation

The first productionization slice landed on 2026-07-18. A checksummed,
transactional PostgreSQL migration establishes constrained tables and indexes
for immutable source snapshots, leases, durable snapshots, artifacts,
idempotent operations, partial provider allocations, hashed purpose-bound
connection tickets, authenticated objects, and explicit retention references.
The migration runner serializes replicas with a schema-scoped advisory lock and
rejects changed or unknown applied migrations. The live database constraint test
is available through `HOSTED_AGENT_TEST_DATABASE_URL`; it remains skipped when a
PostgreSQL fixture is unavailable.

Production workspace archives and future manifests/content blobs/artifacts can
now use an authenticated S3-compatible object store. Objects are addressed and
verified by SHA-256, encrypted server-side, bounded on read/write, and obtained
through the standard AWS credential chain. Every store reports the exact durable
bucket/key used for a content ID, so relational object registration consumes the
physical locator instead of reconstructing it from parallel configuration. The
filesystem implementation now validates identifiers and checksums and is
explicitly development-only. The control plane still needs to move its operation
protocol from the JSON journal onto this relational schema; adding the schema
does not by itself satisfy multi-replica idempotency or recovery.

The direct `ws` dependency was upgraded from 8.18.3 to 8.21.1, resolving the
pinned tree's high-severity memory-disclosure/exhaustion advisories. The npm
production audit reports zero known vulnerabilities after the upgrade.

### Network-edge foundation

The next productionization slice made TLS and WSS mandatory outside an explicit
`HOSTED_AGENT_DEVELOPMENT=true` mode. TLS certificate/key configuration must be
paired, gateway URLs cannot contain credentials/query/fragment material, ticket
TTL is bounded in production, the local ingress bridge is rejected before
provider allocation outside development, and production startup requires the
authenticated object store. Release now synchronously asks the gateway to close
all active lease connections.

HTTP bodies are capped at 1 MiB from both declared length and streamed bytes;
excess streamed data is discarded rather than retained. Responses disable
caching and unexpected provider/storage failures use a generic error instead of
reflecting potentially sensitive diagnostics. The WSS gateway bounds total and
per-lease connections, payloads, pre-upstream messages/bytes, and socket
backpressure. It handles malformed upgrade paths, verifies the same active
lease/sandbox before and after provider connection and at upstream readiness,
and removes empty connection sets. Focused race, rejection, redaction, payload,
buffer, and connection-limit tests increased the provider-independent suite to
20 passes with only the optional live PostgreSQL test skipped.

### Provider lifecycle and reconciliation capabilities

The provider boundary now supports a fail-closed loopback exec-server probe,
managed sandbox inventory scoped by both service and tenant metadata, snapshot
inventory scoped by a known source sandbox or deterministic name, idempotent
snapshot deletion, and optional deterministic snapshot names. Inventory results,
metadata, identifiers, names, and collection sizes are bounded and validated;
connection material is never returned. E2B cannot filter snapshots by arbitrary
metadata, so unscoped snapshot inventory raises an explicit capability error
instead of scanning unrelated resources.

Provider create/restore rejects credential-like metadata and malformed template
or metadata bounds. Sandbox kill no longer converts provider outages into false
success: not-found remains idempotent, while transport/provider failure remains
observable for reconciliation retry. Provision and reconnect now require the
exec probe after startup and before returning connection material; injected probe
failure cleans the provisioned sandbox. Fifteen focused control-plane/provider
tests cover success, fail-closed probe behavior, scoped inventories, snapshot
deletion, and cleanup error propagation. Continuous journal reconciliation and
provider-orphan adoption/reclamation remain to be wired.

### Development ingress hardening

The co-located path bridge remains unavailable outside explicit development
mode, but is now hardened as a trustworthy test/reference capture. It accepts
only canonical local `file:` URIs, resolves authorization roots with `realpath`,
requires non-overlapping real directory roots and an in-root cwd, rejects root
symlinks, escaping/absolute symlinks, devices, sockets, FIFOs, and other special
files, and preserves multiple roots, dirty/untracked and binary bytes, modes,
safe symlinks, and cwd placement. Preflight bounds roots, entries, expanded and
per-file bytes, path depth, archive bytes, and extraction ratio before provider
allocation. Focused tests inspect the extracted archive and exercise overlap,
link, FIFO, and quota rejection.

### Immutable source-snapshot lifecycle

The production ingress foundation accepts an authenticated tenant principal plus
an archive, trusted SHA-256, canonical remote cwd/roots, and bounded expiry. It
fully parses the archive into a staging manifest before the first durable write,
enforcing the archive/type/path/link/mode quotas and requiring every declared
`/workspace/roots/<index>/...` root and cwd while rejecting undeclared content.
Creation publishes content-addressed bytes, registers an immutable available
source object/snapshot/reference, and returns only an opaque `source_...` ID,
checksums, expiry, and size. Same-tenant replay returns the existing immutable
identity; conflicting metadata is rejected.

Resolution authorizes tenant, state, expiry, and the trusted expected checksum
before reading object storage. It then verifies physical content identity and
bytes, reparses the archive, and returns defensive copies. Stable client errors
do not expose storage/database details. A required ref-aware reclaimer is invoked
after every partial publication failure and must surface cleanup-pending rather
than claiming success.

Tenant-owned durable object IDs are derived separately from the shared physical
content identity. A migration permits identical immutable storage locations for
different tenants while retaining tenant-specific database ownership; cleanup
must prove no durable object points at the physical content before deletion.
Seven lifecycle tests cover creation/resolution, cross-tenant denial, replay,
multi-tenant identical bytes, all pre-publication validation, cleanup failures,
and stored corruption. PostgreSQL 17 tests additionally prove transactional
migration, tenant-isolated shared content, immutable replay, and lookup by
checksum. HTTP upload/auth wiring, service resolution before provider allocation,
and successful-expiry garbage collection remain open.

### Connection-ticket lifecycle

Gateway tickets now carry an explicit persisted purpose and issuance time, have
a positive TTL capped at five minutes, rotate prior lease tickets, and are
atomically consumed on their first matching lease/purpose validation. Wrong
lease or purpose does not burn a valid ticket; replay fails; issue, validate,
and revoke prune expired/revoked lookup records. Validation accepts only the
expected 256-bit base64url shape before hashing. Persistence tests prove that
only SHA-256 lookup material—not the raw bearer, WSS URL, or query—is written.
A follow-up migration aligns the PostgreSQL ticket-purpose constraint with the
gateway/probe purposes. The gateway and control plane now consume a common
ticket-authority interface, with a deployment-tenant-bound PostgreSQL
implementation that generates a 256-bit raw bearer only long enough to return
its WSS URL. Independent authorities sharing the database rotate and atomically
consume the same hash state. The PostgreSQL 17 two-pool test validates issue on
one replica and consumption/replay denial on another. The gateway's active-lease
check is also storage-neutral now; PostgreSQL supplies the active provider
sandbox directly and the two-pool test proves another replica stops resolving it
immediately after durable release. Production startup still needs to select
these implementations as part of the full PostgreSQL control-plane cutover, and
active sockets already accepted by other gateway replicas periodically
revalidate the same durable directory and close on release/restore or lookup
failure. Process-local release still closes immediately; the bounded polling
interval supplies cross-replica propagation without relying on lossy events.
Focused gateway coverage proves an established connection closes after a
separate durable-state writer releases its lease.

### Canonical workspace comparison foundation

Patch lifecycle code now has a provider-independent canonical workspace model
covering directories, regular files (mode, size, SHA-256 content digest), and
safe relative symlinks (mode and target). It validates NFC canonical relative
POSIX paths, link containment, modes, digests, duplicate paths, and entry/file/
byte/path/depth/link/manifest/change quotas. Stable key and path ordering yields
a canonical JSON checksum independent of input order.

The same module produces complete sorted add/modify/delete diffs and applies the
archived three-way conflict rule: a changed path conflicts only when the target
differs from both artifact base and artifact current. It counts every conflict
before returning at most 256 sorted canonical `file:` URIs and truncates rejection
text at 4 KiB without splitting a UTF-8 code point. Tests cover binaries,
executable and directory modes, links, additions/deletions, already-applied
targets, 300-conflict truncation, malformed inputs, and every quota dimension.
Manifest capture/persistence and live workspace mutation remain subsequent
lifecycle work.

### Durable patch-artifact repository

The PostgreSQL patch repository validates a canonical base/current manifest pair
against the source lease's exact tenant, child agent, owner, immutable base, and
latest snapshot. It derives the changed-path count and current regular-file byte
total, verifies manifest/artifact/content object kinds, checksums, sizes, state,
and expiry, and inserts the artifact plus all object, snapshot, and owner
retention references in one transaction. Reads authorize either the source agent
or its recorded owner without disclosing cross-tenant existence.

Identical concurrent creation across independent pools converges on one durable
identity; changed replay conflicts and rolls back references. Released source
leases can replay and add Codex retention references, while expiry removes
authorization without deleting the artifact graph. A follow-up migration makes
every artifact identity column immutable even to direct SQL while permitting
lifecycle state transitions. All four repository suites passed against
PostgreSQL 17, covering concurrency, tenant/owner isolation, release retention,
direct-SQL immutability, and expiry. Artifact serialization/upload and the HTTP
export/apply orchestration remain lifecycle work.

### Multi-replica operation journal primitives

The PostgreSQL layer now exposes atomic operation admission over the unique
`(operation, idempotency_key)` identity. It compares tenant and canonical request
hash before any caller mutation, returns one winner under concurrent claims,
lets identical observers await/replay terminal state, and sanitizes and bounds
logical responses so connection/ticket/provider credentials cannot be stored.
Every mutation is fenced by worker ID plus generation, with heartbeats and
`FOR UPDATE SKIP LOCKED` stale takeover preventing a dead worker from later
changing reconciler-owned state.

Partial sandboxes, capture sandboxes, provider snapshots, tickets, and objects
can be recorded immediately in a deduplicated allocation ledger and moved
through adopted/reclaim states. Transaction-scoped advisory locks hash
tenant/lease identities only after sorting and deduplicating lease IDs, then lock
the corresponding rows. After durable lease creation, the winning worker can now
atomically bind that lease as the operation result and adopt an explicit set of
allocations; an omitted, foreign, reclaimed, or stale-generation allocation
rolls the entire binding back.

Docker-backed PostgreSQL 17 tests use independent pools to prove one concurrent
claim, changed-request rejection, terminal replay and redaction, uniqueness,
allocation fencing, atomic lease binding/selected adoption, one stale
reconciler, and reversed multi-lease acquisition without deadlock. The existing
control-plane methods still need to be refactored onto this API before the
production persistence checklist and provider-mutation exit criterion are
satisfied.

### Strict control-plane wire validation

The HTTP boundary now parses the four implemented operations as exact plain JSON
objects before dispatch. It rejects unknown/missing properties, malformed union
discriminants, invalid owner/source relationships, noncanonical or overlapping
workspace `file:` URIs, invalid Unicode, and all identifier/name/root bounds with
HTTP 400 before provider mutation. Bounds use UTF-8 bytes rather than JavaScript
code-unit counts.

Provision/reconnect responses are revalidated as exact bounded objects: distinct
lease/environment identities, contained cwd/roots, canonical WSS endpoint with
one lease-scoped opaque ticket and no userinfo/fragment/extra query, and unique
bounded tool domains/tools. Checkpoint responses are exact snapshot identities.
Invalid internal/provider responses and unexpected failures are returned as a
generic 503, while safe client validation messages remain 4xx. Focused tests
cover every request shape, extra fields, byte boundaries, URI canonicalization,
tool policy, endpoint rules, pre-dispatch rejection, and response rejection.

### Safe archive manifest capture

Provider workspace tar bytes can now be parsed without filesystem extraction
into the canonical manifest model. The parser requires the explicit `roots/`
tree and rejects absolute/traversing/out-of-tree and duplicate paths,
non-directory ancestors, hardlinks, devices, FIFOs, unknown types, escaping
symlinks, invalid modes, checksum warnings, truncated bodies, and declared/body
size mismatches. Archive, metadata-entry, entry/file, per-file/total, manifest,
and decompression/extraction-ratio limits are enforced.

Regular file bodies are hashed while read, written through the content-addressed
object-store boundary, and verified against the returned object ID. Capture
returns stable manifest bytes/checksum, sorted path-to-content-object identities,
and total size without requiring Git. Tests construct raw tar headers to cover
binary data, executable/directory modes, safe links, corruption, truncation,
special/unknown types, conflicts, dishonest storage, and every quota. `tar`
7.5.20 is now a direct dependency rather than an accidental transitive
implementation detail.

### Tenant-scoped durable state repository

A PostgreSQL durable-state repository now implements tenant-authorized object
registration and references, immutable source snapshot registration and lookup,
atomic lease/base-snapshot creation, checkpoint append, lease transitions and
release, snapshot retention references, and purpose-bound ticket hash issue,
single-use consumption, rotation, revocation, and cleanup. Lease and base
snapshot records commit together; missing or cross-tenant objects roll the whole
transaction back, and concurrent environment identity claims across separate
connection pools yield one winner.

Workspace metadata is revalidated at this repository boundary: file URIs must be
canonical absolute local URIs, roots must be unique and non-overlapping, and cwd
must be inside a declared root. Ticket purposes match the gateway wire vocabulary
(`exec_gateway_connect` and `exec_gateway_probe`), hashes must be exactly 32
bytes, and expiry is future-bounded to five minutes. Durable release revokes
outstanding tickets without deleting snapshots or Codex retention references.

The repository was exercised against PostgreSQL 17 in Docker with two independent
pools. All four live suites passed, covering tenant isolation and immutable source
identity, atomic rollback and concurrent uniqueness, checkpoint/reference survival
after release, and ticket rotation/consumption/expiry/revocation/cleanup. This is a
storage primitive; the control-plane lifecycle still needs to replace its JSON
state paths with these transactions and the operation journal before production
multi-replica persistence is complete.

CubeSandbox was verified on 2026-07-18 through stock E2B TypeScript SDK 2.35.0.
Provider code lives in the external TypeScript control plane under `e2b/src`, not
in `codex-core`.

The `e2b/scripts` pipeline builds the Codex fork for
`x86_64-unknown-linux-musl`, strips and checksums it, records its revision,
replaces the upstream binary in the CubeSandbox image, publishes a template, and
verifies `codex exec-server` through WSS. The development template used by the
spike was `tpl-e7bc8fcedb3c4dd8973c5e43`, containing Codex revision
`3780c42c66f904e610858c804bfed79f201bd204` with SHA-256
`c1faf7c82a54bdd196b2907962f20db3a026fd8dc09db98f6d383b5e24817900`.
Template IDs are deployment artifacts, not configuration constants. The template
exposes envd on 49983 and the development exec server on 22101.

The first static release build took about 17 minutes and generated roughly 13
GiB of target data. The unstripped binary was 1.36 GiB and the stripped artifact
about 309 MiB. Cached rebuilds were effectively immediate before stripping. The
pinned npm dependency tree reported one accepted high-severity advisory for the
private spike.

The spike implements `provision`, `reconnect`, `checkpoint`, and `release`; an
E2B adapter and template allowlist; logical lease/environment/snapshot/operation
records; a development JSON journal and blob store; exact allowlisted workspace
archiving; a ticket-authenticated WSS gateway; snapshot recovery; workspace-only
child creation; cleanup reconciliation; and failure injection.

Nine provider-independent tests cover idempotency, mismatched keys, restart and
recovery, child isolation, partial failures, release replay, ticket secrecy and
revocation, and gateway proxying. Live canaries proved template provenance,
process execution, a second command after checkpoint, restore after sandbox loss,
removal of inherited process/secret identity, spawn-time child state, and
independent owner/child divergence. The provider snapshot contained `/workspace`;
the service archive is a defense-in-depth integrity/recovery copy.

## Architecture and trust boundaries

```text
                         HTTPS control requests
 Codex app-server  ─────────────────────────────────> Hosted-agent control plane
       │                                                       │
       │                                                       ├── database
       │                                                       ├── object storage
       │                                                       └── E2B API
       │                                                               │
       │ transient authenticated WSS                                  │ lifecycle
       └──────────────────────────────> Exec gateway ───────────────────┘
                                              │ private WebSocket
                                              ▼
                                     codex exec-server in E2B
```

The control plane owns authorization, logical leases, provider IDs, snapshots,
artifacts, idempotency, and reconciliation. The gateway owns transient connection
authentication and forwarding. They may share a deployment initially but remain
separate trust boundaries.

Fixed constraints:

- Keep SDK calls behind an internal provider adapter in the external service.
- Keep provider and traffic credentials out of Codex, sandbox metadata, command
  arguments, logs, artifacts, metrics, and durable runtime state.
- Package the exact custom Codex fork as a stripped, checksummed musl artifact.
- Start `codex exec-server` after sandbox creation.
- Resolve `sandboxTemplate` only through a server-owned allowlist.
- Give every thread a distinct logical lease, environment, sandbox, and runtime
  identity. Never reuse an environment ID.
- Use provider snapshots only for the same agent. Give children only an atomic
  workspace capture materialized into a clean role template.
- Keep logical state, archives, and patch artifacts in service durable storage.
- Direct 22101 access and `secure:false` are private-network spike settings only.
- Use explicit pause with `autoResume:false`; reconnect is a control-plane state
  transition and release uses provider `kill`.

## HTTP contract

Codex uses `HttpHostedAgentService`. Every operation is an authenticated JSON
`POST` with `Authorization: Bearer $CODEX_HOSTED_AGENT_TOKEN`. The base URL must
be absolute HTTPS with a host and no credentials, query, or fragment. Codex
follows no redirects, uses a 10-second connect and 30-second total timeout, and
rejects decoded responses over 1 MiB. HTTP exists only for loopback tests.

Wire names and tagged variants are camelCase. `ThreadId` is a string. Paths are
canonical `file:` URIs; responses use sandbox paths, never host paths. Opaque IDs
are nonblank and at most 512 UTF-8 bytes.

| Operation | Route | Success |
| --- | --- | --- |
| provision | `POST v1/agents/provision` | `ProvisionedAgent` JSON |
| reconnect | `POST v1/agents/reconnect` | `ProvisionedAgent` JSON |
| checkpoint | `POST v1/agents/checkpoint` | `AgentCheckpoint` JSON |
| export patch | `POST v1/agents/patch/export` | `AgentPatchArtifact` JSON |
| apply patch | `POST v1/agents/patch/apply` | tagged `PatchApplyResult` JSON |
| release | `POST v1/agents/release` | empty 2xx; 204 preferred |

### Provision

```json
{
  "agentId": "019c...",
  "ownerAgentId": null,
  "agentType": "default",
  "sandboxTemplate": "general-v1",
  "source": {
    "type": "rootWorkspace",
    "cwd": "file:///source/project",
    "workspaceRoots": ["file:///source/project"]
  },
  "idempotencyKey": "hosted-agent:019c...:provision"
}
```

`source` is `rootWorkspace` as above,
`{"type":"agentEnvironment","ownerLeaseId":"lease_..."}`, or
`{"type":"durableSnapshot","snapshotId":"snapshot_..."}`.

```json
{
  "leaseId": "lease_abc",
  "environmentId": "env_abc",
  "connection": {
    "execServerUrl": "wss://exec.example/leases/lease_abc?ticket=TRANSIENT"
  },
  "cwd": "file:///workspace/roots/0/project",
  "workspaceRoots": ["file:///workspace/roots/0/project"],
  "baseSnapshotId": "snapshot_base",
  "toolPolicy": {
    "allowedDomains": ["agentEnvironment", "controlPlane"],
    "allowedTools": [{ "name": "exec_command", "namespace": null }]
  }
}
```

Provision is transactional. Failure after any provider allocation, workspace
upload, exec startup/probe, gateway registration, snapshot, or response-persist
step must reclaim the partial sandbox and tickets because Codex has no returned
lease with which to release it.

### Reconnect, checkpoint, and release

Each request is `{"leaseId":"lease_abc","idempotencyKey":"..."}`.
Reconnect returns a complete `ProvisionedAgent`. Lease, environment, paths, base
snapshot, and policy remain stable; connection material rotates. Return 404 only
when the lease genuinely cannot resume, causing Codex to restore its latest
snapshot.

Checkpoint returns `{"snapshotId":"snapshot_..."}` and must remain restorable
after the active sandbox is killed. Pause is not a checkpoint.

Release revokes tickets, terminates connections, kills the sandbox, and marks the
logical lease released. Replay succeeds even if the sandbox is already absent.
Referenced snapshots and artifacts outlive lease release.

### Patch export and apply

Export accepts:

```json
{
  "leaseId": "lease_child",
  "agentId": "019d...",
  "baseSnapshotId": "snapshot_base",
  "idempotencyKey": "..."
}
```

It returns:

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

The service retains the actual artifact. Export compares the exact immutable base
with the latest child state and includes additions, edits, deletions, binary
content, executable modes, and safe symlinks without assuming Git.

Apply accepts
`{"targetLeaseId":"lease_owner","artifactId":"artifact_123","idempotencyKey":"..."}`
and returns one of:

```json
{ "type": "applied", "checkpoint": { "snapshotId": "snapshot_after" } }
```

```json
{ "type": "conflict", "paths": ["file:///workspace/project/src/lib.rs"] }
```

```json
{ "type": "rejected", "reason": "artifact expired" }
```

Apply performs a real three-way comparison of artifact base, artifact current,
and target current. Detect every conflict before mutation. Conflict/rejection
leaves the target byte-for-byte unchanged. Normal conflict is HTTP 200, not 409.
Conflict output is at most 256 paths and rejection reasons at most 4 KiB.
Successful application is atomic and returns a durable checkpoint.

### Tool policy and errors

A hosted tool requires both its exact `{namespace,name}` and its domain. Empty
`allowedTools` denies all. Domains are `agentEnvironment`, `controlPlane`,
`providerHosted`, `environmentBoundMcp`, `ambientMcp`, `clientCallback`,
`extension`, and `orchestratorProcess`. Ambient MCP is always denied; an
environment-bound MCP tool must match the lease environment. Avoid
`orchestratorProcess` because it runs outside the hosted environment.

| Status | Codex category |
| --- | --- |
| 401, 403 | unauthorized |
| 404 from reconnect | lease missing |
| 404 elsewhere | snapshot missing |
| 409 | operation-level patch conflict |
| 422 | invalid template |
| 429 | quota exceeded |
| 502, 503, 504 | unavailable |
| other | connection failed |

Codex ignores error bodies. A normal three-way conflict is a successful tagged
response rather than status 409.

## Idempotency, concurrency, and persistence

Production enforces uniqueness on `(operation,idempotency_key)` and stores a
canonical request hash, state (`in_progress`, `succeeded`, `failed_terminal`),
logical successful response, and every allocated provider resource. Identical
replay returns the same logical result; transient connection material may rotate.
A changed request using the same key is rejected before mutation.

Mutations serialize per lease. Multi-lease operations acquire locks in
deterministic order. Logical records are:

| Record | Important fields |
| --- | --- |
| lease | logical lease/environment, provider sandbox, agent/owner, template, cwd/roots, base/latest snapshot, state, policy version |
| snapshot | logical/provider IDs, workspace manifest/archive, state, references, timestamps |
| artifact | agent, base/current manifests, checksum, counts, blob location, expiry |
| operation | operation/key, request hash, state, logical response, allocations |
| ticket | hash, lease, expiry, revocation, purpose |

Never persist or log connection URLs, gateway tickets, E2B API/access/traffic
tokens, or responses containing them.

## Architecture decisions

### Production workspace ingress

Use an authenticated immutable source snapshot in object storage and pass its
opaque ID to the control plane. The local allowlisted read-only bridge remains
development-only. It captures dirty/untracked files, modes, symlinks, cwd, and
multiple roots under `/workspace/roots/<index>/...`. The spike defaults are eight
roots and 512 MiB archive input; production must also bound file count, expanded
bytes, per-file bytes, and extraction ratio. Arbitrary service-host path lookup,
Git HEAD, and empty workspace fallback were rejected because they change state.

### Exec authentication

Use a service-owned WSS gateway with a short-lived opaque URL ticket scoped to
one lease. Store only its hash; rotate on reconnect and revoke on release. Custom
headers are incompatible with Codex. Snapshot-resident secrets and public raw
22101 access enlarge the trust boundary and were rejected. The gateway costs an
available TLS data-plane hop and a ticket lookup per connection.

### Same-agent recovery

Keep a provider snapshot plus a checksummed service workspace archive. Restore
into a new sandbox, overlay the archive, remove inherited process/gateway
identity, restart exec, and issue fresh credentials. Pause alone is not durable;
workspace-only restore loses runtime state; old credential reuse enables replay.

### Child creation

Snapshot the owner atomically, restore into a temporary capture sandbox, export
workspace only, and materialize it into a clean child template. Kill the capture
before exposing the child. Fork/direct owner-snapshot children were rejected
because they retain processes, sessions, secrets, and identity. The cost is a
temporary sandbox and two archive transfers per spawn.

### Persistence

Use PostgreSQL for the operation journal and lease index, and authenticated object
storage for archives, manifests, blobs, and artifacts. The JSON file and local
blob directory are spike substitutes only. In-memory state cannot survive restart,
provider-only artifacts die on release, and full connection responses leak bearer
material. Production requires transactions, locks, retention, and reference
collection.

### Lease timeout

Use timeout action `pause` with `autoResume:false`; only the control plane may
reconnect, and release kills. Auto-resume hides authorization/state transitions;
timeout kill makes idle recovery expensive; pause is not a checkpoint. Production
timeout values come from measured idle cost and reconnect latency.

## E2B implementation notes

- Use `Sandbox.create` for trusted templates and restoration,
  `createSnapshot` for checkpoints, `connect` for explicit resume, and `kill` for
  release/reconciliation.
- E2B snapshots include memory and processes. Use them only for the same agent and
  always rekey transport identity after restore.
- Use file APIs for small bootstrap data and object storage/archive transfer for
  workspaces. The sandbox filesystem is not durable artifact storage.
- Template start commands run during build and are captured, so creation-time
  environment variables are unavailable to them. Start per-lease processes after
  creation.
- Bind production exec-server to loopback, keep secure controller access enabled,
  and configure public traffic/egress per role.
- The runtime user is uid 1000 and `/workspace` must be writable by it.

## Canary configuration

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

Set `CODEX_HOSTED_AGENT_TOKEN` in the Codex process. Every hosted role requires a
non-empty `sandbox_template`. Keep the feature gated until the acceptance matrix
in [`TODO.md`](TODO.md) passes.
