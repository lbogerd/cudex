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

For local CubeSandbox, set `E2B_VALIDATE_API_KEY=false` and set
`POC_PROVIDER_CA_CERTIFICATE` to its development CA PEM. The runner validates
that bounded regular certificate file, re-executes Node with it as additional
provider trust before loading the E2B SDK, includes it in the generated combined
CA bundle, and passes the explicit key-validation policy to the control service.
These settings belong in `.env`; no shell export or system trust-store change is
required.

For an E2B endpoint with normal key validation, leave
`E2B_VALIDATE_API_KEY=true` (or omit it) and leave
`POC_PROVIDER_CA_CERTIFICATE` empty unless that endpoint uses a private CA.

POC Codex processes receive that combined bundle through both
`CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE`. This covers Codex's shared clients
and the hosted-agent reqwest client without changing the host trust store.

The generated config pins multi-agent v2's `collaboration` namespace, and the
server-owned role policy authorizes the matching namespaced spawn/wait tools.
This is explicit because current Codex defaults namespace these tools; patch
application remains a plain hosted-only tool by design.

Set `POC_CODEX_MODEL` to a model that supports direct tools. At the time of
this proof, the listed `gpt-5.6-*` defaults are code-mode-only, while `gpt-5.5`
supports the restricted `exec_command`/`write_stdin` policy. Automated mode
checks the authenticated catalog and the exact artifact's cached tool mode
before `thread/start`, so an incompatible model fails before E2B allocation.

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
Retained reports contain only lifecycle IDs and assertion booleans. Exit 0 means
functional and service-owned cleanup acceptance passed, exit 1 means a
functional/lifecycle failure, exit 2 means preflight/configuration failure, and
exit 3 means the functional flow passed but exact provider cleanup needed forced
intervention. Set `POC_KEEP_ON_FAILURE=true` only for diagnosis, then use
`status` and `down` promptly to avoid continued E2B and Docker resource costs.

Secured CubeSandbox envd access is implemented by the tracked, bounded E2B data
plane adapter in this repository. It supplies the create-time traffic credential
to file and command calls that the pinned SDK's high-level clients do not
currently authenticate. No `node_modules` modification, dependency patch, or
post-install rewrite is used.

The POC enables two bearer-protected inspection/cleanup operations only in its
own control-service process. They verify one exact active root sandbox and delete
only provider snapshots selected from the exact released POC tenant. Production
service startup leaves these operations disabled.

The current secured E2B public-port route to exec-server port 22101 is accepted
only for this proof. Private/reverse executor transport and removal of this
public route remain explicit production blockers.
