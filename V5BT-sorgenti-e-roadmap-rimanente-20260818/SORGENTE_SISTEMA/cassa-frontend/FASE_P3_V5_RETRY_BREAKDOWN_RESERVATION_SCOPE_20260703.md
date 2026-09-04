# Fase P3 v5 - Retry breakdown e scope reservation

Data: 2026-07-03

## Obiettivo

Seguire la roadmap aggiornata `CASSAv4_ROADMAP_v5_FASE_P`: chiudere P3.13
con breakdown per stage dei retry residui e applicare P3.14 sullo stage
dominante, senza promuovere tuning di concorrenza che nasconde la causa.

## Roadmap acquisita

Cartella copiata nel progetto:

- `CASSAv4_ROADMAP_v5_FASE_P/ROADMAP_REALTIME_CASSAV4_v5_FASE_P.md`
- `CASSAv4_ROADMAP_v5_FASE_P/PLAYBOOK_DOMAIN_WRITE_AUDIT.md`

## Modifiche

- `app-state.repository.js` registra i retry app-state per stage e causa:
  `appStateWriteRetry:stage.<stage>.<cause>`.
- Le metriche distinguono anche la label della write:
  `appStateWriteRetry:<metricLabel>.stage.<stage>.<cause>`.
- Le failure del hook `beforeWrite` sono etichettate come
  `appStateWriteHook:*`.
- Runtime metrics conserva sempre le label diagnostiche P3 e quelle
  `appStateWriteRetry` / `appStateWriteHook`.
- I writer dominio hanno metriche stabili:
  `payments.appStateWrite`, `rooms.appStateWrite`,
  `reservations.appStateWrite`, `notifications.appStateWrite`.
- `writeReservationDb` rispetta `splitDomains` espliciti tramite
  `resolveScopedWriteSplitDomains`.
- Il modulo prenotazioni passa domini stretti:
  - create/update: `posReservationStates`, `posReservations`
  - lock acquire/release/lock-state: `posReservationLocks`
  - delete/status senza tavoli: states + locks
  - status con tavoli: states + locks + `posSettings`, `integration`,
    `tableLocks`
- `writeDb` assegna una label diagnostica `route:<METHOD path>.appStateWrite`
  quando una route resta senza `metricLabel`, cosi' i retry generici non
  tornano anonimi come `domains:*`.
- Aggiunto guardrail statico:
  `reservation writes keep explicit split domains for lock-heavy paths`.

## Evidenza P3.13

Run: `logs/loadtest-phaseP_v5_p313_breakdown/report.json`

- Business ops: 1260
- Durata: 257037 ms
- Failure: 0
- Retry ordine: 0
- Deadlock app-state: 0
- `appStateWriteRetry`: assenti
- `orderLane` wait create: media 15629.86 ms, p95 26648 ms
- `orderLane` wait sync: media 16549.07 ms, p95 26742 ms

Conclusione: nessun retry residuo in quel run, ma P3 non chiusa per coda
order-lane ancora alta.

## Probe non promosso

Run: `logs/loadtest-phaseP_v5_p314_orderlane8_probe/report.json`

- Business ops: 1260
- Durata: 230877 ms
- Failure: 0
- Concorrenza order lane: 8
- 1 retry app-state `beforeWrite.transientDbError`
- Label dominante:
  `domains:posReservationStates+posReservationLocks+posReservations+posSettings+integration+auditEvents+tableLocks`

Conclusione: la concorrenza 8 abbassa un po' l'attesa, ma reintroduce un retry
su reservation/table domains. Non promossa come default.

## Fix P3.14 e mini-load

Run: `logs/loadtest-phaseP_v5_p314_route_label_25/report.json`

- Business ops: 760
- Durata: 130946 ms
- Failure: 0
- RT virtuale: 5/5 successi HTTP
- `appStateWriteRetry`: assenti
- `Hook pre-write app-state`: assente
- Un retry transiente station-state gestito dal retry dedicato, fuori dalla
  write app-state P3.14.

## Load-50 post-fix

Run: `logs/loadtest-phaseP_v5_p314_reservation_scope_50/report.json`

- Business ops: 1260
- Durata: 231943 ms
- Failure: 0
- RT virtuale: 1/1 successo HTTP
- `Deadlock found`: assente nel log backend
- `Hook pre-write app-state`: assente
- `Write app-state MySQL in retry`: assente
- `appStateWriteRetry`: assente
- Bytes InnoDB scritti: 242.58 MB
- Righe inserite/aggiornate: 32056 / 20299

Metriche code principali:

- `orderLane` create: media 14215.81 ms, p95 22720 ms
- `orderLane` sync: media 15064.61 ms, p95 23026 ms
- `paymentLane` free-split: media 5345.30 ms, p95 22727 ms
- `reservationLane` create: media 4301.90 ms, p95 12961 ms
- `stationStateLane` state: media 2305.15 ms, p95 5000 ms

## Test

- `node --check cassa-frontend/backend/server.js`: OK
- `node --check cassa-frontend/backend/modules/reservations/reservations.handlers.js`: OK
- `node --check cassa-frontend/backend/tests/route-policy-architecture.test.mjs`: OK
- Suite reservation/app-state/runtime/route-policy: 104/104 pass
- Suite rapida post fallback route label: 75/75 pass
- Budget `server.js`: 38790 righe su 39500, margine 710

## Stato P3

P3.13/P3.14 hanno isolato e rimosso il retry app-state residuo osservato sul
probe reservation. P3 pero' non e' ancora chiusa: il gate latenza resta
violato per attese order-lane intorno a 22-23s p95 sotto load-50.

Prossimo passo consigliato:

- eseguire un secondo load-50 consecutivo post-fix per confermare zero retry
  app-state;
- poi aprire il prossimo collo P3 sulla latenza order-lane, partendo da
  `orderWorkflow:orders.sync.appStateWrite` e pressione incrociata con
  payment/reservation lane.
