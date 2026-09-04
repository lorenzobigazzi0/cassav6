# MQTT bridge - Step 14

Step 14 introduce il bridge MQTT per fanout realtime LAN.

MQTT non e' sorgente di verita': gli eventi partono da `event_outbox`, che
resta il log durabile letto dal publisher backend.

## Flag

```env
MQTT_ENABLED=1
MQTT_EVENTS_ENABLED=1
MQTT_COMMANDS_ENABLED=0
MQTT_RETAINED_STATE_ENABLED=1
MQTT_URL=mqtt://127.0.0.1:1883
MQTT_STORE_ID=default
```

`MQTT_COMMANDS_ENABLED` deve restare `0` in questa fase. I comandi critici
restano HTTP e passano dai path MySQL/command_inbox esistenti.

Da Step 15, anche se `MQTT_COMMANDS_ENABLED=1`, l'abilitazione effettiva resta
bloccata finche' non sono presenti `COMMAND_INBOX_ENABLED=1`,
`COMMAND_INBOX_MODE=write|enforce|enforce_pilot` e
`MQTT_COMMAND_ACK_ENABLED=1`. Vedi `docs/mqtt-command-gate-step15.md`.

## Flow

```text
MySQL transaction
-> event_outbox
-> EventOutboxCoordinator
-> SSE payload
-> MQTT bridge
-> device LAN
```

Il bridge viene avviato solo nei processi che possono pubblicare
`event_outbox`, evitando publisher duplicati sui processi `api-worker`.

## Topic

I topic principali seguono il contratto:

```text
pos/{storeId}/events/orders/{orderId}
pos/{storeId}/events/tables/{tableId}
pos/{storeId}/events/rooms/{roomId}
pos/{storeId}/events/payments/{paymentId}
pos/{storeId}/events/prints/{jobId}
pos/{storeId}/events/fiscal/{documentId}
```

Sono previsti fallback tecnici per eventi gia' presenti nel backend:
`notifications`, `stations`, `settings` e `system`.

## QoS e retained

- QoS 1 per domini applicativi principali.
- QoS 0 solo per fallback `system`.
- Retained solo per stato tavolo, stampa e settings quando
  `MQTT_RETAINED_STATE_ENABLED=1`.
- Nessun retained per pagamenti e fiscale.

## Failure policy

- MQTT down non blocca richieste HTTP.
- Se MQTT e' abilitato ma il broker non e' pronto, l'evento non viene trattato
  come pubblicato solo grazie a MQTT.
- Il client deve deduplicare usando `eventId`.

## Rollback

```env
MQTT_ENABLED=0
MQTT_EVENTS_ENABLED=0
MQTT_COMMANDS_ENABLED=0
```

Il rollback spegne solo il fanout MQTT. SSE, replay HTTP e `event_outbox`
restano invariati.

## Verifica

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
npm run check:backend
npm run profile:runtime
```

## Step 14B - Canary broker

`npm run canary:mqtt-bridge:report` avvia un broker MQTT embedded se non viene
passato `--broker-url`, collega il bridge reale e verifica:

- consegna a subscriber wildcard `pos/{storeId}/events/#`;
- topic `orders`, `tables` e `payments`;
- QoS 1 sui domini applicativi;
- retained ammesso per stato tavolo;
- assenza di retained sui pagamenti;
- `MQTT_COMMANDS_ENABLED=0`.

Per usare un broker esterno:

```bash
node scripts/mqtt-bridge-canary.mjs --broker-url mqtt://127.0.0.1:1883
```

## Step 14C - Reconnect broker

`npm run canary:mqtt-bridge:reconnect:report` avvia un broker embedded su una
porta locale, pubblica un evento, spegne il broker, verifica che un publish
durante il down non lanci errori e poi riavvia il broker sulla stessa porta.
Il bridge deve riconnettersi e consegnare un nuovo evento.

Il canary verifica anche che il client MQTT del bridge non diventi una coda
alternativa: l'evento tentato durante il down non viene consegnato dopo il
restart. Il retry durabile resta responsabilita' di `event_outbox`.

## Step 14D - Fanout 100 client

`npm run canary:mqtt-bridge:load:report` avvia un broker embedded, collega 100
subscriber wildcard e pubblica eventi tramite il bridge MQTT reale.

Il canary verifica:

- 100 client connessi;
- consegna di tutti gli eventi a tutti i client;
- nessun duplicato per coppia `clientId/eventId`;
- QoS 1 sui domini applicativi;
- `eventId` sempre disponibile per deduplica lato client;
- `MQTT_COMMANDS_ENABLED=0`.

Per ridurre o aumentare il carico:

```bash
node scripts/mqtt-bridge-load-canary.mjs --clients 50 --events 3
```

## Step 14E - Mosquitto ACL policy

`configs/mosquitto.conf.example` e `configs/mosquitto.acl.example` definiscono
la policy di broker LAN:

- anonymous disabilitato;
- password file obbligatorio;
- ACL file obbligatorio;
- backend unico writer di `pos/+/events/#`;
- device reader di eventi;
- device writer solo su presence/acks propri tramite `%u`;
- printer gateway reader di print events e writer solo del proprio status.

`npm run check:mqtt-acl:report` valida staticamente la policy Mosquitto e
simula gli accessi critici: backend write eventi, device read eventi, device
non-write eventi/payment/fiscal, presence propria, blocco presence altrui.

La scrittura device su `events/#` viene negata per assenza di permesso `write`,
non tramite `topic deny` sullo stesso topic, per non bloccare anche la lettura
degli eventi.

## Step 14F - Reconnect storm multi-device

`npm run canary:mqtt-bridge:storm:report` avvia un broker embedded, collega 50
subscriber wildcard con reconnect attivo ed esegue 3 restart del broker sulla
stessa porta.

Il canary verifica:

- tutti i device si riconnettono dopo ogni restart;
- il publish durante broker down fallisce in modo controllato con
  `not_connected`;
- gli eventi tentati durante il down non vengono accodati dal client MQTT;
- il fanout post-restart arriva a tutti i client;
- non ci sono duplicati per coppia `clientId/eventId`;
- `MQTT_COMMANDS_ENABLED=0`.

MQTT resta solo fanout realtime: il retry durabile continua a essere
responsabilita' di `event_outbox`.

## Step 14G - Mosquitto live canary

`npm run canary:mqtt-mosquitto-live:report` valida un broker Mosquitto reale o
LAN usando credenziali esterne. Le password non vengono scritte nei report.

Variabili richieste:

```env
MQTT_LIVE_CANARY_BROKER_URL=mqtt://192.168.0.28:1883
MQTT_LIVE_BACKEND_USERNAME=backend
MQTT_LIVE_BACKEND_PASSWORD=...
MQTT_LIVE_DEVICE_USERNAME=palmare-template
MQTT_LIVE_DEVICE_PASSWORD=...
MQTT_LIVE_PRINTER_USERNAME=printer-gateway-template
MQTT_LIVE_PRINTER_PASSWORD=...
MQTT_LIVE_CANARY_STORE_ID=default
```

Il canary verifica:

- anonymous connect rifiutato;
- bridge backend con credenziali backend connesso e writer di `events/#`;
- device reader su `events/#`;
- device writer solo sulla propria presence;
- device non writer su `events/#`;
- printer gateway reader su `events/prints/#`;
- printer gateway non writer su `events/#`;
- `MQTT_COMMANDS_ENABLED=0`.

Se il broker reale non ha ancora il ruolo printer, usare temporaneamente
`--skip-printer`, ma non considerare completo il gate ACL di produzione finche'
anche il printer gateway non e' validato.

## Step 14H - Retained persistence su broker reale

`npm run canary:mqtt-retained-persistence:publish` pubblica un marker
`table.state` retained e un marker `payment.status` non-retained tramite il
bridge MQTT reale, poi salva `reports/mqtt-retained-persistence-marker.json`.

Flusso operativo:

```bash
npm run canary:mqtt-retained-persistence:publish
# riavviare manualmente il servizio Mosquitto reale
npm run canary:mqtt-retained-persistence:verify
npm run canary:mqtt-retained-persistence:clear
```

Il canary verifica:

- table state pubblicato retained;
- payment pubblicato non-retained;
- dopo restart reale il nuovo client riceve ancora il retained del tavolo;
- dopo restart reale il pagamento non compare come retained;
- il marker e i report non contengono password;
- `MQTT_COMMANDS_ENABLED=0`.

Il comando `clear` cancella il retained marker del tavolo pubblicando payload
vuoto retained sullo stesso topic. Non cancella eventi durabili: agisce solo
sul broker MQTT.

## Step 14I - TLS/mqtts

Il bridge supporta broker TLS tramite `mqtts://` oppure `MQTT_TLS_ENABLED=1`.
I certificati e le chiavi private restano fuori repository.

Flag runtime:

```env
MQTT_TLS_ENABLED=1
MQTT_URL=mqtts://192.168.0.28:8883
MQTT_TLS_CA_PATH=/etc/mosquitto/certs/ca.crt
MQTT_TLS_CERT_PATH=
MQTT_TLS_KEY_PATH=
MQTT_TLS_SERVERNAME=192.168.0.28
MQTT_TLS_REJECT_UNAUTHORIZED=1
```

`configs/mosquitto-tls.conf.example` definisce un profilo TLS Mosquitto con:

- listener `8883`;
- anonymous disabilitato;
- password file e ACL file obbligatori;
- `cafile`, `certfile`, `keyfile`;
- `tls_version tlsv1.2`;
- persistenza broker attiva.

`npm run check:mqtt-tls:report` valida staticamente che il profilo TLS non
parta senza certificato, chiave, CA, autenticazione e ACL.

Per un test live completo usare gli stessi canary 14G/14H puntando
`MQTT_LIVE_CANARY_BROKER_URL` o `MQTT_RETAINED_CANARY_BROKER_URL` a
`mqtts://host:8883` e configurando la CA tramite `MQTT_TLS_CA_PATH`.
