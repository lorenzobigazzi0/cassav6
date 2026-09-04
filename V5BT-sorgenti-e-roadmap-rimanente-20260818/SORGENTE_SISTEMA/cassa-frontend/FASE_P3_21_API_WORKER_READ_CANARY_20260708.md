# Fase P3.21 - Canary API Worker Reads Post Cache Fix

Data: 2026-07-08
Target deploy: Raspberry `192.168.0.67`
Runtime: stampa, fiscale e cassa automatica reale disattivati

## Obiettivo

Verificare dopo P3.20 che il percorso multi-processo delle letture resti corretto e veloce:

- proxy HTTPS verso `api-worker` per le letture scalabili;
- health/control su owner;
- stream notifiche su `realtime-gateway`;
- comportamento mutation probe coerente con gli order-worker attivi.

## Stato Target

Flag rilevanti:

```env
BACKEND_MULTI_PROCESS_READ_WORKERS=1
BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED=1
BACKEND_API_WORKER_ORIGIN=http://127.0.0.1:5283,http://127.0.0.1:5284
BACKEND_RELATIONAL_LAYOUT_TABLES_READ_PRIMARY=1
BACKEND_MULTI_PROCESS_ORDER_WORKERS=1
BACKEND_MULTI_PROCESS_ORDER_STATE_EXTERNALIZED=1
BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1
BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=...
```

I/O reale:

```env
PRINTING_ENABLED=0
BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0
AUTOMATIC_CASH_GATEWAY_ENABLED=0
CASSAV4_TEST_DISABLE_REAL_IO=1
FISCAL_REAL_IO_DISABLED=1
```

## Nota Sul Primo Run

Il primo canary:

```text
api_worker_read_p3_21_post_layout_cache_20260708
```

ha prodotto:

```text
readsToWorker=4166/4166
readP95=25.46ms
errors=0
mutation proxy role=api-worker
direct worker mutation status=401
SSE realtime=true
```

Il processo era sano, ma lo script usciva con errore perche' assumeva ancora che `POST /api/integration/orders/create` dovesse sempre restare su owner e che il worker diretto dovesse sempre rispondere `503 BACKEND_PROCESS_ROUTE_BLOCKED`.

Sul target attuale questa assunzione non e' piu' valida: gli order-worker sono abilitati e la route `orders/create` e' in allowlist. Quindi il comportamento corretto e':

- mutation proxy su `api-worker`;
- worker diretto non bloccato dal route guard;
- risposta `401 Sessione login richiesta` per body vuoto, cioe' la route entra correttamente nell'auth handler.

## Correzione Canary

Aggiornato:

```text
scripts/api-worker-read-canary.mjs
```

Nuovi parametri:

```env
CANARY_EXPECT_ORDER_MUTATION_PROXY_ROLE=api-owner|api-worker
CANARY_EXPECT_DIRECT_WORKER_MUTATION_BLOCKED=1|0
```

Default compatibile col vecchio comportamento:

```env
CANARY_EXPECT_ORDER_MUTATION_PROXY_ROLE=api-owner
CANARY_EXPECT_DIRECT_WORKER_MUTATION_BLOCKED=1
```

Per il target corrente il canary va lanciato con:

```env
CANARY_EXPECT_ORDER_MUTATION_PROXY_ROLE=api-worker
CANARY_EXPECT_DIRECT_WORKER_MUTATION_BLOCKED=0
```

Test aggiunto:

```text
backend/tests/api-worker-read-canary-static.test.mjs
```

## Run Finale 5283

Comando:

```text
CANARY_RUN_ID=api_worker_read_p3_21_order_workers_expected_20260708
CANARY_API_WORKER_ORIGIN=http://127.0.0.1:5283
CANARY_READ_DURATION_MS=60000
CANARY_READ_CONCURRENCY=8
CANARY_EXPECT_ORDER_MUTATION_PROXY_ROLE=api-worker
CANARY_EXPECT_DIRECT_WORKER_MUTATION_BLOCKED=0
```

Risultato:

| Metrica | Valore |
| --- | ---: |
| Letture verso api-worker | 4166/4166 |
| read p50 | 12.78 ms |
| read p95 | 24.53 ms |
| read max | 509.94 ms |
| Ruoli | `{"api-owner":834,"api-worker":4166}` |
| Mutation proxy | `api-worker`, HTTP 401 |
| Worker diretto | HTTP 401, non bloccato come atteso |
| SSE realtime gateway | true |
| Errori | 0 |

## Run Finale 5284

Comando:

```text
CANARY_RUN_ID=api_worker_read_p3_21_worker5284_expected_20260708
CANARY_API_WORKER_ORIGIN=http://127.0.0.1:5284
CANARY_READ_DURATION_MS=30000
CANARY_READ_CONCURRENCY=8
CANARY_EXPECT_ORDER_MUTATION_PROXY_ROLE=api-worker
CANARY_EXPECT_DIRECT_WORKER_MUTATION_BLOCKED=0
```

Risultato:

| Metrica | Valore |
| --- | ---: |
| Letture verso api-worker | 2083/2083 |
| read p50 | 12.61 ms |
| read p95 | 24.73 ms |
| read max | 435.45 ms |
| Ruoli | `{"api-owner":417,"api-worker":2083}` |
| Mutation proxy | `api-worker`, HTTP 401 |
| Worker diretto | HTTP 401, non bloccato come atteso |
| SSE realtime gateway | true |
| Errori | 0 |

## Test

Eseguiti su Raspberry:

```text
/usr/local/bin/node --check scripts/api-worker-read-canary.mjs
/usr/local/bin/node --test backend/tests/api-worker-read-canary-static.test.mjs
```

Esito:

```text
PASS
```

Servizi finali:

```text
cassav4-backend: active
cassav4-api-worker@5283: active
cassav4-api-worker@5284: active
cassav4-frontend: active
cassav4-realtime: active
```

## Decisione

P3.21 e' PASS.

Il piano letture multiprocesso e' coerente dopo P3.20:

- letture scalabili al 100% su api-worker;
- p95 letture intorno a 25 ms;
- SSE sul realtime gateway;
- mutation probe coerente con order-worker abilitati.

## Prossimo Step Consigliato

Tornare sul collo principale P3: latenza ordini.

Prossimo taglio consigliato:

1. eseguire un canary e2e order-worker sulle route in allowlist con aspettative `api-worker`;
2. raccogliere p95/p99 di `order.create` e `order.sync`;
3. se resta alto, profilare CPU per-op sul target con `--cpu-prof` sotto canary 50.
