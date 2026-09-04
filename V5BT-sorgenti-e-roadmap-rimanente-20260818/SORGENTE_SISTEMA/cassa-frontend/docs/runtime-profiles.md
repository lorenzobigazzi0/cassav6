# Runtime profiles

## STANDARD

Comportamento conservativo, vicino all'avvio esistente.

```bash
launcher/start-standard.sh
```

Windows:

```cmd
launcher\start-standard.cmd
```

## NEAR_REALTIME

Profilo di test monoprocesso/quasi-monoprocesso per validare i path moderni:

- runtime metrics;
- baseline diagnostics;
- app-state dirty tracking;
- scoped reads;
- event outbox;
- SSE payload;
- stampa fast worker.

Dal completamento degli Step 6.5/7 include anche:

```env
PRINT_SPOOL_SQL_PRIMARY=1
PRINT_CIRCUIT_BREAKER=1
REALTIME_REPLAY_ENABLED=1
SSE_LEGACY_REFRESH=0
```

```bash
launcher/start-near-realtime.sh
```

## NEAR_REALTIME_PUSH_FIRST

Profilo Step 7 per validare lo stream SSE con envelope outbox, `Last-Event-ID`
e client push-first senza refresh legacy.

```env
EVENT_OUTBOX_ENABLED=1
REALTIME_REPLAY_ENABLED=1
SSE_EVENT_PAYLOAD=1
SSE_LEGACY_REFRESH=0
IDEMPOTENCY_STORE_ENABLED=1
CLIENT_PUSH_FIRST=1
CLIENT_WIDE_INVALIDATE_DISABLED=1
CLIENT_OPTIMISTIC_ACTIONS=1
SCOPED_READS=1
REDIS_ENABLED=0
MQTT_ENABLED=0
```

File env di riferimento: `configs/near-realtime-push-first.env.example`.

Dal completamento dello Step 9A, `SCOPED_READS=1` abilita i primi endpoint
read-only mirati per tavoli, sala, notifiche e job stampa. Il rollback e':

```env
SCOPED_READS=0
```

## NEAR_REALTIME_REDIS

Profilo Redis per Step 10A. Redis resta cache/sessioni/presenza, non sorgente di verita.

```bash
launcher/start-near-realtime-redis.sh
```

Dal completamento dello Step 10A questo profilo e' operativo per cache hot,
sessioni e presenza volatile. Redis resta acceleratore: MySQL rimane sorgente
di verita e Redis down non deve bloccare i comandi HTTP.

```env
SCOPED_READS=1
REDIS_ENABLED=1
REDIS_CACHE_ENABLED=1
REDIS_SESSIONS_ENABLED=1
REDIS_PRESENCE_ENABLED=1
REDIS_LOCKS_ENABLED=0
LANE_PRINT=1
PRINT_LANE_ENABLED=1
```

Rollback:

```env
REDIS_ENABLED=0
REDIS_CACHE_ENABLED=0
REDIS_SESSIONS_ENABLED=0
REDIS_PRESENCE_ENABLED=0
LANE_PRINT=0
PRINT_LANE_ENABLED=0
```

Dal completamento dello Step 11A questo profilo abilita anche la print lane
per `POST /api/integration/print`. La lane e' valida solo con
`PRINT_SPOOL_SQL_PRIMARY=1` e mantiene il fallback legacy disattivabile via
flag.

Dal completamento degli Step 12A/12B/12C/12D/12E/12F/13A questo profilo espone
anche il pilot SQL-primary table/order, la lettura tavoli/ordini relazionale,
il rollout pagamenti relazionale, il fiscale relazionale e la fiscal outbox:

```env
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

La versione aggregato resta `revision`; `aggregateVersion` nello stream
realtime viene popolato dagli eventi che contengono gia' `revision` o
`currentRevision`.

Rollback Step 12A:

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

## FISCAL_OUTBOX_WORKER_STAGING

Profilo Step 13G per provare il worker fiscale POS su staging con coda
relazionale durabile e rollback semplice. E' deliberatamente separato dai
profili near-realtime generici per evitare accensioni accidentali del worker.

```bash
launcher/start-fiscal-outbox-worker-staging.sh
```

Windows:

```cmd
launcher\start-fiscal-outbox-worker-staging.cmd
```

File env di riferimento:
`configs/fiscal-outbox-worker-staging.env.example`.

L'example usa `NODE_ENV=staging` per restare avviabile senza segreti reali. Un
ambiente production deve usare `configs/fiscal-outbox-worker-staging.env` non
committato con `NODE_ENV=production`, `BACKEND_TOKEN_SECRET` e provider fiscale
reale configurati.

Flag fiscali chiave:

```env
BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY=1
BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY=1
BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY=1
BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY=1
BACKEND_FISCAL_OUTBOX_ENABLED=1
BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=1
BACKEND_FISCAL_OUTBOX_WORKER_INTERVAL_MS=1000
BACKEND_FISCAL_OUTBOX_WORKER_BATCH_SIZE=5
BACKEND_FISCAL_OUTBOX_WORKER_LEASE_MS=30000
```

Smoke test prima dell'avvio staging:

```bash
npm run test:phase13g
npm run profile:runtime
```

Smoke read-only dopo l'avvio staging, puntando al DB relazionale di test:

```bash
npm run migrate:relational:schema
node scripts/fiscal-outbox-staging-smoke.mjs --db-path backend/backend-relational.sqlite --base-url http://127.0.0.1:5280
node scripts/fiscal-outbox-staging-smoke.mjs --db-path backend/backend-relational.sqlite --base-url http://127.0.0.1:5280 --output reports/fiscal-outbox-worker-staging-smoke.txt
npm run smoke:fiscal-outbox-worker:report
```

Canary pagamento fiscale controllato:

```bash
npm run canary:fiscal-outbox-payment:report
node scripts/fiscal-outbox-payment-canary.mjs --base-url http://127.0.0.1:5280 --execute
npm run canary:fiscal-outbox-payment:mock:report
```

`--execute` invia il pagamento solo se i fiscal devices attivi sono
mock/staging/test/sandbox. Per un provider reale serve anche
`--allow-real-fiscal`.

Il canary `:mock:report` avvia un backend temporaneo e un provider fiscale mock
locale; serve a validare end-to-end il worker senza emettere documenti reali.

Evidenza consolidata Step 13:

```bash
npm run evidence:fiscal-outbox-step13:report
```

Il report consolidato ripete smoke live read-only, preflight live senza
pagamento e canary mock isolato, salvando JSON e Markdown in `reports/`.

Rollback rapido:

```env
BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0
```

Rollback completo:

```cmd
launcher\start-rollback-safe.cmd
```

## NEAR_REALTIME_MQTT

Profilo Step 14 per il bridge MQTT da `event_outbox`. MQTT trasporta eventi
realtime LAN; i comandi critici restano HTTP/MySQL.

Flag minimi:

```env
MQTT_ENABLED=1
MQTT_EVENTS_ENABLED=1
MQTT_COMMANDS_ENABLED=0
MQTT_COMMAND_ACK_ENABLED=0
MQTT_RETAINED_STATE_ENABLED=1
MQTT_URL=mqtt://127.0.0.1:1883
```

```bash
launcher/start-near-realtime-mqtt.sh
```

Verifica:

```bash
npm run test:phase14
npm run test:phase14b
npm run test:phase14c
npm run test:phase14d
npm run test:phase14e
npm run test:phase14f
npm run test:phase14g
npm run test:phase14h
npm run test:phase14i
npm run canary:mqtt-bridge:report
npm run canary:mqtt-bridge:reconnect:report
npm run canary:mqtt-bridge:load:report
npm run canary:mqtt-bridge:storm:report
npm run canary:mqtt-mosquitto-live:report
npm run canary:mqtt-retained-persistence:publish
npm run canary:mqtt-retained-persistence:verify
npm run check:mqtt-acl:report
npm run check:mqtt-tls:report
npm run check:mqtt-command-gate:report
npm run test:phase15
npm run test:phase17
npm run profile:runtime
```

Rollback:

```env
MQTT_ENABLED=0
MQTT_EVENTS_ENABLED=0
MQTT_COMMANDS_ENABLED=0
MQTT_COMMAND_ACK_ENABLED=0
```

Step 15 rende `MQTT_COMMANDS_ENABLED=1` solo una richiesta: i comandi MQTT si
abilitano davvero solo con command-inbox in `write/enforce/enforce_pilot` e
`MQTT_COMMAND_ACK_ENABLED=1`.

Step 17 aggiunge il pilot `notifications.ack` in
`backend/modules/realtime-backbone/mqtt-command-pilot.js`; resta scollegato dal
runtime principale finche' non viene completato il wiring dietro gate.

## CANARY_MULTIPROCESS

Profilo sperimentale. Da usare solo dopo baseline e test canary.

```bash
launcher/start-canary-multiprocess.sh
```

## ROLLBACK_SAFE

Profilo di ritorno al comportamento più legacy/stabile.

```bash
launcher/start-rollback-safe.sh
```

## Runtime profile

Ogni avvio deve stampare la matrice:

```bash
npm run profile:runtime
```

La matrice evidenzia warning se un profilo near-realtime viene avviato con flag critici spenti.

## Aggiornamento Fase 01 — Dirty tracking nei profili

I profili `NEAR_REALTIME` e `CANARY_MULTIPROCESS` devono partire con:

```env
APP_STATE_DIRTY_TRACKING=shadow
APP_STATE_DIRTY_TRACKING_MODE=shadow
```

Il passaggio a `warn` e poi `enforce` è manuale e deve avvenire solo dopo avere generato e approvato i report:

```bash
npm run diag:collect-runtime-metrics
npm run dirty:tracking:analyze
```

## Aggiornamento Fase 02 — Command inbox nei profili

I profili near-realtime includono ora:

```env
COMMAND_INBOX_ENABLED=1
COMMAND_INBOX_MODE=shadow
```

Il rollback usa:

```env
COMMAND_INBOX_ENABLED=0
COMMAND_INBOX_MODE=off
```

Verifica runtime:

```bash
npm run profile:runtime
```

Analisi snapshot:

```bash
npm run command:inbox:analyze
```
