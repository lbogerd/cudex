# E2B spike architecture decisions

These decisions record the spike performed against CubeSandbox through E2B SDK
2.35.0 on 2026-07-18. The local contract suite is provider-independent; the live
canaries used template `tpl-e7bc8fcedb3c4dd8973c5e43`.

## ADR-1: Production workspace ingress

**Chosen design.** The product creates an authenticated, immutable source snapshot
in object storage and sends its opaque ID to the control plane. The co-located
bridge in this spike is retained only for local development. It archives every
allowlisted root, including dirty/untracked files, modes and symlinks, and maps
cwd and multiple roots into `/workspace/roots/<index>/...`. The default proposed
limits are 8 roots and 512 MiB compressed-transfer input; production must also
enforce file-count, expanded-byte and extraction-ratio limits.

**Evidence.** `archiveWorkspace` and the black-box provision test copy a dirty
workspace and reject roots outside the allowlist. The live template requires the
runtime workspace to be owned by uid 1000; the template Dockerfile now establishes
that invariant.

**Rejected alternatives.** Arbitrary service-host `file:` dereferencing, cloning
Git HEAD, and silently using an empty workspace do not reproduce user state. A
per-request upload extension couples Codex to transport details and is deferred in
favor of an opaque snapshot ID.

**Boundary, failure, and cost.** The bridge is read-only and path allowlisted;
special files and escaping links must be rejected before production. Quota or
upload failure kills the partial sandbox. Archive creation adds one full workspace
read, object storage adds one write/read, and materialization adds one extraction.

## ADR-2: Exec authentication

**Chosen design.** A service-owned WSS gateway accepts a short-lived opaque ticket
in the URL, validates its hash, scopes it to one lease, then resolves and proxies
the current raw exec endpoint. Reconnect rotates the ticket; release revokes all
tickets and closes active sockets. Tickets default to 60 seconds.

**Evidence.** Tests prove rotation, revocation, hashed persistence, and absence of
URLs/tickets from durable JSON. The existing live canary proves the unmodified
Codex exec protocol through the provider WSS endpoint. The gateway implementation
forwards unchanged WebSocket frames and never persists the raw endpoint.

**Rejected alternatives.** Custom headers are incompatible with the Codex client.
The direct `22101` route and `secure:false` remain private-network canary settings.
Snapshot-resident gateway secrets enlarge the sandbox trust boundary.

**Boundary, failure, and cost.** The gateway owns ticket validation and provider
connectivity; E2B credentials stay in the control plane. Expired, unknown, or
revoked tickets fail before upgrade. This adds a highly available data-plane hop,
one ticket lookup per connection, TLS termination, and connection metrics.

## ADR-3: Same-agent recovery

**Chosen design.** Keep a durable provider snapshot for the same agent, plus a
checksummed service workspace archive as a defense-in-depth recovery copy. Restore
the provider snapshot into a new sandbox, overlay the recorded workspace archive,
remove inherited gateway/process identity, start a fresh exec server, and issue a
new ticket.

**Evidence.** The live lifecycle canary created snapshot
`snap-e9cc54c9dfc949dbb25ad385`, reconnected and ran a second command, killed the
owner, restored `spawn-state`, removed the old secret/process identity, and ran
again. The provider snapshot did contain `/workspace`; the archive supplies a
provider-independent integrity copy. The local restart test reconstructs the
lease solely from persisted IDs.

**Rejected alternatives.** Pause alone is not durable after kill. A workspace-only
restore loses same-agent runtime state. Reusing old gateway credentials permits
snapshot replay.

**Boundary, failure, and cost.** Snapshot IDs and archives are durable service
metadata; connection material is not. Missing active sandboxes cause reconnect
404 so Codex chooses explicit restore. Recovery costs snapshot storage plus one
workspace archive; credentials and runtime identity are always rekeyed.

## ADR-4: Child creation

**Chosen design.** Snapshot the owner atomically, restore that snapshot into a
temporary capture sandbox, export only `/workspace/roots`, and materialize the
archive into a clean child role template. Kill the capture sandbox before making
the child reachable.

**Evidence.** The local isolation test proves equal spawn-time bytes followed by
independent divergence. The live canary proved `spawn-state` in the child,
owner=`spawn-state`, child=`child`, and no `/tmp/gateway-secret` in the child.

**Rejected alternatives.** `Sandbox.fork` and booting the child from the owner's
snapshot retain processes, sessions, secrets, and runtime identity. Exporting the
live owner without first snapshotting is not atomic.

**Boundary, failure, and cost.** Only the validated workspace archive crosses the
owner/child boundary. Any capture/materialization failure kills both temporary and
partial child sandboxes. The design adds a temporary sandbox and two archive
transfers per child spawn.

## ADR-5: Persistence

**Chosen design.** PostgreSQL is the production operation journal and lease index;
authenticated object storage holds workspace archives, future patch artifacts,
and content blobs. The spike uses an atomically replaced mode-0600 JSON file and a
content-addressed local blob directory behind equivalent internal interfaces.

**Evidence.** A service restart reconnects using persisted provider IDs. Canonical
request hashes reject changed-key replay without mutation, successful replay is
stable apart from intentionally rotated transient connection material, and startup
reconciliation kills journaled partial allocations. Durable files contain neither
connection URLs nor tickets.

**Rejected alternatives.** In-memory state cannot survive restart. E2B-only storage
loses artifacts on release. Persisting complete connection responses leaks bearer
material, so the journal stores only the logical response and regenerates the URL.

**Boundary, failure, and cost.** Database uniqueness on `(operation,
idempotency_key)` and per-lease locks are required in production. Crashes leave an
`in_progress` allocation for reconciliation. Costs are a transaction per state
transition and object-store retention/reference collection.

## ADR-6: Lease timeout

**Chosen design.** Create sandboxes with timeout action `pause` and
`autoResume:false`; only the control plane reconnects and transitions the logical
lease. Release always uses provider `kill`.

**Evidence.** SDK 2.35.0 exposes and the deployment accepts explicit lifecycle
options. The reconnect test keeps logical lease/environment identity stable and
the live lifecycle canary reconnects after checkpoint interruption.

**Rejected alternatives.** Auto-resume hides provider state transitions and can
bypass authorization/reconciliation. Timeout kill makes ordinary idle recovery
depend on a full durable restore. Memory-preserving pause is not a durable
checkpoint.

**Boundary, failure, and cost.** A paused provider resource is never treated as an
authorization grant; a new ticket is mandatory. Missing/killed resources return
404. Paused sandboxes retain provider storage (and optionally memory), trading
lower reconnect latency for idle resource cost; metrics must drive the production
timeout value.
