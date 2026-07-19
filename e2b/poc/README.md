# Local hosted-Codex owner/child proof

This Linux-only development proof runs the real checksummed Codex artifact
against the production PostgreSQL/S3/HTTPS lifecycle path, provisions an E2B
root, lets it spawn an isolated child, applies the child artifact, verifies the
root workspace, and cleans up exact run-owned resources.

## Prerequisites

- x86_64 Linux, Node.js 22 or newer, and Docker Compose v2;
- ordinary `docker` access or passwordless `sudo -n docker`;
- an E2B API endpoint/key and a published template metadata JSON file;
- the matching executable at `e2b/.artifacts/codex/<build-id>/codex`;
- either a Codex access token or a ChatGPT `auth.json`.

Garage 2.3.0 is used because its `--single-node --default-bucket` path creates a
small S3-compatible development store with generated credentials. It has
replication factor one, provides no durability guarantee, and is deliberately
destroyed by `docker compose down --volumes`. It is not a production topology.

## Configuration

Copy `e2b/poc/.env.example` to `e2b/poc/.env` and fill every required value.
The file is parsed as data by Node and is never sourced by the shell. Configure
exactly one of `CODEX_ACCESS_TOKEN` and `CODEX_AUTH_JSON_FILE`; empty values do
not count. The documented auth file location is
`e2b/poc/secrets/auth.json`. Both `.env` and every file in `secrets/` are ignored.

An access token is passed only to Codex and is never copied into `CODEX_HOME`.
An auth JSON source is validated without following symlinks, copied to the
per-run Codex home as mode `0600`, and removed during cleanup. Never commit or
paste either credential into logs, prompts, issues, or reports.

## Commands

Run from the repository root:

```bash
./e2b/scripts/hosted-codex-poc.sh auth
./e2b/scripts/hosted-codex-poc.sh preflight
./e2b/scripts/hosted-codex-poc.sh up
./e2b/scripts/hosted-codex-poc.sh automated
./e2b/scripts/hosted-codex-poc.sh interactive
./e2b/scripts/hosted-codex-poc.sh status
./e2b/scripts/hosted-codex-poc.sh down
```

`auth` performs device login without starting Docker or E2B. `automated` runs
the complete proof with a 20-minute model deadline. `interactive` prepares the
same environment and opens the exact Codex TUI for diagnosis; a successful TUI
exit alone is not an acceptance pass. `up`, `status`, and `down` use the single
ignored pointer at `e2b/.state/poc/current` and refuse missing or ambiguous state.

Each live proof creates at least a root and child E2B sandbox and may create
provider snapshots, so normal E2B compute/storage costs apply. On interruption,
run `status` and then `down`. Cleanup is strictly scoped to the run's tenant and
`managedBy` marker; the POC never inventories or deletes unaffiliated resources.

The current secured E2B public-port route to exec-server port 22101 is accepted
only for this proof. Private/reverse executor transport and removal of this
public route remain explicit production blockers.
