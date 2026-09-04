# Fase J0 - Tables/Bills Shadow Equivalence - 2026-07-01

## Obiettivo

Avviare la Fase J della `ROADMAP_REALTIME_CASSAV4_v3.md` dal dominio gia' predisposto: `table_states`, `table_bills` e `table_locks`.

Questa fase mantiene app-state come primary e usa il relazionale in shadow/canary, verificando che tavoli, conti aperti e lock siano equivalenti dopo mutazioni reali.

## Interventi

- Aggiunto guardrail E2E in `orders-payments-invariants.test.mjs`.
- Il nuovo scenario copre:
  - ordine consegnato su tavolo reale;
  - `table-groups/save` con merge tavoli;
  - acquisizione lock tavolo;
  - verifica totale tavolo persistito dopo merge;
  - confronto `tablesBills` app-state vs relazionale.
- Confermato che il fix di `table-groups/save` risincronizza i financials prima del write, quindi il DB letto subito dopo il merge non resta con totale parent a zero.
- `server.js` resta sotto budget architetturale: 40.499 righe.

## Test aggiunti

- `shadow tablesBills coerente dopo lock e table-groups save`
  - crea ordine delivered su `room_sala_t01`;
  - salva gruppo complesso `room_sala_t01 + room_sala_t02`;
  - acquisisce `workLock`;
  - verifica `totalDue` del tavolo;
  - verifica `deviceUuid` del lock;
  - esegue `compareDomain(..., "tablesBills")`.

## Verifica eseguita

- `node --check cassa-frontend/backend/tests/orders-payments-invariants.test.mjs`: OK.
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs`: 17 pass.
- `node --test cassa-frontend/backend/tests/relational-tables-bills.test.mjs`: 11 pass.
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs`: 11 pass.
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs`: 1 pass.

## Stato

J0 e' coperta per `tablesBills` (`table_states`, `table_bills`, `table_locks`).

Restano da aprire in Fase J:
- schema e shadow-equivalenza per prenotazioni (`reservations`, `reservation_locks`, richieste cambio sala/tavolo);
- read-primary mirate su tavoli/lock;
- comando isolato `lock.acquire`;
- CAS/revision e poi write-primary per `room-change`, `table/move`, `reservations/*`.
