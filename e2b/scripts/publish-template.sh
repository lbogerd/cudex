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

image_metadata=${CUBE_IMAGE_METADATA:-"${e2b_dir}/.artifacts/images/${build_id}.json"}
if [[ ! -f "${image_metadata}" ]]; then
  echo "Missing image metadata ${image_metadata}; run scripts/build-template-image.sh first" >&2
  exit 1
fi
image_ref=$(jq -er '.image' "${image_metadata}")
revision=$(jq -er '.revision' "${image_metadata}")
codex_sha256=$(jq -er '.codexSha256' "${image_metadata}")

writable_layer_size=${CUBE_WRITABLE_LAYER_SIZE:-20Gi}
template_dir="${e2b_dir}/.artifacts/templates"
mkdir -p "${template_dir}"
output_file=$(mktemp /tmp/cudex-template-output.XXXXXX)
watch_file=$(mktemp /tmp/cudex-template-watch.XXXXXX)
trap 'rm -f "${output_file}" "${watch_file}"' EXIT

echo "Publishing CubeSandbox template from ${image_ref}"
sudo cubemastercli tpl create-from-image \
  --image "${image_ref}" \
  --writable-layer-size "${writable_layer_size}" \
  --expose-port 49983 \
  --expose-port 22101 \
  --probe 49983 \
  --probe-path /health \
  --json | tee "${output_file}"

job_id=$(jq -er '.job.job_id' "${output_file}")
template_id=$(jq -er '.job.template_id' "${output_file}")

echo "Waiting for CubeSandbox template ${template_id}"
sudo cubemastercli tpl watch --job-id "${job_id}" --json | tee "${watch_file}"
jq -e '.job.status == "READY" and .job.template_status == "READY"' "${watch_file}" >/dev/null
artifact_id=$(jq -er '.job.artifact_id' "${watch_file}")

jq -n \
  --arg buildId "${build_id}" \
  --arg templateId "${template_id}" \
  --arg jobId "${job_id}" \
  --arg artifactId "${artifact_id}" \
  --arg image "${image_ref}" \
  --arg revision "${revision}" \
  --arg codexSha256 "${codex_sha256}" \
  --arg publishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{buildId: $buildId, templateId: $templateId, jobId: $jobId, artifactId: $artifactId, image: $image, revision: $revision, codexSha256: $codexSha256, publishedAt: $publishedAt}' \
  >"${template_dir}/${build_id}.json"

printf 'template_id=%s\nmetadata=%s\n' "${template_id}" "${template_dir}/${build_id}.json"
