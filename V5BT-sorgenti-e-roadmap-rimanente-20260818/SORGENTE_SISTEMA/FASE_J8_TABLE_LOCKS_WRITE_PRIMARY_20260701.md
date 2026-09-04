# FASE J8 - tableLocks write-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare `POST /api/tables/lock/acquire`, `heartbeat`, `release` e `force-release` nel percorso write-primary relazionale, mantenendo app-state JSON come mirror compatibile.

## Modifiche

- Aggiunta migration `013_table_locks_revision` per introdurre `table_locks.revision`.
- Aggiunto flag `BACKEND_RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY=1`.
- Agganciato alias rollout `TABLES_RELATIONAL_WRITE_PRIMARY=1`.
- Aggiunto `createRelationalTableLockCoordinator` per gestire acquire/heartbeat/release dal relazionale.
- Aggiunti metodi `TablesBillsRelationalRepository.acquireTableLock` e `releaseTableLock`.
- Il lock relazionale usa `expires_at`, ownership `userId/deviceUuid/sessionId`, `purpose`, audit e incremento `revision`.
- Il mirror app-state aggiorna `table.workLock` per compatibilita' con frontend e API legacy.
- Il percorso legacy resta invariato quando il flag e' spento.

## Guardrail

- DB relazionale non disponibile: risposta chiara `503`.
- Tavolo assente: `404`.
- Lock concorrente attivo: `409` con code `TABLE_LOCKED`.
- Release da altro utente/device: `403`.
- Force release vincolato agli stessi permessi legacy (`manage_tables`, `approve_room_change`, `manage_settings`, admin).
- `backend/server.js` resta a 40497 righe, sotto il budget architetturale 40500.

## Test eseguiti

- `node --check` su server, repository, dominio table lock e test J8: OK.
- `node --test cassa-frontend/backend/tests/relational-table-locks-write-primary.test.mjs`: 4/4 OK.
- `node --test cassa-frontend/backend/tests/relational-tables-bills.test.mjs`: 11/11 OK.
- `node --test cassa-frontend/backend/tests/tables-locks.e2e.test.mjs`: 6/6 OK.
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 12/12 OK.
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Stato

Fase J8 completata. Il sotto-dominio `tableLocks` ora ha lease write-primary relazionale con revision/CAS incrementale e mirror app-state. Il prossimo passo naturale della Fase J e' spostare una mutazione tavoli isolata (`table.move` o `room.change`) sul relazionale, usando questi lock come guardrail.
