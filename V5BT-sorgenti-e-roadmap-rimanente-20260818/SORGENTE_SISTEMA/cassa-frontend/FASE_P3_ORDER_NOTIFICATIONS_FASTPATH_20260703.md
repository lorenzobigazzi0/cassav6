# Fase P3 - Order notifications fast path

Data: 2026-07-03

## Esito

Step completato, P3 resta in hardening.

Il collo individuato nel report precedente era
`orderWorkflowStep:orders.sync.mysql.notifications`, che riscriveva l'intero
array `integration.notifications` anche quando `orders/sync` generava una sola
notifica `order_ready`.

Il writer ordini ora sincronizza le notifiche pronte tramite ID esplicito e usa
il full sync solo come fallback.

## Correzioni applicate

- Aggiunto `syncOrderNotificationsFastPath(db, notificationIds)`.
- Il fast path usa `syncObjectArrayEntriesFromAppState(db, "integration",
  "notifications", ids)` quando gli ID sono disponibili.
- `orders/sync` passa `notificationIds` solo se `queueBellNotification` ha
  creato davvero una nuova notifica.
- Se la notifica e' deduplicata non viene piu' sincronizzato inutilmente il
  dominio notifiche.
- Mantenuto fallback full sync di `integration.notifications` per casi non
  identificabili.

## Verifiche automatiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test \
  cassa-frontend/backend/tests/app-state-repository.test.mjs \
  cassa-frontend/backend/tests/runtime-metrics.test.mjs \
  cassa-frontend/backend/tests/route-policy-architecture.test.mjs \
  cassa-frontend/backend/tests/architecture-line-budget.test.mjs \
  cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs \
  cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs \
  cassa-frontend/backend/tests/notifications-persistence.e2e.test.mjs
```

Risultato: 83/83 pass.

`backend/server.js`: 38.785 righe, sotto budget.

## Evidenza load ridotto

Run/snapshot usato:

- `logs/loadtest-phaseP_load-50-p3-notificationids/runtime-metrics-midrun.json`

| Metrica | Valore |
|---|---:|
| `orders.sync.mysql.notifications` avg | 89.17 ms |
| `orders.sync.mysql.notifications` max | 299 ms |
| `orders.sync.mysql.orders` avg | 286.35 ms |
| `orders.sync.auditRecent` avg | 191.84 ms |
| `orders.sync.mysql.fulfillmentHistory` avg | 361.25 ms |
| `orders.sync.appStateWrite` avg | 712.76 ms |
| `orders.create.appStateWrite` avg | 492.44 ms |

Rispetto al collo precedente da 550.67 ms, lo step notifiche e' sceso a
89.17 ms medi.

## Diagnosi aggiornata

Il collo notifiche e' stato ridotto. Sotto burst `load-50` la `order-lane`
rimane comunque in pressione: lo snapshot mostra attese medie in coda alte, pur
con tempi di esecuzione piu' bassi.

I prossimi colli misurati sono:

- `orderWorkflowStep:orders.sync.mysql.fulfillmentHistory`: avg 361.25 ms
- `orderWorkflowStep:orders.sync.mysql.orders`: avg 286.35 ms
- `orderWorkflowStep:orders.sync.auditRecent`: avg 191.84 ms

## Prossimo step

Continuare P3 ottimizzando il sync di `fulfillmentHistory` o riducendo il costo
del write puntuale `integration.orders`, mantenendo le metriche
`orderWorkflowStep:*` come guardrail.
