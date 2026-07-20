# Cudex pilot queue

This file is the active implementation and internal-release queue. Stable
decisions and completed evidence are preserved in [`ARCHIVE.md`](ARCHIVE.md).

## Autonomous coworker-pilot delivery

- [x] A1: documentation baseline, registry enforcement, and delivery checklist.
- [ ] A2: finish reusable runner, patch, report, and lifecycle module extraction.
- [x] A3: release setup, XDG config, auth discovery/login, installer, and doctor.
- [ ] A4/A5: deterministic Git projection, synthetic baseline, and hosted export.
- [ ] A6: generalized TUI runner with exact lifecycle cleanup.
- [ ] A7/A8: exact root patch resolution and recoverable three-way local apply.
- [ ] A9/A10: signals, cleanup/status, redaction, database tests, and fake acceptance.

## Pilot shortcuts and internal-release blockers

`State` is `open` until remediation and validation are complete. A completed ID
must be removed from active code comments and recorded in `ARCHIVE.md`.

| ID | Affected modules | Concrete remediation | Validation required before closing | State |
| --- | --- | --- | --- | --- |
| PILOT-001 | CLI, release selection, installer | Define supported OS/architecture combinations and select platform-specific artifacts. | Install, doctor, projection, run, apply, and cleanup pass on every supported platform. | open |
| PILOT-002 | release, setup, installer | Sign manifests, authenticate distribution, and implement update plus rollback policy. | Tamper, downgrade, key-rotation, update, and rollback tests pass. | open |
| PILOT-003 | runner, infrastructure | Select and operate the supported internal PostgreSQL/object-store topology. | Multi-user lifecycle, outage, upgrade, and isolation acceptance passes. | open |
| PILOT-004 | CLI, lock, runner, workspace | Add isolated concurrent run identities and bounded multi-root selection. | Concurrent runs and multi-root conflict/cleanup tests pass. | open |
| PILOT-005 | CLI, git-workspace | Specify safe non-Git discovery, ignore, identity, and apply rules. | Equivalent selection and three-way apply suites pass outside Git. | open |
| PILOT-006 | synthetic-git, hosted projection | Transport or reconstruct explicitly bounded Git history outside workspace capture. | History-dependent Codex tasks pass without leaking excluded objects. | open |
| PILOT-007 | git-workspace, apply | Define recursive repository boundaries, credentials, and patch semantics. | Submodule and nested-repository security/lifecycle tests pass. | open |
| PILOT-008 | git-workspace, hosted export, apply | Add an explicit reviewable allowlist for required ignored files. | Selection, secrecy, round-trip, deletion, and conflict tests pass. | open |
| PILOT-009 | CLI, TUI launcher | Define a safe upstream option-forwarding compatibility policy. | Versioned compatibility suite covers every supported flag. | open |
| PILOT-010 | runner, generated Codex config | Define configurable approval and hosted policy behavior. | Policy/approval matrix and denial tests pass. | open |
| PILOT-011 | local-patch-source | Expose a stable authenticated patch-return interface or formalize the direct store contract. | Wrong-run, child, corrupt, expired, replay, and availability tests pass across upgrades. | open |
| PILOT-012 | local-patch-apply | Select atomic worktree/directory mechanics and specify crash recovery. | Power-loss and filesystem-fault testing proves atomicity or complete recovery. | open |
| PILOT-013 | gateway, provider, runner | Move exec-server traffic to approved internal private transport. | Network-policy and credential-leak acceptance passes. | open |
| PILOT-014 | service, inspector, cleanup | Replace POC-only operations with supported authenticated operational APIs. | Authorization, audit, pagination, and exact-scope deletion tests pass. | open |
| PILOT-015 | config, infrastructure | Allocate collision-free ports and persist durable discovery. | Parallel-user and stale-state port tests pass. | open |
| PILOT-016 | auth, runner | Complete credential review and implement supported isolated credential storage. | Permission, lifecycle, crash, redaction, and threat-model review pass. | open |
| PILOT-017 | reconciler, quotas, operations | Complete the production-hardening queue required for the approved rollout size. | Human release review accepts outage, quota, monitoring, backup, and recovery evidence. | open |

## Human-in-the-loop delivery

- [ ] H1: confirm LAN endpoint, DNS, API-key issuance, private CA, shared release path, template Git, and coworker Docker access.
- [ ] H2: publish a reviewed matching release bundle and CubeSandbox template; record release ID and checksums.
- [ ] H3: run live success, conflict, signal, sandbox-loss, timeout, cleanup, and redaction acceptance.
- [ ] H4: complete the fresh-coworker UX trial and convert reproducible issues into TODOs.
- [ ] H5: approve the named pilot users and all remaining shortcuts.

## Existing POC and production-hardening queue

The remaining sections preserve the prior POC queue. Completed items are useful
implementation evidence; unchecked fault injection and production items remain
open and are covered by PILOT-017 where applicable.

# Local Hosted-Codex Owner/Child POC Queue (preserved)

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
- [x] Keep the Linux/musl LTO artifact build within rustc's explicit bounded
  query recursion limit.

### Transport, provider, and identity

- [x] Carry protocol stdin/stdout over the selected environment's existing
  `ExecProcess`; stderr is diagnostic-only and no new public port is used.
- [x] Add the immutable non-secret runtime identity and deterministic process ID.
- [x] Add eager remote process startup and protocol handshake before hosted
  thread creation, with a distinct child provider.
- [x] Make provider placement structurally explicit so production hosted paths
  cannot select the shared local provider. Unit-only provisioning uses an
  explicit constructor that disables runtime startup rather than `cfg!(test)`.
- [x] Add verified same-generation recovery through exec-server's retained
  exact-process read and deduplicated write resume. Unprovable reconnects fail
  closed; replacement environments use the authoritative generation.
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

- [x] Emit non-secret reconnect telemetry from the exact process session's
  monotonic successful-recovery signal, alongside start, ready, failure,
  shutdown, and quiescence events.
- [x] Add transport, provider, provisioning, authorization, reconnect, and
  shutdown coverage, including real remote startup in the live acceptance run.
- [x] Add trusted runtime-placement evidence and the six code-mode booleans to
  retained POC reports.
- [x] Run the real root/child CubeSandbox happy-path acceptance with pure
  JavaScript work, stored-value isolation, nested command routing, distinct
  placement, durable patch application, and exact final cleanup.
- [ ] Add destructive live fault cases for an infinite child cell, independent
  root/child sandbox failure, and measured local-versus-sandbox CPU accounting.
- [x] Switch the POC default from `gpt-5.5` only after the full code-mode-only
  acceptance run passes.
- [x] Exempt only the exact identity-derived lease-long code-mode host from
  workspace quiescence, while retaining gates for commands and
  filesystem activity; cover the root-spawns-child deadlock regression in
  PostgreSQL.
- [x] Shut down the child provider on the dedicated patch-finalization path
  before lease release, not only during ordinary thread removal.

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
