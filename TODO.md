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
- [ ] Persist canonical request hashes, operation state, logical responses, and
  all partial provider allocations.
- [ ] Apply transactional per-lease locks and deterministic multi-lease lock
  order to every lifecycle mutation.
- [x] Replace local blobs with authenticated object storage for workspace
  archives, manifests, content blobs, and patch artifacts.
- [ ] Add reference retention so snapshots/artifacts outlive lease release while
  Codex references them.
- [ ] Reconcile abandoned operations, sandboxes, snapshots, capture sandboxes,
  tickets, archives, and expired blobs after crashes and timeouts.
- [ ] Prove idempotency and restart recovery with multiple service replicas.

Exit criterion: concurrent replay causes one logical/provider mutation and no
connection material or allocation is leaked.

## 2. Production workspace ingress

- [ ] Define an authenticated immutable source-snapshot lifecycle and opaque ID.
- [ ] Extend trusted deployment metadata or the provision contract so a remote
  control plane resolves that ID without client-host `file:` access.
- [ ] Authorize tenant/checksum/expiry before sandbox allocation.
- [ ] Preserve roots, cwd, dirty/untracked and binary files, modes, and symlinks
  under `/workspace/roots/<index>/...`.
- [ ] Reject traversal, escaping links, devices, sockets, FIFOs, special files,
  duplicate/conflicting paths, and unsafe archive entries.
- [ ] Bound roots, archive/expanded bytes, files, per-file bytes, path depth, and
  extraction ratio; measure transfer/extraction/cleanup without sensitive paths.
- [x] Keep the co-located read-only bridge development-only; validate canonical
  real paths and reject overlap, unsafe links, special files, and quota excess.

Exit criterion: the remote service reproduces exact source state and reclaims all
failed upload/extraction allocations without Git or shared host paths.

## 3. Control plane and WSS gateway hardening

- [x] Require HTTPS/WSS outside explicit development mode.
- [ ] Bind raw exec-server to loopback/private networking and remove production
  reliance on direct 22101 and `secure:false`.
- [ ] Authorize every request by tenant, lease, agent, owner, snapshot, artifact,
  and trusted template.
- [x] Add ticket purpose, single-use consumption, bounded TTL, rotation, and
  expired/revoked lookup cleanup without persisting bearer material.
- [ ] Add multi-replica ticket lookup and active-connection revocation
  propagation.
- [x] Close every active connection on release.
- [ ] Close stale connections on restore and reject inherited snapshot
  sessions/secrets.
- [ ] Keep provider credentials out of URLs, metadata, commands, persistence,
  errors, logs, traces, and metrics.
- [ ] Health-probe exec before provision/reconnect success.
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

- [x] Strictly validate exact provision, reconnect, checkpoint, and release
  request shapes plus bounded provision/reconnect/checkpoint responses at HTTP.
- [ ] Extend strict validation and authorization to patch requests, trusted
  template/role mappings, and persisted tenant/owner relationships.
- [ ] Make provision cleanup-safe after every allocation step, including response
  persistence failure.
- [ ] Serialize checkpoint, reconnect, child capture, patch, release, and command
  interaction per lease.
- [ ] Persist checksummed base/current workspace manifests with snapshots and
  service archives.
- [ ] On restore, verify and overlay workspace state, remove inherited runtime
  identity, restart exec, and rekey transport credentials.
- [ ] On child creation, atomically snapshot the owner, use a temporary capture,
  export workspace only, create a clean role sandbox, and reclaim all temporary
  snapshots/sandboxes on every path.
- [ ] Reconcile pause with `autoResume:false`; choose active/paused timeouts from
  measured cost and latency.
- [ ] Make release replay succeed after provider loss while retaining referenced
  durable data.

Exit criterion: restart and sandbox-loss recovery work under concurrency, child
identity remains isolated, and lifecycle replay never duplicates resources.

## 5. Patch export

- [x] Add bounded canonical manifest, diff, checksum, and file-type validation
  primitives shared by export and apply.
- [ ] Implement `POST v1/agents/patch/export` using the archived contract.
- [ ] Build canonical sorted manifests with path, type, mode, link target or
  content digest, and immutable base/current identities.
- [ ] Persist content-addressed blobs and the canonical artifact before returning.
- [ ] Compare the exact requested base snapshot with the latest checkpoint.
- [ ] Cover additions, modifications, deletions, binaries, executable modes,
  directories, and safe symlinks without requiring Git.
- [ ] Return verified checksum, changed-file count, and size.
- [ ] Enforce authorization, expiry, path, file, byte, and manifest quotas.

Exit criterion: a durable checksummed artifact remains usable after child release.

## 6. Atomic three-way patch application

- [x] Add pure three-way conflict collection with canonical URI sorting, the
  256-path cap, and UTF-8-safe 4 KiB rejection bounds.
- [ ] Implement `POST v1/agents/patch/apply` and `applied`, `conflict`, and
  `rejected` responses.
- [ ] Validate artifact checksum, authorization, expiry, paths, quotas, base, and
  target before mutation.
- [ ] Compare artifact base/current and target current for every changed path;
  collect all conflicts before mutation.
- [ ] Bound conflicts to 256 canonical URIs and rejection reasons to 4 KiB.
- [ ] Guarantee conflict/rejection leaves the target byte-for-byte unchanged.
- [ ] Create a rollback snapshot, stage and validate the complete result away
  from the live workspace, then atomically swap it into place.
- [ ] Persist the post-apply durable checkpoint before responding.
- [ ] Reconcile crashes between rollback, staging, swap, checkpoint, and response.

Exit criterion: clean changes apply atomically; conflicts do not mutate; binary,
mode, symlink, addition, and deletion behavior matches the Codex fake.

## 7. Security, operations, and rollout

- [ ] Add tenant quotas, authorization tests, abuse controls, and audit events.
- [ ] Bound all requests, responses, manifests, artifacts, conflicts, log fields,
  and errors.
- [ ] Treat provider/gateway denial as final; never fall back to local execution.
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

- [ ] Run Docker remote-executor coverage when the daemon is available, or add a
  remote harness fixture capable of supplying the service-owned WSS lease.
- [ ] Confirm Windows/Wine path and type compatibility through the Bazel CI matrix;
  external-service behavior may be skipped only with a specific harness reason.

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

Final acceptance requires an unmodified hosted Codex client to provision through
the HTTPS service and execute before and after checkpoint recovery. Keep the
feature outside the canary cohort disabled until the matrix passes and cleanup
has been observed under injected failure.
