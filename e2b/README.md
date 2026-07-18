# Custom Codex CubeSandbox template

Run these commands from the repository root. The pipeline builds the local Codex fork, creates an OCI image, publishes a CubeSandbox template, and verifies it through the E2B TypeScript SDK.

## One-time setup

1. Start CubeSandbox, its KVM backend, and the registry at `127.0.0.1:5000`.
2. Install build tools and the target used by the Codex fork:

   ```bash
   sudo apt-get install jq musl-tools
   cd codex/codex-rs
   toolchain=$(rustup show active-toolchain | awk '{print $1}')
   rustup target add --toolchain "${toolchain}" x86_64-unknown-linux-musl
   cd ../..
   ```

3. Install the pinned SDK dependencies:

   ```bash
   npm ci --prefix e2b
   ```

Passwordless `sudo` is required for Docker and `cubemastercli`.

## Build and publish

Run the stages in order:

```bash
./e2b/scripts/build-codex-artifact.sh
./e2b/scripts/build-template-image.sh
./e2b/scripts/publish-template.sh
```

Record the `build_id` and `template_id` printed by the scripts. Publishing waits until every CubeSandbox node reports the template ready.

| Output | Location |
| --- | --- |
| Static Codex binary and provenance | `e2b/.artifacts/codex/<build_id>/` |
| Image reference and digest | `e2b/.artifacts/images/<build_id>.json` |
| Template ID and provenance | `e2b/.artifacts/templates/<build_id>.json` |

Artifacts are ignored by Git. Distributable binaries are stripped by default; set `CODEX_STRIP_ARTIFACT=false` when symbols are needed.

## Verify

Load the local development credentials without printing them, then run the canary with the metadata created above:

```bash
set -a
source <(sudo cat /etc/cubesandbox/auth.env)
set +a
export E2B_API_KEY="${CUBESANDBOX_FULL_KEY}"
export E2B_API_URL=http://127.0.0.1:3000
export E2B_DOMAIN=cube.app
export E2B_VALIDATE_API_KEY=false
export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/mkcert_development_CA_246626769331356599751110303311906475686.crt
unset CUBESANDBOX_FULL_KEY CUBESANDBOX_READONLY_KEY CUBESANDBOX_API_KEY

node e2b/scripts/verify-template.mjs e2b/.artifacts/templates/<build_id>.json
```

The canary checks the revision and binary checksum, starts `codex exec-server` on port `22101`, executes a process over its WSS protocol, and kills the sandbox. Success ends with `"verified": true`.

Run the lifecycle, recovery, and child-isolation canary with the same environment:

```bash
node e2b/scripts/live-lifecycle-canary.mjs <template_id>
```

The external TypeScript control plane is under `e2b/src`. Build and run its
provider-independent contract/failure suite with `npm test --prefix e2b`. Runtime
configuration is supplied through `HOSTED_AGENT_*`; see `e2b/src/main.ts` for the
small required set. Architecture results and remaining production work are in
[`../ARCHIVE.md`](../ARCHIVE.md) and [`../TODO.md`](../TODO.md).

## Overrides

- `CODEX_BUILD_TARGET`, `CODEX_BUILD_PROFILE`, `CODEX_ARTIFACT_DIR`: artifact build settings.
- `CODEX_BUILD_ID`: select an existing artifact explicitly.
- `CUBE_BASE_IMAGE`: CubeSandbox/envd base image; default `cubesandbox-codex:0.1.0`.
- `CUBE_IMAGE_REF`: registry and image tag.
- `CUBE_PUSH_IMAGE=0`: build without pushing.
- `CUBE_IMAGE_METADATA`: image metadata used for publishing.
- `CUBE_WRITABLE_LAYER_SIZE`: writable sandbox disk; default `20Gi`.

The template exposes envd on `49983` and Codex on `22101`. The backend must start `codex exec-server --listen ws://0.0.0.0:22101` after sandbox creation; it is intentionally not an image entrypoint.

## Remove a development template

```bash
sudo cubemastercli tpl delete --template-id <template_id>
```

This setup assumes the current trusted private development network. Revisit credentials, TLS, network exposure, and sandbox policy before using it in another environment.
