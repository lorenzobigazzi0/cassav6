# Fase L2 - scioglimento room/reservation lane

Data: 2026-07-02

## Obiettivo

Aprire il secondo passo della Fase L: permettere a `roomLane` e
`reservationLane` di non escludersi piu' a vicenda, senza aprire ancora
`paymentLane`.

Il comportamento resta protetto da flag:

```env
LANE_CROSS_EXCLUSION_TABLES=0
```

Default: `1`, quindi comportamento storico invariato se il flag non viene
esplicitamente spento.

## Modifiche

- `backend/server.js`
  - Aggiunto flag `LANE_CROSS_EXCLUSION_TABLES`.
  - Aggiunti helper:
    - `roomLanePeerRunningForReservationLane()`
    - `reservationLanePeerRunningForRoomLane()`
  - `reservationLane` non considera piu' `roomLaneRunning` come peer bloccante
    quando L2 e' attiva.
  - `canScheduleRoomLaneBatch()` non considera piu'
    `reservationLane.runningCount()` come peer bloccante quando L2 e' attiva.

- `backend/tests/route-policy-architecture.test.mjs`
  - Aggiunto guardrail statico Fase L2 sul flag e sul blocco reciproco
    room/reservation.

## Invarianti mantenuti

- Default runtime conservativo: senza `LANE_CROSS_EXCLUSION_TABLES=0` non
  cambia il comportamento operativo.
- `paymentLane` resta esclusiva verso tutte le altre lane.
- `notificationLane` resta peer bloccante rispetto a room/reservation.
- `stationStateLane` resta peer bloccante.
- `dbMutationQueue` resta il fallback globale esclusivo per route non migrate.
- L1 resta indipendente e governata da `LANE_CROSS_EXCLUSION_ORDERS=0`.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs backend/tests/runtime-metrics.test.mjs
```

Risultato: 14/14 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/concurrency-cas-regression.e2e.test.mjs backend/tests/relational-reservations-lock-write-primary.test.mjs backend/tests/relational-reservations-read-primary.test.mjs backend/tests/relational-reservations.test.mjs backend/tests/relational-room-change-request-write-primary.test.mjs backend/tests/relational-table-room-move-request-write-primary.test.mjs backend/tests/table-structure-updates.e2e.test.mjs backend/tests/reservations-status.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs
```

Risultato: 54/54 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/*.mjs
```

Risultato: 979/979 pass.

Durata full run: 811.891 ms, circa 13m32s.

## Nota di verifica operativa

In questa sessione non e' stato eseguito un canary live con
`LANE_CROSS_EXCLUSION_TABLES=0` attivo su storage MySQL operativo. La verifica
locale ha coperto:

- guardrail statici L1/L2;
- concorrenza CAS K-PRE;
- reservations read/write primary;
- room-change e table-room-move write-primary;
- tavoli complessi e cambio sala;
- waiter routing e notifiche collegate;
- full backend gate.

## STOP/REVIEW

L2 e' pronta per canary controllato. Prima di procedere a L3:

1. Avviare canary con `LANE_CROSS_EXCLUSION_ORDERS=0` e
   `LANE_CROSS_EXCLUSION_TABLES=0`.
2. Tenere `LANE_CROSS_EXCLUSION_PAYMENTS=1`.
3. Monitorare `crossDomainConcurrencyFamiliesActiveMax`.
4. Eseguire traffico misto room-change + reservations + order create/sync.
5. Confermare equivalenza shadow e assenza di regressioni su tavoli, prenotazioni
   e notifiche.
