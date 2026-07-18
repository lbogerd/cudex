# E2B Backend Spike and Architecture Decisions

## Goal

Prove the remaining boundaries between Codex's completed hosted-agent HTTP
contract and CubeSandbox through the E2B TypeScript SDK. The spike ends with
recorded architecture decisions; it is not the full production backend.

Use [`hosted-agent-backend-integration-guide.md`](hosted-agent-backend-integration-guide.md)
as the contract and [`e2b/README.md`](e2b/README.md) for the verified template
workflow.

## Fixed decisions

- Implement an external TypeScript control plane; keep provider code out of
  `codex-core`.
- Pin E2B SDK 2.35.0 behind an internal provider adapter.
- Package the custom Codex fork as a stripped, checksummed musl artifact.
- Start `codex exec-server` after sandbox creation.
- Map trusted Codex template names to deployment-owned CubeSandbox template IDs.
- Give every Codex thread a distinct logical lease, environment, sandbox, and
  runtime identity.
- Use provider snapshots only for the same agent. Create children from a
  workspace-only capture in a clean role template.
- Keep patch artifacts and logical state in service-owned durable storage.
- Treat the current direct `22101` WSS route and `secure: false` as private-network
  spike settings only.

## Spike work

1. **Control-plane skeleton**
   - Add the TypeScript service, E2B adapter, template allowlist, logical lease
     records, operation journal, and bounded/redacted logging.
   - Implement only `provision`, `reconnect`, `checkpoint`, and `release` for the
     spike.

2. **Root workspace ingress**
   - Use a co-located, read-only workspace bridge for the local spike.
   - Copy an allowlisted workspace archive into `/workspace`, including untracked
     and modified files, modes, symlinks, cwd, and multiple roots.
   - Measure archive size and transfer time; define quotas and failure cleanup.

3. **Authenticated exec transport**
   - Put a service-owned WSS gateway in front of the raw exec-server port.
   - Issue short-lived, lease-scoped URL tickets accepted by the existing Codex
     client without custom headers.
   - Prove initialization, process execution, reconnect, expiry, revocation, and
     redaction. Keep the raw port unreachable outside the private provider path.

4. **Checkpoint and recovery**
   - Execute a command, create a durable snapshot, recover the interrupted WSS
     connection, and execute a second command on the same Codex thread.
   - Restart the control plane and reconnect from persisted provider IDs.
   - Kill the sandbox, restore from the durable snapshot into a new sandbox, rekey
     transport credentials, and repeat the command canary.

5. **Child isolation canary**
   - Capture the owner's workspace atomically and materialize it into a clean
     child template.
   - Prove spawn-time state is present, owner and child diverge independently,
     and no owner process, session, gateway secret, or runtime identity survives.

6. **Failure and cleanup canary**
   - Inject failure after each provider allocation step and verify transactional
     cleanup.
   - Verify idempotent replay, mismatched-key rejection, release replay, timeout
     reconciliation, and zero leaked sandboxes or tickets.

## Decisions to record

| Decision | Required spike evidence | Preferred direction |
| --- | --- | --- |
| Production workspace ingress | Exact-state and transfer canary | Explicit source snapshot ID backed by authenticated object storage |
| Exec authentication | URL-only Codex connection, rotation, revocation | Service-owned WSS gateway |
| Same-agent recovery | Snapshot interruption and restore canary | Durable provider snapshot plus fresh gateway credentials |
| Child creation | Process/secret isolation canary | Workspace manifest/archive into a clean template |
| Persistence | Service restart and idempotency canary | PostgreSQL operation journal; object storage for archives and artifacts |
| Lease timeout | Pause/reconnect behavior and cost | Explicit pause, `autoResume: false`, control-plane-owned state transitions |

Each decision record must state the chosen design, rejected alternatives,
security boundary, failure behavior, and operational cost.

## Exit criteria

- An unmodified hosted Codex client provisions through the HTTP service and runs
  commands before and after checkpoint recovery.
- Root and child filesystems match their required source state and remain
  isolated.
- Reconnect survives a control-plane restart; restore survives sandbox loss.
- Connection tickets and provider credentials are absent from logs and durable
  Codex state.
- Every injected failure is reconciled without leaked sandboxes or tickets.
- The six architecture decisions above are recorded and the implementation
  sequence in the integration guide is updated from their results.

## Spike result (2026-07-18)

Implemented under `e2b/src` with black-box/failure tests under `e2b/test` and a
live CubeSandbox lifecycle canary under `e2b/scripts`. The live run proved
checkpoint reconnect, provider-snapshot restore after sandbox loss, credential
and process cleanup, workspace-only child creation, and owner/child divergence.
The provider-independent suite proves restart persistence, canonical idempotency,
mismatched-key rejection, transactional cleanup, release replay, and ticket
redaction/revocation. Decisions and rejected alternatives are recorded in
`e2b/ARCHITECTURE_DECISIONS.md`; the integration guide now marks spike chunks 2
and 3 complete and leaves patch operations for the production sequence.
