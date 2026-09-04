# FASE K-PRE.3 - Transactional outbox contract

Data: 2026-07-02

## Obiettivo

Definire un contratto unico per scrivere la modifica di dominio e l'evento `event_outbox` nello stesso commit relazionale, da riusare nelle sotto-fasi K4-K7.

## Modifiche eseguite

File aggiornati:

- `cassa-frontend/backend/db/relational/realtime-backbone.repo.js`
- `cassa-frontend/backend/db/relational/index.js`
- `cassa-frontend/backend/tests/realtime-backbone.test.mjs`

Dettaglio:

- Aggiunto `withTransactionalOutboxEvent(connection, { paymentWrite, outboxEvent, nowIso })`.
- Il callback `paymentWrite` viene eseguito dentro la stessa transazione dell'insert in `event_outbox`.
- `outboxEvent` puo' essere un oggetto o una funzione derivata dal risultato della scrittura di dominio.
- Se fallisce l'insert outbox, la scrittura di dominio viene rollbackata.
- `EventOutboxRepository.enqueue` riusa lo stesso helper interno di insert outbox, mantenendo il comportamento esistente allineato al nuovo contratto.
- Esportato `withTransactionalOutboxEvent` da `backend/db/relational/index.js`.

## Test aggiunti

In `backend/tests/realtime-backbone.test.mjs`:

- Successo: scrittura dominio + outbox nello stesso commit.
- Rollback richiesto dalla DoD: trigger SQLite che forza il fallimento dell'insert outbox dopo la scrittura di dominio; verifica che la riga di dominio e la riga outbox siano entrambe assenti.

## Verifiche eseguite

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/db/relational/realtime-backbone.repo.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/db/relational/index.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/realtime-backbone.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-backbone.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-event-outbox.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs
```

Risultati:

- `realtime-backbone.test.mjs`: 9/9 verdi.
- `realtime-event-outbox.e2e.test.mjs`: 4/4 verdi.
- `architecture-line-budget.test.mjs`: 1/1 verde.
- `backend/server.js`: 37931 righe, sotto budget.

## Esito

K-PRE.3 completata.

Addendum K-PRE.3.3:

- Decisione documentata in `FASE_KPRE3_3_PAYMENT_STATUS_RETROFIT_DECISION_20260702.md`.
- Il retrofit del publish `payment.status` esistente viene rimandato a K4-K6, endpoint per endpoint, per evitare di mescolare ora app-state legacy e transazione relazionale write-primary.

STOP/REVIEW: rispettato. Il prossimo step della roadmap e' K-PRE.4.
