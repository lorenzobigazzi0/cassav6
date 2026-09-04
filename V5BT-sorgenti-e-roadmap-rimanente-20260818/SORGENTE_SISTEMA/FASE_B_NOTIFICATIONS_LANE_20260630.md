# Fase B - Notifications Lane

Data: 2026-06-30

## Obiettivo

Portare `publish` e `ack` delle notifiche operative fuori dalla coda globale DB, con precedenza alta per comanda pronta e chiamata cameriere.

## Implementato

- Nuova lane `notificationLane` per:
  - `POST /api/integration/notifications/publish`
  - `POST /api/integration/notifications/ack`
- La lane parte prima della order lane quando e' libera, ma con burst controllato (`NOTIFICATION_LANE_BURST=8`) per non affamare le comande sotto traffico continuo.
- Flag rollout:
  - `LANE_NOTIFICATIONS=1`
  - `NOTIFICATION_LANE_ENABLED=0` per disattivare
  - `NOTIFICATION_LANE_CONCURRENCY=1` nello script di riavvio
- La lane si attiva solo con MySQL + `BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1`.
- Chiavi:
  - `notification:<id>` per ack/delete.
  - `order:<orderId>` per comanda pronta.
  - `target:<consumer|device|user|station>` quando la notifica e' mirata.
  - fallback su route/tipo/device.
- Nuova `writeNotificationDb()` con domini mirati:
  - `integration`
  - `sessions`
  - `auditEvents`
- `pull` resta una GET, ma le eventuali write interne di consegna/heartbeat/escalation ora usano `writeNotificationDb()`.
- Aggiunto helper riusabile `modules/queue/mutation-lane.js` e spostate su questo helper sia `reservationLane` sia `notificationLane`, per non superare il limite hard di 40000 righe di `server.js`.
- Metriche runtime aggiunte:
  - `notificationLaneEnqueued`
  - `queues.notificationLane.waitMsByLabel`
  - `queues.notificationLane.runMsByLabel`
  - `notificationLaneDepth`
  - `notificationLaneRunning`

## Guard rail

- La notification lane resta esclusiva rispetto a coda globale, order lane, payment lane, room lane e reservation lane.
- Concorrenza interna fissata a 1 perche' `integration` e' ancora un dominio JSON unico.
- Login e task globali con priorita piu alta bloccano comunque la lane.
- L'evento SSE continua a partire immediatamente nel punto applicativo gia' esistente; la modifica riguarda coda e persistenza.

## Verifiche

Comandi eseguiti con Node locale:

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/modules/runtime-metrics.js`
- `node --check cassa-frontend/backend/modules/queue/mutation-lane.js`
- `bash -n tools/restart-cassav4-linux.sh`
- `node --test cassa-frontend/backend/tests/notifications-persistence.e2e.test.mjs`
- `node --test cassa-frontend/backend/tests/notifications-priority.e2e.test.mjs`
- `node --test cassa-frontend/backend/tests/notification-stream-payload.test.mjs`
- `node --test cassa-frontend/backend/tests/notification-records.test.mjs`
- `node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs`
- `node --test cassa-frontend/backend/tests/reservations-status.e2e.test.mjs`
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs`

Risultato finale:

- Syntax check OK.
- Notifications persistence: 6/6 pass.
- Notifications priority: 3/3 pass.
- Notification stream payload SSE: 1/1 pass.
- Notification records/targeting: 14/14 pass.
- Runtime metrics: 1/1 pass.
- Reservations status regression: 3/3 pass.
- Route/security architecture: 7/7 pass.
- `server.js`: 39999 righe, sotto il limite hard di 40000.

## Prossimo step consigliato

Procedere con B-final:

- mappare le mutazioni ancora nella coda globale;
- lasciare la globale solo come fallback;
- preparare un confronto metriche `dbMutation` vs lane su traffico misto 25/50 device.
