# Development and operations

## Service tests

Use Node.js 22 or newer. From `e2b/`:

```sh
npm ci
npm run build
npm test
npm audit
```

Database tests require `HOSTED_AGENT_TEST_DATABASE_URL`; without it they are skipped. Point it at a disposable development PostgreSQL instance, never a production database. SQL generation uses temporary databases and requires a role with `CREATEDB` permission:

```sh
HOSTED_AGENT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:15432/cudex_test npm test
HOSTED_AGENT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:15432/cudex_test npm run sql:check
# After intentionally changing a query:
HOSTED_AGENT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:15432/cudex_test npm run sql:generate
```

The generator applies migrations to its temporary database, checks PgTyped's output for worker errors, and drops that database afterward. A successful command must not merely compare stale generated files against themselves.

TypeScript is pinned to the supported 5.9 patch series. PgTyped 2.4.3 declares a TypeScript 3.1–5 peer range; do not force a TypeScript 6/7 installation past it. Updating the PostgreSQL JavaScript driver is separate from updating the database server.

## Rust checks

Read `codex/AGENTS.md`. The toolchain is pinned by `codex/codex-rs/rust-toolchain.toml`. Use scoped tests through `just test`, not direct `cargo test`; ask before running the complete workspace suite. Run scoped `just fix -p <crate>` and `just fmt` according to those instructions.

Config/protocol changes require generated fixtures:

```sh
cd codex/codex-rs
just write-config-schema
just write-app-server-schema
just write-app-server-schema --experimental
just test -p codex-app-server-protocol
just bazel-lock-update
```

The artifact script resolves upstream's checksummed V8 artifacts using `CODEX_REPO_ROOT`. A bare build of the V8 host may otherwise try an unavailable default download. For manual GNU-target builds, use the environment returned by `codex/scripts/codex_package/v8.py` for the matching target; do not reuse the musl archive for GNU or vice versa.

## Build and publish a development template

### Install the local CLI

On this machine, start CubeSandbox using the commands below, then run:

```sh
cd /home/xub/src/cudex
bash e2b/scripts/setup-local.sh
cudex -C /absolute/path/to/project
```

Setup requires a clean source checkout, Node 22+, npm, Git, Docker/Compose, and a completed clean musl release build. It selects the newest build whose Codex source matches the checkout (or accepts `--build-id <id>`), publishes its template if metadata is absent, packages a checksummed release, installs the runner into `~/.local/bin`, configures it, and runs `cudex doctor --verify-template`. It does not rebuild Rust automatically or launch an agent session. The installed runner is independent of later checkout changes.

Connection settings come from private `e2b/poc/.env` (mode 600), overridden by `CUDEX_API_URL`, `CUDEX_API_KEY`, `CUDEX_DOMAIN`, `CUDEX_VALIDATE_API_KEY`, and `CUDEX_PROVIDER_CA_CERTIFICATE`. The dotenv file is parsed as data, never sourced as shell code, and is not copied into the installation. The existing file-backed Codex login is reused; if absent, run `cudex login` and then `cudex doctor --verify-template`. The setup script reports a missing PATH entry; add `~/.local/bin` to your shell PATH if necessary.

The API can use plain HTTP only on literal `127.0.0.1` or `[::1]`; remote endpoints still require HTTPS. This machine uses `http://127.0.0.1:3000` and `CUDEX_VALIDATE_API_KEY=false`, inherited from its development configuration. The latter controls SDK key-format validation, not server authentication. Keep API credentials private. Setup does not alter database engine versions, tainer routes, or shell startup files.

Use `cudex status` to inspect a run and `cudex cleanup` to recover an interrupted run. The interactive POC described below is a separate fixture-based test, not the normal CLI.

### Build artifacts manually

From `e2b/`, on Linux/x86-64 with the pinned Rust toolchain, musl target/tools, Docker, `jq`, and CubeSandbox CLI installed:

```sh
bash scripts/build-codex-artifact.sh
bash scripts/build-template-image.sh
bash scripts/publish-template.sh
```

Build from a clean commit when producing a shareable artifact. Both the controller binary and code-mode host are checksummed and tied to template provenance. Defaults produce musl release binaries and publish an image through the local registry at `127.0.0.1:5000`.

The image uses a digest-pinned official CubeSandbox envd base and a compatible Node 22 image. It preserves the base's entrypoint and UID 1000, installs Git, and supplies a writable singleton-host directory. Do not substitute the removed, machine-local `cubesandbox-codex:0.1.0` image.

If commits change between build stages, set `CODEX_BUILD_ID` and `CODEX_ARTIFACT_DIR` explicitly to the build being published. `CUBE_IMAGE_METADATA` selects an existing image metadata file for publication. CubeSandbox 0.7 template creation uses `--detach`, followed by a watched job and explicit READY checks.

## Live workflow verification

Configure the ignored `e2b/poc/.env` using `.env.example`, including the newly generated template metadata. Configure exactly one authentication source. Repository-local `auth.json` must be private and must not be committed. The supported device-login helper is:

```sh
cd e2b
npm run build
node dist/src/poc-runner.js auth
npm run poc:preflight
npm run poc:automated
```

Preflight validates both binary checksums, template provenance, authentication, generated Codex configuration, and model compatibility before allocating a run. The automated workflow exercises separate root/child environments, remote code mode, patch return/apply, and cleanup. Reports live under ignored `.state/poc/` directories. Use `node dist/src/poc-runner.js status` and `down` to inspect or clean an interrupted run.

The normal runner remains `e2b/bin/cudex`; its setup/install workflow consumes a validated shared `release.json`, not an arbitrary binary path. `cudex doctor`, `status`, and `cleanup` remain the operational entry points after setup.

## This machine's CubeSandbox

Installed release: `v0.7.0-amd64`, recorded in `/usr/local/services/cubetoolbox/VERSION.txt`. The all-in-one installation uses the control role and a local Cubelet. Start it without rerunning the installer:

```sh
sudo systemctl start cube-sandbox-control.target cube-sandbox-cubelet.service
sudo env ONE_CLICK_RUNTIME_ENV_FILE=/usr/local/services/cubetoolbox/.one-click.env \
  /usr/local/services/cubetoolbox/scripts/one-click/quickcheck.sh
curl -fsS http://127.0.0.1:3011/internal/v1/nodes \
  | jq 'map({IP,Healthy,ReportedReady,UnhealthyReason})'
```

The old standalone network-agent is obsolete; 0.7 merges it into Cubelet. CubeOps uses this machine's customized port **3011**, not the upstream default 3010. Persistent guards/drop-ins retain that endpoint, Cubelet's master endpoint and registry mirror, Wi-Fi readiness, and loopback bindings for the UI and gRPC proxy.

UI: **https://cube-ui.tainer.run**, upstream `127.0.0.1:12088`. Native CubeSandbox authentication is retained with account `lucas`; there is no duplicate tainer login. Do not expose the origin publicly or manually edit generated tainer routing. Use the installed tainer publishing skill for routing changes.

The upgrade retained exact MySQL 8.0.46 and Redis 7.4.9 images. The project's PostgreSQL 17 and Garage 2.3.0 images were not upgraded. Optional MinIO is persistently disabled; enabling it is a separate deployment decision.

Treat CubeSandbox startup logs as sensitive: upstream may log configuration credentials. Do not paste broad journal tails into reports. Redact diagnostics, and coordinate credential rotation separately.
