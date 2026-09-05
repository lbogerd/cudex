# Architecture

## Ownership

| Layer | Responsibility |
| --- | --- |
| `e2b/src` | Tenant/role policy, leases, execution tickets, interaction ledger, workspace transfer, snapshots, patch export/apply, retention, local return |
| `codex/codex-rs/hosted-agent` | Typed service client and durable client-side lifecycle journal |
| `codex/codex-rs/core/src/hosted` | Provision before session startup, immutable thread binding, dispatch policy, completion/shutdown integration |
| `exec-server` / `code-mode` | Lease-owned remote environment handles and JavaScript host placement over existing execution transport |
| `app-server` / `tui` | Thread lifecycle API and owner-scoped patch notifications |

Upstream still owns conversations, collaboration scheduling, tool implementation, session machinery, protocol generation, and the TUI. The adapter uses upstream thread extension data, tool extensions, environment management, and code-mode session machinery instead of copying those subsystems.

## Execution and policy

1. The runner uploads a bounded source snapshot and configures trusted role/template mappings.
2. Hosted preparation obtains a lease and registers its authenticated remote environment before session startup.
3. The thread's code-mode host runs inside that environment through exec-server stdin/stdout. It needs no extra public listener.
4. Tool dispatch checks both the service allowlist and the adapter's audited execution-domain classification. The effective environment, cwd, workspace roots, lease, and generation must match the binding.
5. Unknown tools and unaudited startup contributors fail closed. Provider-native search is suppressed separately because it does not pass through ordinary function-tool dispatch.

Removing an environment tombstones retained handles, not just the manager's lookup entry. Process completion is distinct from process-group quiescence: snapshots wait for confirmed descendant shutdown. The deterministic, lease-bound JavaScript host is the sole long-lived process exemption; its nested command and filesystem requests remain in the interaction ledger. Model-facing command tools cannot choose that reserved process ID.

The authenticated raw exec gateway is a trusted-controller interface, not an untrusted end-user API. Hosted code must not receive its credentials.

## Patches and shutdown

Child completion exports a durable patch and sends metadata to the owning thread. The child stays active for followups. Applying a patch checks owner/child identity, policy, artifact authorization, baseline, and conflict conditions; a successful apply records a checkpoint. Model-facing results are limited to 8,192 serialized bytes and omit internal checkpoints; oversized conflicts are explicitly summarized. The app-server API retains its full result contract.

Child shutdown stops its code-mode host, finalizes its patch, retires execution handles, and releases the lease. Failed finalization retains recovery records without leaving usable transport handles.

Root shutdown has a different contract: the trusted local runner must export the root workspace after the UI exits. The runtime confirms shutdown, checkpoints, retains references, and writes an exact handoff marker while leaving the root lease available. The runner verifies that marker against the current lease/snapshot before exporting and applying changes locally, then performs cleanup. A zero UI exit alone is not proof of a successful handoff.

Deletion journals remote cleanup before removing local thread identity. Turning hosted configuration off does not turn a persisted hosted thread into a local thread or permit deletion to skip remote cleanup.

## Persistence and recovery

The private journal lives below `$CODEX_HOME/cudex-runtime/hosted-runtime-v1/`. It uses owner-only files, atomic replacement, durable writes, locking, and retryable operation identities. It does not persist bearer tokens, execution endpoints, or tool grants. Fresh grants are obtained from the service.

The original patch baseline and the current restored lease's canonical base are separate. The service permits an ancestor baseline only through a bounded, authenticated restore chain: tenant, agent, owner, template, workspace identity, terminal predecessor, and snapshot edge must agree. Root selection requires one unambiguous lineage tip.

Restart/reconnect validates the persisted source and workspace identity. It does not preserve volatile JavaScript state. Unsupported journal or legacy SQLite state fails explicitly rather than being guessed into the new format. The old custom SQLite migration numbers collide with stable upstream migrations, so they are not carried forward.

## Supported limits

- Hosted development artifacts target Linux/x86-64.
- No independent root history fork support.
- No ambient MCP, hooks, plugins, or provider-native web search in hosted mode.
- No automatic recovery of JavaScript state after terminal host loss.
- Legacy experimental state needs an explicit migration/export decision.
- Shared release distribution remains a trusted-filesystem workflow, not a signed public distribution system.
