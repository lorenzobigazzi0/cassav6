#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postgresql-backup-lib.sh
source "$SCRIPT_DIR/postgresql-backup-lib.sh"

(( $# == 2 )) || cassav6_die "uso: archive-postgresql-wal.sh <percorso-wal> <nome-wal>"
source_path="$1"
wal_name="$2"
[[ "$wal_name" =~ ^([0-9A-F]{24}(\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$ ]] || cassav6_die "nome WAL non valido."
[[ -f "$source_path" && ! -L "$source_path" ]] || cassav6_die "sorgente WAL non valida."

cassav6_assert_backup_tree
archive_directory="$(realpath -e -- "$CASSAV6_BACKUP_ROOT/wal")"
destination="$archive_directory/$wal_name"

if [[ -e "$destination" ]]; then
  [[ -f "$destination" && ! -L "$destination" ]] || cassav6_die "destinazione WAL non valida."
  cmp --silent -- "$source_path" "$destination" || cassav6_die "WAL gia presente con contenuto diverso."
  exit 0
fi

temp_path="$(mktemp "$archive_directory/.${wal_name}.XXXXXX")"
cleanup() { rm -f -- "$temp_path"; }
trap cleanup EXIT
install -m 0600 -- "$source_path" "$temp_path"
sync -f "$temp_path"
if ! ln -- "$temp_path" "$destination" 2>/dev/null; then
  [[ -f "$destination" ]] || cassav6_die "pubblicazione WAL fallita."
  cmp --silent -- "$source_path" "$destination" || cassav6_die "WAL concorrente con contenuto diverso."
fi
rm -f -- "$temp_path"
trap - EXIT
