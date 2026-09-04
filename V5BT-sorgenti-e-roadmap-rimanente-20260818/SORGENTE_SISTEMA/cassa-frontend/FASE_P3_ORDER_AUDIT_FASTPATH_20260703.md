# Fase P3 - Order audit fast path

Data: 2026-07-03

## Esito

Step completato, P3 resta in hardening.

La diagnostica `orderWorkflowStep` ha individuato `auditRecent` come costo
dominante nel fast path ordini. Il writer ordini ora sincronizza gli audit
aggiunti dalla singola mutazione tramite ID espliciti, senza riscrivere ogni
volta una finestra fissa di 64 eventi.

## Correzioni applicate

- Aggiunte metriche per-step `orderWorkflowStep:*` dentro
  `writeIntegrationOrderSyncDb`.
- Aggiunto `syncEntriesFromAppState(appState, eventIds)` ai repository split
  audit MySQL e SQLite.
- `orders/create` e `orders/sync` calcolano `auditEventIds` da
  `db.auditEvents.slice(auditStartIndex)` e li passano a
  `writeIntegrationOrderSyncDb`.
- `syncOrderAuditEventsFastPath` preferisce `syncEntriesFromAppState`; usa
  `syncRecentFromAppState` solo come fallback.

## Verifiche automatiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test \
  cassa-frontend/backend/tests/app-state-repository.test.mjs \
  cassa-frontend/backend/tests/runtime-metrics.test.mjs \
  cassa-frontend/backend/tests/route-policy-architecture.test.mjs \
  cassa-frontend/backend/tests/architecture-line-budget.test.mjs \
  cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs \
  cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs
```

Risultato: 68/68 pass.

`backend/server.js`: 38.792 righe, sotto budget.

## Evidenza load ridotto

Run/snapshot usati:

- Prima: `logs/loadtest-phaseP_load-50-p3-ordersteps/runtime-metrics-midrun.json`
- Dopo: `logs/loadtest-phaseP_load-50-p3-auditids/runtime-metrics-midrun.json`

| Metrica | Prima | Dopo |
|---|---:|---:|
| `orders.create.auditRecent` avg | 647.95 ms | 173.95 ms |
| `orders.sync.auditRecent` avg | 449.27 ms | 94.33 ms |
| `orders.create.appStateWrite` avg | 1133.61 ms | 556.61 ms |
| `orders.sync.appStateWrite` avg | 1186.15 ms | 838.67 ms |
| `orders/create` lane run avg | 1057.98 ms | 753.85 ms |
| `orders/sync` lane run avg | 1045.35 ms | 842.57 ms |

## Diagnosi aggiornata

Il collo audit e' stato ridotto in modo significativo. La coda `order-lane`
resta ancora alta sotto burst `load-50`, quindi P3 non e' completata.

Il prossimo collo misurato e':

- `orderWorkflowStep:orders.sync.mysql.notifications`: avg 550.67 ms
- `orderWorkflowStep:orders.sync.mysql.orders`: avg 338.76 ms

## Prossimo step

Ottimizzare il sync notifiche legato a `orders/sync`:

- evitare full sync di `integration.notifications` quando viene creata una sola
  notifica `order_ready`;
- passare gli ID notifica appena creati e sincronizzare solo quelli;
- mantenere fallback full sync per i casi non identificabili.
