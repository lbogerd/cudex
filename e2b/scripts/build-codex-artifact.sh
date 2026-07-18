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

echo "Building codex (${profile}, ${target}) from ${revision}"
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
    --profile "${profile}" \
    --target "${target}"
)

source_binary="${codex_rs_dir}/target/${target}/${profile}/codex"
if [[ ! -x "${source_binary}" ]]; then
  echo "Expected Codex binary was not produced at ${source_binary}" >&2
  exit 1
fi

install -m 0755 "${source_binary}" "${artifact_dir}/codex"
if [[ "${strip_artifact}" == true ]]; then
  strip_tool=${STRIP:-strip}
  if ! command -v "${strip_tool}" >/dev/null; then
    echo "${strip_tool} is required to strip the distributable artifact" >&2
    exit 1
  fi
  "${strip_tool}" --strip-unneeded "${artifact_dir}/codex"
fi
binary_sha256=$(sha256sum "${artifact_dir}/codex" | awk '{print $1}')
version=$("${artifact_dir}/codex" --version)
build_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
  --arg buildId "${build_id}" \
  --arg revision "${revision}" \
  --argjson dirty "${dirty}" \
  --arg target "${target}" \
  --arg profile "${profile}" \
  --argjson stripped "${strip_artifact}" \
  --arg sha256 "${binary_sha256}" \
  --arg version "${version}" \
  --arg builtAt "${build_time}" \
  '{buildId: $buildId, revision: $revision, dirty: $dirty, target: $target, profile: $profile, stripped: $stripped, sha256: $sha256, version: $version, builtAt: $builtAt}' \
  >"${artifact_dir}/build.json"

printf 'artifact_dir=%s\nbuild_id=%s\nsha256=%s\n' "${artifact_dir}" "${build_id}" "${binary_sha256}"
