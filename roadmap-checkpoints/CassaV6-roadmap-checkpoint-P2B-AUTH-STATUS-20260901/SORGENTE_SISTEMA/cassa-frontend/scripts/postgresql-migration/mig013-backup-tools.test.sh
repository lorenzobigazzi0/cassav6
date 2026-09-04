#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d /tmp/cassav6-mig013-test.XXXXXX)"
cleanup() { rm -rf --one-file-system -- "$test_root"; }
trap cleanup EXIT

export CASSAV6_BACKUP_ROOT="$test_root/managed/cassav6-postgresql"
# shellcheck source=postgresql-backup-lib.sh
source "$SCRIPT_DIR/postgresql-backup-lib.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_fails() {
  if ( "$@" ) >/dev/null 2>&1; then
    fail "il comando doveva fallire: $*"
  fi
}

cassav6_require_root
cassav6_is_safe_identifier cassav6_test || fail "identificatore valido rifiutato"
assert_fails cassav6_require_identifier test 'Cassav6-unsafe'
assert_fails cassav6_normalize_backup_root /var/backups

cassav6_prepare_backup_tree
[[ "$(<"$CASSAV6_BACKUP_ROOT/$CASSAV6_BACKUP_MARKER")" == "$CASSAV6_BACKUP_MARKER_CONTENT" ]] || fail "marker non creato"

for stamp in 20260828T010101Z 20260829T010101Z 20260830T010101Z 20260831T010101Z; do
  artifact="$CASSAV6_BACKUP_ROOT/logical/logical-cassav6_test-${stamp}.dump"
  printf '%s\n' "$stamp" > "$artifact"
  cassav6_write_sha256_sidecar "$artifact" "${artifact}.sha256" >/dev/null
  printf '{}\n' > "${artifact%.dump}.json"
done
printf 'preservare\n' > "$CASSAV6_BACKUP_ROOT/logical/unrelated.txt"
cassav6_prune_logical_backups cassav6_test 2
[[ "$(find "$CASSAV6_BACKUP_ROOT/logical" -maxdepth 1 -type f -name 'logical-cassav6_test-*.dump' | wc -l)" == "2" ]] || fail "retention logica errata"
[[ -f "$CASSAV6_BACKUP_ROOT/logical/unrelated.txt" ]] || fail "retention ha eliminato un file non gestito"

wal_source="$test_root/source-wal"
printf 'wal-one\n' > "$wal_source"
valid_wal="000000010000000000000001"
"$SCRIPT_DIR/archive-postgresql-wal.sh" "$wal_source" "$valid_wal"
"$SCRIPT_DIR/archive-postgresql-wal.sh" "$wal_source" "$valid_wal"
[[ "$(<"$CASSAV6_BACKUP_ROOT/wal/$valid_wal")" == "wal-one" ]] || fail "WAL non archiviato"
printf 'wal-two\n' > "$wal_source"
assert_fails "$SCRIPT_DIR/archive-postgresql-wal.sh" "$wal_source" "$valid_wal"
assert_fails "$SCRIPT_DIR/archive-postgresql-wal.sh" "$wal_source" '../../unsafe'

restore_target="$test_root/restored-wal"
"$SCRIPT_DIR/restore-postgresql-wal.sh" "$valid_wal" "$restore_target"
[[ "$(<"$restore_target")" == "wal-one" ]] || fail "WAL non ripristinato"

echo "PASS: policy percorsi, retention e archivio WAL MIG-013"
