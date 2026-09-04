# Fase P3 - Sweep Pagamenti / Free Split

Data: 2026-07-03

## Contesto

Durante il canary a `ORDER_SYNC_FAST_LANE_CONCURRENCY=8`, dopo lo scope di sale/tavoli, i retry app-state non erano piu' su `rooms.*` ma su `payments.appStateWrite`. Lo step ha quindi applicato il playbook di domain-write audit al dominio pagamenti, con stampante e fiscale virtuali.

## Modifiche

- Etichette app-state puntuali per pagamenti tavolo, split libero, ticket/banco, provider POS, comandi fiscali, ricevute fiscali asincrone e ristampe.
- Guardrail test: nessun `await writePaymentDb(db);` nudo nei flussi pagamenti/fiscale.
- Fast path per `payments.freeSplit.complete.appStateWrite`:
  - `integration.orders` sincronizzati per `orderIds` espliciti.
  - `posSettings.tables` sincronizzato per `tableIds` espliciti.
  - `auditEvents` sincronizzato per ID creati dalla singola mutazione.
  - write principale ridotto ai soli domini record pagamento/fiscale/benefit.

## Verifica

Test mirati:

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/modules/payments/payments.handlers.js`
- `node --check cassa-frontend/backend/modules/payments/payment-free-split-fastpath.js`
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs`

Esito: 40/40 pass.

## Canary 8 worker

### Prima diagnosi payment scope

Run: `phaseP_v5_p321_payment_scoped_orderlane8_50`

- Durata: 223.935 ms
- Business ops: 1260
- Failure: 0
- Retry app-state: 1
- Causa: `payments.freeSplit.complete.appStateWrite.beforeWrite.failure.transientDbError`
- `payments.freeSplit.complete`: avg 554.59 ms, p95 <=1000 ms, max 1575 ms

### Dopo fast path free split

Run: `phaseP_v5_p322_free_split_fastpath_orderlane8_50`

- Durata: 232.892 ms
- Business ops: 1260
- Failure: 0
- Retry/deadlock app-state: 0
- `payments.freeSplit.complete`: avg 132.66 ms, p95 <=500 ms, max 548 ms

Run: `phaseP_v5_p323_free_split_fastpath_orderlane8_50_b`

- Durata: 224.844 ms
- Business ops: 1260
- Failure: 0
- Retry/deadlock app-state: 0
- `payments.freeSplit.complete`: avg 135.75 ms, p95 <=500 ms, max 766 ms

## Decisione

La contesa payment/free-split individuata dal canary e' chiusa: due run consecutivi a 8 worker sono puliti lato retry/deadlock app-state.

Non promuovere ancora il default `ORDER_SYNC_FAST_LANE_CONCURRENCY` da 6 a 8: la roadmap v5 richiede anche un gate di latenza ordini, e i p95 `orders/create`/`orders/sync` restano nell'ordine dei secondi sotto load-50. Il prossimo step deve quindi restare su P3, mirando a coda/esecuzione order-lane o coalescing dei sync puntuali, non a P4.

## Artefatti

- `logs/loadtest-phaseP_v5_p321_payment_scoped_orderlane8_50/REPORT.md`
- `logs/loadtest-phaseP_v5_p322_free_split_fastpath_orderlane8_50/REPORT.md`
- `logs/loadtest-phaseP_v5_p323_free_split_fastpath_orderlane8_50_b/REPORT.md`
