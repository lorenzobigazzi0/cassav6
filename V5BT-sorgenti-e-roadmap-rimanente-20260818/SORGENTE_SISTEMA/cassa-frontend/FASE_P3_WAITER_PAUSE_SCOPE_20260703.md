# Fase P3 - Waiter Pause Write Scope

Data: 2026-07-03

## Obiettivo

Ridurre il rischio di retry/lock sui percorsi `waiter.pause.start` e
`waiter.pause.stop`, emersi come rumore residuo dopo i canary P3 sugli ordini.

## Modifica

- Aggiunto `writeWaiterPauseDb` in `backend/server.js`.
- In MySQL split mode la pausa cameriere non forza piu la scrittura completa
  del dominio `integration`.
- Il fast path sincronizza solo:
  - `integration.waiterPauses`
  - `integration.waiterDeferredCalls`
  - `integration.lastWriteAt`
- Sessioni e audit restano persistiti tramite `writeNotificationDb` con scope
  `sessions` e `auditEvents`.
- Fallback non MySQL invariato: `integration`, `sessions`, `auditEvents`.

## Guardrail

Aggiornato `backend/tests/route-policy-architecture.test.mjs` per proteggere il
nuovo fast path:

- `status` pausa resta read-only.
- `start` e `stop` restano in `waiterPauseLane`.
- `start` e `stop` devono usare `writeWaiterPauseDb`.
- Il fast path deve restare puntuale sui tre campi `integration` sopra.

## Verifiche statiche

Comandi:

```bash
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node --test cassa-frontend/backend/tests/waiter-pauses.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs
```

Esito:

- `node --check`: OK
- test mirati: 49/49 pass
- `server.js`: 38.797 righe split, margine M5 703 righe su 39.500

## Smoke carico

Run:

`phaseP_interinale_p3_waiter_pause_scope_smoke_20`

Configurazione:

- 20 palmari API
- 10 postazioni API
- 0 GUI Playwright
- 20 operazioni per device
- stampa fisica disabilitata
- fiscale reale non chiamato

Sintesi:

- durata: 79 s
- business ops: 600
- HTTP requests: 1496
- failure: 0
- fiscal attempts: 0
- DB approx written: 56.45 MB
- rows inserted/updated/deleted: 2613 / 5249 / 658

Metriche rilevanti:

- `waiter.pause.start`: count 9, fail 0, p50 1193 ms, p95 1961 ms, max 3511 ms
- `waiter.pause.stop`: count 9, fail 0, p50 2380 ms, p95 3114 ms, max 3201 ms
- `waiterPauseLaneEnqueued`: 18
- log backend: nessun retry/deadlock/timeout su `waiter.pause.*`
- resta 1 attesa lunga in `waiterPauseLane` su stop, collegata alla pressione
  generale delle lane, non a fallimento DB

## Esito

Il passo e' promosso rispetto al problema target: i percorsi pausa cameriere
non producono retry nel campione e non fanno piu scritture ampie del dominio
`integration`.

Resta fuori scope di questo step la pressione generale su:

- `orderLane`
- `paymentLane`
- `reservationLane`
- `station.heartbeat`

Questi restano i candidati per i prossimi step P3.

## Artefatti

- Report load test: `logs/loadtest-phaseP_interinale_p3_waiter_pause_scope_smoke_20/REPORT.md`
- Report JSON: `logs/loadtest-phaseP_interinale_p3_waiter_pause_scope_smoke_20/report.json`
- Log backend: `logs/loadtest-phaseP_interinale_p3_waiter_pause_scope_smoke_20/backend.log`
