# Fase P3 v5 - Route fallback scope reservation

Data: 2026-07-03

## Obiettivo

Proseguire la roadmap `CASSAv4_ROADMAP_v5_FASE_P` dopo il secondo load-50
post-fix: il run `phaseP_v5_p314_reservation_scope_50_b` ha confermato zero
failure utente, ma ha riaperto un retry app-state su:

- `route:POST /api/pos/reservations/status.appStateWrite`
- stage `beforeWrite`
- causa `transientDbError`

## Modifiche

- Le write senza `metricLabel` nate dentro le route prenotazioni non cadono piu'
  nel fallback `route:*` con default full-domain.
- `applyRouteFallbackWriteScope` assegna label leggibili
  `reservations.<azione>.routeFallback.appStateWrite`.
- Lo scope di queste write fallback e' limitato a `sessions`, lasciando alle
  write esplicite `reservations.status/create/...` la sincronizzazione dei
  domini prenotazione reali.
- Il simulatore load-50 classifica `order.comp` con tavolo cambiato dopo submit
  come race recuperabile, come gia' faceva `order.correct`.

## Evidenza

### Run pre-fix

Run: `logs/loadtest-phaseP_v5_p314_reservation_scope_50_b/report.json`

- Business ops: 1260
- Failure: 0
- Retry app-state: 1
- Causa: `appStateWriteRetry:route:POST /api/pos/reservations/status.appStateWrite.stage.beforeWrite.transientDbError`

### Run post-fix intermedio

Run: `logs/loadtest-phaseP_v5_p314_routefallback_50/report.json`

- Business ops: 1260
- Retry app-state reservation fallback: assente
- Failure: 1, poi classificata come race attesa del simulatore:
  `order.comp` su tavolo cambiato dopo submit.

### Run post-fix finale

Run: `logs/loadtest-phaseP_v5_p314_routefallback_50_final/report.json`

- Business ops: 1260
- Failure: 0
- RT fiscale virtuale: 4/4 successi HTTP
- `route:POST /api/pos/reservations/status.appStateWrite`: assente
- `reservations.status.routeFallback.appStateWrite`: 57 campioni, avg 80.70 ms
- `appStateWriteRetry`: assente
- `Hook pre-write app-state`: assente
- Code finali `dbMutation/orderLane`: 0 / 0

Residui osservati:

- 1 retry ordine MySQL transient su `integration.orders.entries.errorStage.orderStationIndex.transientDbError`
- 1 retry station-state MySQL transient
- Latenze ancora fuori gate P3:
  - `order.create` p95 25247 ms
  - `order.sync.ready` p95 25251 ms
  - `payment.free_split` p95 13613 ms
  - `reservation.create` p95 13701 ms

## Test

- `node --check cassa-frontend/backend/server.js`: OK
- `node --check cassa-frontend/scripts/loadtest-full-capacity.mjs`: OK
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs`: 37/37 pass
- `node --test cassa-frontend/backend/tests/app-state-repository.test.mjs --test-name-pattern='retry|split domains|dirty'`: 38/38 pass
- Budget `server.js`: 38797 righe su 39500, margine 703

## Stato P3

Lo specifico retry app-state reservation fallback e' corretto. P3 non e' ancora
chiusa: il prossimo collo e' di nuovo `orderStationIndex` con retry residuo
singolo e, soprattutto, la latenza strutturale della order-lane sotto load-50.

Prossimo passo consigliato:

- riprendere P3.14 sullo stage `orderStationIndex` residuo, questa volta
  concentrandosi su coalescing/batching della mutazione ordine o riduzione delle
  sync multiple della stessa comanda nella stessa finestra di burst;
- tenere separato il problema retry dal problema latenza, perche' il run finale
  e' corretto funzionalmente ma non soddisfa i gate numerici P3.
