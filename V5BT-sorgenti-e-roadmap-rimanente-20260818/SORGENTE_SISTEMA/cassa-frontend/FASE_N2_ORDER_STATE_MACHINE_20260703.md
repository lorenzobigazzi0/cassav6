# Fase N2 - Order state machine esplicita

Data: 2026-07-03

## Obiettivo

Introdurre una macchina a stati canonica per il dominio Ordine, come previsto da
`ROADMAP_REALTIME_CASSAV4_v4.md`, senza rompere il workflow legacy delle
postazioni e mantenendo un flag di rollback canary.

## Modifiche

- Estesa `backend/modules/orders/order-state-machine.js` con stati canonici:
  `draft`, `emitted`, `queued`, `preparing`, `ready`, `delivered`,
  `partially_paid`, `paid`, `cancelled`, `corrected`, `compensated`.
- Aggiunte API di dominio:
  `canTransitionOrderState`, `applyOrderStateTransition`,
  `resolveOrderRuntimeState`, `normalizeOrderState` ed errore esplicito
  `INVALID_ORDER_STATE_TRANSITION`.
- Collegato `ORDER_STATE_MACHINE_ENABLED`, default-on e disattivabile con
  `ORDER_STATE_MACHINE_ENABLED=0`, alla state machine workflow usata dal sync
  ordini da postazione.
- Aggiunto guardrail architetturale N2 in `route-policy-architecture.test.mjs`
  per proteggere flag, wiring server e API del modulo ordini.
- Rafforzati i test tabellari su transizioni valide/invalide, alias legacy e
  proiezione runtime da workflow/pagamenti/correzioni.

## Invarianti protette

- Le retrocessioni di stato ordine restano bloccate per default.
- `preparing -> queued` resta consentito solo con contesto esplicito
  `allowPreparationDemotion`.
- `completedAtMs: null` non viene piu' interpretato come ordine consegnato.
- Se un ordine ha gia' `orderState` canonico salvato, `applyTransition` lo usa
  come sorgente autorevole.
- I resi/correzioni restano rappresentati sullo stato corrente come
  `corrected`/`compensated`; non viene introdotta nessuna creazione implicita di
  comande vuote.

## Verifiche

Sintassi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/orders/order-state-machine.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/order-state-machine.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/route-policy-architecture.test.mjs
```

Risultato: ok.

Test mirati ordine/invarianti/architettura:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/order-state-machine.test.mjs cassa-frontend/backend/tests/orders-flow.e2e.test.mjs cassa-frontend/backend/tests/orders-payments-invariants.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs
```

Risultato: 59/59 pass, durata `duration_ms=32565.953751`.

Test write-primary ordini:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-cancel-write-primary.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-correct-write-primary.e2e.test.mjs cassa-frontend/backend/tests/relational-orders-comp-write-primary.e2e.test.mjs cassa-frontend/backend/tests/relational-order-events-write-primary.e2e.test.mjs
```

Risultato: 6/6 pass, durata `duration_ms=6982.741314`.

## Note operative

Il full gate backend completo non e' stato rilanciato in questa fase; l'ultimo
full gate registrato resta quello post M4 da 991/991 test passati.

## Prossimo step

N3 - Print state machine esplicita.
