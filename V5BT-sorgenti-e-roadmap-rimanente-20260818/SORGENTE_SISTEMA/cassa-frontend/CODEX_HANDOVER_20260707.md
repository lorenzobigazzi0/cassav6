# CASSAv4 Codex handover - 2026-07-07

## Workspace

Root corrente in questa sessione Linux:

```text
/home/sentrapa/Desktop/sistemacassav4/estratto/full-frontend-source-handover-20260707-184442/cassa-frontend
```

Questo checkout non risulta un repository git valido nella sessione corrente:
usare verifica filesystem/zip e test npm invece di `git status`.

## Obiettivo corrente

Roadmap near-realtime CASSAv4, blocco MQTT Step 14.

MQTT deve restare fanout realtime LAN da `event_outbox`.
Non deve diventare sorgente di verita', non deve sostituire MySQL e non deve
abilitare comandi critici finche' `command_inbox` non e' stabile.

## Stato roadmap

Completati e validati:

- Step 14A - MQTT bridge foundation.
- Step 14B - Canary broker embedded.
- Step 14C - Reconnect broker.
- Step 14D - Fanout 100 client.
- Step 14E - Mosquitto ACL policy.
- Step 14F - Reconnect storm multi-device.
- Step 14G - Mosquitto live canary con credenziali esterne.
- Step 14H - Retained persistence canary.
- Step 14I - TLS/mqtts policy.
- Step 15 - MQTT command gate default-off: `MQTT_COMMANDS_ENABLED=1` e' solo
  richiesta; effettiva abilitazione solo con command-inbox enforce/write e
  `MQTT_COMMAND_ACK_ENABLED=1`.
- Step 16 - Installazione locale Mosquitto/Redis su questa macchina:
  Mosquitto `192.168.1.182:1883`, Redis `127.0.0.1:6379`, canary live 14G/14H
  e test Redis Step 10 validati.
- Step 17 - MQTT command pilot foundation: modulo default-off per
  `notifications.ack`, con `command_inbox` e ACK MQTT su
  `pos/{storeId}/events/commands/{deviceId}/{requestId}`. Non e' ancora
  collegato al runtime principale.

Report principali:

```text
reports/STEP_14A_MQTT_BRIDGE_FOUNDATION_REPORT.md
reports/STEP_14B_MQTT_BRIDGE_CANARY_REPORT.md
reports/STEP_14C_MQTT_BRIDGE_RECONNECT_REPORT.md
reports/STEP_14D_MQTT_BRIDGE_100_CLIENT_FANOUT_REPORT.md
reports/STEP_14E_MQTT_MOSQUITTO_ACL_POLICY_REPORT.md
reports/STEP_14F_MQTT_RECONNECT_STORM_REPORT.md
reports/STEP_14G_MQTT_MOSQUITTO_LIVE_CANARY_REPORT.md
reports/STEP_14H_MQTT_RETAINED_PERSISTENCE_REPORT.md
reports/STEP_14I_MQTT_TLS_POLICY_REPORT.md
reports/STEP_15_MQTT_COMMAND_GATE_REPORT.md
reports/STEP_16_LOCAL_MQTT_REDIS_INSTALL_REPORT.md
reports/STEP_17_MQTT_COMMAND_PILOT_FOUNDATION_REPORT.md
```

Documento operativo principale:

```text
docs/mqtt-bridge-step14.md
```

## File chiave modificati/aggiunti

Bridge/runtime:

```text
backend/modules/realtime-backbone/mqtt-bridge.js
backend/modules/realtime-backbone/mqtt-command-pilot.js
backend/tests/mqtt-bridge.test.mjs
backend/tests/mqtt-command-pilot.test.mjs
```

Canary e policy MQTT:

```text
scripts/mqtt-bridge-canary.mjs
scripts/mqtt-bridge-reconnect-canary.mjs
scripts/mqtt-bridge-load-canary.mjs
scripts/mqtt-bridge-storm-canary.mjs
scripts/mqtt-acl-policy-check.mjs
scripts/mqtt-mosquitto-live-canary.mjs
scripts/mqtt-retained-persistence-canary.mjs
scripts/mqtt-tls-policy-check.mjs
```

Test:

```text
backend/tests/mqtt-acl-policy.test.mjs
backend/tests/mqtt-bridge-canary.e2e.test.mjs
backend/tests/mqtt-bridge-reconnect-canary.e2e.test.mjs
backend/tests/mqtt-bridge-load-canary.e2e.test.mjs
backend/tests/mqtt-bridge-storm-canary.e2e.test.mjs
backend/tests/mqtt-mosquitto-live-canary.e2e.test.mjs
backend/tests/mqtt-retained-persistence-canary.e2e.test.mjs
backend/tests/mqtt-tls-policy.test.mjs
```

Config:

```text
configs/near-realtime-mqtt.env.example
configs/mosquitto.conf.example
configs/mosquitto.acl.example
configs/mosquitto-tls.conf.example
docs/mqtt-command-gate-step15.md
docs/mqtt-command-pilot-step17.md
.gitignore
package.json
package-lock.json
```

## Comandi verificati

Ultima validazione locale:

```bash
npm run check:mqtt-tls:report
npm run check:mqtt-command-gate:report
npm run test:phase15
npm run test:phase17
npm run test:phase14i
npm run check:backend
```

Risultati:

```text
check:mqtt-tls:report: OK
test:phase17: OK, 35/35 test passati
test:phase14i: OK, 32/32 test passati
check:backend: OK
```

Per verificare tutto il blocco MQTT su un altro PC:

```bash
npm install
npm run test:phase14i
npm run check:mqtt-acl:report
npm run check:mqtt-tls:report
npm run check:backend
```

## Canary live da eseguire solo con broker reale pronto

Questi richiedono credenziali/certificati reali fuori repo.

Mosquitto ACL live:

```bash
npm run canary:mqtt-mosquitto-live:report
```

Retained persistence live:

```bash
npm run canary:mqtt-retained-persistence:publish
# riavviare manualmente Mosquitto reale
npm run canary:mqtt-retained-persistence:verify
npm run canary:mqtt-retained-persistence:clear
```

TLS live:

```env
MQTT_LIVE_CANARY_BROKER_URL=mqtts://192.168.0.28:8883
MQTT_TLS_CA_PATH=/etc/mosquitto/certs/ca.crt
MQTT_TLS_SERVERNAME=192.168.0.28
MQTT_TLS_REJECT_UNAUTHORIZED=1
```

## Variabili importanti

Runtime MQTT:

```env
MQTT_ENABLED=1
MQTT_EVENTS_ENABLED=1
MQTT_COMMANDS_ENABLED=0
MQTT_COMMAND_ACK_ENABLED=0
MQTT_RETAINED_STATE_ENABLED=1
MQTT_URL=mqtt://127.0.0.1:1883
MQTT_STORE_ID=default
```

Variabili locali generate su questa macchina, fuori repo:

```text
/home/sentrapa/Desktop/sistemacassav4/runtime-secrets/cassav4-mqtt-redis.env
```

Non copiare questo file dentro zip/versionamenti pubblici: contiene password
MQTT locali.

TLS opzionale:

```env
MQTT_TLS_ENABLED=1
MQTT_URL=mqtts://192.168.0.28:8883
MQTT_TLS_CA_PATH=/etc/mosquitto/certs/ca.crt
MQTT_TLS_CERT_PATH=
MQTT_TLS_KEY_PATH=
MQTT_TLS_SERVERNAME=192.168.0.28
MQTT_TLS_REJECT_UNAUTHORIZED=1
```

Non committare mai:

```text
certs/
certificates/
*.key
*.pem
*.crt
*.csr
rootCA-key.pem
```

## Prossimi punti consigliati

1. Eseguire `canary:mqtt-mosquitto-live:report` contro Mosquitto reale con
   password file/ACL effettivi.
2. Eseguire `canary:mqtt-retained-persistence:publish`, restart manuale del
   broker, `:verify`, poi `:clear`.
3. Se si usa TLS reale, puntare i canary a `mqtts://host:8883` e impostare
   `MQTT_TLS_CA_PATH`.
4. Non abilitare `MQTT_COMMANDS_ENABLED=1` finche' non viene definito e testato
   il wiring runtime del pilot Step 17 dietro gate Step 15, command-inbox, ACK
   e idempotenza.
5. Prossimo passo codice: collegare `mqtt-command-pilot.js` al bridge/runtime
   solo per `notifications.ack`, poi aggiungere un canary broker reale con
   publish comando, verifica `command_inbox`, ACK e replay.

## Contenuto dello zip di handover

Incluso:

- sorgente backend/frontend/test;
- roadmap markdown `FASE_*`;
- `docs/`;
- `reports/`;
- `scripts/`;
- `configs/`;
- `launcher/`;
- `package.json` e `package-lock.json`;
- questo file di handover.

Escluso:

- `node_modules/`;
- `dist/`;
- `logs/`;
- `backups/`;
- file runtime/build rigenerabili;
- certificati, chiavi private e segreti.
