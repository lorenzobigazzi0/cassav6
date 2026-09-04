#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Eseguire come root sul Raspberry." >&2
  exit 1
fi
if [[ "${MIG024_ALLOW_DEV_APPLY:-}" != "1" ]]; then
  echo "Impostare MIG024_ALLOW_DEV_APPLY=1 per aggiornare il database DEV." >&2
  exit 2
fi

RUN_DIR="${1:-}"
MIGRATION_ENV="/etc/cassav6/postgresql-migration.env"
if [[ -z "$RUN_DIR" || ! -d "$RUN_DIR" || ! -r "$MIGRATION_ENV" ]]; then
  echo "Staging o configurazione migration non validi." >&2
  exit 3
fi

set -a
# shellcheck disable=SC1090
source "$MIGRATION_ENV"
set +a

if [[ "${POSTGRES_DATABASE:-}" != "cassav6" ]]; then
  echo "MIG-024 DEV apply consentito soltanto sul database cassav6." >&2
  exit 4
fi

node "$RUN_DIR/backend/scripts/migrate-postgresql.mjs"
node "$RUN_DIR/backend/scripts/migrate-postgresql.mjs"

