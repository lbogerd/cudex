# Local Hosted-Codex Owner/Child POC Queue

This queue tracks the Linux-only development proof. Stable production decisions
and redacted evidence remain in [`ARCHIVE.md`](ARCHIVE.md). The proof is not
complete until a real ChatGPT-authenticated automated run passes.

## Dedicated CubeSandbox code-mode runtime

This follow-on is Linux-only. A hosted thread is not complete until its lease,
environment connection generation, CubeSandbox, exec-server process handle, and
code-mode protocol connection form one immutable binding. Local Codex retains
its existing process-owned/in-process behavior; hosted Codex must fail closed.

### Packaging and sandbox host

- [x] Build, checksum, publish, install, and label both `codex` and
  `codex-code-mode-host` without retaining the legacy top-level checksum.
- [x] Add a non-protocol `--help` check and a hosted singleton launcher mode.
- [x] Complete singleton path hardening and collision/crash tests.
- [x] Configure and record the POC template's provider CPU and memory limits.

### Transport, provider, and identity

- [x] Carry protocol stdin/stdout over the selected environment's existing
  `ExecProcess`; stderr is diagnostic-only and no new public port is used.
- [x] Add the immutable non-secret runtime identity and deterministic process ID.
- [x] Add eager remote process startup and protocol handshake before hosted
  thread creation, with a distinct child provider.
- [x] Make provider placement structurally explicit so production hosted paths
  cannot select the shared local provider. Unit-only provisioning uses an
  explicit constructor that disables runtime startup rather than `cfg!(test)`.
- [ ] Add verified same-generation recovery. Unprovable same-environment
  reconnects already fail closed and release instead of starting a duplicate;
  replacement environments use the service's authoritative generation.
- [x] Add explicit graceful provider shutdown, active-cell termination, and
  confirmed exec-server process-group quiescence before lease cleanup continues.

### Authorization and dispatch

- [x] Add `environmentBoundCodeMode` to Rust and E2B policy schemas and grant
  only outer `exec`/`wait`; nested tools retain their independent role grants.
- [x] Expose hosted code mode only with an exact verified environment binding.
- [x] Carry the full provider identity into turns and validate thread, lease,
  environment, and generation at every nested dispatch.
- [x] Assert environment-routed nested commands target the provider's exact
  environment.

### Evidence and acceptance

- [ ] Complete non-secret reconnect telemetry after verified same-generation
  recovery exists. Start, ready, failure, shutdown, and quiescence events now
  carry bounded non-secret identity, protocol, duration, and outcome fields.
- [ ] Add transport, provider, provisioning, authorization, reconnect, and
  shutdown tests without bypassing remote startup.
- [x] Add trusted runtime-placement evidence and the six code-mode booleans to
  retained POC reports.
- [ ] Run the real root/child CubeSandbox scenarios, including CPU placement,
  stored-value isolation, nested command routing, independent failure/shutdown,
  and exact final cleanup.
- [ ] Switch the POC default from `gpt-5.5` only after the full code-mode-only
  acceptance run passes.

## 1. Local POC infrastructure

- [x] Add the ignored POC runtime layout and strict data-only `.env` parser.
- [x] Add disposable PostgreSQL 17 and Garage 2.3.0 single-node Compose services.
- [x] Generate per-run database, Garage, object-store, and service credentials.
- [x] Generate a localhost CA/server certificate and combined system/local CA bundle.
- [x] Add Linux/Node/Docker/port preflight and `up`, `status`, and `down` foundations.
- [x] Prove PostgreSQL/Garage health, S3 `HeadBucket`, and repeatable migrations locally.

## 2. Source/auth/config preparation

- [x] Validate access-token and auth-JSON modes without credential propagation.
- [x] Add device-login auth creation with a secrets-only temporary Codex home.
- [x] Add immutable fixture archiving and bounded source-snapshot upload.
- [x] Validate template/binary provenance and exact local artifact checksum.
- [x] Generate strict isolated Codex configuration and exact trusted role policy.

## 3. Automated and interactive drivers

- [x] Add the bounded app-server JSON-RPC transport and evidence collector.
- [x] Add the automated root/child/apply/verify prompt and 20-minute driver.
- [x] Add diagnostic interactive TUI mode using the same artifact and configuration.
- [x] Add a secret-safe report schema, signal handling, and deadline behavior.

## 4. Acceptance and cleanup

- [x] Inspect exact run-owned PostgreSQL lifecycle state and E2B metadata.
- [x] Verify the active root workspace through its exact provider sandbox ID.
- [x] Assert child isolation, patch application, release, thread-tree deletion, and marker.
- [x] Add graceful cleanup, scoped forced cleanup, idempotency, and exit-code behavior.
- [x] Scan retained logs/reports for credential and ticket taint.

## 5. Documentation and verified evidence

- [x] Document every public command, prerequisite, cost, warning, and recovery path.
- [x] Run the full relevant E2B suite and confirm `codex/codex-rs` is unchanged.
- [x] Run a real ChatGPT-authenticated automated proof and record redacted evidence.
- [x] Confirm automated mode completed without needing interactive diagnosis.
- [x] Commit and push each sizeable implementation chunk.

## Deferred production hardening — not required for local POC

These items are copied from the previous unchecked production backlog. They are
not relaxed by this proof and remain blockers for production deployment.

- [ ] Reconcile abandoned operations, sandboxes, snapshots, capture sandboxes,
  tickets, archives, expired references, and unreferenced blobs, including
  bounded authenticated object-store inventory for pre-registration publication
  loss and paginated provider inventory.
- [ ] Bind the raw exec-server to loopback/private networking and remove reliance
  on the secured public E2B port 22101 route and `secure:false` upstream handling.
- [ ] Authorize every request by tenant, lease, agent, owner, snapshot, artifact,
  and trusted template.
- [ ] Keep provider credentials out of URLs, metadata, commands, persistence,
  errors, logs, traces, and metrics across the complete production deployment.
- [ ] Add structured redacted logs, audit events, metrics, rate limits, retry
  budgets, circuit breakers, and remaining request/response bounds.
- [ ] Configure provider public traffic and egress per trusted role.
- [ ] Test TLS, expiry, revocation races, reconnect, and upstream failures with an
  unmodified Codex exec client.
- [ ] Reconcile pause with `autoResume:false` and choose active/paused timeouts
  from measured cost and latency.
- [ ] Add production-wide tenant quotas, authorization tests, and abuse controls.
- [ ] Bound all remaining manifests, artifacts, conflicts, log fields, and errors.
- [ ] Add dashboards and alerts for allocations, leases, reconnect/restore,
  ticket denial, cleanup lag, leaks, storage growth, and gateway health.
- [ ] Exercise provider, API, gateway, database, object-store, process-crash, and
  network-partition outages.
- [ ] Define backup, restore, retention, deletion, and tenant-erasure procedures.
- [ ] Roll out by trusted role with a kill switch and rollback procedure.
- [ ] Add provider-wide garbage collection and unaffiliated object inventory.
- [ ] Add cross-platform support and deterministic fake-model acceptance tests.
