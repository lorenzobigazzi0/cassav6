# Step 12A - Relational primary table/order pilot

## Scope

Step 12A promuove solo il pilot SQL-primary di ordini e tavoli gia' presente nel backend. Non modifica pagamenti, fiscale, Redis o MQTT.

Il codice locale usa `revision` come nome della versione CAS dell'aggregato. Il contratto roadmap chiama lo stesso concetto `version`; non e' stata aggiunta una seconda colonna per evitare due sorgenti di verita.

## Schema

La migrazione `020_aggregate_versions.sql` aggiunge:

```sql
orders.last_event_id
table_states.last_event_id
```

`orders.revision` e `table_states.revision` restano la versione autoritativa usata dai repository per i conflitti.

Da Step 12B, con `BACKEND_RELATIONAL_AGGREGATE_LAST_EVENT_BINDING=1`,
`last_event_id` viene aggiornato nella stessa transazione dell'insert in
`event_outbox` per eventi `order` e `table`. Il valore e' monotono: un evento
piu' vecchio non puo' sovrascrivere uno piu' recente.

Da Step 12C, con `BACKEND_RELATIONAL_TABLES_READ_PRIMARY=1`, gli endpoint
scoped `GET /api/tables/:tableId` e `GET /api/rooms/:roomId/tables` leggono
prima da `table_states`. Il campo `raw_json` conserva la forma visuale del
tavolo, mentre `revision`, `aggregateVersion` e `last_event_id` arrivano dalle
colonne relazionali. Se il reader relazionale non e' disponibile, resta il
fallback esistente su scoped app-state/full app-state.

Da Step 12D, con `BACKEND_RELATIONAL_ORDERS_READ_PRIMARY=1`, l'endpoint
scoped `GET /api/tables/:tableId/open-order` legge da `orders` relazionale. La
regola che decide quale comanda e' aperta resta unica ed e' riusata dal modulo
`scoped-reads.domain.js`. Se il tavolo non ha una comanda aperta, la risposta
resta `order: null` con `meta.source=relational`.

Da Step 12E, i pagamenti principali usano il modello relazionale per il rollout
near-realtime:

- `BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS=1` usa il read-model relazionale
  per report e ristampa movimento;
- `BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY=1` registra ticket banco in
  `payment_containers`, `payment_parts`, `payment_transactions` ed outbox;
- `BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY=1` registra pagamento
  tavolo, snapshot tavolo e outbox in una transazione;
- `BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY=1` registra split
  libero, snapshot tavolo e outbox in una transazione.

I write-primary pagamento devono usare anche `EVENT_OUTBOX_ENABLED=1` e
`IDEMPOTENCY_STORE_ENABLED=1`.

Da Step 12F, il fiscale collegato ai pagamenti e' promosso nel rollout
near-realtime:

- `BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY=1` registra comandi fiscali
  tecnici e retry nel relazionale senza modificare i saldi;
- `BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY=1` registra le ricevute
  fiscali su `fiscal_receipts` usando `attempt_scope` come idempotenza
  fiscale.

Le ricevute fiscali write-primary richiedono i pagamenti write-primary dello
Step 12E.

Da Step 13A, `BACKEND_FISCAL_OUTBOX_ENABLED=1` accoda una riga durabile in
`fiscal_outbox` nella stessa transazione relazionale che registra il pagamento,
la ricevuta fiscale e l'evento outbox. `fiscal_receipts` resta il registro della
ricevuta; `fiscal_outbox` e' la coda operativa recuperabile.

Da Step 13C, `createFiscalOutboxWorker()` fornisce il boundary applicativo del
worker fiscale: consuma una riga claimata da `fiscal_outbox`, invoca un
processore iniettato e aggiorna la coda con esito `issued`, `retrying`,
`failed` o `manual_required`. Non parte automaticamente nel server e non chiama
ancora il provider fiscale reale.

Da Step 13D, `BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=1` collega quel worker al
provider POS fiscale esistente nel solo processo owner. Il worker aggiorna anche
`fiscal_receipts`, quindi la coda operativa e il registro fiscale relazionale
restano allineati.

## Eventi realtime

`toRealtimeEventEnvelope()` ora valorizza `aggregateVersion` leggendo `revision`, `currentRevision` o `aggregateVersion` dal payload dell'evento outbox. Se l'evento non contiene una versione, il campo resta `null`.

Gli eventi di spostamento tavolo usano anche `fromTableId` e `toTableId` per risolvere l'identita' aggregato.

## Flag Step 12A

```env
BACKEND_RELATIONAL_ENABLED=1
EVENT_OUTBOX_ENABLED=1
IDEMPOTENCY_STORE_ENABLED=1
BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=1
BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1
BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY=1
BACKEND_RELATIONAL_AGGREGATE_LAST_EVENT_BINDING=1
BACKEND_RELATIONAL_ORDERS_READ_PRIMARY=1
BACKEND_RELATIONAL_TABLES_READ_PRIMARY=1
BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS=1
BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY=1
BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY=1
BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY=1
BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY=1
BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY=1
BACKEND_FISCAL_OUTBOX_ENABLED=1
BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0
```

Il flag globale `BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1` resta disponibile, ma per il pilot e' preferibile non usarlo per non promuovere tutti i path ordine insieme.

## Rollback

```env
BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=0
BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=0
BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY=0
BACKEND_RELATIONAL_AGGREGATE_LAST_EVENT_BINDING=0
BACKEND_RELATIONAL_ORDERS_READ_PRIMARY=0
BACKEND_RELATIONAL_TABLES_READ_PRIMARY=0
BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS=0
BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY=0
BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY=0
BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY=0
BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY=0
BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY=0
BACKEND_FISCAL_OUTBOX_ENABLED=0
BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0
```

La migrazione e' compatibile all'indietro: le nuove colonne sono nullable e non cambiano le letture legacy.

## Verifica

```bash
npm run check:backend
npm run test:phase12
npm run test:phase12b
npm run test:phase12c
npm run test:phase12d
npm run test:phase12e
npm run test:phase12f
npm run test:phase13a
npm run test:phase13b
npm run test:phase13c
npm run test:phase13d
npm run profile:runtime
```
