# FASE P3.52 - Financial session fast path

Data: 2026-07-09
Target: Raspberry 192.168.0.67
Deploy: /opt/cassav4/current/cassa-frontend
Profilo I/O: test safe, stampa/fiscale/cassa reale disattivati

## Obiettivo

Ridurre il costo CPU del blocco `orderSyncInternal:financialSync`, che nel canary
P3.51b era il primo collo del percorso `/api/integration/orders/sync`:

- worker 5283: 235.12 ms medi
- worker 5284: 235.52 ms medi

## Modifica

File modificati:

- `backend/server.js`
- `backend/tests/route-policy-architecture.test.mjs`

Interventi:

1. `buildIntegrationTableLiveStats` ora accetta `options.currentTableSessions` e
   riusa le sessioni tavolo gia calcolate.
2. `syncPosTableFinancialsFromIntegrationOrders` costruisce `tableSessions` una
   sola volta e le passa alle live stats.
3. `buildIntegrationCurrentTableSessions` non usa piu `sanitizeAuditEvents` nel
   path caldo: usa una scansione mirata sugli eventi `table.session_opened`,
   `table.released`, `table.settled`, evitando clone JSON e sort globale
   dell'audit log.
4. Aggiunto guardrail `P3.52 financial sync riusa le sessioni tavolo e scansiona
   audit in modo leggero`.

## Verifiche locali

- `wc -l backend/server.js`: 38.793 righe
- `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js`: OK
- `route-policy-architecture.test.mjs`: 102/102 OK
- `order-table-financial-plan + order-financial-sync-source + runtime-metrics`: 10/10 OK

## Verifiche su Raspberry

Comandi eseguiti come utente servizio `cassav4`.

- `wc -l backend/server.js`: 38.793 righe
- `/usr/local/bin/node --check backend/server.js`: OK
- `route-policy-architecture.test.mjs`: 102/102 OK
- `order-table-financial-plan + order-financial-sync-source + runtime-metrics`: 10/10 OK

Servizi riavviati e attivi:

- `cassav4-backend.service`
- `cassav4-api-worker@5283.service`
- `cassav4-api-worker@5284.service`
- `cassav4-realtime.service`
- `cassav4-frontend.service`
- `cassav4-battery.service`

Flag safe confermati su owner e worker:

- `PRINTING_ENABLED=0`
- `FISCAL_REAL_IO_DISABLED=1`
- `POS_FISCAL_REAL_IO_DISABLED=1`
- `AUTOMATIC_CASH_REAL_ENABLED=0`

Nota: subito dopo il riavvio il proxy HTTPS ha restituito un 502 temporaneo sul
login mentre l'owner completava startup reconcile. L'owner e' diventato pronto
alle 12:27:23 e gli health check su 5280/5281/5283/5284 sono poi risultati OK.

## Canary 50 device

Run:

`p3_52_financial_session_fastpath_c1_50_20260709`

Esito:

- PASS
- 50/50 OK
- durata: 132.646 s

Latenze P3.52:

| step | p95 |
| --- | ---: |
| create | 862.50 ms |
| sync | 736.46 ms |
| cleanup | 375.55 ms |
| readback | 412.45 ms |

Confronto contro P3.51b:

| step | P3.51b p95 | P3.52 p95 | delta |
| --- | ---: | ---: | ---: |
| create | 925.10 ms | 862.50 ms | -6.8% |
| sync | 892.03 ms | 736.46 ms | -17.4% |
| cleanup | 440.31 ms | 375.55 ms | -14.7% |
| readback | 378.71 ms | 412.45 ms | +8.9% |

Metriche interne `orders/sync`:

| blocco | P3.51b avg | P3.52 avg | delta |
| --- | ---: | ---: | ---: |
| financialSync worker 5283 | 235.12 ms | 173.68 ms | -26.1% |
| financialSync worker 5284 | 235.52 ms | 174.00 ms | -26.1% |
| queueReconcile worker 5283 | 92.92 ms | 79.00 ms | -15.0% |
| queueReconcile worker 5284 | 91.00 ms | 87.48 ms | -3.9% |

## Evidenze

Directory locale:

`reports/p3_52_financial_session_fastpath_20260709/`

File principali:

- `canary/REPORT.md`
- `canary/result.json`
- `p3-52-order-sync-internal-summary.tsv`
- `p3-52-all-runtime-metrics.json`
- `p3-52-services.txt`

## Stato e prossimo step

P3.52 e' valido: ha ridotto il primo collo CPU senza cambiare semantica di
persistenza o ACK.

I colli rimasti nel canary P3.52 sono:

1. `relationalSnapshotRead`: circa 152-158 ms medi
2. `preparationPlan`: circa 124-132 ms medi
3. `queueReconcile`: circa 79-87 ms medi
4. `financialSync`: resta circa 174 ms medi, ma non e' piu il blocco peggiore

Prossimo step consigliato: P3.53 su `relationalSnapshotRead`, con verifica di
quali snapshot vengono letti due volte nello stesso sync e possibile riuso del
primo snapshot relazionale per financial sync quando il target e' lo stesso
tavolo.
