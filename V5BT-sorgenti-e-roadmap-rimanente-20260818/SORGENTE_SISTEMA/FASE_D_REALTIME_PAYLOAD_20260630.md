# Fase D - Realtime Payload

Data: 2026-06-30
Sorgente: `estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source`

## Scopo

Aprire la Fase D della roadmap `ROADMAP_REALTIME_CASSAV4.md`: passare da SSE come semplice segnale `refresh` a SSE con payload piccolo e tipizzato, senza rompere i client esistenti.

## Modifiche

- Aggiunto flag backend `SSE_EVENT_PAYLOAD=1`.
- `publishIntegrationNotificationStreamRefresh` continua a inviare il vecchio evento `refresh`.
- Quando il flag e' attivo invia anche `event: payload` con:
  - `ok`
  - `reason`
  - `type`
  - `atMs`
  - `detail`
- Aggiunta classificazione compatta:
  - `order.created`
  - `order.status`
  - `table.state`
  - `notification`
  - `payment.status`
  - `print.status`
  - `station.state`
  - `settings.updated`
  - `system.refresh`
- Aggiornato il client mobile:
  - ascolta `event: payload`;
  - emette `window` event `pos:server-payload`;
  - applica subito le notifiche contenute nel payload;
  - deduplica il successivo `refresh` legacy per non gestire due volte la stessa notifica;
  - mantiene `refresh` come fallback compatibile.
- Avviato D2 per la sezione tavoli:
  - `order_created`, `order_ready`, `order_state_changed` includono ora `order` e snapshot `table` in formato layout;
  - `table_moved` include snapshot layout `fromTable`/`toTable` nel payload realtime, lasciando invariata la risposta API storica;
  - `TablesWorkspace` ascolta `pos:server-payload`, applica il delta alla cache React Query con merge per tavolo e deduplica il `refresh` legacy con stesso `reason/atMs`;
  - `HomeCard` ascolta lo stesso payload e aggiorna la query `home-dashboard`, quindi i 4 contatori filtro cambiano subito quando arriva un evento tavolo/ordine;
  - se il payload non contiene dati completi, resta il refetch mirato esistente.
- Completato D2 anche per il frontend postazione:
  - `station_state_changed` include ora `stationState` e gli ordini riassegnati/ripristinati dalla macchina a stati postazione;
  - `postazione` ascolta `event: payload` sullo stream SSE gia' esistente;
  - quando il payload contiene ordini, li normalizza e li fonde nella lista locale senza attendere il poll completo;
  - quando il payload contiene stati postazione, aggiorna subito presenza/operatore della postazione;
  - il `refresh` legacy viene deduplicato se arriva dopo il payload con stesso `reason/atMs`;
  - il sync completo resta fallback se il payload e' incompleto o non applicabile.
- Abilitato il flag in:
  - `tools/restart-cassav4-linux.sh`
  - `cassa-frontend/scripts/loadtest-full-capacity.mjs`
  - `cassa-frontend/scripts/endurance-sim-50k.mjs`

## Verifica

Test:

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/tests/notification-stream-payload.test.mjs`
- `npm run typecheck` in `mobile-frontend` -> pass
- `npm run build` in `mobile-frontend` -> pass
- `node --test cassa-frontend/backend/tests/notification-stream-payload.test.mjs` -> 1/1 pass
- `npm run build` in `postazione` -> pass
- Riavvio live `./tools/restart-cassav4-linux.sh` -> backend OK, frontend HTTPS OK
- Health live `http://127.0.0.1:5281/api/health` -> `database.mode=mysql`
- Bundle live `/mobile/` -> `index-DKD495Tj.js`
- Bundle live `/postazione/` -> `index-DpUHbuaI.js`
- Flag runtime backend confermati: `APP_STATE_DIRTY_TRACKING=1`, `SSE_EVENT_PAYLOAD=1`, `PRINT_SPOOL_FAST_WORKER=1`

Il test apre `/api/integration/notifications/stream`, pubblica una notifica `bell` e verifica che arrivi un evento SSE `payload` con `type: "notification"`, `reason: "notification_publish"` e `detail.orderId` coerente.

La build produzione aggiorna `mobile-frontend/dist` con il listener `pos:server-payload`, cioe' il bundle effettivamente servito da `serve-frontends.mjs` su `/mobile`.

## Esito

D1 backend e' avviata in modo compatibile e il client mobile usa gia' il payload per le notifiche. D2 copre ora tavoli, Home e postazione: quando il payload contiene snapshot tabella/ordine/stato postazione, i client aggiornano la cache locale senza refetch immediato. I client continuano a ricevere `refresh`, ma quando arriva il payload corrispondente evitano il poll/refetch doppio di fallback.

## Prossimo Passo

Iniziare Fase E: ridurre i poll periodici quando SSE e' connesso e usare il sync completo solo come recupero su reconnect, payload incompleto o errore stream.
