# Fase P3.20 - Layout Latency e Cache Room Lane

Data: 2026-07-08
Target deploy: Raspberry `192.168.0.67`
Runtime: stampa, fiscale e cassa automatica reale disattivati

## Obiettivo

Misurare il costo reale di `/api/integration/layout` dopo P3.19 e verificare se il read-primary parziale dei tavoli introduce regressioni di latenza.

## Strumento

Aggiunto canary:

```text
scripts/layout-latency-canary.mjs
```

Il canary misura:

- `avg`, `p50`, `p95`, `p99`, `max`;
- status HTTP e numero tavoli;
- ruolo proxy (`api-worker`, owner diretto, ecc.);
- counter runtime `integrationLayoutRelationalTablesApplied` e `integrationLayoutRelationalTablesFallback`;
- `readDb` e invalidazioni Redis/hot-cache.

## A/B Cold Path

Per misurare il costo del ramo layout senza fast-cache, ho impostato temporaneamente:

```env
INTEGRATION_LAYOUT_FAST_CACHE_MS=1
```

Poi ho ripristinato l'env originale. Il flag P3.19 e' rimasto ON a fine test.

| Run | Flag layout read-primary | Avg | p95 | p99 | Max | OK | Applied | Fallback |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `layout_latency_p3_20_cold_on_after_roomlane_fix_20260708` | ON | 91.21 ms | 143.29 ms | 213.78 ms | 213.78 ms | 80/80 | 85 | 0 |
| `layout_latency_p3_20_cold_off_after_roomlane_fix_20260708` | OFF | 88.02 ms | 145.92 ms | 199.27 ms | 199.27 ms | 80/80 | 0 | 0 |

Esito: il read-primary parziale non introduce un costo significativo sul cold path. Il p95 ON e OFF e' sostanzialmente equivalente.

## Bug Trovato

La misura hot-cache iniziale ha mostrato un problema diverso:

| Run | Percorso | Avg | p95 | p99 | Max | Applied | readDb | Invalidazioni |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `layout_latency_p3_20_hot_owner_conc8_20260708` | owner diretto | 657.24 ms | 1192.14 ms | 2245.63 ms | 2796.53 ms | 125 | 127 | 126 |
| `layout_latency_p3_20_hot_proxy_20260708` | frontend -> api-worker | 725.05 ms | 1211.91 ms | 1706.37 ms | 1958.16 ms | n.d. | n.d. | n.d. |

La route `GET /api/integration/layout` era correttamente serializzata nella room lane, ma la lane la trattava come una mutazione e cancellava le hot-cache dopo ogni handler.

Effetto:

- il layout scriveva la fast-cache;
- subito dopo la room lane chiamava `clearIntegrationHotResponseCaches()`;
- la richiesta successiva rifaceva `readDb()` e overlay relazionale;
- `integrationLayoutRelationalTablesApplied` cresceva 1:1 con le richieste;
- p95 hot-cache restava nell'ordine del secondo.

## Correzione

Patch conservativa:

- aggiunto predicato `isIntegrationLayoutReadRequest(method, pathname)`;
- `GET /api/integration/layout` resta nella room lane;
- solo questa GET preserva le hot-cache al termine della room lane;
- le POST Tavoli/Sale continuano a invalidare cache come prima.

Test aggiunto:

```text
backend/tests/integration-hot-cache-invalidation-static.test.mjs
layout read in room lane preserves the hot layout cache
```

## Verifiche Post-Fix

| Run | Percorso | Avg | p95 | p99 | Max | OK | Applied | readDb | Invalidazioni |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `layout_latency_p3_20_hot_owner_after_roomlane_fix_20260708` | owner diretto | 20.47 ms | 31.90 ms | 51.80 ms | 53.81 ms | 120/120 | 1 | 3 | 1 |
| `layout_latency_p3_20_hot_proxy_after_roomlane_fix_20260708` | frontend -> api-worker | 39.09 ms | 83.07 ms | 99.25 ms | 105.22 ms | 200/200 | n.d. | n.d. | n.d. |

Miglioramento hot owner:

```text
p95: 1192.14 ms -> 31.90 ms
p99: 2245.63 ms -> 51.80 ms
readDb: 127 -> 3
invalidazioni cache: 126 -> 1
```

Miglioramento hot proxy:

```text
p95: 1211.91 ms -> 83.07 ms
p99: 1706.37 ms -> 99.25 ms
```

## Test

Eseguiti su Raspberry:

```text
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --test --test-name-pattern="layout read in room lane" backend/tests/integration-hot-cache-invalidation-static.test.mjs
/usr/local/bin/node --test --test-name-pattern="P3.19" backend/tests/route-policy-architecture.test.mjs
```

Esito:

```text
PASS
```

Regressione Tavoli/Sale:

```text
Run: tables_rooms_write_audit_p3_20_roomlane_cache_regression_20260708
Verdict: PASS
```

Servizi finali:

```text
cassav4-backend: active
cassav4-api-worker@5283: active
cassav4-api-worker@5284: active
cassav4-frontend: active
cassav4-realtime: active
```

Env finale:

```env
BACKEND_RELATIONAL_LAYOUT_TABLES_READ_PRIMARY=1
PRINTING_ENABLED=0
BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0
AUTOMATIC_CASH_GATEWAY_ENABLED=0
CASSAV4_TEST_DISABLE_REAL_IO=1
FISCAL_REAL_IO_DISABLED=1
```

`INTEGRATION_LAYOUT_FAST_CACHE_MS` non e' rimasto impostato: il runtime usa il default di produzione.

## Decisione

P3.20 e' PASS.

Il layout read-primary parziale non e' il collo. Il bug reale era l'invalidazione della cache causata dalla room lane sulla GET layout.

## Prossimo Step Consigliato

Riprendere il gate P3 lato ordini/multiprocesso:

1. eseguire un canary `api-worker-read` post-fix per verificare che le letture scalabili restino sotto controllo;
2. poi tornare alla latenza ordini (`order.create`/`order.sync`) con profilo CPU o canary worker ordine, perche' il layout non spiega piu' il p95 alto del sistema.
