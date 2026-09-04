# Fase P3.27 - prefilter idempotenza ordini

Data: 2026-07-08
Target: Raspberry `192.168.0.67`
Profilo: multi-processo con owner `5281`, api-worker `5283/5284`, realtime attivo, I/O reale disattivato.

## Obiettivo

Ridurre una parte del costo CPU su `orders.repo` nel percorso `orders/create`.

Il profilo P3.25 indicava costi rilevanti in:

- `backend/db/relational/orders.repo.js:3 safeJsonParse`
- `backend/db/relational/orders.repo.js:521 listOrders`
- `backend/db/relational/orders.repo.js:926 hydrateOrder`

Uno dei punti piu' economici da correggere era `findOrderByIdempotencyKey`: prima scansionava e idratava tutti gli ordini relazionali per cercare una chiave di idempotenza, quindi ogni create pagava parse JSON proporzionale allo storico.

## Modifiche

File:

- `backend/db/relational/orders.repo.js`
- `backend/tests/relational-orders.test.mjs`

Implementazione:

- aggiunto `canUseRawJsonSubstringLookup()`;
- per chiavi semplici (`A-Z`, `a-z`, numeri, `.`, `_`, `:`, `-`) la query usa `WHERE raw_json LIKE ?`;
- il controllo esatto resta invariato in JS dopo l'idratazione del candidato;
- per chiavi non semplici resta il percorso conservativo precedente, con scansione completa.

Questo evita di parse-are tutto lo storico nel caso normale dei canary e dei client, senza trasformare il filtro SQL in fonte di verita'.

## Test

Sul target:

- `node --check backend/db/relational/orders.repo.js`: OK
- test mirati `relational-orders`: 6/6 OK
- suite completa `backend/tests/relational-orders.test.mjs`: 23/23 OK

## Canary C3/50

Run:

`p3_27_order_idempotency_prefilter_c3_50x_20260708`

Report:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_27_order_idempotency_prefilter_c3_50x_20260708`

Esito:

- PASS
- 50/50 OK
- failed: 0
- create p95: `1641.45 ms`
- sync p95: `1566.30 ms`
- readback p95: `772.20 ms`
- cleanup p95: `1400.39 ms`

Routing:

- create: `api-worker` 50/50
- sync: `api-worker` 50/50
- readback: `api-worker` 50/50
- cleanup: `api-worker` 50/50

Residui:

- lock canary: 0
- ordini canary attivi: 0
- sessioni canary: 100 (attese: mobile + postazione per 50 run)

## Confronto con P3.26

| Metrica | P3.26 | P3.27 |
| --- | ---: | ---: |
| create p95 | 1701.63 ms | 1641.45 ms |
| sync p95 | 1269.17 ms | 1566.30 ms |
| readback p95 | 664.48 ms | 772.20 ms |
| cleanup p95 | 1289.38 ms | 1400.39 ms |

Interpretazione:

- il create path migliora leggermente, coerente con il prefilter idempotenza;
- sync/readback/cleanup sono peggiori per oscillazione/carico del run, quindi questa fase non chiude il gate latenza;
- la modifica e comunque utile per evitare crescita lineare del costo create con lo storico ordini.

## Stato

Gate coerenza: verde.

La prossima fase utile e P3.28: affrontare `listRelationalOrderWorkflowSnapshot()` e financial sync, limitando gli snapshot relazionali al tavolo/ordine coinvolto quando possibile. Quello e' il punto che oggi continua a idratare molti ordini e mantiene alto il p95.
