# Fase P3 - Order fulfillment history fast path

Data: 2026-07-03

## Esito

Step completato, P3 resta in hardening.

Dopo il fast path notifiche il collo piu' evidente nello snapshot era
`orderWorkflowStep:orders.sync.mysql.fulfillmentHistory`. La mutazione
`orders/sync` puo' generare un solo evento di storico quando una comanda passa a
`ready` o `delivered`, ma il writer risincronizzava tutto
`integration.orderFulfillmentHistory`.

Il writer ordini ora sincronizza solo l'evento appena creato e aggiorna
separatamente `fulfillmentAnomalyStats`.

## Correzioni applicate

- Aggiunto `syncOrderFulfillmentHistoryFastPath(db, fulfillmentHistoryIds)`.
- Il fast path usa `syncObjectArrayEntriesFromAppState(db, "integration",
  "orderFulfillmentHistory", ids)` quando l'ID dell'evento e' noto.
- `orders/sync` passa `fulfillmentHistoryIds` con l'ID dell'evento appena
  creato.
- Aggiunto fallback full sync quando lo storico era gia' al limite
  `INTEGRATION_MAX_ORDER_FULFILLMENT_HISTORY`, cosi' le righe potate vengono
  rimosse anche dal domain split.
- `fulfillmentAnomalyStats` resta sincronizzato ad ogni evento.

## Verifiche automatiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test \
  cassa-frontend/backend/tests/app-state-repository.test.mjs \
  cassa-frontend/backend/tests/runtime-metrics.test.mjs \
  cassa-frontend/backend/tests/route-policy-architecture.test.mjs \
  cassa-frontend/backend/tests/architecture-line-budget.test.mjs \
  cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs \
  cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs \
  cassa-frontend/backend/tests/notifications-persistence.e2e.test.mjs \
  cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs
```

Risultato: 91/91 pass.

`backend/server.js`: 38.782 righe, sotto budget.

## Evidenza load ridotto

Run/snapshot usato:

- `logs/loadtest-phaseP_load-50-p3-fulfillmentids/runtime-metrics-midrun.json`

| Metrica | Prima | Dopo |
|---|---:|---:|
| `orders.sync.mysql.fulfillmentHistory` avg | 361.25 ms | 94.58 ms |
| `orders.sync.mysql.fulfillmentHistory` max | 992 ms | 216 ms |
| `orders.sync.appStateWrite` avg | 712.76 ms | 666.69 ms |
| `orders.sync.mysql.orders` avg | 286.35 ms | 315.51 ms |
| `orders.sync.auditRecent` avg | 191.84 ms | 175.38 ms |
| `orders.sync.mysql.notifications` avg | 89.17 ms | 120.89 ms |

## Diagnosi aggiornata

Il collo fulfillment e' stato ridotto. Nel nuovo snapshot il costo maggiore tra
i sotto-step ordini e':

- `orderWorkflowStep:orders.sync.mysql.orders`: avg 315.51 ms
- `orderWorkflowStep:orders.create.mysql.orders`: avg 200.13 ms
- `orderWorkflowStep:orders.create.auditRecent`: avg 180.74 ms

La pressione residua P3 e' quindi soprattutto sul write puntuale
`integration.orders` e sulla concorrenza della `order-lane`, non piu' sullo
storico fulfillment.

## Prossimo step

Continuare P3 valutando il costo del write `integration.orders`:

- misurare se il costo viene da checksum/diff della singola riga o dagli indici
  `order_station`;
- ridurre il lavoro dell'indice quando la stazione della comanda non cambia;
- mantenere fallback full sync e guardrail statici.
