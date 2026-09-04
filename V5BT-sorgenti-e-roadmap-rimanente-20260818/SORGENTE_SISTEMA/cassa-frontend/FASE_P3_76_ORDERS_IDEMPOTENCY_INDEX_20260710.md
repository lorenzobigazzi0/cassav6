# Fase P3.76 - Indice idempotenza ordini e chiusura gate C3

Data: 2026-07-10
Target: Raspberry `192.168.0.67`
Release: `/opt/cassav4/releases/20260707-test-safe-real-io-223951`

## Obiettivo

Rimuovere il costo CPU dominante trovato dal profiling P3.75 nel percorso
`orders/create` e ripetere il gate concorrente operativo C3 su due api-worker.

Il profilo P3.75 mostrava che `findOrderByIdempotencyKey` eseguiva un
`raw_json LIKE` e poi idratava tutte le righe candidate. Sul database runtime
erano presenti 4.705 ordini: ogni nuova chiave, quindi anche ogni normale miss,
pagava una scansione lineare.

## Correzione

La migrazione `023_orders_idempotency_index.sql` aggiunge a `orders`:

```text
idempotency_key
created_by_user_id
created_by_device_uuid
```

e crea l'indice:

```sql
idx_orders_idempotency_scope
  (idempotency_key, created_by_user_id, created_by_device_uuid)
```

La migrazione retrocompila le colonne da `raw_json`, tollera JSON non valido e
mantiene la semantica esistente: quando user/device non sono salvati
nell'ordine, il filtro non rende l'ordine irraggiungibile.

Tutti i percorsi sono stati allineati:

- `createOrder` inserisce le colonne native;
- `replaceOrderWithRevision` le aggiorna nella stessa CAS;
- `updateOrderWithRevision` le riallinea quando cambia `raw_json`;
- shadow equivalence confronta anche le nuove colonne;
- il lookup usa solo uguaglianza indicizzata e non contiene piu fallback
  `raw_json LIKE` o full scan.

## Hardening deploy

Durante il deploy e stato trovato un secondo bug: lo script
`migrate-relational-schema.mjs` non riconosceva l'esecuzione diretta quando il
percorso passava dal symlink `/opt/cassav4/current`, quindi poteva terminare
senza applicare migrazioni. Il controllo ora confronta i percorsi reali e un
test riproduce il symlink del deploy.

## Migrazione live

Database runtime reale:

```text
/var/lib/cassav4/backend-relational.sqlite
```

Esito:

- integrita SQLite: `ok`;
- schema: `022 -> 023`;
- ordini pre-migrazione: 4.705;
- chiavi retrocompilate: 4.705/4.705;
- mismatch tra colonna e `raw_json`: 0;
- query plan: `SEARCH orders USING INDEX idx_orders_idempotency_scope`.

Backup consistente pre-migrazione:

```text
/opt/cassav4/backups/p3-76-orders-idempotency-index-20260710-115609/
  backend-relational-runtime-before.sqlite
```

## Test

- suite locale relazionale/migrazioni: 35/35;
- suite locale app-state/shadow/policy/metriche: 237/237;
- guardrail locale finale: 151/151;
- E2E async ACK, crash-reconcile e create idempotente: 3/3;
- test CLI migrazione, incluso symlink `current`: 9/9;
- guardrail selezionati sul Raspberry: 151/151;
- `backend/server.js`: 38.799 righe su budget 39.500.

## Canary C3

Configurazione:

- 50 device/tavoli distinti;
- concorrenza 3, limite operativo della lane BAR;
- owner 5281, realtime 5282, api-worker 5283/5284;
- stampante, fiscale e cassa automatica reali disabilitati.

| Run | Esito | Durata | Create p95 | Sync p95 | Readback p95 | Cleanup p95 | Worker 5283/5284 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C3a | 50/50 | 47,13 s | 462,48 ms | 467,77 ms | 214,84 ms | 318,71 ms | 24/26 |
| C3b | 50/50 | 42,30 s | 452,08 ms | 380,52 ms | 135,37 ms | 254,33 ms | 26/24 |

Confronto con P3.75 (`create p95 620,54 ms`):

- create p95: -25,47% e -27,15%;
- idempotenza media: 51,08 ms -> 1,52/1,58 ms;
- riduzione lookup idempotenza: -97,02% e -96,91%;
- idempotenza p95 bucket: `<=100 ms -> <=5/10 ms`.

Stage create principali post-fix:

| Stage | C3a avg / p95 | C3b avg / p95 |
| --- | ---: | ---: |
| `idempotency` | 1,52 / <=5 ms | 1,58 / <=10 ms |
| `readDb` | 40,72 / <=250 ms | 45,56 / <=250 ms |
| `allocationAndStationState` | 14,16 / <=50 ms | 15,44 / <=50 ms |
| `auditPrelude` | 16,04 / <=50 ms | 11,54 / <=50 ms |
| `buildOrderAndAssignment` | 14,02 / <=50 ms | 17,16 / <=100 ms |
| write relazionale | 8,18 / <=50 ms | 5,20 / <=50 ms |

## Capacita osservata

Usando in modo conservativo le medie HTTP di create+sync+cleanup come domanda
di servizio sui due worker:

- C3a: capacita teorica 10,25 mutazioni/s, arrivo osservato 3,18/s,
  margine circa +222%;
- C3b: capacita teorica 11,30 mutazioni/s, arrivo osservato 3,55/s,
  margine circa +219%.

Questo conto vale per il profilo C3 e non sostituisce il prossimo load-100.

## Stato finale

- 100/100 ordini canary annullati correttamente;
- 50/50 tavoli puliti: zero ordini attivi, importi, pending bill e work lock;
- zero postazioni canary rimaste attive;
- outbox non pubblicato: 0;
- zero `SQLITE_BUSY`, deadlock, rollback, retry flush, fatal o restart;
- owner, realtime, due worker, frontend e battery: `active`;
- `PRINTING_ENABLED=0`;
- `FISCAL_REAL_IO_DISABLED=1`;
- `POS_FISCAL_REAL_IO_DISABLED=1`;
- `AUTOMATIC_CASH_REAL_ENABLED=0`.

## Esito

Il gate P3 operativo e verde su due run consecutivi: create, sync, readback e
cleanup hanno tutti p95 sotto 500 ms. P3.76 e chiusa.

Il prossimo costo dominante e `readDb` (40-46 ms medi, p95 bucket <=250 ms),
da tenere sotto osservazione nel P4/load-100. Non serve un altro refactor P3
prima del ramp: il prossimo step e P4 con I/O reale ancora disabilitato.

## Artefatti

```text
reports/p3_76_orders_idempotency_20260710/
```

Contiene i due report C3, snapshot metriche pre/post per worker, delta stage,
retry breakdown, layout/stazioni finali, journal e checksum sorgenti.
