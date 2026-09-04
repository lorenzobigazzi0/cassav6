#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a
# shellcheck disable=SC1091
source "$ROOT/configs/canary-multiprocess.env.example"
set +a
node scripts/check-release-clean.mjs --warn-only .
node scripts/print-runtime-profile.mjs --profile canary-multiprocess --root "$ROOT"
if [[ -x ../tools/restart-v5bt-linux.sh ]]; then
  exec ../tools/restart-v5bt-linux.sh
fi
exec npm run dev:backend
