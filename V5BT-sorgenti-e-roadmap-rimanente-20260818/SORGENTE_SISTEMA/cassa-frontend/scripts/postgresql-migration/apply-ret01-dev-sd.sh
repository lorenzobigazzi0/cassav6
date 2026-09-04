#!/usr/bin/env bash
# RET-01: applica la migration 007 al PostgreSQL DEV su microSD.
#
# La 007 approva le otto finestre di retention proposte da MIG-026 e non attiva
# nulla: le policy restano `enabled=false` e le cinque legalmente protette non
# vengono toccate. La migration porta postcondizioni proprie che falliscono con
# SQLSTATE 55000 se una di queste condizioni non regge.
#
# Stessa forma di apply-mig026-dev-sd.sh: root, opt-in esplicito, runner
# eseguito due volte per dimostrare l'idempotenza.
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Eseguire come root sul Raspberry." >&2
  exit 1
fi
if [[ "${RET01_ALLOW_DEV_APPLY:-}" != "1" ]]; then
  echo "Impostare RET01_ALLOW_DEV_APPLY=1 per aggiornare il database DEV." >&2
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
  echo "RET-01 DEV apply consentito soltanto sul database cassav6." >&2
  exit 4
fi

node "$RUN_DIR/backend/scripts/migrate-postgresql.mjs"
node "$RUN_DIR/backend/scripts/migrate-postgresql.mjs"

# Le postcondizioni usano le stesse credenziali del runner: senza -h/-U psql
# proverebbe il socket locale come root, che non e un ruolo del database.
PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 \
  -h "${POSTGRES_HOST:-127.0.0.1}" \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DATABASE" \
  -f "$RUN_DIR/scripts/postgresql-migration/ret01-postconditions.sql"
