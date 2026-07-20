#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --release <shared-release.json>" >&2
  exit 2
}

[[ $# -eq 2 && "$1" == "--release" ]] || usage
release_path="$(realpath -- "$2")"
[[ -f "${release_path}" && ! -L "${release_path}" && "$(basename -- "${release_path}")" == "release.json" ]] || {
  echo "shared release.json is missing or unsafe" >&2
  exit 2
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
e2b_dir="$(cd -- "${script_dir}/.." && pwd)"
repository_root="$(cd -- "${e2b_dir}/.." && pwd)"
revision="$(git -C "${repository_root}" rev-parse HEAD)"
[[ "${revision}" =~ ^[0-9a-f]{40}$ ]] || { echo "Cudex revision is unavailable" >&2; exit 2; }

node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 22 )) || { echo "Cudex requires Node.js 22 or newer" >&2; exit 2; }

npm run build --prefix "${e2b_dir}"
node "${e2b_dir}/scripts/verify-cudex-release.mjs" "${release_path}" "${revision}"

data_root="${XDG_DATA_HOME:-${HOME}/.local/share}"
bin_root="${XDG_BIN_HOME:-${HOME}/.local/bin}"
install_root="${data_root}/cudex/cli"
target="${install_root}/${revision}"
mkdir -p -- "${install_root}" "${bin_root}"
chmod 700 "${install_root}"
temporary="$(mktemp -d "${install_root}/.install-${revision}.XXXXXX")"
cleanup() { rm -rf -- "${temporary}"; }
trap cleanup EXIT

cp -a -- "${e2b_dir}/bin" "${e2b_dir}/dist" "${e2b_dir}/migrations" \
  "${e2b_dir}/scripts" "${e2b_dir}/package.json" "${e2b_dir}/package-lock.json" "${temporary}/"
mkdir -- "${temporary}/poc"
cp -a -- "${e2b_dir}/poc/compose.yaml" "${e2b_dir}/poc/garage.toml.template" \
  "${e2b_dir}/poc/fixture" "${e2b_dir}/poc/prompts" "${temporary}/poc/"
printf '{"revision":"%s"}\n' "${revision}" > "${temporary}/cudex-build.json"
npm ci --omit=dev --ignore-scripts --prefix "${temporary}"
chmod 755 "${temporary}/bin/cudex"

if [[ -e "${target}" ]]; then
  rm -rf -- "${temporary}"
else
  mv -- "${temporary}" "${target}"
fi
trap - EXIT

link_tmp="${install_root}/.current-${revision}"
ln -s -- "${target}" "${link_tmp}"
mv -Tf -- "${link_tmp}" "${install_root}/current"
ln -sfn -- "${install_root}/current/bin/cudex" "${bin_root}/cudex"

echo "Installed cudex at ${bin_root}/cudex"
echo "Next: cudex setup --release ${release_path}"
