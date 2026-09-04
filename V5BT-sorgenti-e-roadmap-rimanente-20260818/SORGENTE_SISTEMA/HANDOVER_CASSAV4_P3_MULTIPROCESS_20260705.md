# Handover CASSA V4 - P3 Multi-Process

Data handover: 2026-07-05

## Dove lavorare

Workspace reale:

```bash
cd /home/sentrapa/Desktop/sistemacassav4/estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source
```

Roadmap/stato principale:

```text
cassa-frontend/FASE_P3_MULTIPROCESS_TOPOLOGY_20260704.md
```

Nodo consigliato per i test:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node
```

Nodo runtime usato dal restart live:

```bash
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node
```

Nota: in questa shell `git` non risulta disponibile, quindi non basarsi su `git status`.

## Stato live attuale

Profilo live attivo: canary multi-process fino a `create+sync+cancel+comp+correct+barReplacement+lineSplit`.

URL LAN:

```text
https://192.168.1.182:5280/mobile/
```

Processi live verificati con health 200:

```text
owner backend       5281  PID 115765
realtime gateway    5282  PID 115792
api worker          5283  PID 115817
frontend HTTPS      5280  PID 115848
```

Health check usato:

```bash
for url in http://127.0.0.1:5281/api/health http://127.0.0.1:5282/api/health http://127.0.0.1:5283/api/health https://127.0.0.1:5280/mobile/; do
  printf '%s ' "$url"
  curl -k -s -o /dev/null -w '%{http_code}\n' "$url"
done
```

## Ultimo step completato

Ultimo step chiuso: `MP-4be transfer notifications outbox`.

Obiettivo chiuso:

- `transfer/request` pubblica `transfer_request` tramite `event_outbox` dopo il mirror mirato ordine+notifica.
- `transfer/resolve` pubblica `transfer_approved` / `transfer_denied` tramite `event_outbox` dopo il mirror mirato ordine+notifica.
- Entrambe le pubblicazioni usano `requireOutbox` quando sono attivi write-primary relazionale della route + `EVENT_OUTBOX_ENABLED`.
- Il blocco `notifications` e' stato rimosso da `transfer/request` e `transfer/resolve`.
- `notifications` resta residuo solo su `transfer/force`.

File modificati/aggiunti nell'ultimo step:

```text
cassa-frontend/backend/server.js
cassa-frontend/scripts/order-workflow-externalization-audit.mjs
cassa-frontend/backend/tests/order-workflow-externalization-audit.test.mjs
cassa-frontend/backend/tests/route-policy-architecture.test.mjs
cassa-frontend/backend/tests/relational-orders-transfer-notification-outbox.e2e.test.mjs
cassa-frontend/FASE_P3_MULTIPROCESS_TOPOLOGY_20260704.md
```

Punti runtime importanti:

```text
cassa-frontend/backend/server.js:27496
  publish transfer_request via event_outbox

cassa-frontend/backend/server.js:27663
  publish transfer_approved / transfer_denied via event_outbox
```

Nuovo test e2e:

```text
cassa-frontend/backend/tests/relational-orders-transfer-notification-outbox.e2e.test.mjs
```

## Stato audit P3

Audit verificato dopo MP-4be:

```text
orderWorkersGoNoGo: no-go
totalOrderWorkflowRoutes: 14
activeOrderWorkflowRoutes: 13
disabledForOrderWorker: 1
disabledRouteKeys: POST /api/integration/orders/correct/resolve
readyForOrderWorker: 8
blockedForOrderWorker: 5
writePrimaryCovered: 13
```

Write-primary relazionale: 13/13 route attive completato.

Route pronte per order-worker: 8/13 attive.

Allowlist corrente: GO, ma solo per queste route:

```text
POST /api/integration/orders/create
POST /api/integration/orders/sync
POST /api/integration/orders/cancel
POST /api/integration/orders/comp
POST /api/integration/orders/correct
POST /api/integration/orders/replacement/bar-charge
POST /api/orders/replacement/bar-charge
POST /api/integration/orders/line/split
```

Non aggiungere ancora transfer, price-override o storno alla allowlist worker.

Blocchi residui attuali:

```text
audit-permissions: 3
  POST /api/integration/orders/line/price-override
  POST /api/integration/orders/transfer/force
  POST /api/integration/orders/transfer/resolve

financial-sync: 2
  POST /api/integration/orders/line/price-override
  POST /api/integration/orders/storno

locks-handoff: 2
  POST /api/integration/orders/transfer/force
  POST /api/integration/orders/transfer/request

fiscal-payments: 1
  POST /api/integration/orders/storno

notifications: 1
  POST /api/integration/orders/transfer/force
```

## Test verdi gia eseguiti

Comandi gia eseguiti con esito verde:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js

/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/relational-orders-transfer-notification-outbox.e2e.test.mjs

/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/order-workflow-externalization-audit.test.mjs

/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs

/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/phase-p-validation-preflight.test.mjs
```

Risultati:

```text
relational-orders-transfer-notification-outbox: 1/1
order-workflow-externalization-audit: 7/7
route-policy-architecture: 74/74
phase-p-validation-preflight: 9/9
server.js: 38799 righe
```

Canary live verde:

```text
report: logs/order-worker-sync-e2e-canary-ordersynce2e_transfer_notifications_mp4be_regression_20260705T035330/REPORT.md
createRole: api-worker
lineSplitRole: api-worker
syncRole: api-worker
workflow: delivered
```

## Comandi utili per ripartire

Audit corrente con allowlist live:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node \
  cassa-frontend/scripts/order-workflow-externalization-audit.mjs \
  --json-only \
  --no-write \
  --route-allowlist 'POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge,POST /api/integration/orders/line/split'
```

Dry-run restart profilo corrente:

```bash
BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY=1 \
BACKEND_RESTART_DRY_RUN=1 \
bash tools/restart-cassav4-linux.sh
```

Restart live profilo corrente, con stampa reale disabilitata:

```bash
PRINTING_ENABLED=0 \
BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY=1 \
bash tools/restart-cassav4-linux.sh
```

Canary live di regressione:

```bash
PRINTING_ENABLED=0 \
CANARY_REQUIRE_PRINTING_DISABLED=1 \
CANARY_REQUIRE_LINE_SPLIT=1 \
CANARY_SYNC_WORKFLOW_STATUS=ready \
CANARY_SKIP_CLEANUP=1 \
CANARY_REQUIRE_CLEANUP=0 \
CANARY_EXPECT_CREATE_PROXY_ROLE=api-worker \
CANARY_EXPECT_LINE_SPLIT_PROXY_ROLE=api-worker \
CANARY_EXPECT_SYNC_PROXY_ROLE=api-worker \
CANARY_USERNAME=lorenzo \
CANARY_PIN=1234 \
CANARY_RUN_ID=ordersynce2e_next_$(date +%Y%m%dT%H%M%S) \
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node \
  cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs
```

## Prossimo step consigliato

Prossimo focus consigliato: `audit-permissions`.

Motivo: e' il blocco piu' grande rimasto, con 3 route. Inoltre `transfer/resolve` dopo MP-4be resta bloccata solo da `audit-permissions`; chiudendola puo' diventare il prossimo candidato pronto per order-worker.

Step pratico consigliato per la prossima chat:

1. Creare lo step `MP-4bf`.
2. Analizzare `handleIntegrationOrderTransferResolve`, `handleIntegrationOrderTransferForce` e `handleIntegrationOrderLinePriceOverride`.
3. Separare permessi/audit da dipendenze owner-bound usando sorgenti condivise e scritture audit idempotenti.
4. Partire da `transfer/resolve`, perche' dopo MP-4be il suo blocker residuo e' solo `audit-permissions`.
5. Aggiungere test route-policy + e2e che provino:
   - permesso/approvazione deterministico cross-process;
   - audit scritto una sola volta;
   - nessun mirror app-state scritto su 403/409;
   - event_outbox/notifica invariati.
6. Aggiornare `order-workflow-externalization-audit.mjs` rimuovendo `audit-permissions` da `transfer/resolve` solo quando il test e' verde.
7. Valutare se aggiungere `transfer/resolve` alla allowlist in un nuovo preset separato o in un canary dedicato, senza toccare `transfer/request`, `transfer/force`, `price-override` o `storno`.

Non fare subito:

- Non abilitare wildcard order-worker.
- Non aggiungere tutte le route transfer alla allowlist insieme.
- Non rimuovere blocker da `transfer/force` finche' restano `audit-permissions`, `locks-handoff` e `notifications`.
- Non rimuovere blocker da `storno` finche' fiscal-payments e financial-sync non sono trattati.
- Non usare stampante/fiscale reale nei test: mantenere `PRINTING_ENABLED=0`.

## Nota funzionale storica da non rompere

Per il dominio resi/correzioni: il reso senza sostituzione deve aggiornare la comanda corrente, non creare una nuova comanda vuota. Le righe rese devono restare visibili/barrate e neutre economicamente. Questa nota non era il focus dello step MP-4be, ma resta un vincolo importante del progetto.
