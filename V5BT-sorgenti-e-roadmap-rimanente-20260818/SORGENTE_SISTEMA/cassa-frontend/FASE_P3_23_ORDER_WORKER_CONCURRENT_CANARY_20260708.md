# FASE P3.23 - Order Worker Concurrent Canary

Data: 2026-07-08
Target: Raspberry `192.168.0.67`
Percorso deploy: `/opt/cassav4/current/cassa-frontend`

## Obiettivo

Validare il canary e2e concorrente su order workflow multi-processo senza usare I/O reale di stampa, fiscale o cassa automatica.

Flag/condizioni operative:

- `PRINTING_ENABLED=0`
- route attese su `api-worker`
- cleanup obbligatorio
- tavoli canary distribuiti su `room_gazebo_t03` ... `room_gazebo_t24`

## Problema trovato

Il batch C2 era passato, ma il primo C3 ha fallito 2 run su 27:

- una cleanup ha risposto `401` e risultava su ruolo `api-owner`
- una create ha risposto `401` con `Sessione login non valida o scaduta`
- e' rimasto un ordine canary attivo: `orders:00698` su `room_gazebo_t19`

Diagnosi: la route policy rinfrescava le sessioni esternalizzate, ma alcuni handler order/lock rivalidavano il payload contro un `db` letto da cache/app-state senza `refreshExternalizedSessions`. Sotto concorrenza login -> api-worker questo poteva produrre una sessione valida in policy ma assente nel secondo controllo handler.

## Fix applicato

Aggiornato `backend/server.js`:

- `handleIntegrationOrderCreate`
- `handleIntegrationOrderSync`
- `handleIntegrationOrderCancel`
- `handleIntegrationOrderLineSplit`
- `handleIntegrationOrderLinePriceOverride`
- `handleIntegrationOrderComp`
- `handleIntegrationOrderCorrection`
- `handleTableLockAcquire`
- `handleTableLockHeartbeat`
- `handleTableLockRelease`
- `handleTableLockForceRelease`

I percorsi ora:

- leggono `refreshExternalizedSessions: true` prima di validare in handler
- mantengono `refreshExternalizedTableLocks: true` dove serve il lock tavolo
- riusano `req.__authContext` se la route policy ha gia validato la sessione

Aggiornato `backend/tests/route-policy-architecture.test.mjs` con un gate statico per evitare regressioni su sessioni stale nei worker.

## Verifiche locali

Comandi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-name-pattern "multiprocess order sync refreshes|order posSettings fast-path|table locks and order workflow|MP-4au" backend/tests/route-policy-architecture.test.mjs
```

Esito: 4/4 passati.

Nota: la suite completa `route-policy-architecture` ha ancora fallimenti non chiusi in questo step, tra cui budget monolite `server.js` e alcune regex/debiti architetturali gia presenti. Non sono stati trattati per non allargare lo scope del fix C3.

## Deploy e verifiche target

File copiati su target:

- `backend/server.js`
- `backend/tests/route-policy-architecture.test.mjs`

Servizi riavviati:

- `cassav4-backend`
- `cassav4-api-worker@5283`
- `cassav4-api-worker@5284`

Health:

- servizi backend/frontend/realtime attivi
- `/api/health` su `https://127.0.0.1:5280` OK
- log owner: `STAMPA DISABILITATA`
- log fiscale: I/O reale disabilitato per test

Pulizia residui pre-fix:

- `orders:00698` annullato via API cleanup
- canary attivi dopo cleanup: `0`
- lock gazebo dopo cleanup: `0`

## Canary C2 precedente

Run: `order_worker_batch_p3_23_c2_24x_20260708`

- esito: PASS
- ok: 24/24
- create p95: 919.25 ms
- sync p95: 661.63 ms
- readback p95: 441.49 ms
- cleanup p95: 776.97 ms
- ruoli: tutti `api-worker`
- residui: 0 lock / 0 ordini canary attivi

## Canary C3 post-fix

Run: `order_worker_batch_p3_23_c3_27x_fix_20260708`

Report target:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-order_worker_batch_p3_23_c3_27x_fix_20260708/REPORT.md`

Risultato:

| Runs | OK | Failed | Create p95 | Sync p95 | Readback p95 | Cleanup p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 27 | 27 | 0 | 1624.63 ms | 1090.61 ms | 770.25 ms | 825.22 ms |

Ruoli:

- create: `api-worker` 27/27
- sync: `api-worker` 27/27
- readback: `api-worker` 27/27
- cleanup: `api-worker` 27/27

Residui dopo run:

- canary attivi: `0`
- lock gazebo: `0`

Log post-run:

- nessun nuovo `401`
- nessun nuovo `Sessione login non valida`
- nessun nuovo timeout lock MySQL nel periodo del C3 post-fix

## Esito

Gate P3.23 C3 verde per la regressione sessione/lock:

- eliminato il 401 intermittente login/sessione sotto concorrenza 3
- cleanup tornato su `api-worker`
- nessun ordine canary o lock lasciato in stato sporco

Resta da proseguire con il prossimo step roadmap sulle latenze residue: il p95 create C3 resta oltre 1.5s, quindi il collo principale e' ancora performance/coda, non piu consistenza sessione.
