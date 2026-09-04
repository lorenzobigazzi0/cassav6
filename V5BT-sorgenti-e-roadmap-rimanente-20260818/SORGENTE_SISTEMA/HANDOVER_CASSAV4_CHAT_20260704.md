# Handover CASSA V4 - 2026-07-04

Questo file serve per passare il contesto a un'altra chat Codex senza perdere lo stato operativo.

## Percorso di lavoro

Root sorgente attuale:

```text
/home/sentrapa/Desktop/sistemacassav4/estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source
```

Frontend mobile LAN:

```text
https://192.168.1.38:5280/mobile/
```

## Stato runtime corrente

Servizi attivi sulla rete attuale:

```text
0.0.0.0:5280  frontend multiplexer HTTPS  pid 10884
0.0.0.0:5281  backend API               pid 10857
0.0.0.0:8765  battery dashboard/service pid 4821
0.0.0.0:9090  fake automatic cash       pid 10777
```

Processi visti il 2026-07-04:

```text
4821   /home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node server/index.js
10777  /home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node tools/fake-automatic-cash-gateway.mjs
10857  /home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node backend/server.js
10884  /home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node serve-frontends.mjs
```

Env backend verificato in questa sessione:

```text
AUTOMATIC_CASH_GATEWAY_BASE_URL=http://127.0.0.1:9090
AUTOMATIC_CASH_GATEWAY_ENABLED=1
AUTOMATIC_CASH_GATEWAY_USERNAME=amalia
AUTOMATIC_CASH_GATEWAY_PASSWORD=182018
POS_FISCAL_API_BASE_URL=http://192.168.1.200:8765
BATTERY_SERVICE_URL=http://127.0.0.1:8765/battery
```

Nota: il gateway fiscale e ancora puntato al reale `192.168.1.200:8765`; il gateway cassa automatica usato nei test e il simulato locale `127.0.0.1:9090`.

## Login e credenziali operative

Utente app verificato:

```text
username: lorenzo
pin:      1234
ruolo:    admin
id:       u_lorenzo
```

Il PIN di `lorenzo` e stato aggiornato nel DB MySQL in `app_state_domain_records`, dominio `users`, record `u_lorenzo`.
Login reale verificato contro:

```text
POST http://127.0.0.1:5281/api/auth/login
```

Risultato: `ok: true`, token restituito, utente `u_lorenzo`.

Credenziali DB usate localmente:

```text
host: 127.0.0.1
port: 3306
database: cassa
user: cassa_app
password: amalia2026
```

Nota importante: `amalia / 182018` sono credenziali configurate per il gateway simulato/backend, non risultano come login app nel DB attuale.

## Verifiche cassa automatica

Gateway simulato diretto:

```text
GET  http://127.0.0.1:9090/api/health  -> ok
POST http://127.0.0.1:9090/api/login   -> ok, mode FAKE, token presente
```

Gateway tramite backend:

```text
GET http://127.0.0.1:5281/api/automatic-cash/gateway/state?token=...&deviceUuid=...
```

Risultato verificato con sessione `lorenzo`: `ok: true`, `reachable: true`.

Attenzione: molte API del backend non accettano solo `Authorization: Bearer`; `validateSessionContext` richiede `token` e `deviceUuid` nel payload/query gestito dal router.

## Comandi utili

Riavvio completo backend/frontend con cassa automatica simulata:

```bash
cd /home/sentrapa/Desktop/sistemacassav4/estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source
AUTOMATIC_CASH_GATEWAY_BASE_URL=http://127.0.0.1:9090 \
AUTOMATIC_CASH_GATEWAY_ENABLED=1 \
./tools/restart-cassav4-linux.sh
```

Avvio gateway cassa automatica simulato:

```bash
cd /home/sentrapa/Desktop/sistemacassav4/estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source
FAKE_AUTOMATIC_CASH_HOST=0.0.0.0 \
FAKE_AUTOMATIC_CASH_PORT=9090 \
FAKE_AUTOMATIC_CASH_DEPOSIT_TOTAL_CENTS=2000 \
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node tools/fake-automatic-cash-gateway.mjs
```

Avvio battery service:

```bash
cd /home/sentrapa/Desktop/sistemacassav4/estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source/battery-dashboard
HOST=0.0.0.0 PORT=8765 /home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node server/index.js
```

## Roadmap e stato tecnico

Roadmap attiva piu recente chiesta dall'utente:

```text
/home/sentrapa/Downloads/ROADMAP_INTERINALE_P3_LATENZA.md
```

Report tecnici P3 presenti:

```text
cassa-frontend/FASE_P3_STATION_STATE_ENTRY_FASTPATH_20260704.md
cassa-frontend/FASE_P3_ORDER_OUTLIER_ANALYSIS_20260704.md
cassa-frontend/FASE_P3_SECONDARY_ORDER_WRITES_20260704.md
```

Esempi di report load test P3 importanti:

```text
logs/loadtest-phaseP_interinale_p3_station_state_entry_canary8_50/REPORT.md
logs/loadtest-phaseP_interinale_p3_orderlane_capacity16_probe_50/REPORT.md
logs/loadtest-phaseP_interinale_p3_create_idempotency_key_canary8_50/REPORT.md
logs/loadtest-phaseP_interinale_p3_secondary_order_writes_canary8_50/REPORT.md
```

Sintesi P3:

```text
Station-state: retry/fast path migliorato e confermato.
Order p95: ancora alto sotto burst da 50 device, tipicamente 10-18s nei canary.
Outlier analysis: il problema non sembra dipendere solo dalla dimensione payload.
Concurrency order lane 16: provata, peggiora in alcune condizioni; non alzarla alla cieca.
Patch idempotency key create order: testata e poi revertita perche non risolveva il collo.
Prossimo passo consigliato: decisione architetturale su write-primary relazionale o commit asincrono degli ordini.
```

## Test e verifiche recenti da non perdere

Comandi/check ricordati come passati nelle fasi recenti:

```text
node --check cassa-frontend/backend/server.js
node --check cassa-frontend/scripts/loadtest-full-capacity.mjs
route-policy-architecture: 46/46
station-pause-transfer.e2e: 13/13
app-state-repository: 40/40
```

Ultime verifiche fatte per questo handover:

```text
lorenzo / 1234 login backend: ok
gateway simulato diretto 9090: ok
gateway simulato via backend con sessione lorenzo: ok, reachable true
porte 5280, 5281, 8765, 9090: in ascolto su 0.0.0.0
```

## Note operative importanti

1. Se il backend mostra `[fiscal-pos] status non raggiungibile`, non confonderlo con il gateway cassa automatica: il fiscale e configurato su `192.168.1.200:8765`.
2. Per i test richiesti dall'utente, non usare stampante, fiscale o cassa reali salvo istruzione esplicita: usare gateway simulato e stampanti/fiscale virtuali.
3. La rete attuale e `192.168.1.38`; se cambia rete, rifare rilevamento IP e riavviare frontend/backend con URL coerenti.
4. In questo checkout `git status --short` non ha mostrato output al momento del file handover.
5. Se serve cambiare PIN utenti, il record reale e in MySQL `app_state_domain_records`, dominio `users`; aggiornare `raw_json` e `row_hash` con SHA256 del JSON salvato.
6. Non riaprire il collo P3 aumentando semplicemente la concorrenza: i report indicano rischio di peggioramento. Serve ridurre il lavoro sincrono della lane ordine.

## Contesto funzionale da preservare

Richieste utente gia stabilizzate come vincoli:

```text
- "reso senza sostituzione": non deve creare una nuova comanda vuota.
- Il reso deve restare sulla comanda corrente, con riga visibile/neutralizzata.
- In postazione, quantita modificate devono evidenziarsi in rosso e lampeggiare.
- Notifiche pronte/chiamate devono essere il piu possibile realtime.
- Se il target notifica non e online, inviare a chiunque sia online.
- Per test massivi usare simulazioni, non hardware reale.
```

## Priorita consigliata per la prossima chat

1. Confermare runtime con `ss -ltnp | rg ':(5280|5281|8765|9090)'`.
2. Aprire `ROADMAP_INTERINALE_P3_LATENZA.md` e i tre report `FASE_P3_*_20260704.md`.
3. Riprendere dalla fase P3 sul collo ordine, non dalla parte station-state gia trattata.
4. Se il prossimo lavoro riguarda cassa automatica, partire da login `lorenzo / 1234` e gateway simulato `127.0.0.1:9090`.
5. Se si riparte con test load, usare report in `logs/loadtest-phaseP_interinale_p3_*` come baseline.
