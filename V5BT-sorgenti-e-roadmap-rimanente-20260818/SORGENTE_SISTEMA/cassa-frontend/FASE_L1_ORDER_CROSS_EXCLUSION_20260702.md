# Fase L1 - scioglimento order lane

Data: 2026-07-02

## Obiettivo

Aprire il primo passo della Fase L: permettere a `orderSyncLane` di non
escludersi piu' con `roomLane`, `reservationLane` e `notificationLane`, senza
toccare ancora `paymentLane`.

Il comportamento resta protetto da flag:

```env
LANE_CROSS_EXCLUSION_ORDERS=0
```

Default: `1`, quindi comportamento storico invariato se il flag non viene
esplicitamente spento.

## Modifiche

- `backend/server.js`
  - Aggiunto flag `LANE_CROSS_EXCLUSION_ORDERS`.
  - Aggiunti helper:
    - `orderLanePeerRunningForRoomLikeLanes()`
    - `roomLikeLanePeerRunningForOrderLane()`
    - `hasDomainLaneRunning()`
    - `scheduleCrossDomainCompatibleLaneTasks()`
  - `reservationLane` e `notificationLane` non considerano piu'
    `orderSyncLaneRunning` come peer bloccante quando L1 e' attiva.
  - `canScheduleOrderSyncLaneBatch()` non considera piu' `roomLane`,
    `reservationLane` e `notificationLane` come peer bloccanti quando L1 e'
    attiva.
  - `canScheduleRoomLaneBatch()` non considera piu' `orderSyncLane` come peer
    bloccante quando L1 e' attiva.
  - Lo scheduler centrale, quando una lane e' gia' in esecuzione, prova ad
    avviare altre lane compatibili invece di tornare subito.
  - `paymentLane` resta esclusiva verso tutte le altre lane.
  - `dbMutationQueue` resta esclusiva verso tutto.

- `backend/modules/runtime-metrics.js`
  - Aggiunta metrica campionata:
    `crossDomainConcurrencyFamiliesActive`.
  - Aggiunti gauge:
    - `crossDomainConcurrencyFamiliesActive`
    - `crossDomainConcurrencyFamiliesActiveMax`

- `backend/tests/route-policy-architecture.test.mjs`
  - Aggiunto guardrail statico Fase L1 sul flag e sullo scheduler.

- `backend/tests/runtime-metrics.test.mjs`
  - Aggiunto test della metrica di concorrenza cross-domain.

## Invarianti mantenuti

- Default runtime conservativo: senza `LANE_CROSS_EXCLUSION_ORDERS=0` non cambia
  il comportamento operativo.
- `paymentLane` non viene ancora aperta.
- `stationStateLane` resta peer bloccante.
- `dbMutationQueue` resta il fallback globale esclusivo per route non migrate.
- Urgenze in `dbMutationQueue` impediscono l'avvio di nuove lane compatibili.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs backend/tests/route-policy-architecture.test.mjs
```

Risultato: 13/13 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/concurrency-cas-regression.e2e.test.mjs backend/tests/station-pause-transfer.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs backend/tests/table-structure-updates.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs
```

Risultato: 44/44 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/*.mjs
```

Risultato: 978/978 pass.

Durata full run: 798.488 ms, circa 13m18s.

## Nota di verifica operativa

In questa sessione non e' stato eseguito un test live con MySQL/canary e flag
`LANE_CROSS_EXCLUSION_ORDERS=0` attivo su traffico reale: le lane room e
reservation dipendono dalla configurazione storage operativa. La parte locale
ha verificato:

- guardrail statici del nuovo scheduler;
- metrica runtime;
- assenza di regressioni con default conservativo;
- test K-PRE concorrenza CAS;
- test operativi postazioni, tavoli, waiter routing, pagamenti e fiscale;
- full backend gate.

## STOP/REVIEW

L1 e' pronta per canary controllato. Prima di procedere a L2:

1. Avviare una postazione canary con `LANE_CROSS_EXCLUSION_ORDERS=0`.
2. Tenere `paymentLane` esclusiva.
3. Monitorare `crossDomainConcurrencyFamiliesActiveMax`.
4. Eseguire traffico misto ordine + prenotazione + notifica.
5. Confermare equivalenza shadow e assenza di regressioni su code/postazioni.
