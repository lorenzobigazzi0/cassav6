#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a
# shellcheck disable=SC1091
source "$ROOT/configs/near-realtime.env.example"
set +a
node scripts/check-release-clean.mjs --warn-only .
node scripts/print-runtime-profile.mjs --profile near-realtime --root "$ROOT"
exec npm run dev:backend
