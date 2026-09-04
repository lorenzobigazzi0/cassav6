# Feature flag inventory — Fase -1/0

Questa fase rende visibili i flag più importanti, senza promuovere automaticamente i path canary a default.

## Database e app-state

- `BACKEND_DB_MODE`
- `BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS`
- `BACKEND_MYSQL_SPLIT_SESSIONS`
- `BACKEND_MYSQL_SPLIT_AUDIT_EVENTS`
- `APP_STATE_DIRTY_TRACKING`
- `SCOPED_READS`
- `BACKEND_RELATIONAL_ORDERS_READ_PRIMARY`
- `BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY`
- `BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY`
- `BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY`
- `BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY`
- `BACKEND_RELATIONAL_AGGREGATE_LAST_EVENT_BINDING`
- `BACKEND_RELATIONAL_TABLES_READ_PRIMARY`
- `BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS`
- `BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY`
- `BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY`
- `BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY`
- `BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY`
- `BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY`
- `BACKEND_FISCAL_OUTBOX_ENABLED`
- `BACKEND_FISCAL_OUTBOX_WORKER_ENABLED`
- `BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH`

Aggiornamento Step 9A: `SCOPED_READS=1` abilita endpoint GET mirati
read-only per tavolo, sala, notifiche e job stampa. Ogni risposta espone
`meta.fullStateFallbackUsed`; in near-realtime deve restare `false` sui path
migrati.

Aggiornamento Step 12A: il pilot SQL-primary table/order usa i flag granulari
`BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY`,
`BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY` e
`BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY`. In questo step non viene
promosso il flag globale `BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY`, cosi' il
cutover resta reversibile per singolo flusso.

Aggiornamento Step 12B: `BACKEND_RELATIONAL_AGGREGATE_LAST_EVENT_BINDING=1`
aggiorna `orders.last_event_id` e `table_states.last_event_id` nella stessa
transazione dell'insert in `event_outbox`. Il rollback e' riportarlo a `0`.

Aggiornamento Step 12C: `BACKEND_RELATIONAL_TABLES_READ_PRIMARY=1`
promuove le letture scoped `GET /api/tables/:tableId` e
`GET /api/rooms/:roomId/tables` a `table_states` relazionale. Il fallback
app-state resta disponibile se il reader relazionale non e' disponibile.

Aggiornamento Step 12D: `BACKEND_RELATIONAL_ORDERS_READ_PRIMARY=1`
promuove la lettura scoped `GET /api/tables/:tableId/open-order` a `orders`
relazionale. Un tavolo senza comanda aperta restituisce `order: null` dalla
sorgente relazionale, senza forzare il fallback full-state.

Aggiornamento Step 12E: i flag `BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS=1`,
`BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY=1`,
`BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY=1` e
`BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY=1` promuovono report,
ticket banco, pagamento tavolo e split libero al modello relazionale. I write
primary pagamenti devono girare con `EVENT_OUTBOX_ENABLED=1` e
`IDEMPOTENCY_STORE_ENABLED=1`.

Aggiornamento Step 12F: `BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY=1`
registra i comandi fiscali tecnici nel relazionale senza cambiare i saldi;
`BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY=1` registra le ricevute
fiscali collegate ai pagamenti write-primary. Le ricevute fiscali richiedono i
flag pagamenti dello Step 12E gia' attivi.

Aggiornamento Step 13A: `BACKEND_FISCAL_OUTBOX_ENABLED=1` accoda una riga
durabile in `fiscal_outbox` quando una ricevuta fiscale relazionale viene
registrata nella transazione pagamento/fiscale. Il flag richiede
`BACKEND_RELATIONAL_ENABLED=1`, `EVENT_OUTBOX_ENABLED=1` e Step 12F attivo.

Aggiornamento Step 13C: il worker `createFiscalOutboxWorker()` non introduce un
nuovo flag e non parte automaticamente. Usa la stessa `fiscal_outbox` abilitata
da `BACKEND_FISCAL_OUTBOX_ENABLED`; il collegamento runtime al provider fiscale
resta uno step successivo.

Aggiornamento Step 13D: `BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=1` avvia nel
processo owner il worker che consuma `fiscal_outbox`, chiama il provider POS
fiscale esistente e sincronizza `fiscal_receipts`. Deve restare `0` finche' non
si vuole spostare il recovery POS dalla vecchia coda app-state alla coda
relazionale durabile.

Aggiornamento Step 13E: nessun nuovo flag. Il canary
`npm run test:phase13e` accende `BACKEND_FISCAL_OUTBOX_ENABLED=1` e
`BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=1` in ambiente test, usa una POS API
simulata e verifica emissione `issued` senza doppia chiamata provider.

Aggiornamento Step 13F: nessun nuovo flag. `npm run test:phase13f` estende il
canary POS simulato a ticket, pagamento tavolo e split libero. Quando
`BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=1`, anche gli handler modulari tavolo e
split libero non schedulano il job POS legacy.

Aggiornamento Step 13G: nessun nuovo flag di prodotto. Il profilo
`configs/fiscal-outbox-worker-staging.env.example` abilita il worker fiscale
solo insieme a ticket/tavolo/split write-primary e ricevute fiscali
write-primary. `npm run profile:runtime` segnala warning se il worker e'
acceso con pagamenti write-primary parziali.

Aggiornamento Step 13H: nessun nuovo flag. `npm run smoke:fiscal-outbox-worker`
e' uno smoke read-only per verificare il DB relazionale staging dopo l'avvio
del worker: stati bloccanti, backlog, processing stale e duplicati
`fiscal_outbox`/`fiscal_receipts`.

Aggiornamento Step 13I: nessun nuovo flag. Lo stesso smoke supporta `--output`
e lo script `npm run smoke:fiscal-outbox-worker:report` per salvare evidenza in
`reports/` senza cambiare la logica del worker.

Aggiornamento Step 13J: nessun nuovo flag. `npm run migrate:relational:schema`
applica solo le migrazioni relazionali versionate al DB scelto da
`BACKEND_RELATIONAL_DB_PATH`, senza import da app-state.

Aggiornamento Step 13K: nessun nuovo flag. Il profilo staging e' avviabile su
Windows tramite `npm run dev:backend` cross-platform e lo smoke puo' validare
anche `/api/health` via `--base-url`.

Aggiornamento Step 13L: nessun nuovo flag runtime. Il canary
`npm run canary:fiscal-outbox-payment` usa argomenti CLI espliciti:
`--execute` per creare il pagamento e `--allow-real-fiscal` per autorizzare un
provider non mock/staging.

Aggiornamento Step 13M: nessun nuovo flag runtime. Il canary
`npm run canary:fiscal-outbox-payment:mock:report` avvia backend e provider
fiscale mock temporanei con env isolato e verifica il worker `fiscal_outbox`
senza usare il provider reale.

Aggiornamento Step 13N: nessun nuovo flag runtime. Il comando
`npm run evidence:fiscal-outbox-step13:report` consolida smoke live, preflight
live e canary mock isolato in evidenze JSON/Markdown senza modificare il
runtime.

Aggiornamento Step 14A: `MQTT_ENABLED=1` insieme a `MQTT_EVENTS_ENABLED=1`
abilita il bridge eventi MQTT da `event_outbox`. `MQTT_COMMANDS_ENABLED` resta
spento: i comandi critici restano HTTP/MySQL. `MQTT_RETAINED_STATE_ENABLED=1`
abilita retained solo per stati ammessi dal contratto, non per pagamenti o
fiscale.

Aggiornamento Step 14B: nessun nuovo flag runtime. `npm run
canary:mqtt-bridge:report` valida il bridge con broker MQTT embedded o broker
esterno via `--broker-url`, mantenendo `MQTT_COMMANDS_ENABLED=0`.

Aggiornamento Step 14C: nessun nuovo flag runtime. `npm run
canary:mqtt-bridge:reconnect:report` valida broker down/restart e reconnect
del bridge sulla stessa porta, mantenendo il retry durabile su `event_outbox`
e non nel client MQTT.

Aggiornamento Step 14D: nessun nuovo flag runtime. `npm run
canary:mqtt-bridge:load:report` valida fanout MQTT con 100 subscriber wildcard,
eventId per deduplica e `MQTT_COMMANDS_ENABLED=0`.

Aggiornamento Step 14E: nessun nuovo flag runtime. `npm run
check:mqtt-acl:report` valida gli esempi Mosquitto in `configs/`, con backend
unico writer di `events/#`, device reader eventi e writer solo su presence/acks
propri.

Aggiornamento Step 14F: nessun nuovo flag runtime. `npm run
canary:mqtt-bridge:storm:report` valida reconnect storm multi-device con
broker restartato piu' volte, publish down controllato, fanout post-restart e
assenza di duplicati.

Aggiornamento Step 14G: nessun nuovo flag runtime. `npm run
canary:mqtt-mosquitto-live:report` valida un broker Mosquitto reale/LAN con
credenziali esterne, anonymous disabilitato, backend unico writer eventi,
device reader/presence e printer gateway limitato agli eventi print.

Aggiornamento Step 14H: nessun nuovo flag runtime. `npm run
canary:mqtt-retained-persistence:publish` e `:verify` validano su broker reale
che `table.state` sopravviva come retained dopo restart Mosquitto, mentre
`payment.status` resti non-retained. Il marker non contiene segreti.

Aggiornamento Step 14I: `MQTT_TLS_ENABLED=1` o `MQTT_URL=mqtts://...`
abilitano TLS sul bridge MQTT. `MQTT_TLS_CA_PATH`,
`MQTT_TLS_CERT_PATH`, `MQTT_TLS_KEY_PATH`, `MQTT_TLS_SERVERNAME` e
`MQTT_TLS_REJECT_UNAUTHORIZED` configurano il trust store locale senza
committare certificati o chiavi. `npm run check:mqtt-tls:report` valida
staticamente il profilo Mosquitto TLS.

Aggiornamento Step 15: `MQTT_COMMANDS_ENABLED=1` non basta piu' ad abilitare
comandi MQTT. Il bridge espone `commandsRequested=true`, ma
`commandsEnabled=true` solo se `COMMAND_INBOX_ENABLED=1`,
`COMMAND_INBOX_MODE=write|enforce|enforce_pilot` e
`MQTT_COMMAND_ACK_ENABLED=1`. `npm run check:mqtt-command-gate:report` salva il
report statico del gate.

Aggiornamento Step 17: nessun nuovo flag runtime. Il pilot
`backend/modules/realtime-backbone/mqtt-command-pilot.js` supporta solo
`notifications.ack`, pubblica ACK su `pos/{storeId}/events/commands/...` e
lavora solo quando il gate Step 15 espone `commandsEnabled=true`. Non e'
ancora collegato a `server.js`.

## Realtime

- `EVENT_OUTBOX_ENABLED`
- `IDEMPOTENCY_STORE_ENABLED`
- `SSE_EVENT_PAYLOAD`
- `BACKEND_REALTIME_GATEWAY_ENABLED`
- `MQTT_ENABLED`
- `MQTT_EVENTS_ENABLED`
- `MQTT_COMMANDS_ENABLED`
- `MQTT_COMMAND_ACK_ENABLED`
- `MQTT_TLS_ENABLED`
- `MQTT_TLS_CA_PATH`
- `MQTT_TLS_CERT_PATH`
- `MQTT_TLS_KEY_PATH`
- `MQTT_TLS_SERVERNAME`
- `MQTT_TLS_REJECT_UNAUTHORIZED`

## Redis

- `REDIS_ENABLED`
- `REDIS_CACHE_ENABLED`
- `REDIS_SESSIONS_ENABLED`
- `REDIS_PRESENCE_ENABLED`
- `REDIS_LOCKS_ENABLED`

Redis resta opzionale in questa fase. Non e' sorgente di verita.

Aggiornamento Step 10A: `REDIS_ENABLED=1` abilita l'adapter volatile
opzionale; `REDIS_CACHE_ENABLED=1` usa cache-aside sui read scoped tavolo,
sala e ordine aperto; `REDIS_SESSIONS_ENABLED=1` e
`REDIS_PRESENCE_ENABLED=1` aggiornano chiavi volatile per device/sessione
dagli endpoint auth. `REDIS_LOCKS_ENABLED` deve restare `0`: Redis non e'
lock autoritativo.

## Stampa

- `PRINTING_ENABLED`
- `PRINT_ASYNC_DISPATCH`
- `PRINT_SPOOL_FAST_WORKER`
- `AUTO_PRINT_ENQUEUE_DELAY_MS`
- `PRINT_TCP_TIMEOUT_MS`
- `PRINT_SPOOL_PRINTER_PROBE_TIMEOUT_MS`

## Lane/concorrenza

- `LANE_PAYMENTS`
- `LANE_ROOMS`
- `LANE_NOTIFICATIONS`
- `LANE_PRINT`
- `LANE_RESERVATIONS`
- `LANE_STATION_STATE`
- `PRINT_LANE_ENABLED`
- `PAYMENT_LANE_ENABLED`
- `ROOM_LANE_ENABLED`
- `ORDER_SYNC_FAST_LANE_ENABLED`

Aggiornamento Step 11A: `LANE_PRINT=1` con `PRINT_LANE_ENABLED=1`
abilita una lane dedicata per `POST /api/integration/print`, ma solo se
`PRINT_SPOOL_SQL_PRIMARY=1`. La lane stampa usa metriche proprie
(`printLaneEnqueued`, `queues.printLane`) e non entra nel conteggio che blocca
le domain lane tavoli/ordini; il rollback e' `LANE_PRINT=0` oppure
`PRINT_LANE_ENABLED=0`.

## Diagnostica

- `RUNTIME_METRICS`
- `RUNTIME_METRICS_QUEUE_SAMPLE_LIMIT`
- `DIAGNOSTICS_BASELINE`
- `DIAGNOSTICS_LOG_JSON`
- `DIAGNOSTICS_SAMPLE_RATE`
- `DIAGNOSTICS_BASELINE_LOG_PATH`

## Client/frontend

Aggiornamento Step 7/8A: `CLIENT_PUSH_FIRST`, `CLIENT_WIDE_INVALIDATE_DISABLED`
e `CLIENT_OPTIMISTIC_ACTIONS` hanno un primo uso effettivo sul mobile tramite
`public/config.json` (`clientPushFirst`, `wideInvalidateDisabled`,
`clientOptimisticActions`) e sul backend tramite
`configs/near-realtime-push-first.env.example`.

- `CLIENT_PUSH_FIRST`
- `CLIENT_WIDE_INVALIDATE_DISABLED`
- `CLIENT_OPTIMISTIC_ACTIONS`
- `ANDROID_POLLER_FALLBACK_ONLY`

Questi ultimi sono documentati perché fanno parte della roadmap, ma l'attivazione effettiva richiede i refactor frontend delle fasi successive.

## Aggiornamento Fase 01 — Dirty tracking rollout

`APP_STATE_DIRTY_TRACKING` non va più trattato solo come booleano. Sono supportate le modalità:

```text
off | shadow | warn | write | enforce
```

Alias:

```text
0/off    => off
1/on     => write
write    => write
enforce  => enforce
```

Uso consigliato per profili near-real-time:

```env
APP_STATE_DIRTY_TRACKING=shadow
APP_STATE_DIRTY_TRACKING_MODE=shadow
```

`shadow` misura senza modificare la semantica di persistenza; `warn` aggiunge warning; `enforce` blocca domini non dichiarati e va usato solo dopo STOP/REVIEW.

## Aggiornamento Fase 02 — Command inbox

Nuovi flag:

```env
COMMAND_INBOX_ENABLED=0|1
COMMAND_INBOX_MODE=off|shadow|write|enforce
```

Uso consigliato ora:

```env
COMMAND_INBOX_ENABLED=1
COMMAND_INBOX_MODE=shadow
```

`COMMAND_INBOX_ENABLED=1` abilita la fondazione e le metriche disponibili. In questa fase non rende ancora obbligatorio il wrapper per gli handler business.

`MQTT_COMMANDS_ENABLED=1` non deve essere usato senza `COMMAND_INBOX_ENABLED=1`, perché i comandi su broker richiedono requestId/idempotencyKey/ACK applicativo.
