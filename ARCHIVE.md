# Hosted Agent E2B Reference Archive

This document preserves the verified integration facts, stable backend contract,
architecture decisions, and spike results for the hosted-agent E2B backend. It
is reference material, not a work queue. Remaining implementation work is in
[`TODO.md`](TODO.md).

## Local hosted-Codex POC foundation (2026-07-19)

The Linux-only POC uses a host Node.js control service and a disposable Compose
stack containing only PostgreSQL 17 and Garage 2.3.0. Garage runs with
`--single-node --default-bucket`, replication factor one, generated per-run S3
credentials, and named metadata/data volumes removed by `down --volumes`.
PostgreSQL, Garage S3, and control ports bind only to `127.0.0.1`; occupied fixed
ports fail preflight.

All generated state lives below ignored `e2b/.state/poc/<run-id>`. Runtime and
Compose environment files and private keys use mode `0600`. The service stays on
the production PostgreSQL/S3 path: `HOSTED_AGENT_DEVELOPMENT` is absent, Garage
uses path-style S3 at region `garage`, and the service receives exact per-run
tenant, worker, bearer, and `managedBy` identities. Docker never receives Codex
authentication material.

TLS is an ephemeral two-day CA plus localhost server certificate with DNS
`localhost` and IP `127.0.0.1` SANs. The POC creates a combined bundle from the
system Debian CA bundle and its local CA; it does not mutate system trust or Rust
sources. Startup checks unauthenticated HTTPS denial, authenticated HTTP routing,
certificate validation, and WSS missing-ticket denial before any E2B allocation.

The new public foundation commands are `preflight`, `up`, `status`, and `down`
through `e2b/scripts/hosted-codex-poc.sh`. Unit evidence: strict env defaults,
unknown-key/auth/port rejection, runtime-file modes/secret separation, required
TLS SANs, combined trust, and certificate verification. Local Docker evidence:
both pinned services reached healthy state, Garage passed scoped S3 `HeadBucket`,
and all checksummed migrations ran before the deliberately credential-free
foundation service startup check. No `codex/codex-rs` file changed.

## POC source, authentication, and generated configuration (2026-07-19)

The POC accepts exactly one Codex authentication source. Access-token mode builds
an allowlisted Codex-only environment containing `PATH`, the isolated
`CODEX_HOME`, the combined CA, the hosted-service bearer, and the access token.
Auth-JSON mode rejects paths outside the repository, every symlinked path
component, non-files, malformed/non-object/empty JSON, and copies the original
bytes to runtime mode `0600`. Device login uses a temporary ignored directory
under `e2b/poc/secrets` and replaces only the documented regular-file target.

`source-snapshot-client.ts` computes the archive SHA-256, emits the four-byte
big-endian metadata envelope, authenticates without tenant data, validates TLS
through the combined bundle, refuses redirects, bounds request/response bytes,
and accepts only the exact response shape with matching checksum, expiry, and
size. The CLI reuses `archiveWorkspace`; the fixture maps exactly to
`file:///workspace/roots/0/fixture` with a four-hour maximum TTL. A live Docker
integration uploaded and resolved that fixture through the production HTTPS
source API backed by PostgreSQL and Garage, in addition to the Garage object
round trip and repeatable migrations.

Template metadata now gates build ID, 40-hex revision, template ID, checksum,
matching executable artifact, ELF64 little-endian x86_64 identity, and local
SHA-256. Generated isolated config enables both hosted agents and multi-agent v2,
omits the tool namespace to produce plain tool names, selects root by default,
binds the immutable source, and gives root/child distinct logical templates. The
server-owned JSON maps both logical roles to the verified provider template with
policy version one and the exact domain/plain-tool allowlists.

The ignored template metadata currently present in this workspace points to an
older checksummed binary whose strict-config checker reports
`hosted_agents.source_snapshot` as unknown. The new preflight correctly fails on
that mismatch before Docker or E2B allocation. A rebuilt matching Codex artifact
and hosted template metadata are therefore required for the live proof; no Rust
source was changed to bypass the check.

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
fake. Its eight operations are `provision`, `reconnect`, `checkpoint`,
`export_patch`, `apply_patch`, `retain`, `clear_references`, and `release`. The client enforces HTTPS control
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

Docker remote-executor validation was completed on 2026-07-18 after restoring
safe host build capacity. The standard Ubuntu harness built the Codex CLI,
provisioned its container, reached a healthy remote exec-server, and first
passed `remote_test_env_can_connect_and_use_filesystem`. A broad 964-test run
then passed 874 tests and failed 90. Three failures were stale remote fixtures
that requested `/bin/sh` even though the selected environment advertised Bash;
the other failures retained the already recorded host-local helper,
network/proxy, nested-sandbox, approval, and mock-server environment-sensitive
signatures. Two remote opt-ins outside the focused module remain among that
harness debt: a network-approval fixture and an unavailable
`test_stdio_server` helper. The broad run is not recorded as green. After
changing the three explicit shell fixtures to `/bin/bash`, all 19 `codex-core`
`remote_env` tests passed with zero failures. This closed the earlier linker
`SIGBUS` gap caused by the root filesystem being 99% full. The focused local
app-server patch-route suite also passed. The standard remote harness still
cannot synthesize the service-owned WSS lease; that remains part of the final
live app-server acceptance flow. Windows/Wine and macOS compatibility were
explicitly deferred when the implementation and acceptance scope narrowed to
x86_64 Linux.

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

The object store contract also supports idempotent exact-object deletion: the
development store validates the content identifier before a forced unlink, and
the S3 implementation issues `DeleteObject` for the same configured bucket/key
that publication registered. A bounded `PostgresObjectReclaimer` can now reclaim
registered object allocations owned by one in-progress operation generation. It
retains anything referenced directly or through a source snapshot, workspace
snapshot, or artifact; identical physical content owned by another logical
object is kept while only the unreferenced logical audit row becomes
`deleted`.

Publication and registration use a transaction-scoped physical-locator lock;
reclamation uses the same PostgreSQL-safe lock key at session scope across its
committed phases, followed by logical-object and row locks. Reference creation
locks the available logical-object row. This prevents a reclaimer from
deleting content between a content-addressed put and tenant registration, makes
reference creation lose safely once deletion starts, and serializes competing
replicas. Distinct logical objects, including unchanged snapshots in the same
tenant, may share one physical locator; the non-unique locator index supports
lookup without making content identity a logical-ownership constraint.

Reclamation commits `deleting` before external I/O while retaining a
session-scoped locator lock, performs idempotent deletion outside any database
transaction, then commits `deleted`/`reclaimed` audit state. If deletion succeeds
but the worker or final commit is lost, a tenant-bounded recovery pass resumes
the durable `deleting` row without relying on the original operation generation.
It rechecks the physical locator after reacquiring the session lock, so content
republished or registered by a sibling logical object during the crash window is
retained while only the stale logical row is finalized. Per-object failures are
counted without starving later rows in the bounded batch.
PostgreSQL 17 coverage proves bounded batches, worker/generation fencing,
retained references, same- and cross-tenant shared bytes, failure/crash retry,
and competing replica claims. Allocations whose physical put
succeeded before relational registration remain intentionally untouched because
their logical allocation lacks a trustworthy physical locator; an aged,
authenticated storage-inventory pass is still required for that crash window.

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

The production gateway now opens provider exec connections through E2B's
secured public-traffic boundary. Provider create/restore and both live canaries
use `secure:true`; the provider exposes a separate transient exec-upstream value
containing only a canonical WSS root URL and the bounded traffic access token.
The gateway independently revalidates that value, sends the token only as the
`X-Access-Token` upstream header, and returns generic close reasons for missing,
malformed, or rejected credentials. Created sandboxes, inventory, logical
responses, URLs, and durable state contain no traffic token. Development-only
plain WebSocket upstreams are restricted to numeric loopback addresses, and
upgrade requests accept exactly one `ticket` query parameter before consuming
it. Direct unauthenticated access is denied in focused tests. The exec-server
still listens on `0.0.0.0:22101` inside the sandbox because E2B's public proxy
cannot reach a loopback-only listener; replacing that route with provider-private
networking remains an explicit production blocker.

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
checksum. Production startup wiring and successful-expiry garbage collection
remain open.

The TypeScript wire contract now has an exact `sourceSnapshot` provision source
containing only the opaque source ID and trusted lowercase SHA-256. It rejects
tenant IDs, owners, host paths, archive bytes, and extra properties. A separate
authenticated API adapter validates canonical create/resolve JSON, takes tenant
only from trusted context, receives archive bytes out of band with a 512 MiB
pre-dispatch cap, and revalidates lifecycle response identity and archive
integrity. The control plane now accepts that trusted principal and a narrow
resolver as injected service configuration, resolves and verifies the exact ID,
checksum, and archive before provider creation, uploads the defensive archive
copy, and uses its canonical remote cwd/root URIs. Missing configuration remains
fail-closed with 503. Authorization or storage failure allocates nothing; later
provision failure reclaims the sandbox; successful idempotent replay neither
resolves nor allocates again.

Linux workspace transfer no longer extracts over a live root or reuses a fixed
temporary archive. Every upload first runs the complete non-extracting manifest
parser with archive, entry, file, byte, path, link, type, conflict, and expansion
limits; malformed input causes no SDK file write or command. The provider now
uses the deployment's configured ingress limits, including checked archive
wrapper overhead, and independently requires contiguous indexed roots within
the configured root-count cap. This covers child and durable captures as well
as already-validated source uploads. Upload and export use unique opaque paths;
upload extracts
under a same-filesystem stage, requires the staged `roots` directory, applies
ownership without following symlinks, moves the prior roots to a backup, and
restores that backup when a failed swap or SDK-reported interruption returns.
Shell traps and a separate SDK-level `finally` cleanup cover command and
transport failures. Export checks its remote archive size before SDK readback,
validates the downloaded archive again, and always removes its temporary file.
The development ingress now writes canonical `roots/...` tar names accepted by
the universal boundary.

Both directions emit fixed-cardinality, path-free phase events containing only
direction, phase, bounded duration/bytes, and success. They cover validation,
transfer, extraction or capture, and cleanup; observer failure cannot affect
workspace state. Both directions return only generic errors rather than provider
stderr. Eight Linux transfer tests prove exact replacement, binary bytes,
executable modes, symlinks, failed extraction, interrupted-swap recovery,
configured archive/root rejection before provider I/O, pre-read export bounds,
metric redaction/isolation, cleanup, archive round trip, and actual development
ingress compatibility. The full 153-test TypeScript run passed with 116 passes
and 37 database-gated skips.

`PostgresDurableState` now also exposes a final, transaction-composable source
authorization primitive. It locks the exact source row only when tenant, opaque
ID, trusted checksum, `available` state, and unexpired lifetime all still match,
using the caller's PostgreSQL client so authorization can be repeated in the
same transaction that eventually attaches the lease. Mismatch is deliberately
reported as not found. Together with the pre-allocation resolver, this closes
both sides of the authorization time-of-check gap. Production provision still
needs to select the PostgreSQL lifecycle and resolver at startup.

Rust Codex now accepts optional trusted `[hosted_agents.source_snapshot]`
deployment metadata containing only a canonical `source_<32 lowercase hex>` ID
and lowercase SHA-256. It is retained in locked session configuration. Root
hosted threads emit the exact path-free `sourceSnapshot` provision variant while
children continue to use their owner lease and development deployments without
the metadata retain the allowlisted `rootWorkspace` bridge. The in-memory fake
can register immutable source metadata for deterministic root-selection tests.
Exact serde, invalid-config, root-selection, and ownership-lineage tests passed;
the broader lineage test requires the repository's 16 MiB Rust test stack.
Production startup now constructs the PostgreSQL lifecycle/resolver and activates
the authenticated creation route when durable database and trusted tenant
configuration are present.

The source creation HTTP boundary is now implemented behind explicit trusted
principal/API injection. `POST /v1/source-snapshots` accepts only
`application/vnd.codex.source-snapshot.v1`: a four-byte big-endian metadata
length, at most 64 KiB of exact JSON metadata, then the separately bounded tar
bytes. Tenant identity comes only from authenticated server context and is
rejected in metadata; queries, wrong content types, malformed framing, invalid
UTF-8, empty/oversized archives, and streamed or declared overflow fail before
lifecycle dispatch. Responses are validated non-secret references with no-store
and nosniff headers. API root/archive bounds are deployment-injectable instead
of hard-coded. The full 155-test TypeScript run passed with 118 passes, 37
database-gated skips, and zero failures.

Outside explicit development mode, startup now requires
`HOSTED_AGENT_DATABASE_URL` (or `DATABASE_URL`) and the single-tenant deployment
identity `HOSTED_AGENT_TENANT_ID`, applies checksummed migrations, constructs the
PostgreSQL durable source state, and injects the same principal/lifecycle into
both upload and pre-allocation provision resolution. Development may omit both
and retains the local bridge; partial configuration fails closed. Source TTL,
root, archive, file, entry, path, and expansion bounds share deployment limits.

The production source reclaimer uses the same physical-location advisory lock as
publication. It safely covers object-store put before registration, exact
registered-but-unreferenced objects, shared physical content across tenants,
durable source/object references, concurrent replicas, and resumable `deleting`
state. A PostgreSQL 17 run exercised the complete 158-test TypeScript suite with
158 passes, no skips, and no failures. This completes remote immutable source ID
creation and pre-allocation resolution without client-host `file:` access; the
remaining JSON-to-PostgreSQL provision transaction cutover is tracked separately
under production persistence.

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

### Local black-box lifecycle acceptance

A local Linux acceptance harness now drives the actual HTTP server,
development control plane, JSON store, filesystem object store, ticket issuer,
gateway, fake provider, and a token-checking WebSocket exec endpoint solely
through public HTTP/WSS boundaries. Concurrent identical provision requests
exposed a read-before-journal race in the development control plane. A
per-operation in-process gate now makes identical callers wait for terminal
replay and makes changed requests observe the committed request hash before any
provider mutation. This gate intentionally hardens only the single-process JSON
development substitute; PostgreSQL uniqueness, claims, and fencing remain the
multi-replica production mechanism.

The harness proves one allocation for concurrent duplicates, changed-key
rejection before mutation, unique distinct leases/environments, checkpoint
durability, service/store restart against the same provider sandbox, ticket
rotation, authenticated command echo after reconnect, missing-sandbox 404,
workspace-only clean restore with fresh identity, repeatable release, zero live
sandboxes, and retained checkpoint bytes. Provider creation errors and gateway
upstream authentication denial return stable redacted failures, cause no
fallback allocation, and leave neither injected provider error text nor traffic
credentials in persisted JSON. Unexpected development-provider errors are now
recorded only as `service unavailable`; bounded client-caused failures retain
only their status class. The three focused black-box tests and the complete
PostgreSQL-backed 254-test suite pass with no skips. This coverage does not
replace production PostgreSQL lifecycle dispatch or the final live E2B run with
an unmodified Codex client.

### Production PostgreSQL lifecycle dispatch

Production startup now separates the lifecycle interface from the development
`ControlPlane`. Explicit development mode retains the JSON store, local ticket
issuer, and local lease directory. Outside development, no JSON control-plane
state is opened: immutable-source provision, durable restore, checkpoint,
reconnect, and release dispatch to their PostgreSQL coordinators. The gateway
and every coordinator share one `PostgresTicketIssuer` and
`PostgresDurableState`, so ticket hashes, connection generations, active sandbox
lookup, replay, rotation, and revocation use one authority across replicas.
Reconnect and release also revoke this replica's active gateway sockets after
their durable transition.

Trusted production roles now come from exact `HOSTED_AGENT_ROLES` JSON keyed by
agent type. Each role contains only `sandboxTemplate`, `providerTemplateId`,
`toolPolicy`, and positive `policyVersion`; names, policy domains/tools, counts,
and UTF-8 byte lengths are bounded. Duplicate sandbox templates are rejected so
restore cannot ambiguously select a policy. Local `rootWorkspace` ingress stays
disabled in production. At this stage child provision was deliberately not
supplied to the production dispatcher: it returned a stable 503 until command
traffic shared the lease gate, preventing a durable but command-inconsistent
capture from being exposed. The later production command-quiescence milestone
below closes that gap.

Startup runs the generic, child, and patch-apply reconcilers once before
listening and then starts their non-overlapping bounded pollers. Generic stale
claims explicitly exclude `patch_apply`, whose richer phase ledger belongs only
to its dedicated reconciler; child subtype rows remain isolated as before.
Immutable provision now continuously heartbeats source resolution, provider
create/upload/start/probe/export/snapshot calls, workspace preparation, and
cleanup. Patch export does the same around source resolution, artifact storage,
and object reclamation. Live gated tests prove neither operation can be taken
stale during a slow external call.

Router, role configuration, exclusion-filter, heartbeat, and existing lifecycle
coverage bring the complete Docker-backed PostgreSQL suite to 272 passing tests
with no skips. The remaining production-dispatch gap is the durable command
interaction gate required before child exposure (and for a fully
command-consistent patch/checkpoint instant), plus the final live E2B client
acceptance run.

### Durable command-interaction gate foundation

Migration 0012 adds a tenant/lease/generation/session-scoped interaction ledger
for process and filesystem mutations. Admission takes the same PostgreSQL lease
advisory lock as lifecycle mutation, verifies the exact active lease generation,
and records an active interaction before returning. Exact detach, resume, and
finish transitions are idempotent; finished rows are terminal, unfinished
process identity cannot be reused within a session, and identity fields are
immutable. Lifecycle
quiescence fails closed on every unfinished row, including an older generation,
so rotation cannot hide work with an ambiguous outcome.

Durable checkpoint and child capture now assert quiescence while already holding
their lease lock. Patch apply asserts it before rollback capture or workspace
mutation, and stale patch recovery repeats the assertion before restoring a
rollback archive. Cross-replica PostgreSQL tests prove that interaction admission
and lifecycle capture exclude each other, generation fencing is exact, and all
three mutation paths leave provider/object/workspace state untouched while a
command remains unfinished.

This is intentionally a foundation rather than a claim of end-to-end command
consistency: production gateway traffic does not populate the ledger yet.
Protocol-aware process/filesystem tracking must record before forwarding, keep
ambiguous disconnects detached and fail closed, and finish only from an
authoritative exec-server response or notification. Production child dispatch
therefore remains disabled until that gateway wiring is complete. Migration,
transition, exclusion, and lifecycle refusal coverage brings the complete
Docker-backed PostgreSQL suite to 278 passing tests with no skips.

### Production command quiescence and child dispatch

The production WebSocket gateway now recognizes an exact allowlist of the
exec-server protocol and fails closed on unknown message shapes, methods,
duplicate request IDs, and unsafe numeric IDs. It durably admits every process
start and filesystem mutation through the generation-fenced interaction ledger
before forwarding the frame. Filesystem operations finish only after the matching
response or error. A disconnect keeps forwarded work detached; successful
session resume finishes older-generation filesystem entries only after the old
handler has completed filesystem shutdown, while process entries are listed and
reattached across connection generations.

Process completion has a stronger Linux-only contract than process exit. The
exec-server retains late stdout/stderr, terminates the whole process group, scans
`/proc` until no non-zombie group member remains, and only then emits the new
`process/quiesced` notification. `process/read` also reports the quiesced state so
a reconnect can recover a notification missed during disconnect. The gateway
finishes a process ledger entry only from one of those two authoritative signals;
`process/exited`, `process/closed`, and termination responses are deliberately
insufficient. Migration 0013 permits a reused client process ID only after its
previous interaction is terminal and gives every execution a fresh immutable
interaction identity.

Production startup now supplies the durable child coordinator, so child capture
is enabled behind the same lease/quiescence fence as checkpoint and patch apply.
Gateway ordering tests prove admission precedes forwarding and durable finish
precedes client-visible quiescence. Reconnect tests cover binary JSON, missed
terminal notifications, older-generation process reattachment, and filesystem
shutdown settlement. Linux integration coverage proves redirected background
descendants are gone before quiescence, while existing late-output coverage
remains green. The exec-server protocol's 12 tests and the complete
Docker/PostgreSQL-backed E2B suite pass, the latter at 283 tests with no skips.

### Codex durable-reference synchronization foundation

Migration 0014 adds one tenant/thread desired-reference row for the exact base
snapshot, latest snapshot, optional patch artifact, and current lease recorded by
Codex. The new strict `POST /v1/agents/retain` route authorizes the lease to the
authenticated tenant and agent, authorizes both snapshots through that agent's
lease lineage, authorizes the optional artifact to the agent or its owner, and
atomically replaces only that tenant/thread's `codex_thread` roots. Sync is
idempotent and remains available after lease release.

The Rust hosted-service contract now exposes the same retention operation. Codex
syncs initial durable state before committing startup, syncs turn and patch-apply
checkpoints after local persistence, and unconditionally syncs the complete final
record before release. Production release checks the synchronized latest
snapshot under its existing lease transaction before it can revoke or destroy
the sandbox. A failure therefore preserves the lease instead of crossing a local
persistence/service-retention crash window. This work also fixed a core read
destructure exposed by the new exec-server `quiesced` response field.

The next retention layer copies the complete snapshot/artifact object graph into
tenant/thread `codex_thread` roots with unbounded retention. Artifact lookup,
expiry sweeps, and patch-apply source verification now treat a live Codex root as
authoritative beyond the artifact's ordinary TTL while continuing to verify
state, identity, checksums, locators, and bytes. Release verifies every direct
root under the lease fence and removes that released lease's incidental
`lease_base`, `lease_latest`, and `lease_restore_source` snapshot roots after the
Codex roots are safe.

Migration 0015 adds a positive monotonic revision and service-computed SHA-256
desired-set hash to every tenant/thread control row. Initial synchronization must
omit an expected revision; a different desired set must present the current
revision and advances it exactly once. Exact crash replays return the stored
revision and hash even from an older local revision, while stale different-set
writers fail before roots change. PostgreSQL serializes this decision under the
tenant/agent lock. Codex persists each acknowledged revision with runtime state,
including checkpoint, patch-apply, and final artifact synchronization; legacy
records safely default to no revision. The fake service mirrors the compare-and-
swap and replay semantics.

Migration 0016 and `POST /v1/agents/references/clear` add the remote half of
thread deletion. A clear is tenant-, agent-, lease-, and revision-bound. Its
transaction advances the revision once, records a permanent clear timestamp and
empty-set hash, and removes every snapshot, artifact, and object `codex_thread`
root. Exact stale replays return the cleared revision/hash, while wrong-lease,
future/stale active revisions, and every attempt to retain after clear fail
closed. The control row remains as the non-resurrection tombstone.

SQLite migration 0042 completes the local deletion lifecycle with a standalone
subtree outbox that has no cascading dependency on thread rows. App-server first
stops every subtree member and completes hosted release, then records the entire
validated membership—including non-hosted members and each hosted lease/revision—
before deleting any rollout. A missing hosted reference revision fails before
local removal. The batch becomes remotely clearable only when none of its member
rows remains in SQLite, so crashes cannot clear service roots while local thread
data still exists.

Ready batches drain after local deletion and at app-server startup, with sustained
in-process retries capped at a 60-second backoff. Failed batches receive a durable
attempt timestamp and rotate behind untouched work, preventing an unavailable or
poison batch from starving later deletions. Partial multi-thread clear is safe
because the service clear is idempotent; the local batch is deleted only after
every hosted member succeeds. Failure to persist a successful release revision
keeps hosted cleanup pending, so deletion cannot enqueue a stale remote fence.
Durable membership also lets a repeated `thread/delete` finish after rollout,
spawn-edge, or thread-row loss. State tests cover grouped readiness, survival,
fair retry ordering, replay, completion, and missing-revision refusal; app-server
coverage proves the normal subtree path leaves no outbox residue; hosted service/
core tests cover permanent clear, exact replay, and forwarding the durable fence.
The affected local suites pass 236 tests with no skips; the complete hosted
Docker/PostgreSQL suite passes 288 tests with no skips.

Production manifest persistence is complete across every lifecycle coordinator.
Startup injects one `WorkspaceSnapshotPublisher` into immutable provision,
checkpoint, clean restore, clean child creation, and patch application. Each path
captures or reconstructs the resulting archive, publishes its exact canonical
checksummed manifest and deduplicated content graph, and commits the snapshot and
object references atomically. Patch export resolves and verifies the persisted
base/current manifests; patch application builds and reparses the prospective
archive before committing its result through the same checkpoint publisher.
Workspace publication plus PostgreSQL provision, restore, child, export, and
apply suites cover these paths. The remaining-work checkbox predated the later
production coordinator wiring and is now reconciled as complete.

The PostgreSQL lifecycle replica matrix is complete. Immutable provision,
checkpoint, release, reconnect, child creation, patch export, restore, and patch
application all exercise independent pools/coordinators with operation and lease
fencing. Clean restore and clean patch application now start identical requests
concurrently on two replicas and assert one provider mutation plus exact logical
replay. The reconnect recovery test closes the originating pool after an
external-boundary failure, reconstructs its state, journal, ticket issuer,
revoker, and coordinator from the durable schema, then uses the fresh runtime to
claim and reconcile the stale operation without losing access or duplicating the
provider transition. Existing ambiguous-commit and stale-allocation tests cover
the remaining restart boundaries and cleanup/adoption outcomes.

The production general reconciler now invokes the object reclaimer's bounded,
tenant-scoped `deleting` recovery on every pass. This closes the crash window
where physical object deletion succeeded but the worker died before committing
the logical `deleted`/allocation audit state; exact locator locking, shared
physical-object protection, and idempotent store deletion remain enforced by the
existing reclaimer. General operation, inventory, ticket, and deleting-object
work share independently bounded counters. Expiry-driven registered-object GC,
pre-registration object-store inventory, and provider pagination remain queued.

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

A mutation-free patch-application planner now reparses the checksummed artifact,
canonicalizes the target, verifies the exact target and artifact content-object
sets, and computes every three-way conflict before it can return a ready plan.
Clean plans overlay additions, modifications, deletions, binary files, modes,
directories, and symlinks while preserving unrelated target changes, and return
the complete prospective manifest plus its path-to-object map. Manifest creation
also rejects any present non-directory ancestor, so file/directory hierarchy
collisions fail before provider mutation. The focused planner tests and the full
PostgreSQL-backed suite passed (227 tests, no skips). Provider mutation remains
unwired until durable apply-source resolution, archive staging, rollback phases,
checkpoint persistence, and crash reconciliation are implemented.
Live workspace mutation remains subsequent lifecycle work.

PostgreSQL patch application now has a read-only durable-source resolver. It
takes the same transaction-scoped advisory lock and row lock used by lifecycle
writers, requires an active or paused target with an exact latest snapshot, and
authorizes an artifact only when its released-or-live source child records both
the target lease and target agent as owner. Tenant, expiry, and wrong-owner-lease
cases do not disclose artifact existence. Under that fence it verifies the
artifact's owner, snapshot, and object-reference graph; object kind, state,
expiry, locator, size, and SHA-256 against physical bytes; canonical artifact and
manifest parsing; embedded versus durable lineage metadata; and the complete
target and changed-content sets before invoking the mutation-free planner. The
resolver returns verified content bytes for later staging and composes with a
caller-owned transaction so the same lease fence can cover subsequent apply
phases.

Five live PostgreSQL tests cover clean planning after child release, conflict
planning, exact owner-lease isolation even for another lease of the same agent,
expiry and tenant non-disclosure, missing/corrupt/dishonestly located material,
and a two-pool checkpoint race that cannot advance the target while the apply
resolver's transaction owns its fence. The full suite passed 232 tests with no
skips. The resolver is deliberately not exposed at HTTP until deterministic
archive assembly and the durable rollback/stage/swap/checkpoint phase ledger are
implemented.

Ready patch plans can now be assembled into deterministic uncompressed Linux
workspace tar files without touching a sandbox. The builder accepts exactly one
verified body per planned file, rechecks logical object reuse, SHA-256, size,
path, mode, and complete content-set identity, emits stable uid/gid/time metadata,
and uses deterministic PAX records when canonical Unicode paths or links exceed
ustar fields. It bounds the archive as records are emitted, then reparses the
finished bytes through the existing no-extraction archive boundary and requires
the complete manifest to round-trip exactly. Tests cover binary and empty files,
executable/directory modes, symlinks, long PAX paths, deterministic repetition,
missing/extra/duplicate/dishonest content, inconsistent object reuse, and archive
quota overflow. The full suite passed 235 tests with no skips.

Migration 0009 and a transaction-composable PostgreSQL repository now persist
each mutating patch attempt independently of the operation's eventual logical
response. An immutable identity fixes the exact target lease and pre-apply
snapshot, artifact, provider sandbox, result snapshot and manifest, and staged
archive checksum and size. The rollback provider snapshot can be recorded only
through an allocated `provider_snapshot` ledger row owned by the same fenced
operation and target lease. Database triggers permit only `planned` to
`rollback_ready`, ordered swap/checkpoint transitions, or explicit rollback and
pre-mutation failure paths; identity, prior timestamps, rollback allocation, and
error metadata cannot be rewritten during later transitions.

Repository transitions require the current operation generation and worker, so
stale takeover immediately fences the old process while allowing the new owner
to resume the recorded phase. `checkpointed` additionally requires that the
result is the target lease's available latest snapshot and that its manifest and
workspace-archive objects match the planned checksums and archive size. Four live
two-pool tests cover exact concurrent replay, caller-owned transaction rollback,
the complete success path, unavailable checkpoint refusal, stale-worker rollback
resumption, invalid rollback allocations, and direct-SQL identity/timestamp/phase
guards. Migrations remain concurrent and repeatable; the full suite passed 239
tests with no skips. Provider rollback creation, swap execution, checkpoint
publication, and reconciliation remain unwired from this ledger.

A PostgreSQL patch-apply coordinator now drives that ledger through real provider
and durable-storage effects. A session-scoped advisory lease lock, compatible
with every existing transaction-scoped lifecycle lock, spans provider calls
while allowing each crash boundary to commit separately. Under it the
coordinator claims/replays the operation, resolves and plans exact material,
builds both result and rollback archives, creates and immediately ledgers a
named provider rollback snapshot, commits `swap_started` before the provider's
already-staged atomic roots replacement, verifies the exported live result
against the planned manifest, and creates a named result provider snapshot.
Workspace preparation now accepts `patch_apply` as a checkpoint source mode, so
the result archive, manifest, content, provider snapshot, target latest pointer,
application `checkpointed` phase, and adopted allocations commit as one final
database transaction before the logical `applied` response.

Normal conflicts and rejections complete without an application row or any
provider, workspace, or object-store mutation. Post-snapshot failures enter the
durable rollback path and upload the independently validated original archive;
the operation becomes terminal only after `rolled_back` and provider-snapshot
reclamation. A failed rollback deliberately retains its provider snapshot for
reconciliation. Success similarly deletes and reclaims the temporary rollback
snapshot before completing the operation, while the result snapshot and all
checkpoint objects remain adopted. Deterministic application, snapshot, and
provider snapshot names support later inventory recovery.

Three PostgreSQL integration tests cover clean apply/checkpoint/replay, complete
conflict immutability, and a one-time provider failure after swap that restores
the exact original archive and latest-snapshot identity. A separate two-pool
test proves the session lease lock remains exclusive across an intermediate
commit.

The authenticated `POST /v1/agents/patch/apply` boundary now exact-validates the
tenant-free request, dispatches only to the tenant-bound PostgreSQL coordinator,
exact-validates the logical response, and returns `applied`, `conflict`, and
`rejected` as successful tagged JSON results. Production startup shares one
journal, durable state, and object reclaimer between patch export and apply,
constructs durable checkpoint preparation with deployment archive limits, and
fails closed when the PostgreSQL runtime is absent rather than calling the JSON
control plane. Focused HTTP tests cover every result tag, extra tenant-field
rejection before dispatch, malformed coordinator output, and unavailable durable
service behavior. The full PostgreSQL-backed suite passed 244 tests with no
skips.

A production-wired, patch-apply-only reconciler now claims stale operations with
an explicit tenant and `patch_apply` filter, without enabling the general
inventory reconciler against lifecycle sandboxes still owned by the JSON control
plane. It holds the same session lease lock as a live apply, validates the
immutable application and exact allocation metadata, and resolves the original
workspace archive directly from the checksummed durable source snapshot without
depending on an artifact that may have expired. Before checkpoint it
conservatively restores every ambiguous `swap_started`, `swapped`, or
`rollback_started` outcome, aborts and reclaims staged workspace objects, removes
ledgered and deterministic-name unledgered provider snapshots, and only then
fails the operation terminally. A verified `checkpointed` attempt instead
preserves every adopted result resource, reclaims only rollback state, and
reconstructs the exact `applied` response.

Provider deletion failure remains retryable, resource deletion rechecks durable
snapshot and unfinished-allocation guards under the provider-resource lock, and
the checkpoint repository now revalidates the complete latest-snapshot/object
graph even on phase replay. Recovery rechecks the original canonical request
hash and the exact committed preparation, numeric object-allocation set, result
provider allocation, provider snapshot, archive, and manifest identities before
completing. Snapshot RPC failures whose server-side outcome is ambiguous remain
in progress for a later deterministic inventory pass even when immediate cleanup
finds nothing. The stale-claim update also carries tenant identity through its
candidate/update join as defense in depth.

Seven additional live tests cover lost rollback/result snapshot responses,
expired-artifact rollback-ready recovery with a missing redundant content blob
and without claiming an unrelated checkpoint, an unledgered rollback snapshot,
ambiguous swap-started rollback plus cleanup retry, swapped prepared-object and
unledgered-result cleanup, and checkpoint-commit-before-response completion.
The checkpoint case deliberately crosses single- to double-digit allocation IDs.
The full PostgreSQL-backed suite passed 251 tests with no skips.

### Durable patch-artifact repository

Patch export now has a verified immutable-source boundary. Canonical manifest
bytes must be exact UTF-8 canonical JSON, match their snapshot identity and
digest, and pass every workspace structural and quota check. The PostgreSQL
resolver authorizes the active/paused child lease, exact requested base and
durable latest snapshots, then follows only tenant-owned snapshot references;
every manifest and content object must be available, unexpired, at the exact
configured bucket/key, and match its durable size and digest. Artifact creation
and snapshot reads can now join a caller-owned transaction, and artifact
validation rejects unavailable or expired snapshots. Live PostgreSQL and parser
coverage exercise authorization, locator/content corruption, expiry, canonical
shape, and rollback visibility; all 213 tests pass. At that stage the journaled
coordinator, artifact-object publication, stale cleanup, and HTTP wiring remained.

The unwired PostgreSQL patch-export coordinator now claims `patch_export`
against the exact source lease and derives deterministic artifact and logical
object IDs from tenant/operation/idempotency identity plus the serialized
checksum. It resolves and verifies the immutable base/latest graph, maps every
changed current file to one exact retained content object, serializes canonical
artifact bytes, and immediately registers and journals the content-addressed
put. Under the source-lease lock it repeats the complete authorization and
serialization, then creates all artifact references, adopts the object
allocation, and stores the bounded logical response in one transaction. Replay
checks the durable artifact's tenant, lease, agent, base, checksum, count, and
size without another put. Caught failures reclaim the unreferenced object, and
ambiguous commit acknowledgement preserves durable success. Two-replica,
authorization, storage-failure, final-lineage-race, cleanup, and ambiguous-commit
coverage bring the live PostgreSQL suite to 218/218. Explicit stale-operation
takeover/reconciliation remained before production use.

The authenticated `POST /v1/agents/patch/export` boundary now exact-validates
the archived request before dispatch, invokes the tenant-bound PostgreSQL
coordinator configured by production startup, exact-validates the secret-free
logical response, and returns the canonical artifact metadata. The route is
unavailable rather than falling back to the JSON control plane when the durable
runtime is absent. Production instances require an explicit unique
`HOSTED_AGENT_WORKER_ID` for journal fencing; artifact retention defaults to
seven days and is bounded by the coordinator. Focused route tests cover valid
dispatch, tenant-field spoofing, and unavailable durable service behavior. The
complete Docker/PostgreSQL 17 TypeScript suite passes 219/219 with no skips.

The bounded PostgreSQL reconciler now understands stale `patch_export`
operations. It accepts only the coordinator's one exact deterministic object
allocation and exact `{artifactId,checksum}` metadata; malformed, extra,
cross-lease, or otherwise inconsistent state remains pending without deletion.
For an adopted allocation, recovery holds the source-lease lock, rechecks the
current generation and complete allocation identity, verifies the tenant-scoped
available artifact and artifact object under the same transaction, and writes
the same validator-built logical response as the normal commit path. For an
unadopted allocation, it uses the existing generation-fenced, reference-safe,
shared-locator-safe object reclaimer and terminalizes only after the allocation
is durably reclaimed. An adopted object without its exact artifact fails closed
and remains untouched. Transaction-composable allocation reads and a dedicated
artifact reconciliation lookup keep these checks inside the recovery lock.
Focused malformed-state coverage plus two-replica PostgreSQL tests prove exact
logical reconstruction, old-worker fencing, physical cleanup before terminal
failure, and no deletion of inconsistent adopted state. The complete
Docker/PostgreSQL 17 TypeScript suite passes 223/223 with no skips. The general
reconciler remains intentionally unwired from production startup until the
remaining lifecycle writers share its locking protocol.

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
export/apply orchestration were the next lifecycle work; serialization and
durable upload are now supplied by the unwired coordinator described above.

The canonical artifact format now bundles the exact base/current snapshot IDs
and manifests, complete sorted changed paths, nullable content-object IDs for
changed current regular files, changed count, and current-content byte total.
It never embeds file bodies. Serialization reconstructs the diff, requires every
changed current file's logical content object exactly once, and returns deterministic
canonical bytes, SHA-256, and deduplicated content IDs for storage/repository
registration. Parsing bounds bytes before decoding, requires exact UTF-8 JSON
shape and byte-for-byte canonical encoding, verifies the checksum, then rebuilds
the entire envelope from its manifests to reject altered order, paths, types,
identities, counts, sizes, or references. Five focused tests cover deterministic
binary/mode/directory/link/add/delete output and corruption/quota rejection.

### Tenant-safe workspace snapshot publication

An intentionally unwired `WorkspaceSnapshotPublisher` now parses a provider
workspace archive once without extraction, builds its canonical manifest, and
publishes the archive, manifest, and deduplicated file content through the
authenticated content-addressed object store. Each physical write is checked
against its SHA-256 identity and exact store-reported bucket/key before a
tenant-owned logical object is registered. Logical IDs bind tenant, snapshot,
kind, and checksum, so two tenants can safely retain identical physical bytes
without colliding in PostgreSQL.

Base-lease and checkpoint transactions now retain every content blob alongside
the archive and manifest. Object references require an `available` object, so a
future reclaimer cannot attach new durable state to an object already entering
deletion. The publisher validates the durable lease/snapshot result before
returning and invokes a reference-aware cleanup boundary only for confirmed
physical puts; cleanup failure remains explicit for reconciliation. Ambiguous
put failures and process crashes before registration still require an aged
object-store inventory sweep.
It remains unwired until the PostgreSQL lifecycle coordinator and the
transactional physical/logical object reclaimer own these boundaries together.

Canonical patch artifacts and their PostgreSQL repository now carry opaque
tenant-scoped logical content IDs rather than assuming a raw digest is a global
database identity. Repository creation binds each logical content row's trusted
checksum and size back to the current manifest. Focused tests cover canonical
binary/mode/link changes, partial publication failures, committed replay
protection, deduplicated files, and cross-tenant physical sharing; PostgreSQL 17
coverage proves six distinct logical objects and snapshot references over the
shared archive/content locations for two tenants.

The publisher now has a separate unwired durable base-preparation entry point.
It accepts only an owned `provision` fence whose tenant matches the complete
canonical intent, derives preparation-scoped logical IDs, and finishes archive
parsing, manifest capture, quota checks, locator resolution, and intent
validation before the first write. For each missing object it holds the exact
physical-location plus operation/preparation locks while put, logical
registration, allocation recording, and association commit as one database
unit. Exact concurrent or later replay verifies the full descriptor set and
performs no duplicate put. Partial failure moves only that preparation into
reclamation, attempts a bounded scoped batch, and exposes cleanup-pending so an
aborted replay can continue it. A PostgreSQL live test proves three exact
registrations/allocations/associations, concurrent no-put replay, no lease
attachment, and terminal cleanup after a partial publication failure. A put
whose database transaction never commits still has no safe durable identity and
remains part of the explicitly open aged object-store inventory sweep.

The same publisher can now attach a prepared base using the caller's PostgreSQL
transaction. It locks and re-verifies the durable intent and exact allocated
object set, repeats tenant/ID/checksum/state/expiry source authorization in that
transaction, reconstructs the snapshot only from locked database associations,
creates the lease/base snapshot, and marks the preparation committed while its
object allocations are still unadopted. It returns those locked allocation IDs
for the outer journal coordinator to adopt with sandbox/provider allocations
before logical completion. A live rollback test proves lease, snapshot, and
preparation commit all disappear together; replay then commits them successfully.
This is a transaction composition primitive, not production route wiring.

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

The journal's allocation, success, and terminal-failure writers and the durable
state's base-lease/checkpoint writers also accept an existing PostgreSQL client.
Provider locks now accept a bounded set of sandbox/provider-snapshot identities,
deduplicate and sort their unambiguous keys, and acquire them in one transaction;
the single-resource helper delegates to the same path. A max-one-connection live
test composes allocation recording, base lease/snapshot creation, explicit
adoption, response redaction, and logical completion in one commit. An injected
final failure leaves the operation in progress and rolls back every allocation,
lease, and snapshot, while independent replicas taking the same compound locks
in reverse input order serialize without deadlock. These are coordinator
primitives, not production lifecycle wiring.

Migration 0006 and the unwired `PostgresWorkspacePreparations` repository add a
durable authority for the object-publication gap before that final transaction.
One preparation is bound to an owned operation and the canonical SHA-256 of its
complete secret-free lease, source checksum, sandbox, policy, snapshot, archive,
and manifest intent. Every associated logical object must be an available object
allocation owned by that same operation, tenant, and exact purpose. The database
protects immutable preparation/object identity and legal state transitions;
repository gates lock the operation, preparation, sorted allocations, and
available object rows before `prepared` or final commit. Commit and abort thus
linearize across replicas, exact terminal transitions replay safely, and a stale
generation can resume while the old worker is fenced. Reclaim preserves deleted
object audit rows, while a later hard row purge cascades only its preparation
association. At this foundation stage these primitives were not yet composed by
a lifecycle coordinator.

`PostgresObjectReclaimer` can now reclaim one `reclaim_pending` workspace
preparation without sweeping unrelated object allocations owned by the same
operation. It holds the current worker/generation fence, locks the preparation,
claims a bounded allocation batch, and reuses the resumable exact-locator delete,
durable-reference, and shared-physical-content protections. It terminalizes only
after every object that was actually registered and associated is reclaimed;
this intentionally supports failure partway through publication, while bytes
written before database registration remain the aged-inventory responsibility.
Deleted logical rows and associations remain as audit state. Live tests cover
bounded progress, terminal replay, partial publication, unrelated allocations,
retained references, injected post-delete failure, wrong fences, and refusal to
reclaim a committed preparation.

Preparation IDs now derive deterministically from tenant plus operation and
idempotency identity; logical workspace object IDs are separately domain-bound
to preparation, purpose, and checksum. Publication replay first locks the owned
operation and preparation and can distinguish an exact existing association
from a missing object without another put. The `prepared` gate and prepared or
committed replay compare the complete expected object set—ID, purpose, checksum,
size, expiry, bucket, and key—under sorted allocation/object locks. Same-count
substitution, unavailable objects, changed locators, nonallocated rows, and
intent drift fail closed. The abort transition also has a transaction-owning
convenience path, while caller-supplied executors remain max-one-connection safe.

### Durable immutable-source provision coordinator

An unwired PostgreSQL provision coordinator now composes the existing primitives
into one immutable-source lifecycle. It strictly validates the request, resolves
agent type through a trusted role-to-sandbox-template/provider-template/policy
mapping, and claims the tenant-bound canonical request hash. A competing replica
waits for the same terminal operation; successful and failed replay perform no
provider or object mutation.

The owning worker resolves the authenticated source before allocation, creates a
sandbox with only bounded `managedBy`, tenant, lease, agent, and trusted-template
metadata, and journals the sandbox immediately under the provider-resource lock.
After upload, exec start/probe, exact workspace export, and provider snapshot, it
journals the snapshot and uses the durable workspace preparation to register the
archive, manifest, and every distinct content blob. Operation heartbeats fence
the long external stages.

One final provider-locked PostgreSQL transaction repeats source authorization,
creates the active lease/base snapshot and all retention references, adopts only
the sandbox/snapshot/prepared-object allocations, and persists a secret-free
logical response. The raw gateway ticket is created only after commit. Replay
reloads the active durable lease and rotates a fresh ticket, so a ticket-service
failure cannot roll back or duplicate the provider allocation.

Failure before commit aborts and boundedly reclaims any preparation objects,
deletes the provider snapshot, kills the sandbox, marks their allocations
reclaimed under the same locks, and only then records terminal failure. Raw
provider IDs are retained in process immediately after each external allocation,
even before its ledger insert returns, while provider inventory metadata covers
the process-crash gap. `WorkspaceSnapshotPublisher.abortDurableBase` supplies the
bounded exact-preparation cleanup path used by this coordinator.

Docker-backed PostgreSQL 17 tests force one replica to observe the other while a
ledgered sandbox is blocked in upload, then prove one provider mutation, five
adopted allocations, one committed lease/base snapshot/preparation, sanitized
logical replay, and fresh tickets. A second test fails the second workspace
object put after both provider resources exist and proves all three recorded
allocations are reclaimed, no lease/snapshot is committed, shared source content
survives, and terminal replay causes no mutation. A third test loses the final
commit acknowledgement and then injects ticket failure during confirmed-success
replay, proving the adopted lease/resources remain intact for fresh replay from
another replica. The complete TypeScript suite
passed as part of the 180-of-180 suite with zero skips against the isolated
database. Production startup remains on the legacy lifecycle until reconnect,
restore, and child capture can move to the same PostgreSQL authority together.

### Durable checkpoint coordinator

An unwired PostgreSQL checkpoint coordinator now uses the same canonical
operation journal, allocation ledger, durable workspace preparation, and
secret-free terminal replay as immutable-source provision. It holds the
transactional lease lock from authoritative lease loading through provider
workspace export and snapshot capture, workspace-object publication, and final
commit. Checkpoints for the same lease therefore serialize across replicas even
when they use different idempotency keys.

The preparation records the exact expected latest snapshot and the complete
lease identity, including agent/owner lineage, provider sandbox, trusted
template, cwd/roots, tool policy, and policy version. The final transaction
locks the preparation and provider snapshot, reloads the lease, compare-and-
swaps that expected latest identity, appends the snapshot and references, adopts
only its provider/object allocations, and persists `{snapshotId}` atomically.
The immutable base snapshot does not change.

Provider snapshot identity is retained immediately after capture and ledgered
under its provider-resource lock. If archive/object publication fails, cleanup
aborts and boundedly reclaims the exact preparation and deletes only the new
provider snapshot; it never kills the active lease sandbox or advances latest.
Both provision and checkpoint resolve an uncertain final transaction outcome
before cleanup. A confirmed success is replayed without deletion; a confirmed
still-owned in-progress operation may be cleaned; an unreadable or ownership-
changed outcome remains cleanup-pending for reconciliation. Thus a lost commit
acknowledgement—or even a simultaneous recovery-read outage—cannot cause adopted
resources to be deleted. Preparation abort also drains its complete bounded
object set across as many configured cleanup batches as required before the
operation may become terminal.

Docker-backed PostgreSQL 17 tests gate provider capture to prove two coordinators
serialize, commit distinct ordered checkpoints, preserve the base snapshot, and
replay without mutation. An injected third-object failure with one-object
cleanup batches proves the active sandbox survives while the provider snapshot
and every published object are reclaimed, latest remains unchanged, and
terminal replay is side-effect free.
An ambiguous-commit test loses the commit acknowledgement and then fails the
recovery read, proving the available snapshot and active sandbox remain intact
for later replay. The complete live suite passed 180 of 180 tests with zero
skips.

This coordinator serializes lifecycle writers that use the PostgreSQL lease
lock. The exec gateway's command path does not yet acquire that gate, so the
captured workspace cannot yet be described as a command-consistent instant;
production wiring must add command fencing (or an equivalent isolated capture
protocol) before making that guarantee.

### Durable release coordinator

An unwired PostgreSQL release coordinator now makes loss of access durable
before provider cleanup. Its tenant-bound operation claim atomically binds the
existing target lease, closing the crash gap between a journal claim and release
intent. Under the shared lease-then-provider lock order, the first transaction
revokes every ticket, moves active/paused state to `release_pending`, and records
the exact sandbox as lease-bound release cleanup work. Process-local gateway
connections are also revoked on execution and every successful replay.

A second lease/provider-locked transaction kills the sandbox, treating the
provider-neutral confirmed-missing signal as success, then atomically marks the
cleanup allocation reclaimed, the lease released, and the secret-free logical
operation `{released:true}` succeeded. It never deletes base/latest snapshots,
workspace objects, artifact data, or their references. A different release key
against the same lease observes released state and succeeds without another
kill; identical keys replay the same terminal operation.

Ordinary provider errors and ambiguous kill outcomes never terminal-fail or
restore access. They leave tickets revoked, the lease `release_pending`, the
allocation unfinished, and the operation fenced in progress. The reconciler has
an explicit release path—before generic sandbox adoption—that can reconstruct
cleanup even after a crash immediately following the target-bound claim, retry
kill under the same locks, and atomically complete the lease/allocation/operation
graph. Final database acknowledgement ambiguity uses the same conservative
outcome resolution as provision/checkpoint, so an unreadable success cannot
repeat destructive work.

The E2B adapter now maps both the SDK's false-on-missing kill result and
`SandboxNotFoundError` to the provider-neutral missing signal used by reconnect,
and removes stale cached handles. Docker-backed PostgreSQL 17 tests prove
checkpoint-before-release
ordering; one kill across duplicate and different keys; durable ticket and
connection revocation; base/latest snapshot, object, and provider-snapshot
retention; confirmed-missing success; transient kill recovery through real
stale-operation reconciliation; reconstruction immediately after a target-bound
claim with no allocation yet; and lost final acknowledgement plus failed outcome-
read replay without a second kill.

### Durable connection generations

Reconnect cannot invalidate established gateway sockets across replicas by
rotating ticket hashes alone: an accepted socket no longer presents its ticket,
and a reconnect normally retains the same provider sandbox ID. Leases and
ticket hashes now therefore carry a bounded monotonic `connection_generation`.
Ticket consumption returns the generation authenticated by its atomic database
update, while the active-lease directory returns the current sandbox ID and
generation. The gateway compares both before upgrading and at every bounded
revalidation point, closing a connection when either changes.

Successful reconnect and confirmed sandbox loss atomically increment the lease
generation and revoke prior ticket hashes under the lease lock. This also closes
the validate-before-rotation race: a ticket consumed at generation N cannot be
attached after the directory advances to N+1, even when both rows still name the
same sandbox. The JSON development backend mirrors the generation behavior.

Two focused gateway tests prove pre-upgrade race rejection and closure of an
established socket after a separate durable writer changes only the generation.
A two-pool PostgreSQL 17 test proves reconnect/loss increments, old-ticket
denial, fresh-ticket generation binding, and replica-visible active targets.
The complete Docker-backed suite passed 183 of 183 tests with zero skips on
x86_64 Linux.

### Durable reconnect coordinator

An unwired PostgreSQL reconnect coordinator now atomically claims its existing
target lease and uses the shared lease-then-exact-sandbox lock order. It verifies
that provider reconnect returns the same sandbox ID, starts and health-probes
exec, then commits ticket-hash revocation, a monotonic connection-generation
advance, active lease state, and the exact secret-free logical response in one
transaction. Only a known commit triggers immediate process-local socket
revocation and issuance of a raw gateway ticket.

Ticket issuance is bound to the exact generation produced by that execution or
replay. If a newer reconnect overtakes an older response, the older issuer fails
closed instead of minting access across the newer revocation barrier. Every
successful idempotent replay takes the lease lock, verifies the stored logical
response against current durable identity, advances the generation again,
revokes older hashes and sockets, and issues one fresh ticket. The raw URL never
enters the journal. Ticket-service failure after commit leaves the operation
succeeded so replay can repair delivery without repeating provider work.

Confirmed provider absence atomically advances the generation, revokes ticket
hashes, marks the lease `lost`, and stores terminal `service_404`; later loss or
release also makes a previously successful replay return 404 without issuing
access. Generic provider/database errors do not terminalize the operation or
alter durable access. The ordering intentionally rotates only after a successful
health probe so a transient connect/start/probe failure does not deliberately
discard still-viable lease authorization; the provider work remains scoped to
the same locked lease and sandbox.

The reconciler has an explicit zero-allocation reconnect path. A stale owner is
generation-fenced, reuses the same lease/provider order, retries exact provider
health, completes success without generating bearer material, or records
confirmed loss atomically. Durable generation changes close sockets on all
replicas through gateway revalidation, while an optional local revoker closes
same-process sockets immediately.

Seven focused two-pool PostgreSQL tests prove duplicate-key single execution,
distinct-key serialization, generation-bound fresh replay tickets, secret-free
journal state, transient takeover, confirmed loss, ambiguous commit recovery,
ticket-delivery repair, and 404 after later loss. Together with the gateway race
coverage, the full Docker-backed PostgreSQL 17 suite passed 190 of 190 tests with
zero skips on x86_64 Linux. Production startup remains on the legacy lifecycle
until restore and child capture can move to the same authority together.

### Durable clean-restore lineage foundation

Restore is still the `provision` wire operation, but its durable identities differ
from ordinary provision: the operation's primary lease is the terminal source,
while its result is a new replacement lease. Migration 0008 records a separate
`result_lease_id` on operations and immutable `restore_source_lease_id` plus
`restore_source_snapshot_id` on replacement leases. Composite foreign keys prove
that the retained snapshot belongs to the recorded source lease and tenant; a
unique source index permits only one replacement. A dedicated
`lease_restore_source` snapshot reference keeps the recovery point retained.

The journal can now fence and bind a result lease while adopting selected
sandbox, provider-snapshot, and object allocations to that result without
rewriting the source `primary_lease_id`. Stale takeover returns both identities,
so later restore reconciliation can distinguish cleanup from a committed result.

The PostgreSQL state layer now exposes one exact restore authorization lock. It
requires a terminal (`lost` or `released`) source, its available unexpired latest
snapshot and workspace archive, matching tenant/agent/owner/owner-lease/template
lineage, and no prior replacement. Final restore commit repeats that authorization,
creates the new active lease/base snapshot with immutable lineage, adds the
retention reference, revokes old tickets, and changes `lost` to `released` in the
same transaction. Cross-tenant, stale-snapshot, active-source, or second-restore
attempts fail before state mutation.

Docker-backed PostgreSQL 17 tests prove atomic lineage commit/rollback, retained
source references, one-replacement enforcement, and preservation of separate
source/result identities through stale operation takeover. This is a prerequisite,
not the restore coordinator: clean-template creation, verified archive loading,
allocation cleanup, and ambiguous-commit reconciliation remain in the queue.

The next prerequisite binds the same source lease/snapshot pair into the
canonical workspace-preparation intent. Immutable ingress, durable restore, and
checkpoint are mutually exclusive, fully paired source modes; mixed or partial
identity fails before object publication. `commitDurableRestore` locks the exact
prepared intent and objects, invokes the atomic restored-lease state transition
on the caller's transaction, verifies the new snapshot, and only then marks the
preparation committed. A restore resolver independently checks that the logical
archive's registered bucket/key matches the configured object store and verifies
its content-addressed digest and size before exposing bytes. Focused PostgreSQL
coverage proves restore preparation/commit and the full suite remains green.

The unwired PostgreSQL restore coordinator now claims the durable-snapshot
request against its exact source lease, derives deterministic replacement
lease/environment/snapshot identities, and loads the authorized archive before
creating only the trusted clean provider template. It never invokes provider
runtime restore. Provider calls are surrounded by renewable operation fencing;
the provider snapshot has a deterministic operation-derived name, and cleanup
rechecks generation ownership under the same resource lock before deleting it
or the fresh sandbox. Final source authorization, lost-source retirement,
replacement creation, allocation adoption, and secret-free logical completion
share one source-lease/provider-resource transaction. Replay verifies the full
source lease/snapshot/agent/owner/template lineage and issues a current-generation
ticket only after commit. Duplicate template-to-role mappings are rejected so a
restore cannot switch policy through an ambiguous trusted role. Live PostgreSQL
coverage proves exact archive overlay without runtime identity inheritance,
mutation-free replay, pre-allocation authorization rejection, partial cleanup,
and ambiguous-commit recovery; all 199 tests pass. At that stage,
restore-specific stale preparation recovery and the provider-snapshot allocation
window still blocked production wiring.

Restore stale takeover is now explicit rather than falling through generic
provision cleanup. A reconciler must be configured with the preparation ledger
and object reclaimer before it will touch a source-bound provision operation.
It verifies the terminal source and deterministic replacement identity, rejects
mixed source modes or committed lineage without the exact durable result, moves
publishing/prepared work to reclamation, and drains associated plus stray object
allocations before any provider teardown. It then enumerates the exact
operation-derived provider-snapshot name (sandbox-scoped when possible), deletes
an unledgered orphan under the provider-resource lock, reclaims any ledgered
snapshot, and kills the fresh sandbox last. Every destructive call rechecks the
takeover generation. Live PostgreSQL coverage proves a prepared object graph is
fully reclaimed and that a snapshot created immediately before allocation
journaling is discovered and deleted before its sandbox; the suite is 201/201.
This closes restore-specific stale cleanup, while the still-broader allocation
boundary for an object-store put before its durable registration remains queued.

### Durable child-capture coordinator foundation

Migrations 0010 and 0011 add and constrain an immutable nullable operation
subtype to source-bound `provision` rows only. Child creation
retains the public `provision` idempotency namespace while persisting subtype
`child`; replay must match it exactly. Stale claims can select either child or
unsubtyped operations, and the general reconciler explicitly excludes child
rows. This prevents a source-bound child operation from being mistaken for a
restore and provides an unambiguous recovery selector even if the process dies
before its first allocation is journaled.

An unwired PostgreSQL child coordinator now claims the exact owner lease and
holds its session advisory lock across the complete capture. It authorizes the
active/paused owner agent, latest snapshot, provider sandbox, and connection
generation; takes a deterministically named owner snapshot; restores only a
temporary metadata-marked capture sandbox; exports workspace bytes; and destroys
both inherited resources before allocating the child. The exposed result always
comes from a clean trusted-role template with a fresh runtime identity. Capture
snapshot, capture sandbox, result sandbox, and result snapshot are journaled
immediately under provider-resource locks. Cleanup retries tolerate already
missing sandboxes, and an outage leaves the exact operation and allocations in
progress rather than falsely reporting terminal cleanup.

The workspace-preparation intent now has a mutually exclusive child source mode
that binds the owner lease and its exact latest snapshot. Final commit repeats
authorization against the exact owner provider sandbox and connection
generation, requires both temporary allocations to be durably reclaimed,
verifies the complete provider/object allocation set, atomically creates the
child lease and base snapshot, adopts only result resources, and completes with
a secret-free logical response. A ticket is issued only after commit. Two-pool
coverage proves duplicate replay, clean-template state without inherited session
identity, exact owner rejection before provider mutation, complete ordinary
failure cleanup, durable cleanup-pending state, operation-subtype isolation, and
owner-lock exclusion against another lifecycle mutation.

A dedicated child-only stale reconciler now claims only `provision`/`child`
operations and holds the owner session lock throughout recovery. A committed
child is completed only after reconstructing the exact deterministic lease,
snapshot, preparation, provider-allocation, object-allocation, request-hash, and
metadata graph. Any mismatch remains in progress without provider mutation.
An uncommitted operation must instead match the coordinator's exact allocation
prefix and preparation intent before cleanup begins. Recovery aborts partial
workspace publication, reclaims associated and stray objects, retries ledgered
provider cleanup, and discovers resources whose provider RPC succeeded before
its response was journaled. Sandboxes are scoped by service, tenant, child lease,
owner lease, and capture/result purpose; snapshots use operation-derived names.
Every discovered resource is rechecked under the global provider lock against
all durable leases, snapshots, and unfinished allocations before deletion, and
absence is observed before terminal failure. Provider and object-store work is
heartbeat-fenced and each pass is bounded.

Two-pool tests cover ledgered cleanup retry, lost capture-snapshot and
capture-sandbox responses, explicit unledgered inventory, exact committed
response reconstruction, and fail-closed corrupted-graph handling. The complete
Docker-backed PostgreSQL suite passes 266 tests with no skips. This closes the
durable child allocation/recovery invariant. Command execution still does not
participate in the lease gate, so a command-consistent capture instant and
production startup wiring remain separate work.

### Bounded PostgreSQL reconciliation foundation

An intentionally unwired `PostgresReconciler` now claims stale operations only
for its configured tenant and generation-fences every ledger mutation. Bounded
passes adopt durable sandboxes and provider snapshots, reclaim abandoned
sandboxes/capture sandboxes/snapshots, retry provider failures from
`reclaim_pending`, reconstruct logical provision and checkpoint success from
durable records, terminally fail operations whose allocations were all safely
reclaimed, and delete a bounded batch of retained expired/consumed/revoked
tickets. Concurrent `runOnce` calls coalesce and polling never overlaps.

Provider inventory is restricted by both `managedBy` and tenant metadata, gives
fresh unjournaled resources the same stale-age grace as operations, checks
durable ownership and unfinished allocations globally before and after taking a
resource lock, and only enumerates snapshots through a known sandbox. Provider
locks use transaction-scoped PostgreSQL advisory locks with a bounded lock wait
and pass one client through every database check/update, avoiding both leaked
session locks and one-connection-pool deadlock. The allocation guard ignores
terminal operations so released/deleted resources cannot be retained forever.

Docker-backed PostgreSQL 17 coverage proves tenant-isolated takeover,
`reclaim_pending` adoption, logical replay recovery, terminal-allocation
cleanup, same-resource serialization across replicas, independent-resource
parallelism, lock release on failure, and operation with a one-connection pool.
The worker must not be started in production until every lifecycle writer takes
the same provider-resource lock immediately after allocation, verifies the
resource, and holds the lock through ledger recording and durable association.
Archive/object/blob reconciliation,
pagination beyond the provider adapter's hard inventory caps, startup wiring,
and discovery of E2B snapshots after their source sandbox disappears remain
open; E2B exposes neither arbitrary snapshot metadata filtering nor a safe
unscoped snapshot listing API.

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

### Reconnect fencing, clean recovery, and child-capture cleanup

The Linux control-plane spike now distinguishes confirmed provider sandbox loss
from transient connect, start, and health-probe failures. The E2B adapter maps
only `SandboxNotFoundError` to the provider-neutral missing-sandbox signal. A
confirmed loss returns the lease-missing response Codex uses to select durable
restore and revokes outstanding tickets/connections; other provider failures are
redacted retryable 503 responses and leave the existing connection authority
intact.

Successful reconnect now revokes every prior ticket and active gateway socket
before restarting exec and issuing new access. Replaying the same successful
operation performs the revocation again before rotating the ticket, preventing a
previous reconnect response from leaving a live stale session.

Confirmed sandbox loss now moves the old lease out of the active directory
before Codex selects durable recovery. Durable snapshots are same-agent recovery,
not a cloning mechanism: the request must match the source lease's agent, owner,
trusted template, and latest snapshot, and the source lease must already be lost
or released. All checks occur before provider allocation; active, stale, and
cross-lineage sources fail closed.

Recovery no longer creates a sandbox from the provider snapshot. It creates the
trusted clean template, uploads the checksummed service workspace archive,
starts and probes a fresh exec server, and issues a new lease ticket. Provider
snapshot process, filesystem, session, and transport identity therefore cannot
be inherited. The source lease is retired when the replacement lease/snapshot
commit. Moving that transition and authorization into PostgreSQL locks remains
part of the production lifecycle cutover.

Child workspace capture now deletes its temporary owner snapshot as well as
killing the temporary restored sandbox. Nested cleanup guarantees snapshot
deletion is attempted even when capture-sandbox termination fails; restore and
export failures also clean the child allocation, capture, and snapshot. Provider
cleanup outages still require the planned PostgreSQL allocation ledger and
reconciler before the broader every-path child/provision cleanup invariant can be
claimed.

The provider-independent suite has 180 tests: 131 passed and 49 live-database
tests are skipped without `HOSTED_AGENT_TEST_DATABASE_URL`. New coverage proves
ticket/socket rotation on reconnect and replay, transient-versus-missing error
classification, missing-sandbox revocation, and child temporary-resource cleanup
on success plus restore/export failures. Recovery coverage additionally proves
clean-template creation without provider restore, removal of a fake inherited
runtime secret, exact workspace restoration, latest-snapshot/lineage checks,
idempotent replay, and cleanup after each post-allocation failure stage.

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

The TypeScript contract layer now validates patch export and apply independently
of route wiring. Export requests/responses are exact objects with opaque IDs,
lowercase SHA-256, and bounded changed-file and byte counts. Apply responses are
exact tagged variants: checkpoints are opaque, conflicts contain at most 256
unique strictly sorted canonical `file:///workspace/...` URIs, and rejection
reasons are trimmed, control-free UTF-8 bounded to 4 KiB. Prototype/accessor
objects, extra tenant/connection/ticket/access fields, malformed tags, unsafe
paths, duplicate or unsorted conflicts, and oversized multibyte reasons fail
closed. These validators do not implement the authenticated HTTP routes or
their durable lifecycle authorization.

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
