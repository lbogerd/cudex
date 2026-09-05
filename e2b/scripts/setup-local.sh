#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
e2b_dir=$(cd -- "${script_dir}/.." && pwd)
if [[ "${1:-}" == --help ]]; then
  echo 'Usage: bash e2b/scripts/setup-local.sh [--build-id <id>]'
  echo 'Uses poc/.env (or CUDEX_* connection overrides), publishes a missing template,'
  echo 'packages a matching clean build, installs cudex, and verifies the installation.'
  exit 0
fi
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
  echo 'Local setup requires Linux x86_64' >&2; exit 1;
}
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
  echo 'Local setup requires Node.js 22 or newer' >&2; exit 1;
}
npm ci --prefix "${e2b_dir}"
npm run build --prefix "${e2b_dir}"
exec node "${e2b_dir}/dist/src/commands/setup-local.js" "$@"
