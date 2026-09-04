# FASE J9 - table/move write-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare `POST /api/integration/layout/table/move` nel percorso write-primary relazionale per lo stato tavoli, usando i lock relazionali completati in J8 come guardrail.

## Modifiche

- Aggiunta migration `014_table_states_revision` per introdurre `table_states.revision`.
- Aggiunto flag `BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY=1`.
- Agganciato alias rollout `TABLES_RELATIONAL_WRITE_PRIMARY=1`.
- `normalizePosTable` preserva `revision/currentRevision`.
- Lo spostamento tavolo incrementa la revision del tavolo sorgente e del tavolo destinazione.
- Aggiunto `TablesBillsRelationalRepository.replaceTablesFromAppState` per sostituire solo i tavoli coinvolti, con controllo revision opzionale.
- Il write-primary relazionale viene eseguito prima del write app-state; il mirror JSON resta coerente e cancella i lock source/target.
- Il percorso legacy resta invariato quando il flag e' spento.

## Guardrail

- DB relazionale non disponibile: risposta chiara `503`.
- Conflitto revision: `409` con code `TABLE_REVISION_CONFLICT`.
- Source/target continuano a richiedere lock attivi `table.move_source` e `table.move_target`.
- I lock dei due tavoli vengono rimossi dal mirror e dal relazionale dopo lo spostamento.
- `backend/server.js` resta a 40495 righe, sotto il budget architetturale 40500.

## Test eseguiti

- `node --check` su server, repository e test J9: OK.
- `node --test cassa-frontend/backend/tests/relational-table-move-write-primary.test.mjs`: 1/1 OK.
- `node --test cassa-frontend/backend/tests/relational-table-locks-write-primary.test.mjs`: 4/4 OK.
- `node --test cassa-frontend/backend/tests/table-structure-updates.e2e.test.mjs`: 5/5 OK.
- `node --test cassa-frontend/backend/tests/relational-tables-bills.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 23/23 OK.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.
- `node --test cassa-frontend/backend/tests/relational-migration-script.test.mjs`: 6/6 OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Stato

Fase J9 completata. `table/move` ora aggiorna `table_states` in write-primary relazionale con revision incrementale e mirror app-state coerente. Il prossimo passo naturale della Fase J e' portare le richieste `room-change`/`table-room-move-request` sul relazionale, per chiudere anche la parte autorizzativa dello spostamento tra sale.
