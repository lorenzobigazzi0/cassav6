# Fase P3 - Transaction metrics

Data: 2026-07-03

## Esito

Step completato, P3 resta in hardening.

Dopo le metriche interne `appStateDomainSplit` restava non spiegata una parte
importante del costo di `integration.orders.entries.total`. In questo step sono
state aggiunte metriche specifiche per isolare pool e transazione nel sync
puntuale `syncObjectArrayEntriesFromAppState`.

## Correzioni applicate

- Aggiunte metriche `appStateDomainSplit` per:
  - `entries.ensure`
  - `entries.getPool`
  - `entries.getConnection`
  - `entries.beginTransaction`
  - `entries.commit`
  - `entries.rollback`
  - `entries.release`
- `withConnection` accetta un `metricPrefix` opzionale e misura pool,
  connection e release solo quando richiesto.
- `syncObjectArrayEntriesFromAppState` misura `ensure`, transazione e totale
  con prefisso `integration.orders.entries`.
- Aggiornati test repository e guardrail statico.

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

- `logs/loadtest-phaseP_load-50-p3-transactionmetrics/runtime-metrics-midrun.json`

Metriche workflow:

| Metrica | Valore |
|---|---:|
| `orders.sync.mysql.orders` avg | 297.95 ms |
| `orders.create.mysql.orders` avg | 179.46 ms |
| `orders.sync.appStateWrite` avg | 663.85 ms |
| `orders.create.appStateWrite` avg | 547.88 ms |

Metriche interne `appStateDomainSplit:integration.orders`:

| Metrica | Count | Avg | Max |
|---|---:|---:|---:|
| `entries.total` | 164 | 222.79 ms | 761 ms |
| `entries.rollback` | 45 | 52.80 ms | 300 ms |
| `entries.commit` | 119 | 52.28 ms | 341 ms |
| `entries.ensure` | 164 | 40.13 ms | 475 ms |
| `index.total` | 254 | 39.40 ms | 530 ms |
| `entries.getPool` | 164 | 32.43 ms | 417 ms |
| `entries.beginTransaction` | 164 | 25.56 ms | 325 ms |
| `entries.stateRead` | 164 | 19.57 ms | 258 ms |
| `entries.getConnection` | 164 | 12.32 ms | 195 ms |
| `entries.upsertChangedRows` | 164 | 10.84 ms | 130 ms |

## Diagnosi aggiornata

Il costo residuo di `entries.total` e' composto soprattutto da overhead di
transazione/pool e da rollback sotto carico:

- `commit` e `rollback` hanno entrambi media intorno a 52 ms;
- `ensure` medio 40 ms include il controllo iniziale, con p95 alto;
- `getPool` medio 32 ms e `getConnection` medio 12 ms;
- l'upsert riga ordine resta basso, circa 11 ms medi;
- l'indice resta non dominante, circa 39 ms medi.

Nel log del run non risultano errori MySQL espliciti nella ricerca rapida, ma
la presenza di 45 rollback indica che il prossimo step deve distinguere conflitti
operativi attesi da abort/transient DB.

## Prossimo step

Continuare P3 su due binari:

- aggiungere contatori/label sugli esiti del sync puntuale ordine:
  `committed`, `rolledBack`, `revisionConflict`, `transientDbError`;
- ridurre overhead transazionale se possibile, partendo da `ensure/getPool`:
  evitare lavoro ripetuto quando il repository e' gia' ensured e valutare
  riuso/batching delle sync puntuali nella stessa mutazione ordine.
