#!/usr/bin/env sh
set -eu

grep -Fx 'owner-spawn-state' state.txt >/dev/null
grep -Fx 'child-saw-owner-spawn-state' child-result.txt >/dev/null
grep -Fx 'hosted-child-complete' src/message.txt >/dev/null
