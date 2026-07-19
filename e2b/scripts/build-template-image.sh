#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
e2b_dir=$(cd -- "${script_dir}/.." && pwd)
workspace_dir=$(cd -- "${e2b_dir}/.." && pwd)
codex_dir="${workspace_dir}/codex"

short_revision=$(git -C "${codex_dir}" rev-parse --short=12 HEAD)
build_id=${CODEX_BUILD_ID:-${short_revision}}
if ! git -C "${codex_dir}" diff --quiet || ! git -C "${codex_dir}" diff --cached --quiet; then
  build_id=${CODEX_BUILD_ID:-"${short_revision}-dirty"}
fi

artifact_dir=${CODEX_ARTIFACT_DIR:-"${e2b_dir}/.artifacts/codex/${build_id}"}
metadata="${artifact_dir}/build.json"
if [[ ! -x "${artifact_dir}/codex" || ! -x "${artifact_dir}/codex-code-mode-host" || ! -f "${metadata}" ]]; then
  echo "Missing artifact ${artifact_dir}; run scripts/build-codex-artifact.sh first" >&2
  exit 1
fi

revision=$(jq -er '.revision' "${metadata}")
binary_sha256=$(jq -er '.binaries.codex.sha256' "${metadata}")
code_mode_host_sha256=$(jq -er '.binaries["codex-code-mode-host"].sha256' "${metadata}")
actual_sha256=$(sha256sum "${artifact_dir}/codex" | awk '{print $1}')
actual_code_mode_host_sha256=$(sha256sum "${artifact_dir}/codex-code-mode-host" | awk '{print $1}')
if [[ "${binary_sha256}" != "${actual_sha256}" || "${code_mode_host_sha256}" != "${actual_code_mode_host_sha256}" ]]; then
  echo "Artifact checksum does not match build.json" >&2
  exit 1
fi

base_image=${CUBE_BASE_IMAGE:-cubesandbox-codex:0.1.0}
image_ref=${CUBE_IMAGE_REF:-"127.0.0.1:5000/cudex-codex:${build_id}"}
build_dir="${e2b_dir}/template/.build"
image_metadata_dir="${e2b_dir}/.artifacts/images"
mkdir -p "${build_dir}" "${image_metadata_dir}"
install -m 0755 "${artifact_dir}/codex" "${build_dir}/codex"
install -m 0755 "${artifact_dir}/codex-code-mode-host" "${build_dir}/codex-code-mode-host"
install -m 0644 "${metadata}" "${build_dir}/build.json"

sudo docker build \
  --file "${e2b_dir}/template/Dockerfile" \
  --build-arg "BASE_IMAGE=${base_image}" \
  --build-arg "CODEX_REVISION=${revision}" \
  --build-arg "CODEX_BINARY_SHA256=${binary_sha256}" \
  --build-arg "CODEX_CODE_MODE_HOST_SHA256=${code_mode_host_sha256}" \
  --tag "${image_ref}" \
  "${e2b_dir}/template"

if [[ "${CUBE_PUSH_IMAGE:-1}" == 1 ]]; then
  sudo docker push "${image_ref}"
fi

image_digest=$(sudo docker image inspect "${image_ref}" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)
jq -n \
  --arg buildId "${build_id}" \
  --arg image "${image_ref}" \
  --arg imageDigest "${image_digest}" \
  --arg baseImage "${base_image}" \
  --arg revision "${revision}" \
  --arg sha256 "${binary_sha256}" \
  --arg codeModeHostSha256 "${code_mode_host_sha256}" \
  '{buildId: $buildId, image: $image, imageDigest: $imageDigest, baseImage: $baseImage, revision: $revision, codexSha256: $sha256, codeModeHostSha256: $codeModeHostSha256}' \
  >"${image_metadata_dir}/${build_id}.json"

printf 'image=%s\nimage_digest=%s\nmetadata=%s\n' \
  "${image_ref}" "${image_digest}" "${image_metadata_dir}/${build_id}.json"
