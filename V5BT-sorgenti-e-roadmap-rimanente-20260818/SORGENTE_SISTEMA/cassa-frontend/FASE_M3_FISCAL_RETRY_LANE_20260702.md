# Fase M3 - fiscal retry lane dedicata

Data: 2026-07-02

## Obiettivo

Isolare i retry fiscali POS pendenti in una corsia dedicata, separata dai
percorsi caldi di ordini, pagamenti, notifiche, tavoli e postazioni.

Prima di M3 i job fiscali asincroni venivano avviati con timer/promesse sparse:
le scritture DB erano protette da `withDbMutation`, ma lo scheduling di status,
receipt e reprint non aveva una lane misurabile e non esponeva pressione/runtime
dedicati.

## Modifiche

- `backend/server.js`
  - Aggiunta `fiscalRetryLane` basata su `createSerializedMutationLane`.
  - Aggiunti flag canary:
    - `LANE_FISCAL_RETRY=0`
    - `FISCAL_RETRY_LANE_ENABLED=0`
  - Aggiunti parametri runtime:
    - `FISCAL_RETRY_LANE_CONCURRENCY` default `1`, max `4`
    - `FISCAL_RETRY_LANE_BURST` default `8`, max `40`
  - `schedulePosFiscalReceiptBackgroundJob()` ora accoda i job receipt POS nella
    lane fiscale con chiave `fiscal-receipt:<paymentId>`.
  - `schedulePosFiscalReprintBackgroundJobs()` ora accoda le ristampe POS nella
    lane fiscale con chiave `fiscal-reprint:<paymentId>:<receiptId>`.
  - La deduplica in-flight copre anche il tempo in cui il job e' in attesa nella
    lane, non solo la finestra di esecuzione.
  - La lane fiscale non entra in `domainLaneRunningCount()`: non blocca le corsie
    real time di ordini, pagamenti, sale, reservation, notifiche e station state.
  - Le scritture DB interne ai job fiscali continuano a passare da
    `withDbMutation`.

- `backend/modules/runtime-metrics.js`
  - Aggiunto counter:
    - `fiscalRetryLaneEnqueued`
  - Aggiunti gauge:
    - `fiscalRetryLaneDepth`
    - `fiscalRetryLaneRunning`
  - Aggiunti istogrammi wait/run:
    - `runtimeMetrics.queues.fiscalRetryLane.waitMsByLabel`
    - `runtimeMetrics.queues.fiscalRetryLane.runMsByLabel`

- Test aggiornati:
  - `backend/tests/runtime-metrics.test.mjs`
    - snapshot e bucket per `fiscalRetryLane`;
  - `backend/tests/pos-fiscal-retry.e2e.test.mjs`
    - retry POS emesso tramite lane e metriche runtime verificate;
  - `backend/tests/route-policy-architecture.test.mjs`
    - guardrail statico su flag, counter, scheduling receipt/reprint e isolamento
      da `domainLaneRunningCount()`.

## Invarianti mantenuti

- Il pagamento resta confermato una sola volta: il retry fiscale non crea un
  secondo incasso.
- Una ricevuta POS gia emessa non viene duplicata.
- La finestra retry fino alle 05:00 continua a marcare `EXPIRED` senza chiamare
  il gateway fiscale quando scaduta.
- Le ristampe POS restano deduplicate per `paymentId + receiptId`.
- La lane fiscale e' misurabile ma non partecipa ai blocchi cross-domain del
  real time.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
```

Risultato: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/runtime-metrics.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs
```

Risultato: 7/7 pass.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/*.mjs
```

Risultato: 987/987 pass.

Durata full run: `duration_ms=789320.137269`, circa 789,3s / 13m09s.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/route-policy-architecture.test.mjs backend/tests/runtime-metrics.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs
```

Risultato post-guardrail: 22/22 pass.

## Verifica operativa consigliata

Nel canary reale controllare:

- `runtimeMetrics.counters.fiscalRetryLaneEnqueued`
- `runtimeMetrics.gauges.fiscalRetryLaneDepth`
- `runtimeMetrics.gauges.fiscalRetryLaneRunning`
- `runtimeMetrics.queues.fiscalRetryLane.waitMsByLabel`
- `runtimeMetrics.queues.fiscalRetryLane.runMsByLabel`

Se il gateway fiscale rallenta o cade, la pressione deve accumularsi sulla lane
fiscale e non sulle corsie calde di ordini/postazioni/notifiche.

## STOP/REVIEW

M3 e' chiusa lato codice e test. Il prossimo passo naturale della Fase M puo'
procedere sulla dashboard/lettura operativa delle metriche residue.
