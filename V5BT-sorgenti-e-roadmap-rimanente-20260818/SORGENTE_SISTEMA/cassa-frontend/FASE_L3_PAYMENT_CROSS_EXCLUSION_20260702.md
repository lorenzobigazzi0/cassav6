# Fase L3 - scioglimento payment lane

Data: 2026-07-02

## Obiettivo

Aprire il terzo e ultimo passo della Fase L: permettere a `paymentLane` di non
escludersi piu' con le altre domain lane, mantenendo esclusiva la coda globale
storica `dbMutationQueue`.

Il comportamento resta protetto da flag:

```env
LANE_CROSS_EXCLUSION_PAYMENTS=0
```

Default: `1`, quindi comportamento storico invariato se il flag non viene
esplicitamente spento.

## Modifiche

- `backend/server.js`
  - Aggiunto flag `LANE_CROSS_EXCLUSION_PAYMENTS`.
  - Aggiunti helper:
    - `paymentLanePeerRunningForDomainLanes()`
    - `domainLanePeerRunningForPaymentLane()`
  - `reservationLane`, `notificationLane`, `stationStateLane`, `orderSyncLane`
    e `roomLane` usano il nuovo helper invece di leggere direttamente
    `paymentLaneRunning`.
  - `canSchedulePaymentLaneBatch()` mantiene il blocco su:
    - `dbMutationQueueRunning`
    - `paymentLaneRunning`
  - Con L3 attiva, `paymentLane` puo' ignorare `orderSyncLane`, `roomLane`,
    `reservationLane`, `notificationLane` e `stationStateLane`.

- `backend/tests/route-policy-architecture.test.mjs`
  - Aggiunto guardrail statico Fase L3 sul flag e sullo scioglimento
    payment-vs-domain-lanes.

## Invarianti mantenuti

- Default runtime conservativo: senza `LANE_CROSS_EXCLUSION_PAYMENTS=0` non
  cambia il comportamento operativo.
- `paymentLane` resta seriale rispetto a se stessa.
- `dbMutationQueue` resta esclusiva verso tutto.
- I blocchi L1 e L2 restano indipendenti:
  - `LANE_CROSS_EXCLUSION_ORDERS=0`
  - `LANE_CROSS_EXCLUSION_TABLES=0`
- La metrica `crossDomainConcurrencyFamiliesActiveMax` resta la verifica runtime
  per il canary.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs backend/tests/runtime-metrics.test.mjs
```

Risultato: 15/15 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/concurrency-cas-regression.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/fiscal-optimism-boundary.e2e.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs backend/tests/relational-payments.test.mjs backend/tests/relational-payments-reports-read-primary.test.mjs backend/tests/relational-payments-ticket-write-primary.test.mjs backend/tests/relational-payments-table-write-primary.test.mjs backend/tests/relational-payments-free-split-write-primary.test.mjs backend/tests/relational-fiscal-command-write-primary.test.mjs backend/tests/relational-fiscal-receipts-write-primary.test.mjs backend/tests/orders-payments-invariants.test.mjs backend/tests/table-structure-updates.e2e.test.mjs backend/tests/relational-reservations-lock-write-primary.test.mjs backend/tests/relational-reservations-read-primary.test.mjs backend/tests/reservations-status.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs backend/tests/settlement-ledger.test.mjs
```

Risultato: 145/145 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/*.mjs
```

Risultato: 980/980 pass.

Durata full run: 803.881 ms, circa 13m24s.

## Nota di verifica operativa

In questa sessione non e' stato eseguito un canary live con i flag L1+L2+L3
attivi su storage MySQL operativo. La verifica locale ha coperto:

- guardrail statici L1/L2/L3;
- metrica runtime cross-domain;
- fiscal boundary;
- weird payments e replay fiscale;
- K3-K7 pagamenti/fiscale relazionale;
- invarianti ordini/pagamenti;
- tavoli, prenotazioni e waiter routing;
- settlement ledger;
- full backend gate.

## STOP/REVIEW

L3 e' tecnicamente pronta per canary controllato. Per chiudere davvero la Fase L
in ambiente operativo:

1. Avviare canary con:
   - `LANE_CROSS_EXCLUSION_ORDERS=0`
   - `LANE_CROSS_EXCLUSION_TABLES=0`
   - `LANE_CROSS_EXCLUSION_PAYMENTS=0`
2. Monitorare `crossDomainConcurrencyFamiliesActiveMax`.
3. Eseguire traffico misto ordine + prenotazione + cambio sala + pagamento +
   fiscal retry.
4. Confermare equivalenza shadow e assenza di regressioni su saldi, ricevute,
   idempotenza e code.
5. Solo dopo canary verde aprire Fase M.
