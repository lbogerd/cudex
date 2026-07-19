#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
e2b_dir=$(cd -- "${script_dir}/.." && pwd)
workspace_dir=$(cd -- "${e2b_dir}/.." && pwd)
codex_dir="${workspace_dir}/codex"
codex_rs_dir="${codex_dir}/codex-rs"

target=${CODEX_BUILD_TARGET:-x86_64-unknown-linux-musl}
profile=${CODEX_BUILD_PROFILE:-release}
strip_artifact=${CODEX_STRIP_ARTIFACT:-true}
revision=$(git -C "${codex_dir}" rev-parse HEAD)
short_revision=$(git -C "${codex_dir}" rev-parse --short=12 HEAD)
dirty=false
if ! git -C "${codex_dir}" diff --quiet || ! git -C "${codex_dir}" diff --cached --quiet; then
  dirty=true
fi
build_id=${short_revision}
if [[ "${dirty}" == true ]]; then
  build_id="${build_id}-dirty"
fi

artifact_dir=${CODEX_ARTIFACT_DIR:-"${e2b_dir}/.artifacts/codex/${build_id}"}
mkdir -p "${artifact_dir}"

if ! (cd "${codex_rs_dir}" && rustup target list --installed) | grep -Fxq "${target}"; then
  toolchain=$(cd "${codex_rs_dir}" && rustup show active-toolchain | awk '{print $1}')
  echo "Rust target ${target} is not installed; run: rustup target add --toolchain ${toolchain} ${target}" >&2
  exit 1
fi
if [[ "${target}" == *-musl ]] && ! command -v musl-gcc >/dev/null; then
  echo "musl-gcc is required; install the musl-tools package" >&2
  exit 1
fi

echo "Building codex and codex-code-mode-host (${profile}, ${target}) from ${revision}"
v8_env_file=$(mktemp /tmp/cudex-v8-env.XXXXXX)
trap 'rm -f "${v8_env_file}"' EXIT
PYTHONPATH="${codex_dir}/scripts" python3 -c '
import sys
from codex_package.targets import TARGET_SPECS
from codex_package.v8 import resolve_codex_v8_cargo_env

for key, value in (resolve_codex_v8_cargo_env(TARGET_SPECS[sys.argv[1]]) or {}).items():
    print(f"{key}={value}")
' "${target}" >"${v8_env_file}"
while IFS= read -r assignment; do
  export "${assignment}"
done <"${v8_env_file}"

(
  cd "${codex_rs_dir}"
  cargo build \
    --locked \
    --package codex-cli \
    --bin codex \
    --package codex-code-mode-host \
    --bin codex-code-mode-host \
    --profile "${profile}" \
    --target "${target}"
)

for binary in codex codex-code-mode-host; do
  source_binary="${codex_rs_dir}/target/${target}/${profile}/${binary}"
  if [[ ! -x "${source_binary}" ]]; then
    echo "Expected binary was not produced at ${source_binary}" >&2
    exit 1
  fi
  install -m 0755 "${source_binary}" "${artifact_dir}/${binary}"
done
if [[ "${strip_artifact}" == true ]]; then
  strip_tool=${STRIP:-strip}
  if ! command -v "${strip_tool}" >/dev/null; then
    echo "${strip_tool} is required to strip the distributable artifact" >&2
    exit 1
  fi
  "${strip_tool}" --strip-unneeded "${artifact_dir}/codex"
  "${strip_tool}" --strip-unneeded "${artifact_dir}/codex-code-mode-host"
fi
codex_sha256=$(sha256sum "${artifact_dir}/codex" | awk '{print $1}')
code_mode_host_sha256=$(sha256sum "${artifact_dir}/codex-code-mode-host" | awk '{print $1}')
version=$("${artifact_dir}/codex" --version)
build_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
  --arg buildId "${build_id}" \
  --arg revision "${revision}" \
  --argjson dirty "${dirty}" \
  --arg target "${target}" \
  --arg profile "${profile}" \
  --argjson stripped "${strip_artifact}" \
  --arg codexSha256 "${codex_sha256}" \
  --arg codeModeHostSha256 "${code_mode_host_sha256}" \
  --arg version "${version}" \
  --arg builtAt "${build_time}" \
  '{buildId: $buildId, revision: $revision, dirty: $dirty, target: $target, profile: $profile, stripped: $stripped, binaries: {codex: {sha256: $codexSha256, version: $version}, "codex-code-mode-host": {sha256: $codeModeHostSha256}}, builtAt: $builtAt}' \
  >"${artifact_dir}/build.json"

printf 'artifact_dir=%s\nbuild_id=%s\ncodex_sha256=%s\ncode_mode_host_sha256=%s\n' \
  "${artifact_dir}" "${build_id}" "${codex_sha256}" "${code_mode_host_sha256}"
