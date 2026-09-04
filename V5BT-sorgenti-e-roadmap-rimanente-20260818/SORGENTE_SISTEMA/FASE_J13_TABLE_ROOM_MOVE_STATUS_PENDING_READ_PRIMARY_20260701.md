# FASE J13 - table-room-move/status e pending read-primary relazionale

Data: 2026-07-01

## Obiettivo

Portare le letture operative di `table-room-move/status` e `table-room-move/pending` sul relazionale quando `BACKEND_RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY=1` e' attivo, mantenendo compatibilita' con mirror app-state e timeout automatici.

## Modifiche

- `POST /api/integration/layout/table/room-move/status` legge la richiesta da `table_room_move_requests` quando la write-primary relazionale e' attiva.
- Il record relazionale viene sincronizzato nel mirror in memoria prima della logica di timeout, cosi' l'auto-approvazione puo' continuare a usare il percorso esistente.
- `POST /api/integration/layout/table/room-move/pending` usa `ReservationsRelationalRepository.listTableRoomMoveRequests({ targetRoomId, status: "pending" })`.
- Il filtro per utente richiedente resta applicato lato backend, cosi' il mittente non vede la propria richiesta tra le pending da approvare.
- Non sono state aggiunte migrazioni: schema e repository avevano gia' campi e indici necessari.

## Guardrail

- DB relazionale richiesto ma non disponibile: risposta `503` chiara.
- Se il record relazionale manca, il mirror app-state resta fallback compatibile per richieste legacy.
- La response pubblica continua a usare `buildPosTableRoomMoveResponse`, senza esporre campi interni non previsti.
- `backend/server.js` resta a 40498 righe, sotto il budget architetturale 40500.

## Test eseguiti

- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js`: OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/relational-table-room-move-request-write-primary.test.mjs`: OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/relational-table-room-move-request-write-primary.test.mjs`: 4/4 OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/table-room-move-domain.test.mjs cassa-frontend/backend/tests/relational-room-change-request-write-primary.test.mjs`: 13/13 OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/relational-reservations.test.mjs cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 18/18 OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs`: 8/8 OK.
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.

## Stato

Fase J13 completata. Il prossimo passo naturale e' portare `table-room-move/resolve` su write-primary relazionale, cosi' approvazione/rifiuto chiudono il ciclo sul DB relazionale invece di dipendere dal solo app-state.
