# FASE J14 - table-room-move/resolve write-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare `POST /api/integration/layout/table/room-move/resolve` in write-primary relazionale, cosi' approvazione e rifiuto delle richieste di spostamento tavolo tra sale chiudono il ciclo su `table_room_move_requests`.

## Modifiche

- Aggiunto `ReservationsRelationalRepository.resolveTableRoomMoveRequest`.
- Il resolve relazionale aggiorna solo richieste `pending`, imposta `approved`/`rejected`, timestamp, operatore risolutore e incrementa `revision`.
- Il mapping accetta sia `resolvedBy*` sia `approver*`, evitando che la shadow sync perda l'operatore dopo `writeRoomDb`.
- `handleIntegrationLayoutTableRoomMoveResolve` rilegge il record relazionale, lo sincronizza nel mirror e poi risolve sul repository quando `BACKEND_RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY=1`.
- Il mirror app-state resta aggiornato per notifiche, SSE e compatibilita' dei client esistenti.
- Aggiunti test J14 per approvazione e rifiuto con verifica di riga relazionale, raw JSON e mirror app-state.

## Guardrail

- DB relazionale non disponibile: `503` chiaro.
- Record relazionale mancante/non aggiornabile: errore esplicito senza fallback silenzioso.
- Richieste gia' non pending restano idempotenti nella response pubblica.
- `backend/server.js` resta a 40496 righe, sotto il budget architetturale 40500.

## Test eseguiti

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/db/relational/reservations.repo.js`: OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js`: OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/relational-table-room-move-request-write-primary.test.mjs`: OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/relational-table-room-move-request-write-primary.test.mjs`: 6/6 OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/table-room-move-domain.test.mjs cassa-frontend/backend/tests/relational-room-change-request-write-primary.test.mjs`: 13/13 OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 18/18 OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 9/9 OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/relational-shadow.test.mjs`: 53/53 OK.

## Stato

Fase J14 completata. Il ciclo `table-room-move` ora copre request, status, pending e resolve sul percorso relazionale. Il prossimo passo naturale e' fare il mini-check di chiusura Fase J e individuare eventuali endpoint tavoli/prenotazioni rimasti su app-state prima di passare alla Fase K pagamenti/fiscale.
