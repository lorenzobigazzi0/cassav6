# Fase P3 - Domain split internal metrics

Data: 2026-07-03

## Esito

Step completato, P3 resta in hardening.

Dopo il fast path sull'indice postazioni il costo residuo principale era ancora
`orderWorkflowStep:orders.sync.mysql.orders`. In questo step non e' stata
applicata una nuova ottimizzazione funzionale: e' stata aggiunta
strumentazione interna al repository MySQL domain split per capire dove viene
speso il tempo del write puntuale `integration.orders`.

## Correzioni applicate

- Il repository `mysql-domains-split.repository.js` ora riceve `runtimeMetrics`.
- Aggiunte metriche `appStateDomainSplit:*` per il sync puntuale degli array
  annidati.
- Per `integration.orders.entries` vengono misurati:
  - `stateRead`
  - `upsertChangedRows`
  - `total`
- Per `integration.orders.index` vengono misurati:
  - `collect`
  - `stateRead`
  - `compare`
  - `deleteRows`
  - `insertRows`
  - `total`
- Aggiunto guardrail statico in `route-policy-architecture.test.mjs`.
- Il test repository verifica sia lo skip dell'indice invariato sia la presenza
  delle metriche interne.

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

Risultato: 93/93 pass.

`backend/server.js`: 38.783 righe, sotto budget.

## Evidenza load ridotto

Run/snapshot usato:

- `logs/loadtest-phaseP_load-50-p3-domainmetrics/runtime-metrics-midrun.json`

Metriche workflow:

| Metrica | Valore |
|---|---:|
| `orders.sync.mysql.orders` avg | 303.56 ms |
| `orders.create.mysql.orders` avg | 210.94 ms |
| `orders.sync.appStateWrite` avg | 705.94 ms |
| `orders.create.appStateWrite` avg | 704.25 ms |

Metriche interne `appStateDomainSplit:integration.orders`:

| Metrica | Avg | Max |
|---|---:|---:|
| `entries.total` | 244.11 ms | 1204 ms |
| `index.total` | 44.51 ms | 408 ms |
| `entries.stateRead` | 22.80 ms | 253 ms |
| `entries.upsertChangedRows` | 10.79 ms | 126 ms |
| `index.deleteRows` | 7.56 ms | 268 ms |
| `index.stateRead` | 7.42 ms | 103 ms |
| `index.collect` | 1.43 ms | 12 ms |
| `index.insertRows` | 1.03 ms | 302 ms |
| `index.compare` | 0.01 ms | 1 ms |

## Diagnosi aggiornata

Le nuove metriche dicono che l'indice postazioni non e' piu' il costo
principale. La media `entries.total` e' circa 244 ms, mentre lettura stato,
upsert righe e indice spiegano solo una parte del tempo.

Il prossimo collo da isolare e':

- overhead di transazione/commit/roundtrip MySQL nel sync puntuale;
- eventuale costo non misurato di `ensure()`/pool/connection;
- eventuale full replace dell'indice ancora presente nei percorsi non puntuali.

## Prossimo step

Continuare P3 misurando separatamente in `syncObjectArrayEntriesFromAppState`:

- `ensure`
- `getConnection`
- `beginTransaction`
- `commit`
- `rollback`

Se il collo e' il commit/roundtrip, valutare batch o riduzione del numero di
sync puntuali per singola mutazione ordine.
