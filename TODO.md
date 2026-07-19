# Hosted Agent E2B Remaining Work

This is the implementation queue for turning the completed E2B spike into a
production backend. Stable decisions, evidence, and wire schemas are in
[`ARCHIVE.md`](ARCHIVE.md).

## 1. Production persistence

- [x] Add PostgreSQL migrations for leases, snapshots, artifacts, operations,
  and connection-ticket hashes.
- [x] Enforce unique operation/idempotency keys, lease IDs, and environment IDs.
- [x] Add atomic PostgreSQL operation claims, sanitized logical replay, worker/
  generation fencing, allocation ledgers, stale takeover, and sorted lease-lock
  primitives.
- [x] Atomically bind a committed lease to its owned operation and adopt only
  explicitly selected allocations under worker/generation fencing.
- [x] Add fail-closed provider health probing, tenant-scoped managed sandbox
  inventory, scoped snapshot inventory/deletion, and observable cleanup errors.
- [x] Add tenant-scoped PostgreSQL repositories for immutable source snapshots,
  leases, durable snapshots, object/snapshot references, and purpose-bound
  single-use ticket hashes.
- [x] For immutable-source provision, persist the canonical request hash,
  operation state, secret-free logical response, sandbox/provider-snapshot
  allocations, and every archive/manifest/content allocation.
- [x] Extend the journal/allocation protocol through durable checkpoint,
  including exact logical replay and cleanup of partial publication.
- [x] Extend the journal/allocation protocol through durable release, including
  durable access revocation, provider cleanup work, and reconciled completion.
- [x] Extend the journal/fencing protocol through durable reconnect, including
  target-bound claims, generation-bound access rotation, secret-free replay,
  confirmed-loss terminalization, and explicit stale takeover without invented
  resource allocations.
- [x] Extend the same journal/allocation protocol through restore, child capture,
  and patch.
- [x] Add the durable clean-restore lineage foundation: distinct operation source
  and result leases, schema-enforced source lease/snapshot pairing, terminal/
  latest/tenant/agent/owner/template authorization, atomic lost-source retirement,
  source-snapshot retention, and result-lease allocation adoption.
- [x] Bind restore lineage into the durable workspace-preparation intent, add an
  atomic restore commit path, and load only the authorized content-addressed
  archive after exact locator/digest/size verification.
- [x] Add an unwired PostgreSQL clean-restore coordinator with source-bound
  journal claims, deterministic replacement identities, continuous fencing,
  clean-template allocation, exact lineage replay, and cleanup-safe commit.
- [x] Add an unwired PostgreSQL child coordinator with an immutable operation
  subtype, owner session locking, exact owner/snapshot/sandbox reauthorization,
  immediately ledgered capture/result resources, clean-template isolation,
  durable workspace preparation, and result-only allocation adoption.
- [x] Reconcile stale child operations by exact committed-graph reconstruction or
  bounded reclamation of partial objects, ledgered resources, deterministic
  snapshots, and metadata-marked sandboxes under global ownership guards.
- [x] Reconcile stale restore preparations and deterministic provider snapshots
  before sandbox teardown, including unledgered post-snapshot crash recovery,
  bounded object reclamation, and fail-closed committed-result protection.
- [x] Apply transactional per-lease locking to durable checkpoint capture and
  commit across service replicas.
- [x] Apply transactional lease/provider locking to durable release across
  service replicas and stale-operation takeover.
- [x] Apply transactional per-lease locks and deterministic multi-lease lock
  order to every remaining lifecycle mutation.
- [x] Add composable same-transaction journal/state executors and sorted compound
  provider-resource locks so allocation recording, lease/snapshot commit,
  allocation adoption, and logical completion can commit or roll back together.
- [x] Add a fenced durable workspace-preparation ledger that binds canonical
  lease/source/sandbox/snapshot intent to exact object allocations and
  linearizes replica-safe commit, abort, and reclaim transitions.
- [x] Add bounded preparation-scoped object reclamation that preserves unrelated
  operation allocations, durable references, shared locators, and deletion audit
  state while recovering partial publication and retry failures.
- [x] Bind preparation and logical-object IDs deterministically to operation and
  content identity, and exact-verify every associated object's purpose,
  checksum, size, expiry, and locator on publication and terminal replay.
- [x] Replace local blobs with authenticated object storage for workspace
  archives, manifests, content blobs, and patch artifacts.
- [x] Make object stores report their exact durable bucket/key locator so
  PostgreSQL registrations cannot drift from physical writes.
- [ ] Add reference retention so snapshots/artifacts outlive lease release while
  Codex references them.
- [ ] Reconcile abandoned operations, sandboxes, snapshots, capture sandboxes,
  tickets, archives, and expired blobs after crashes and timeouts.
- [x] Add bounded, tenant-scoped PostgreSQL reclamation for registered object
  allocations with operation fencing, reference/shared-locator protection,
  retry-safe exact-key deletion, and cross-replica physical-location locking.
- [x] Add the bounded tenant-scoped PostgreSQL reconciliation foundation for
  fenced stale takeover, sandbox/capture/snapshot reclaim or adoption,
  provision/checkpoint logical recovery, guarded provider inventory, and
  retained ticket cleanup. Keep it unwired until lifecycle writers share its
  provider-resource lock protocol.
- [x] Select PostgreSQL lifecycle coordinators, ticket hashes, active-sandbox
  directory, trusted roles, and bounded reconcilers in production startup for
  immutable provision, restore, checkpoint, reconnect, release, and patch;
  retain the JSON control plane only in explicit development mode.
- [x] Reconcile stale durable release intent by preserving revoked access,
  retrying exact sandbox cleanup, and atomically terminalizing lease/allocation/
  operation state without deleting referenced snapshots or objects.
- [x] Prove immutable-source provision idempotency across two service replicas,
  including one provider mutation, exact logical replay, and terminal replay
  after partial-publication cleanup.
- [ ] Prove restart recovery and the remaining lifecycle mutations with multiple
  service replicas.

Exit criterion: concurrent replay causes one logical/provider mutation and no
connection material or allocation is leaked.

## 2. Production workspace ingress

- [x] Define an authenticated immutable source-snapshot lifecycle and opaque ID.
- [x] Validate tenant ownership, trusted checksum, expiry, canonical roots/cwd,
  archive layout/types/links, and all archive quotas before durable publication.
- [x] Extend trusted deployment metadata or the provision contract so a remote
  control plane resolves that ID without client-host `file:` access:
  - [x] accept a strictly validated trusted source ID/checksum in hosted-agent
    configuration and emit the exact path-free `sourceSnapshot` provision wire;
  - [x] add a bounded authenticated binary creation/upload route that keeps
    tenant identity out of request data and archive bytes out of JSON;
  - [x] wire production startup to the PostgreSQL lifecycle/resolver and its
    reference-safe partial-publication reclaimer.
- [x] Define the exact `sourceSnapshot` provision wire shape and authenticated
  create/resolve API adapter without accepting tenant identity or host paths from
  JSON; keep provision fail-closed until the durable backend owns the route.
- [x] Authorize tenant/checksum/expiry through a trusted resolver before sandbox
  allocation; fail closed when the resolver is unavailable or inconsistent.
- [x] Add a same-transaction final authorization lock for the exact source
  tenant, ID, checksum, available state, and expiry; provision remains unwired.
- [x] Preserve roots, cwd, dirty/untracked and binary files, modes, and symlinks
  under `/workspace/roots/<index>/...` through staged Linux materialization.
- [x] Reject traversal, escaping links, devices, sockets, FIFOs, special files,
  duplicate/conflicting paths, and unsafe archive entries before provider upload.
- [x] Bound roots, archive/expanded bytes, files, per-file bytes, path depth, and
  extraction ratio; measure transfer/extraction/cleanup without sensitive paths.
- [x] Keep the co-located read-only bridge development-only; validate canonical
  real paths and reject overlap, unsafe links, special files, and quota excess.

Exit criterion: the remote service reproduces exact source state and reclaims all
failed upload/extraction allocations without Git or shared host paths.

## 3. Control plane and WSS gateway hardening

- [x] Require HTTPS/WSS outside explicit development mode.
- [ ] Bind raw exec-server to loopback/private networking and remove production
  reliance on direct 22101 and `secure:false`.
- [x] Require the secured E2B traffic token on every gateway-to-exec WebSocket,
  keep it out of URLs and durable state, and fail closed when it is absent,
  malformed, or rejected.
- [ ] Authorize every request by tenant, lease, agent, owner, snapshot, artifact,
  and trusted template.
- [x] Add ticket purpose, single-use consumption, bounded TTL, rotation, and
  expired/revoked lookup cleanup without persisting bearer material.
- [x] Add a tenant-bound PostgreSQL ticket authority so replicas share hashed
  issue, rotation, single-use consumption, and revocation state.
- [x] Decouple gateway lease authorization from the JSON store and provide a
  PostgreSQL active-sandbox directory for replica-consistent revalidation.
- [x] Add a durable per-lease connection generation to PostgreSQL and JSON
  leases/tickets; reject pre-rotation tickets after validation races and close
  established connections across replicas when the generation changes even if
  the provider sandbox ID does not.
- [x] Close every active connection on release.
- [x] On reconnect, rotate every lease ticket, close active gateway connections
  on both first execution and idempotent replay, revoke access on confirmed
  sandbox loss, and preserve viable access across transient provider outages.
- [x] Restore only into a clean trusted template, overlay verified workspace
  state, and reject inherited snapshot sessions/secrets before issuing rekeyed
  transport credentials.
- [ ] Keep provider credentials out of URLs, metadata, commands, persistence,
  errors, logs, traces, and metrics.
- [x] Health-probe exec before provision/reconnect success.
- [x] Redact unexpected HTTP errors and hard-bound HTTP bodies plus gateway
  payloads, connections, pending queues, and backpressure.
- [ ] Add structured redacted logs, audit events, metrics, rate limits, retry
  budgets, circuit breakers, and remaining request/response bounds.
- [ ] Configure provider public traffic and egress per trusted role.
- [ ] Test TLS, expiry, revocation races, reconnect, and upstream failures using
  an unmodified Codex exec client.

Exit criterion: the raw endpoint is externally unreachable, invalid/cross-lease
tickets always fail, and secrets never enter durable or observable state.

## 4. Complete production lifecycle behavior

- [x] Parse provider workspace archives without extraction into canonical
  manifests/content blobs, rejecting unsafe tar types, paths, links, conflicts,
  corruption, and quota excess.
- [x] Strictly validate exact provision, reconnect, checkpoint, and release
  request shapes plus bounded provision/reconnect/checkpoint responses at HTTP.
- [x] Extend strict validation and authorization to patch requests, trusted
  template/role mappings, and persisted tenant/owner relationships.
- [x] Strictly validate the exact patch export/apply request and tagged response
  wire shapes, including bounded checksums, counts, sizes, canonical conflicts,
  rejection reasons, and rejection of extra credential-bearing fields.
- [x] Add an unwired PostgreSQL immutable-source provision coordinator that
  immediately ledgers provider resources, durably prepares every workspace
  object, atomically commits/adopts the lease graph and logical response, and
  reclaims partial publication before terminal failure.
- [x] Add an unwired PostgreSQL checkpoint coordinator that holds the lease lock
  across provider capture, durably prepares every workspace object, compare-and-
  swaps the expected latest snapshot, and atomically adopts allocations and the
  secret-free logical response.
- [x] Add an unwired PostgreSQL release coordinator that atomically binds its
  target, persists `release_pending` plus ticket revocation and exact sandbox
  cleanup work, and only marks released after kill or confirmed provider loss.
- [x] Add an unwired PostgreSQL reconnect coordinator that serializes and probes
  the exact existing sandbox, atomically rotates durable access only after
  health, replays with a fresh generation-bound ticket, preserves access on
  transient connect failure, and marks confirmed loss atomically.
- [ ] Extend cleanup-safe provision through child/restore sources and wire it to
  production startup with reconciler recovery for process loss at every external
  allocation boundary.
- [x] Serialize durable checkpoint capture and commit per lease across replicas.
- [x] Serialize durable release against checkpoint and other release operations
  per lease while using the same deterministic provider-resource lock order.
- [x] Serialize durable reconnect against checkpoint, release, and other
  reconnect operations per lease using the common lease/provider lock order.
- [ ] Serialize child capture, patch, and command interaction per lease; command
  execution must share the checkpoint gate before capture can claim a command-
  consistent instant.
  - [x] Add a generation-fenced PostgreSQL interaction ledger whose admission
    shares the lifecycle lease lock, and make checkpoint, child capture, patch
    apply, and interrupted patch rollback refuse every unfinished interaction.
  - [ ] Track exec-server process and filesystem mutations at the production
    gateway, including detach/resume and authoritative completion, before
    enabling production child dispatch.
- [x] Persist checksummed base/current workspace manifests with the unwired
  durable provision and checkpoint snapshots and service archives.
- [ ] Carry the same manifest persistence through the remaining production
  lifecycle wiring and patch operations.
- [x] Add an unwired tenant-safe workspace snapshot publisher that validates
  provider archives, stores exact archive/manifest/content objects, and retains
  every content blob through the atomic base/checkpoint snapshot transaction.
- [x] Add a provision-fenced durable preparation path that plans before writes,
  atomically registers each successful put with its allocation/association,
  skips exact replay puts, and resumes bounded preparation-scoped cleanup.
- [x] Attach an exact durable preparation to its base lease inside the caller's
  transaction, repeating source authorization there and marking the preparation
  committed before allocation adoption.
- [x] In the provider lifecycle, authorize the same agent/owner/template and
  latest terminal snapshot, overlay its verified workspace into a clean trusted
  template, restart exec, and rekey transport credentials.
- [x] Move clean restore authorization, old-lease terminalization, and new-lease
  creation into the PostgreSQL lifecycle transaction and cross-replica locks.
- [x] Reclaim child-capture sandboxes and provider snapshots after successful
  workspace-only capture and ordinary restore/export failure paths.
- [x] Make child creation atomically snapshot the owner, create only a clean
  trusted-role sandbox, and durably ledger/reconcile temporary captures so
  provider cleanup outages cannot leak snapshots or sandboxes.
- [ ] Reconcile pause with `autoResume:false`; choose active/paused timeouts from
  measured cost and latency.
- [x] Make unwired durable release replay succeed after confirmed provider loss,
  retain referenced durable data, and reconcile transient/ambiguous kill failure.

Exit criterion: restart and sandbox-loss recovery work under concurrency, child
identity remains isolated, and lifecycle replay never duplicates resources.

## 5. Patch export

- [x] Add bounded canonical manifest, diff, checksum, and file-type validation
  primitives shared by export and apply.
- [x] Add an immutable tenant/lineage-authorized PostgreSQL artifact repository
  with snapshot/object/content references, expiry, replay, and retention after
  source lease release.
- [x] Add strict canonical manifest-byte parsing, verified tenant/snapshot
  material resolution, and caller-transaction artifact/snapshot repository APIs
  needed by durable patch export.
- [x] Add an unwired PostgreSQL patch-export coordinator with source-bound
  claims, deterministic artifact/object identities, fenced publication,
  same-transaction artifact/adoption/completion, exact replay, and caught-failure
  object reclamation.
- [x] Implement `POST v1/agents/patch/export` using the archived contract and
  wire the durable coordinator into production startup.
- [x] Build canonical sorted manifests with path, type, mode, link target or
  content digest, and immutable base/current identities.
- [x] Persist content-addressed blobs and the canonical artifact before returning.
- [x] Use tenant-scoped logical content-object IDs throughout snapshot retention,
  canonical artifact serialization, and PostgreSQL artifact validation while
  safely sharing identical physical content across tenants.
- [x] Compare the exact requested base snapshot with the latest checkpoint.
- [x] Cover additions, modifications, deletions, binaries, executable modes,
  directories, and safe symlinks without requiring Git.
- [x] Return verified checksum, changed-file count, and size.
- [x] Enforce authorization, expiry, path, file, byte, and manifest quotas.
- [x] Reconcile stale patch-export operations after process loss, including
  exact adopted-artifact logical completion and fenced object reclamation.

Exit criterion: a durable checksummed artifact remains usable after child release.

## 6. Atomic three-way patch application

- [x] Add pure three-way conflict collection with canonical URI sorting, the
  256-path cap, and UTF-8-safe 4 KiB rejection bounds.
- [x] Add a mutation-free patch-application planner that verifies complete
  manifest/content material and produces the full prospective workspace.
- [x] Resolve patch application from a transaction-locked PostgreSQL target,
  enforcing the exact owner-lease lineage and checksum-verifying every referenced
  artifact, manifest, and content object from durable storage.
- [x] Assemble ready plans into deterministic bounded Linux workspace tar files,
  verify every body, and reparse the result to prove the full manifest round-trip.
- [x] Add an immutable generation-fenced PostgreSQL apply-attempt ledger with
  allocation-bound rollback identity and explicit swap/checkpoint/rollback phases.
- [x] Coordinate the clean apply path through rollback capture, validated atomic
  provider upload, observed-result verification, durable checkpoint, and replay.
- [x] Implement `POST v1/agents/patch/apply` and `applied`, `conflict`, and
  `rejected` responses.
- [x] Validate artifact checksum, authorization, expiry, paths, quotas, base, and
  target before mutation.
- [x] Compare artifact base/current and target current for every changed path;
  collect all conflicts before mutation.
- [x] Bound conflicts to 256 canonical URIs and rejection reasons to 4 KiB.
- [x] Guarantee conflict/rejection leaves the target byte-for-byte unchanged.
- [x] Create a rollback snapshot, stage and validate the complete result away
  from the live workspace, then atomically swap it into place.
- [x] Persist the post-apply durable checkpoint before responding.
- [x] Reconcile crashes between rollback, staging, swap, checkpoint, and response.

Exit criterion: clean changes apply atomically; conflicts do not mutate; binary,
mode, symlink, addition, and deletion behavior matches the Codex fake.

## 7. Security, operations, and rollout

- [ ] Add tenant quotas, authorization tests, abuse controls, and audit events.
- [ ] Bound all requests, responses, manifests, artifacts, conflicts, log fields,
  and errors.
- [x] Treat provider/gateway denial as final; never fall back to local execution,
  with a black-box HTTP/WSS test proving stable denial, no alternate provider
  mutation, and no provider error/credential persistence.
- [ ] Add dashboards/alerts for allocations, leases, reconnect/restore, ticket
  denial, cleanup lag, leaks, storage growth, and gateway health.
- [ ] Exercise provider/API/gateway/database/object-store outages, process crash,
  and network partitions.
- [x] Resolve the pinned dependency tree's high-severity advisory before broader
  deployment.
- [ ] Define backup, restore, retention, deletion, and tenant-erasure procedures.
- [ ] Roll out by trusted role with a kill switch and rollback procedure.

## 8. Required acceptance matrix

Port relevant behavior from
`codex/codex-rs/hosted-agent/src/hosted_agent_tests.rs` to black-box HTTP tests,
then run the complete app-server flow against live E2B.

- [x] Run focused Docker remote-executor coverage. After restoring build capacity, the
  standard Ubuntu harness reached a healthy remote exec-server and all 19
  `codex-core` `remote_env` tests passed after aligning three explicit shell
  fixtures with the executor's advertised Bash shell. The standard harness
  still cannot synthesize the service-owned WSS lease; that remains part of the
  final live app-server acceptance flow. The broad core run's host-local helper,
  network/proxy, and nested-sandbox failures remain harness debt rather than a
  green remote run.
- [x] Defer Windows/Wine and macOS compatibility. Current implementation and
  acceptance scope is x86_64 Linux; reopen cross-platform validation before any
  broader rollout.

| Scenario | Required assertion |
| --- | --- |
| identical replay | same logical result and one provider mutation |
| changed-key replay | rejected before mutation |
| concurrent duplicates | one operation and provider mutation |
| every partial failure | all provider/service allocations reclaimed |
| distinct provisions | unique lease/environment identities |
| root materialization | exact dirty, binary, mode, symlink, cwd, multi-root state |
| gateway | unmodified client initializes and executes through authenticated WSS |
| ticket lifecycle | rotation, expiry, revocation, wrong lease, replay policy, redaction |
| checkpoint | durable snapshot/archive and command after reconnect |
| service/database restart | reconnect from durable provider IDs |
| missing sandbox | reconnect 404 then fresh restore and credentials |
| child | spawn state, divergence, no inherited process/session/secret/identity |
| patch export | durable artifact with checksum and complete file-type coverage |
| clean apply | atomic complete result and durable checkpoint |
| conflict apply | bounded paths and byte-identical target |
| release replay | repeated success, no live resources, referenced data retained |
| denied tool | hidden or rejected without local fallback |
| observability | no ticket, URL, credential, content, or secret leakage |
| outage/crash | terminal reconciliation and zero leaked resources |

The local black-box harness now traverses the real HTTP validator, development
control plane, filesystem object store, ticket issuer, gateway, provider adapter,
and authenticated WebSocket proxy. It covers identical and changed-key replay,
concurrent duplicates, distinct identities, checkpoint plus service/store
restart, reconnect and command echo, ticket rotation, missing-sandbox 404 plus
clean durable restore, repeated release with retained snapshot data, and final
provider/gateway denial with secret-taint checks. These are boundary regressions,
not substitutes for the still-required PostgreSQL production routing and live
unmodified-Codex/E2B run.

Final acceptance requires an unmodified hosted Codex client to provision through
the HTTPS service and execute before and after checkpoint recovery. Keep the
feature outside the canary cohort disabled until the matrix passes and cleanup
has been observed under injected failure.
