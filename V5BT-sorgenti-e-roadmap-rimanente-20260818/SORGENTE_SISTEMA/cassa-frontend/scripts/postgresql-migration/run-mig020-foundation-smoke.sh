#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Eseguire come root (sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
database=""
verify_only=0

while (( $# > 0 )); do
  case "$1" in
    --database)
      (( $# >= 2 )) || { echo "--database richiede un valore." >&2; exit 2; }
      database="$2"
      shift 2
      ;;
    --verify-only)
      verify_only=1
      shift
      ;;
    *)
      echo "Argomento sconosciuto: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! "$database" =~ ^[a-z_][a-z0-9_]*$ || ${#database} -gt 63 ]]; then
  echo "Nome database non valido." >&2
  exit 2
fi
if (( verify_only == 0 )) && [[ ! "$database" =~ ^cassav6_mig020_smoke_[a-z0-9_]+$ ]]; then
  echo "Lo smoke mutativo e consentito solo su un database cassav6_mig020_smoke_* dedicato." >&2
  exit 2
fi
if (( verify_only == 1 )) && [[ "$database" != "cassav6" && ! "$database" =~ ^cassav6_mig020_smoke_[a-z0-9_]+$ ]]; then
  echo "La verifica e consentita solo sul database DEV cassav6 o su un database smoke dedicato." >&2
  exit 2
fi

migration_env="/etc/cassav6/postgresql-migration.env"
app_env="/etc/cassav6/postgresql-app.env"
[[ -f "$migration_env" && ! -L "$migration_env" ]] || { echo "Environment migration non valido." >&2; exit 3; }
[[ -f "$app_env" && ! -L "$app_env" ]] || { echo "Environment app non valido." >&2; exit 3; }

set -a
# File creato e protetto dal provisioning CassaV6.
# shellcheck disable=SC1090
source "$migration_env"
set +a

MIG020_APP_USER="$(sed -n 's/^POSTGRES_USER=//p' "$app_env" | tail -n 1)"
MIG020_APP_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$app_env" | tail -n 1)"
MIG020_RUNTIME_ROLE="$(sed -n 's/^POSTGRES_RUNTIME_ROLE=//p' "$app_env" | tail -n 1)"
[[ -n "$MIG020_APP_USER" && -n "$MIG020_APP_PASSWORD" && -n "$MIG020_RUNTIME_ROLE" ]] || {
  echo "Configurazione app incompleta." >&2
  exit 3
}

export POSTGRES_DATABASE="$database"
export MIG020_APP_USER MIG020_APP_PASSWORD MIG020_RUNTIME_ROLE

args=()
(( verify_only == 0 )) || args+=(--verify-only)
exec node "$SCRIPT_DIR/mig020-foundation-smoke.mjs" "${args[@]}"
