#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a
# shellcheck disable=SC1091
source "$ROOT/configs/rollback-safe.env.example"
set +a
node scripts/print-runtime-profile.mjs --profile rollback-safe --root "$ROOT"
exec npm run dev:backend
