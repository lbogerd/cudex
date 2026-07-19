#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
e2b_dir="$(cd -- "${script_dir}/.." && pwd)"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <auth|preflight|up|automated|interactive|status|down>" >&2
  exit 2
fi

npm run build --prefix "${e2b_dir}"
exec node "${e2b_dir}/dist/src/poc-runner.js" "$1"
