# Cudex coworker pilot

`cudex` runs the standard Codex TUI against a project workspace hosted in
CubeSandbox, then safely returns the hosted root agent's changes to the local
Git checkout. The pilot is for trusted coworkers on Linux/x86_64 and uses a
trusted LAN control plane and shared release directory.

The existing fixed-project POC remains available to maintainers under
`e2b/scripts/hosted-codex-poc.sh`. It is a diagnostic and live-acceptance
harness, not the normal coworker interface.

## Coworker workflow

An administrator first publishes a matching release bundle and CubeSandbox
template. A coworker then installs and configures Cudex once:

```bash
./e2b/scripts/install-cudex.sh --release /shared/cudex/pilot-1/release.json
cudex setup --release /shared/cudex/pilot-1/release.json
cudex doctor
```

Normal use is from a Git working tree:

```bash
cd /path/to/project
cudex "implement the requested change"
git diff
```

`cudex` selects tracked files plus non-ignored untracked files, uploads an
immutable projection without `.git` or ignored files, creates a synthetic Git
baseline in the sandbox, starts the standard Codex TUI, and waits for the hosted
root result. On a successful TUI exit it compares the uploaded base, hosted
proposal, and current local files. Conflict-free changes are applied locally
without staging or committing them. A conflict leaves the checkout unchanged.

Release setup, authentication discovery/login, installation, `doctor`,
`version`, `cudex files`, and the arbitrary-checkout TUI lifecycle are
implemented. Root-result resolution and local application arrive in the next
delivery chunk; in the current intermediate revision a successful TUI is
reported, cleanup runs, and the command returns `1` without local mutation.

## Command reference

```text
cudex [PROMPT]
cudex -C <directory> [PROMPT]
cudex --model <model> [-C <directory>] [PROMPT]

cudex setup --release <shared-release.json>
cudex doctor [--verify-template]
cudex files [-C <directory>]
cudex status
cudex cleanup
cudex login
cudex version
```

Only `PROMPT`, `-C`, and `--model` are accepted for pilot sessions. Other
upstream Codex flags are rejected rather than forwarded ambiguously.

Exit statuses are stable:

| Status | Meaning |
| --- | --- |
| `0` | Session succeeded, the patch applied or was empty, and cleanup completed. |
| `1` | Session, patch resolution, or apply failed with no outstanding cleanup. |
| `2` | Installation, configuration, or preflight failed before allocation. |
| `3` | Manual hosted-resource or local rollback-journal recovery is required. |
| `4` | Local three-way conflict; the checkout was not changed. |
| `130` / `143` | SIGINT/SIGTERM was received and cleanup succeeded. |

## Files, trust, and local changes

The selected directory must be inside a Git worktree. Cudex uploads the
NUL-safe result of `git ls-files --cached --others --exclude-standard`, in
deterministic order. That includes every tracked file (even if a current ignore
rule matches its name) and excludes ignored untracked files. Regular files and
safe relative symlinks are preserved;
special files, submodules, nested repositories, unsafe symlinks, and archive
limit violations are rejected before allocation. Ignored files and `.git` are
never uploaded or returned.

For pilot uploads the service receives
`HOSTED_AGENT_WORKSPACE_MODE=git-working-set`. It initializes Git metadata at
`/workspace/.cudex-git`, writes the project `.git` pointer, and creates one
fixed-identity synthetic baseline commit. Hosted exports use the same Git
working-set selection, so deletions and executable-mode changes are preserved
while ignored generated output and Git metadata stay out of the returned
archive. Other provider modes retain their previous full-archive behavior.

The shared release manifest is the pilot trust root. Setup validates platform,
Node version, file sizes, SHA-256 checksums, executable modes, matching template
metadata, and release revisions before atomically caching a release under the
user's XDG data directory. Configuration and run state use XDG paths with
owner-only permissions. Existing Codex authentication is copied into the
isolated runtime only for the run and is removed during cleanup.

Interactive setup prompts for the CubeSandbox API URL and asks for its API key
with terminal echo disabled; the default sandbox domain is `cube.app`. Automated
setup can provide `CUDEX_API_URL`, `CUDEX_API_KEY`, `CUDEX_DOMAIN`, and optional
`CUDEX_PROVIDER_CA_CERTIFICATE` environment values. These values replace the
POC's repository-local `.env`; the API key is stored separately at mode `0600`.

Release manifest version 1 binds the release ID, Cudex and Codex revisions,
Linux/x86_64 platform, minimum Node version, binary sizes and SHA-256 checksums,
template metadata checksum and ID, CPU/memory limits, and creation time. Setup
atomically caches exactly `release.json`, `codex`, `codex-code-mode-host`, and
`template.json` after validating the complete bundle.

Cudex never stages or commits project changes. It applies only paths proven
safe by the immutable base/proposed/target comparison and uses a same-filesystem
backup journal. If rollback cannot be proven complete, it retains the journal,
returns status `3`, and prints its exact recovery path.

Never put API keys, auth files, credentials, release secrets, connection URLs,
or private keys in a project or prompt. Repository-local `.env`, auth files,
artifacts, state, logs, and runtime reports are ignored.

## Recovery and diagnostics

Only one Cudex run per local user is allowed. If a prior process was interrupted,
inspect its redacted state with `cudex status`; use `cudex cleanup` to retry the
exact run-scoped cleanup. Do not manually remove the lock or current pointer
until the command reports that no live run owns them.

Each run keeps separate mode-`0600` `session-report.json`, `apply-report.json`,
and `cleanup-report.json` files below the XDG state directory. Reports contain
only bounded non-secret outcomes. `cudex status` reads the non-secret current
pointer and exact tenant lifecycle counts; `cudex cleanup` retries deletion and
teardown for only that run.

When local application returns status `3`, leave the retained journal in place
and follow the printed recovery instructions. When it returns status `4`, no
local path was changed; reconcile the local edits and start a new run.

Maintainers can still run the fixed POC commands documented in
[`e2b/poc/README.md`](e2b/poc/README.md): `auth`, `preflight`, `up`, `automated`,
`interactive`, `status`, and `down`.

## Pilot shortcuts and internal-release blockers

Every active shortcut has a stable ID here, a remediation and validation record
in [`TODO.md`](TODO.md), and an adjacent implementation comment where it is
enforced. These are explicit pilot limits, not production defaults.

| ID | User-visible limitation | Why acceptable for coworker testing | Required before internal release |
| --- | --- | --- | --- |
| PILOT-001 | Linux/x86_64 only. | The trusted pilot machines use one known platform. | Define and test the supported platform matrix and artifact selection. |
| PILOT-002 | An unsigned trusted shared filesystem is the release trust root. | Access is limited to the trusted coworker LAN. | Add signed manifests, authenticated distribution, and update/rollback policy. |
| PILOT-003 | Every user runs disposable PostgreSQL and Garage locally. | It reuses the proven POC and contains each test run. | Choose and operate a supported internal control-plane topology. |
| PILOT-004 | One active run and one workspace root per user. | Pilot users can serialize their sessions. | Support multiple isolated concurrent runs and bounded multi-root selection. |
| PILOT-005 | Git repositories only. | The selected pilot projects already use Git. | Specify and implement safe non-Git workspace behavior. |
| PILOT-006 | Sandboxes get a synthetic baseline without repository history. | Codex needs status/diff, not full history, for pilot tasks. | Transport or reconstruct bounded Git history outside captured workspace state. |
| PILOT-007 | Submodules and nested repositories are rejected. | Their recursive credentials and trust are out of pilot scope. | Define secure recursive repository and credential behavior. |
| PILOT-008 | Ignored files are neither uploaded nor returned. | It avoids accidental secret/build-output capture. | Add an explicit, reviewable inclusion policy for required ignored files. |
| PILOT-009 | Only a small subset of upstream Codex CLI flags is supported. | The normal prompt, directory, and model workflow is sufficient. | Add compatibility tests and a safe forwarding policy. |
| PILOT-010 | Approval policy is fixed to `never` inside CubeSandbox. | The isolated trusted pilot environment is the approval boundary. | Define an internal-release approval and policy model. |
| PILOT-011 | Patch material is resolved directly from local PostgreSQL/object storage. | The control plane is disposable and local to the user. | Define a stable supported patch-return boundary or formalize this as an internal API. |
| PILOT-012 | Multi-file apply uses a rollback journal, not an atomic filesystem transaction. | It provides bounded recovery on the pilot filesystem. | Evaluate atomic directory/worktree strategies and crash recovery guarantees. |
| PILOT-013 | CubeSandbox networking follows the current secured POC route. | The route is already verified on the trusted LAN. | Move exec-server traffic to the approved internal private transport. |
| PILOT-014 | POC inspection and cleanup operations are enabled locally. | They make exact pilot cleanup observable and recoverable. | Replace them with supported authenticated operational interfaces. |
| PILOT-015 | Fixed local ports are used unless configured. | Pilot users coordinate on otherwise idle developer machines. | Add collision-free allocation and durable discovery. |
| PILOT-016 | Existing local Codex auth is copied into an isolated runtime. | It avoids a second daily login for trusted coworkers. | Complete credential review and define supported credential storage. |
| PILOT-017 | Reconciliation, quotas, monitoring, backup, and outage hardening remain deferred. | The named pilot is small, trusted, and supervised. | Complete the relevant production-hardening queue before broader deployment. |

## Contributing and delivery

Follow [`CONTRIBUTING.md`](CONTRIBUTING.md) before every implementation commit.
Stable decisions and redacted evidence belong in [`ARCHIVE.md`](ARCHIVE.md).
Open work and shortcut remediation belong in [`TODO.md`](TODO.md). The delivery
branch is `cudex/coworker-pilot`; feature commits are pushed without force.
