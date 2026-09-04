#!/usr/bin/env bash
# REV2 2026-08-31 — Gate statico finale contro i residui legacy nel runtime.
# Vedi 10_LEGACY_DECOMMISSION.md.
set -euo pipefail

ROOT="${1:-.}"
BACKEND="$ROOT/backend"
if [[ ! -d "$BACKEND" ]]; then BACKEND="$ROOT"; fi

# REV2: verifica dello strumento invece di fallire silenziosamente.
if command -v rg >/dev/null 2>&1; then
  SEARCH="rg"
elif command -v grep >/dev/null 2>&1; then
  SEARCH="grep"
  echo "[warn] ripgrep non trovato, uso grep (piu lento, esclusioni approssimate)"
else
  echo "[FAIL] ne rg ne grep disponibili: il gate non puo essere eseguito"
  exit 2
fi

FAIL=0

run_search() {
  local pattern="$1"
  if [[ "$SEARCH" == "rg" ]]; then
    rg -n "$pattern" "$BACKEND" \
      --glob '!**/tests/**' \
      --glob '!**/*.test.js' \
      --glob '!**/*.test.mjs' \
      --glob '!**/tools/legacy-import/**' \
      --glob '!**/node_modules/**' \
      --glob '!**/*.md' 2>/dev/null || true
  else
    grep -rnE "$pattern" "$BACKEND" \
      --exclude-dir=tests --exclude-dir=node_modules --exclude-dir=legacy-import \
      --exclude='*.test.js' --exclude='*.test.mjs' --exclude='*.md' 2>/dev/null || true
  fi
}

check() {
  local label="$1" pattern="$2"
  local out
  out=$(run_search "$pattern")
  if [[ -n "$out" ]]; then
    echo "[FAIL] $label"
    echo "$out" | head -40
    local n
    n=$(echo "$out" | wc -l)
    if (( n > 40 )); then echo "  ... e altre $((n - 40)) occorrenze"; fi
    FAIL=1
  else
    echo "[OK]   $label"
  fi
}

echo "=== Gate legacy runtime su: $BACKEND ==="

# \b evita falsi positivi su identificatori che contengono il nome (es. readDbPool).
check 'readDb runtime'          '\breadDb\('
check 'writeDb runtime'         '\bwriteDb\('
check 'node:sqlite runtime'     'node:sqlite'
check 'mysql2 runtime'          'from ["'"'"']mysql2|require\(["'"'"']mysql2'
check 'app_state SQL runtime'   '\bapp_state\b|\bapp_state_domain_records\b'
check 'app-state repositories'  'app-state/.*\.repository'
check 'split state runtime'     'app-state-split|backend-relational\.sqlite'

# REV2: Redis e fuori perimetro. Se compare nel runtime, e stato introdotto
# senza attraversare un gate (vedi ANNEX_A_FUORI_PERIMETRO.md A.3 e RED-01).
check 'redis client runtime'    'from ["'"'"'](redis|ioredis)["'"'"']|require\(["'"'"'](redis|ioredis)["'"'"']'

# REV2: feature flag di transizione che devono sparire al decommission.
check 'flag di transizione'     'BACKEND_RELATIONAL_(ENABLED|MODE|PRIMARY_DOMAINS|WRITE_PRIMARY_DOMAINS)|_WRITE_PRIMARY\b'

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "Gate NON superato. Gli unici match ammessi sono documentazione e tool"
  echo "offline in tools/legacy-import/ esplicitamente allowlisted."
  exit 1
fi
echo "Legacy runtime gate passed."
