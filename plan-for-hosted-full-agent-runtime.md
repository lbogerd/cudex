# Hosted Full-Agent Runtime

## Summary

Replace Codex-managed sandboxing with a hosted-agent runtime in which every root or spawned agent is a full, independent Codex thread backed by:

- a unique hosted sandbox lease;
- an immutable project snapshot taken at creation;
- a trusted agent role mapped to an opaque sandbox template;
- an authoritative tool-routing policy returned by the hosting service;
- an optional patch artifact exported on completion.

Keep parent/child relationships only for ownership, messaging, quotas, result delivery, and lifecycle. Do not inherit environments, filesystem state, cwd, approvals, execution policy, credentials, or sandbox permissions.

Implement this behind an experimental `hosted_agents` feature and split the work into reviewable stages under the repository’s 800-line guidance.

## Foundation Snapshot (2026-07-17)

The first foundation branch, `feat/hosted-agents`, implements the service,
configuration, and environment-lifecycle seams needed before thread orchestration
can move to hosted environments.

Completed:

- Stage 1 service contract:
  - added the `codex-hosted-agent` crate with the documented request, response,
    patch, policy, and error types;
  - added a native-RPITIT `HostedAgentService` trait;
  - added a production HTTP client with environment-sourced bearer
    authentication, HTTPS-only service transport, WSS-only executor transport,
    bounded timeouts and response sizes, disabled redirects, response validation,
    duplicate lease/environment rejection, and redacted diagnostics;
  - added an in-memory fake covering provision, reconnect, checkpoint, durable
    restore, patch export, atomic apply/conflict behavior, and release with
    request-consistent idempotency.
- Configuration foundation:
  - added the default-off `Feature::HostedAgents` gate and `[hosted_agents]`
    settings;
  - added normalized `sandbox_template` metadata to inline, layered, and
    file-backed agent roles;
  - added hosted-role/default-role validation, safe service URL validation,
    config-lock support, and regenerated `core/config.schema.json`.
- Dynamic environment lifecycle slice from Stage 2:
  - dynamically registered environments can be removed without affecting other
    environments;
  - removal aborts startup, closes the active transport, permanently disconnects
    stale handles, cancels in-progress authenticated recovery, and prevents
    subsequent reconnect attempts;
  - local, default, and statically configured environments fail closed.
- Hosted thread startup slice from Stages 2 and 3:
  - added core-owned `HostedAgentRuntime` state and a provision/register
    transaction boundary;
  - preallocates thread IDs before session construction so provision requests and
    Codex sessions share the same identity;
  - centrally provisions both roots and thread-spawned agents, using the root
    workspace or the owner's active lease as the snapshot source;
  - binds hosted threads to exactly the service-returned environment and drops
    inherited environment and exec-policy state;
  - rejects environment-ID collisions without replacing existing environments;
  - rolls back the environment registration and lease on registration or later
    thread-startup failure.
- Hosted runtime teardown slice from Stages 2 and 8:
  - atomically removes committed runtime ownership alongside thread removal;
  - unregisters and releases only the removed thread's environment and lease;
  - releases successfully shut down threads during bounded manager-wide
    shutdown without touching timed-out or submit-failed threads;
  - retains opaque runtime metadata when cleanup fails so a later removal can
    retry instead of forgetting the lease;
  - scopes release idempotency keys to the lease generation so a future restored
    lease for the same thread cannot collide with an earlier release.
- Tool-domain foundation from Stage 5:
  - added `ToolExecutionDomain` and `ToolExecutionDomainKind` independently of
    `ToolExposure`.
- Tool-domain authorization from Stage 5:
  - carries the service-returned policy and exact environment binding as
    immutable thread/turn runtime state;
  - classifies all planned runtime and hosted tools independently of exposure,
    filters unauthorized model specifications, and rechecks policy at dispatch;
  - rejects ambient and mismatched-environment MCP tools even if their coarse
    domain and exact tool name are granted;
  - completely unregisters legacy shell, code mode, and permission escalation
    tools for hosted threads while preserving existing non-hosted registries.
- External-sandbox enforcement from Stage 4:
  - centrally forces every hosted root and spawned thread to use an external
    sandbox with unrestricted network access and approval policy `Never`;
  - replaces configured permission-profile constraints with trusted hosted
    runtime permissions and disables the Codex-managed network proxy before
    session construction;
  - keeps the provisioned environment, external-sandbox profile, and approval
    policy immutable across later thread-setting and turn-setting updates;
  - retains the existing hosted tool-plan behavior that omits permission
    requests, legacy shell, code mode, and exec-permission escalation.
- Root agent-role selection from Stage 3 and the app-server API foundation:
  - added the experimental nullable `thread/start.agentType` field, with
    omission selecting `hosted_agents.default_agent_type`;
  - trims explicit selections, rejects blank values and hosted-disabled use,
    and resolves the trusted role to its opaque sandbox template only inside
    the centralized core provisioning boundary;
  - keeps stable generated API fixtures free of the experimental field while
    validating both stable and experimental schema generation.
- Spawn runtime-isolation cleanup from Stage 3:
  - hosted spawn and resume paths no longer inherit owner environment
    snapshots, environment selections, or exec-policy instances;
  - hosted spawn configuration no longer copies the live owner turn's cwd,
    approval policy, or permission profile, including role reloads and agent
    jobs;
  - preserves the existing inheritance behavior for non-hosted agents.

Validated in this branch:

- `just test -p codex-hosted-agent`: 8 passed;
- `just test -p codex-features`: 30 passed;
- focused hosted-agent config tests in `codex-core`: 5 passed before the final
  URL-query and blank-default validation cases were appended;
- focused active-recovery cancellation test in `codex-exec-server`: passed;
- hosted runtime orchestration tests in `codex-core`: 3 passed;
- hosted root/spawned thread startup test in `codex-core`: passed;
- thread-manager tests after release integration in `codex-core`: 30 passed;
- hosted runtime transaction tests after release integration in `codex-core`: 3 passed;
- full `codex-core` run after release integration: 2,880 passed, 97 failed,
  12 skipped; failures were in existing environment-sensitive sandbox,
  approval/network, missing test-binary, and timing-sensitive integration tests,
  while the hosted lifecycle and thread-manager coverage passed;
- focused resumed root and subagent session tests in `codex-core`: 2 passed;
- surrounding tool-spec, registry, and MCP exposure suites: 44 passed;
- hosted external-sandbox root/child coverage: passed;
- thread-manager tests after external-sandbox enforcement: 30 passed;
- combined hosted tool-plan, unified-exec, shell-spec, and thread-manager
  coverage after removing hosted escalation arguments: 79 passed;
- hosted root role selection and root/child runtime-isolation coverage: 2
  focused `codex-core` tests passed;
- `thread/start.agentType` capability gating and hosted-runtime forwarding: 2
  focused `codex-app-server` integration tests passed;
- `codex-app-server-protocol`: 266 passed, including stable fixture parity and
  the experimental field round trip;
- normal and experimental `just write-app-server-schema` generation passed,
  with the checked-in tree restored to the stable fixture set;
- scoped `just fix` passed for `codex-core`, `codex-app-server-protocol`, and
  `codex-app-server` after clearing the regenerable Rust incremental cache that
  had filled the development volume;
- environment-focused tests in `codex-exec-server`: 61 passed;
- scoped `just fix -p codex-core`: passed after clearing regenerable build
  artifacts that had exhausted the development volume;
- `just write-config-schema`, `just bazel-lock-update`, the hosted-agent Bazel
  target query, and final `just fmt`: passed.

The broader `codex-exec-server` run had 301 passing tests, including the new
environment-removal coverage. Thirty-four existing filesystem-sandbox tests
failed because the sandbox helper aborted with `SIGABRT` in the development
container.

Still pending:

- the remainder of Stage 4: normalize typed executor and remote-filesystem
  denials as explicit external-sandbox failures without retry or escalation;
- route direct `codex_delegate` review/guardian session creation through the
  manager-owned hosted provisioning path;
- separate ownership lineage from the active thread whose lease supplies a
  fork or detached subagent's project snapshot;
- Stages 6–8: persistence/restore, completion and explicit patch acceptance,
  lifecycle finalization, telemetry, app-server APIs, and end-to-end coverage.

## Final Implementation Status (2026-07-18)

All eight implementation stages are complete on `feat/hosted-agents`.

See [Hosted Agent Backend Integration Guide](hosted-agent-backend-integration-guide.md) for the
provider-neutral HTTP contract and the E2B control-plane, transport, snapshot, artifact, security,
and rollout guidance needed to connect a production backend.

The completed runtime now provides:

- one centrally provisioned, independently leased hosted environment for every hosted root,
  spawned agent, and direct review/guardian delegate;
- fail-closed external-sandbox permissions, exact tool/domain authorization at specification and
  dispatch time, normalized service denials, and explicit local-fallback invariant failures;
- durable owner lineage, lease/snapshot/lifecycle metadata, completed-turn checkpoints,
  reconnect-or-restore behavior, and automatic recovery of interrupted finalization;
- checkpoint/export/persist/release completion ordering with durable `PendingFinalization` and
  `ReleasePending` recovery;
- explicit, idempotent, conflict-safe patch acceptance through the plain `apply_agent_patch`
  collaboration tool and experimental app-server `agent/patchApply` API;
- owner-scoped, guaranteed-delivery `agent/patchAvailable` notifications with bounded non-secret
  artifact metadata;
- deepest-first descendant shutdown, generation-safe asynchronous cleanup retries with bounded
  backoff, deletion protection while cleanup is pending, and no terminal idle release of otherwise
  resumable hosted threads;
- bounded telemetry for provision/restore/checkpoint latency, active leases, patch size/conflicts,
  denied domains, cleanup retries, and prevented local fallback;
- a bounded fake filesystem that verifies snapshot isolation, checkpoint authority, clean
  add/modify/delete application, and atomic three-way conflicts without partial mutation.

Validation for the final stages includes the full 17-test `codex-hosted-agent` suite; focused core
tests for provision rollback, checkpoint/finalization/release recovery, reconnect/restore, durable
lineage, patch application, follow-up rejection after terminal release, cleanup generation safety,
tool policy, and telemetry; app-server protocol/schema validation; and public app-server tests for
experimental gating, request validation, ownership non-disclosure, notification scoping, response
mapping, and subtree removal ordering. Scoped Clippy fixes and repository formatting passed after
each landing chunk.

The Docker remote-executor command was attempted on 2026-07-18, but the development host reported
that its Docker daemon was unreachable. The focused app-server patch route suite then ran locally
and passed. Hosted external-service execution is intentionally not skipped silently: the standard
remote harness cannot synthesize the hosting service's service-owned WSS lease connection, and Wine
coverage remains delegated to the repository's Bazel CI matrix.

Deployment still owns the two explicit service-side assumptions from this plan: transactional
cleanup of any lease that is created before `provision` returns an error, and TTL reaping after a
Codex process crash. Codex persists only opaque identifiers and retries every cleanup operation for
which it has obtained a lease identifier.

## Success Criteria

- Root and spawned agents use the same provisioning path.
- Every agent receives exactly one unique remote environment.
- Hosted mode never falls back to local execution.
- Codex uses external sandbox/full-permission semantics with no approval prompts.
- Unauthorized out-of-sandbox tools are absent from model specs and rejected during dispatch.
- Child project state is a snapshot of its owner at spawn time and remains independent afterward.
- Completion returns a durable patch artifact without automatically modifying the owner.
- The owner can explicitly apply a patch atomically; conflicts leave its sandbox unchanged.
- Missing sandboxes are restored from the agent’s latest durable snapshot when resumed.
- Existing non-hosted Codex behavior remains unchanged while the feature is disabled.

## New Crate and Core Types

Create a small `codex-hosted-agent` crate rather than expanding `codex-core`. It should depend on protocol, exec-server, path, and tool types, while `codex-core` owns orchestration.

Define:

```rust
struct AgentProvisionRequest {
    agent_id: ThreadId,
    owner_agent_id: Option<ThreadId>,
    agent_type: String,
    sandbox_template: String,
    source: ProjectSnapshotSource,
    idempotency_key: String,
}

enum ProjectSnapshotSource {
    RootWorkspace {
        cwd: PathUri,
        workspace_roots: Vec<PathUri>,
    },
    AgentEnvironment {
        owner_lease_id: String,
    },
    DurableSnapshot {
        snapshot_id: String,
    },
}

struct ProvisionedAgent {
    lease_id: String,
    environment_id: String,
    connection: HostedEnvironmentConnection,
    cwd: PathUri,
    workspace_roots: Vec<PathUri>,
    base_snapshot_id: String,
    tool_policy: AgentToolPolicy,
}

struct AgentToolPolicy {
    allowed_domains: BTreeSet<ToolExecutionDomainKind>,
    allowed_tools: BTreeSet<ToolName>,
}

struct AgentPatchArtifact {
    artifact_id: String,
    agent_id: ThreadId,
    base_snapshot_id: String,
    checksum: String,
    changed_files: u32,
    size_bytes: u64,
}

enum PatchApplyResult {
    Applied,
    Conflict { paths: Vec<PathUri> },
    Rejected { reason: String },
}
```

Expose a documented `HostedAgentService` trait using native RPITIT futures with explicit `Send` bounds, not `async_trait`:

- `provision`
- `reconnect`
- `checkpoint`
- `export_patch`
- `apply_patch`
- `release`

All operations must be idempotent. Persist only opaque lease, snapshot, and artifact IDs; never persist service credentials, authorization tokens, connection URLs, or rendezvous secrets.

## Configuration and Public API

Add:

```toml
[hosted_agents]
enabled = true
service_url = "https://sandbox-service.example"
default_agent_type = "default"

[agents.default]
description = "General development agent."
sandbox_template = "general-v1"

[agents.researcher]
description = "Research agent."
sandbox_template = "research-v1"

[agents.debugger]
description = "Debugger agent."
sandbox_template = "debugger-v1"
```

Read service authentication from an environment variable such as `CODEX_HOSTED_AGENT_TOKEN`, not `config.toml`.

Extend `AgentRoleToml` and `AgentRoleConfig` with `sandbox_template: Option<String>`. Require it for every role usable in hosted mode.

Add an experimental nullable `agentType` to app-server v2 `ThreadStartParams`. Omission selects `hosted_agents.default_agent_type`. Keep the existing `spawn_agent.agent_type` argument.

Do not expose raw sandbox template names to the model beyond trusted agent-role descriptions. The model selects an allowed agent type; Codex resolves the corresponding template.

Regenerate:

- `core/config.schema.json`
- app-server v2 normal and experimental schemas
- generated TypeScript fixtures

## Stage 1: Service Contract and Fake Provisioner

Implement `codex-hosted-agent` with:

- the types and trait above;
- a production HTTP client with bounded timeouts and redacted diagnostics;
- an in-memory fake supporting provision, checkpoint, restore, patch export, conflict simulation, and release;
- explicit error categories: unavailable, unauthorized, invalid template, snapshot missing, quota exceeded, connection failed, and patch conflict.

Do not couple the service contract to app-server or `AgentControl`.

Add unit tests for idempotency, redaction, response validation, and duplicate environment/lease rejection.

## Stage 2: Dynamic Environment Ownership

Extend `EnvironmentManager` to support removing a dynamically registered environment and terminating its connection without affecting other agents.

Introduce a core-owned `HostedAgentRuntime` containing:

```rust
struct HostedAgentRuntime {
    lease_id: String,
    environment_id: String,
    agent_type: String,
    sandbox_template: String,
    base_snapshot_id: String,
    latest_snapshot_id: String,
    tool_policy: AgentToolPolicy,
}
```

Each thread must select only its own environment. Never place another agent’s environment in its `TurnEnvironmentSelections`.

Provision before constructing the thread session:

1. Allocate the thread/agent ID.
2. Resolve the trusted role.
3. Ask the hosting service to snapshot and provision.
4. register the returned environment;
5. create the thread bound to that single environment;
6. release and unregister the environment if any later startup step fails.

No local environment fallback is permitted in hosted mode.

## Stage 3: Uniform Root and Spawned-Agent Creation

Centralize provisioning below app-server and collaboration handlers, in the thread manager path used by all thread creation surfaces.

Refactor `AgentControl` so spawned agents no longer use:

- inherited environments;
- inherited exec policy;
- `apply_spawn_agent_runtime_overrides`;
- parent cwd or permission profiles.

Continue sharing `AgentControl` for task-tree coordination, concurrency limits, messaging, residency, and rollout budgets.

Retain `SessionSource::SubAgent`, `ThreadSource::Subagent`, parent thread IDs, agent paths, and existing wire names for compatibility. Semantically, they describe ownership only.

For context transfer:

- Default to a fresh context containing the role instructions, task, and normal project guidance.
- Preserve explicit `fork_turns` modes as conversation-context transfer only.
- Continue sanitizing tool calls, environment IDs, inter-agent messages, and transient runtime items.
- Never transfer runtime state or environment selections with forked history.

At spawn time, the hosting service snapshots the owner’s current lease atomically. Subsequent edits in either sandbox are independent.

## Stage 4: External Sandbox Semantics

For hosted agents, force the effective Codex runtime to:

- `SandboxPolicy::ExternalSandbox`;
- approval policy `Never`;
- unrestricted Codex filesystem and network permissions;
- no execution escalation;
- no `request_permissions` tool;
- no Codex managed-network proxy;
- no inherited approval cache.

Do not modify the existing `CODEX_SANDBOX_*` constants or environment-variable behavior.

A service denial is a final tool failure reported as an external sandbox denial. Codex must not retry locally or escalate around it.

## Stage 5: Tool-Domain Authorization

Add `ToolExecutionDomain` metadata independently of `ToolExposure`:

```rust
enum ToolExecutionDomain {
    AgentEnvironment,
    ControlPlane,
    ProviderHosted,
    EnvironmentBoundMcp { server: String, environment_id: String },
    AmbientMcp { server: String },
    ClientCallback,
    Extension,
    OrchestratorProcess,
}
```

Store the domain alongside each planned runtime and hosted tool specification.

Enforce authorization twice:

1. Remove denied tools before sending model-visible specifications.
2. Recheck the current thread’s policy in `ToolRegistry` immediately before dispatch.

`ToolExposure::Hidden` must not count as authorization.

Initial classification:

- `AgentEnvironment`: unified exec, `write_stdin`, `apply_patch`, `view_image`.
- `ControlPlane`: plan, status/list/wait/message, interruption, and spawn where individually granted.
- `ProviderHosted`: hosted web search.
- `ClientCallback`: dynamic tools.
- `Extension`: extension executors, including standalone image/search implementations.
- `OrchestratorProcess`: code mode and legacy local shell.
- MCP: classify from its exact environment binding.

Hosted-mode defaults:

- Permit environment tools and a minimal allowlisted control-plane set.
- Deny all outside domains unless the provisioning response explicitly grants both domain and tool.
- Completely unregister legacy `shell_command`; do not retain its hidden dispatch handler.
- Disable code mode until its V8 host can run within the hosted environment.
- Disable provider-hosted search, connectors, dynamic tools, plugins, and unclassified extensions by default.
- Reject MCP servers using the local/default environment.
- Permit stdio or HTTP MCP only when bound to the current agent’s exact environment ID.

## Stage 6: Persistence, Checkpointing, and Resume

Add optional hosted-runtime metadata to thread persistence, preferably as a nullable JSON metadata field to avoid proliferating columns:

- agent type and template;
- lease ID;
- environment ID;
- base and latest snapshot IDs;
- last exported patch artifact;
- lifecycle state.

Provide equivalent support in local and in-memory thread stores. Never inject this metadata into model context.

Checkpoint after every successfully completed turn and immediately before normal sandbox release. Update persisted metadata only after the service confirms the checkpoint.

Resume behavior:

1. Read the persisted runtime record.
2. Attempt to reconnect to the existing lease.
3. If it no longer exists, provision a fresh sandbox from `latest_snapshot_id`.
4. Register the new environment ID and update persisted lease metadata.
5. Resume the existing Codex thread and conversation history.
6. If no durable snapshot exists, fail clearly without creating a fresh workspace from unrelated current state.

Work from an interrupted, uncheckpointed turn may be discarded. The last completed-turn snapshot is authoritative.

Service leases should also have server-side TTL cleanup for crashes where Codex cannot call `release`.

## Stage 7: Completion and Explicit Patch Acceptance

When an owned agent reaches a completed state:

1. checkpoint its sandbox;
2. export a patch relative to its immutable base snapshot;
3. persist the `AgentPatchArtifact`;
4. include the artifact metadata with the completion result;
5. release the sandbox once the artifact is durable.

Do not apply the patch automatically.

Add a collaboration tool and app-server v2 method named `agent/patchApply`. It accepts the child agent ID and artifact ID and applies the artifact to the requesting owner’s current sandbox.

Authorization requirements:

- The caller must own the source agent directly or through the permitted task tree.
- The artifact must belong to that source agent.
- The caller must have the control-plane grant for patch application.
- The target must be the caller’s own environment.

The hosting service performs an atomic three-way application using the child’s base snapshot and the owner’s current snapshot:

- success changes the owner sandbox and creates a new checkpoint;
- conflict returns bounded conflicting paths and leaves the owner unchanged;
- repeated application of the same artifact is idempotent.

Add an experimental `agent/patchAvailable` notification and corresponding v2 TypeScript types. Do not add new v1 API surface.

## Stage 8: Lifecycle and Failure Handling

Define these terminal behaviors:

- Provision failure: no thread is created; any partial lease is released.
- Thread startup failure: unregister environment and release lease.
- Spawn quota failure: do not provision.
- Agent cancellation mid-turn: discard uncheckpointed work, then release.
- Agent completion: checkpoint, export patch, persist artifact, release.
- Agent close/archive without completion: checkpoint only if the last turn completed; otherwise release from the last durable state.
- Parent close: interrupt descendants, finalize completed descendants, then release all owned leases.
- Codex crash: external TTL reaps leases; resume restores from persisted snapshots.
- Service unavailable during release: mark cleanup pending and retry asynchronously; never block persisted thread completion indefinitely.
- Service unavailable during checkpoint or patch export: preserve the lease and mark completion as pending finalization rather than reporting a patchless success.

Emit structured telemetry for provision latency, restore count, active lease count, checkpoint latency, patch size, patch conflicts, denied tool domains, cleanup retries, and accidental local-fallback attempts.

## Test Plan

### Unit tests

- Role/template resolution and missing-template failures.
- Tool-policy filtering of direct, deferred, hosted, hidden, and code-mode nested tools.
- Dispatch rejects forged or stale calls even if a handler remains registered.
- Legacy shell is absent from hosted registries.
- Local/default MCP bindings are rejected.
- Runtime metadata serialization excludes credentials and connection details.
- Provision/release/checkpoint/apply operations are idempotent.
- Patch conflict leaves the target snapshot unchanged.

### Core integration tests

Use `TestCodexBuilder::build_with_auto_env()` where possible and a fake hosted-agent service for lifecycle assertions.

Cover:

- root agent gets one hosted environment;
- two spawned agents get distinct leases and environments;
- spawned agent never inherits its owner’s environment or cwd;
- owner changes after spawn are not visible to the child;
- child changes are not visible until patch acceptance;
- explicit acceptance applies a clean patch;
- diverged edits produce an atomic conflict;
- service-denied file writes and network calls are not retried locally;
- hosted web search and dynamic tools are denied by default;
- an explicitly granted outside domain becomes visible and callable;
- missing lease restores from the latest snapshot;
- failed provisioning leaves no thread, registry entry, or leaked lease;
- completion exports and persists a patch before releasing the lease.

### App-server integration tests

Use `TestAppServer::new_with_auto_env()` and `send_thread_start_request_with_auto_env()` unless a test intentionally installs dynamic environments.

Cover:

- `thread/start.agentType`;
- generated schemas and TypeScript names;
- `agent/patchAvailable`;
- `agent/patchApply` success, conflict, unauthorized owner, stale artifact, and retry;
- restart/resume with a missing external lease;
- thread listing preserves owner, role, and agent status without exposing secrets.

Run Docker remote-executor coverage for core and app-server. Keep Wine compatibility in types and path handling, but skip external-service behavior only where the test harness cannot provide the hosted service, with a specific reason.

## Validation Workflow Per Stage

For every stage:

1. Run focused crate tests with `just test -p <changed-crate>`.
2. Run affected core or app-server integration tests.
3. Run `just write-config-schema` after config changes.
4. Run `just write-app-server-schema` and `--experimental` after v2 API changes.
5. Run `just fix -p <changed-crate>` for large Rust changes.
6. Run `just fmt` last, as required by the repository.
7. Do not rerun tests after `fix` or `fmt`.
8. Ask before running the complete workspace `just test` when shared core/protocol work is ready.

Keep each PR below approximately 800 changed lines, with complex logic below 500 lines. Suggested landing sequence:

1. service contract and fake;
2. dynamic environment removal/ownership;
3. tool-domain authorization;
4. root provisioning;
5. spawned-agent provisioning and inheritance removal;
6. persistence and restore;
7. patch artifacts and explicit application;
8. app-server API, telemetry, and end-to-end remote tests.

## Rollout

- Ship disabled by default behind `hosted_agents`.
- Enable first in tests with the fake provisioner.
- Enable for internal root agents without spawning.
- Enable spawned full agents next.
- Enable snapshot restore and patch acceptance after lifecycle telemetry is stable.
- Keep existing local/non-hosted execution unchanged during the migration.
- Hosted mode is fail-closed: provisioning, policy, or connection failures never fall back to local execution.

## Explicit Assumptions

- Resource and provisioning latency increases are accepted.
- Every root and spawned agent receives a separate sandbox.
- Project snapshots are intentionally isolated after spawn.
- The hosting service can atomically snapshot one agent environment to create another.
- The hosting service provides durable checkpoints and patch artifacts.
- Patch application is explicit, atomic, and conflict-safe.
- Resume restores the latest durable agent snapshot when a lease disappears.
- Outside-sandbox tools are denied by default.
- Parent/child metadata remains for coordination, but there is no distinct subagent runtime.
- Initial implementation keeps existing collaboration tool names and thread-source wire values for compatibility.
