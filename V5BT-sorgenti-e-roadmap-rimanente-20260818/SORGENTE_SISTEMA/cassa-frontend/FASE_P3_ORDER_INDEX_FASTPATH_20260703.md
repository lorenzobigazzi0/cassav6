# Fase P3 - Order station index fast path

Data: 2026-07-03

## Esito

Step completato, P3 resta in hardening.

Dopo il fast path fulfillment il costo maggiore nei sotto-step ordini era
`orderWorkflowStep:orders.sync.mysql.orders`. Il write puntuale
`integration.orders` aggiorna anche l'indice `order_station`, usato per leggere
solo le comande della postazione.

Il repository MySQL ora confronta l'indice postazioni gia' presente con quello
calcolato dalla riga ordine aggiornata. Se la comanda cambia stato, totale o
progressi ma resta sulla stessa postazione, salta delete/insert dell'indice.

## Correzioni applicate

- Aggiunto confronto change-aware delle righe `order_station`.
- Aggiunto `listOrderStationIndexState(...)` per leggere solo le chiavi indice
  dei record ordine cambiati.
- `syncOrderStationIndex(...)` in modalita' puntuale cancella/reinserisce solo
  i record con indice realmente cambiato.
- Il full replace dell'indice resta invariato nei full sync.
- Aggiunto test repository che verifica:
  - nessun rewrite indice se cambia solo il totale;
  - rewrite indice quando cambia la postazione.

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

Risultato: 92/92 pass.

`backend/server.js`: 38.782 righe, sotto budget.

## Evidenza load ridotto

Run/snapshot usato:

- `logs/loadtest-phaseP_load-50-p3-orderindex/runtime-metrics-midrun.json`

| Metrica | Prima | Dopo |
|---|---:|---:|
| `orders.sync.mysql.orders` avg | 315.51 ms | 293.25 ms |
| `orders.sync.mysql.orders` max | 851 ms | 848 ms |
| `orders.sync.appStateWrite` avg | 666.69 ms | 644.57 ms |
| `orders.create.mysql.orders` avg | 200.13 ms | 214.91 ms |
| `orders.sync.mysql.fulfillmentHistory` avg | 94.58 ms | 81.97 ms |
| `orders.sync.mysql.notifications` avg | 120.89 ms | 92.83 ms |

## Diagnosi aggiornata

Il rewrite inutile dell'indice postazione e' stato eliminato, ma il guadagno e'
piu' piccolo rispetto ai fast path precedenti. Nel nuovo snapshot il costo
maggiore resta:

- `orderWorkflowStep:orders.sync.mysql.orders`: avg 293.25 ms
- `orderWorkflowStep:orders.create.mysql.orders`: avg 214.91 ms
- `orderWorkflowStep:orders.create.auditRecent`: avg 199.72 ms

La pressione residua e' quindi probabilmente dentro il diff/upsert della riga
ordine o nella dimensione del JSON della singola comanda, non solo nell'indice
postazioni.

## Prossimo step

Continuare P3 aggiungendo metrica interna nel repository per separare:

- lettura stato record corrente;
- upsert riga ordine;
- confronto/sync indice;
- tempo totale `syncObjectArrayEntriesFromAppState`.

Poi decidere se ottimizzare checksum/raw JSON oppure ridurre la dimensione del
payload ordine scritto.
