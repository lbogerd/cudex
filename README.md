# Cudex

Cudex runs Codex agents in independent CubeSandbox workspaces. A TypeScript control plane owns provisioning, authenticated execution transport, snapshots, patch artifacts, retention, and cleanup. Codex remains the agent runtime and UI.

This rebuild starts from pristine upstream **Codex `rust-v0.153.4`**, then adds a small set of integration seams. It does not carry forward the old core implementation or its custom SQLite migrations.

| Component | Baseline |
| --- | --- |
| Codex | `rust-v0.153.4` |
| CubeSandbox | `v0.7.0` |
| E2B SDK | `2.46.1` |
| TypeScript | `~5.9.3`; PgTyped's supported peer range excludes 6 and 7 |
| Database/storage engines | Existing versions retained; no engine upgrade in this rebuild |

## Start here

- [Architecture and guarantees](docs/architecture.md)
- [Development, builds, and local CubeSandbox operations](docs/development.md)
- [Upstream app-server API, including Cudex additions](codex/codex-rs/app-server/README.md)

The source trees are `codex/` (vendored upstream plus adapters) and `e2b/` (control plane, local runner, tests, and template tooling). Generated binaries, credentials, templates, and per-run state are ignored development artifacts, not source releases.

## Important boundaries

Hosted mode fails closed: unsupported tools, ambient MCP/hooks/plugins, provider-native web search, environment redirection, and loss of the hosted runtime do not become local execution. Child changes return as durable patches; they are not silently merged into the owner workspace.

Children remain resident after a successful turn so followups can use the same runtime. Explicit close, eviction, or session shutdown performs final cleanup. JavaScript state does not survive a terminal host loss or controller restart; ordinary transport recovery must reconnect to the same live host.

Independent root history forks are not supported by the existing control-plane source contract. Old experimental Codex database homes require an explicit migration decision; do not point the new runtime at them and expect automatic conversion.
