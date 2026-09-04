#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postgresql-backup-lib.sh
source "$SCRIPT_DIR/postgresql-backup-lib.sh"

(( $# == 2 )) || cassav6_die "uso: restore-postgresql-wal.sh <nome-wal> <destinazione>"
wal_name="$1"
destination="$2"
[[ "$wal_name" =~ ^([0-9A-F]{24}(\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$ ]] || exit 1
cassav6_assert_backup_tree
source_path="$CASSAV6_BACKUP_ROOT/wal/$wal_name"
[[ -f "$source_path" && ! -L "$source_path" ]] || exit 1
install -m 0600 -- "$source_path" "$destination"
