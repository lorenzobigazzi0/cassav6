# Fase B - Payments/Fiscal Lane

Data: 2026-06-30

## Obiettivo

Separare le mutazioni piu lente e sensibili di pagamenti/fiscale dalla coda globale DB, mantenendo serializzazione per aggregato e riducendo il blocco su login, radio, notifiche e ordini.

## Implementato

- Nuova lane `paymentLane` per route:
  - `POST /api/payments/table`
  - `POST /api/payments/ticket`
  - `POST /api/payments/free-split`
  - `POST /api/fiscal/command`
  - `POST /api/reports/payment-movement/reprint`
- Flag rollout:
  - `LANE_PAYMENTS=1`
  - `PAYMENT_LANE_ENABLED` disattiva se impostato a `0`
  - `PAYMENT_LANE_CONCURRENCY=2` nello script di riavvio
- La lane e attiva solo quando lo storage e compatibile:
  - MySQL con `BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1`
  - oppure split payments/fiscal externalized.
- Chiavi di serializzazione:
  - `table:<tableId>` per incassi tavolo e split tavolo
  - `movement:<movementId>` per ristampe movimento
  - `fiscal:<paymentId|receiptId|fiscalReceiptId|fiscalMovementId>` per comandi fiscali
  - fallback su ordine, idempotency/client payment, device/user o globale per route senza identificativo.
- Persistenza mirata via `writePaymentDb()` su:
  - transazioni provider
  - incasso tavolo
  - incasso banco/ticket
  - split libero e replay fiscale
  - comando fiscale
  - ristampa movimento.
- Metriche runtime aggiunte:
  - `paymentLaneEnqueued`
  - `queues.paymentLane.waitMsByLabel`
  - `queues.paymentLane.runMsByLabel`
  - `paymentLaneDepth`
  - `paymentLaneRunning`
- `tools/restart-cassav4-linux.sh` ora rende espliciti `LANE_PAYMENTS=1` e `PAYMENT_LANE_CONCURRENCY=2`.

## Guard rail

- La coda globale resta esclusiva rispetto a order lane e payment lane.
- La lane ordini e la lane pagamenti non girano insieme: si evita concorrenza fra ordini e incassi che aggiornano gli stessi tavoli/ordini.
- Una mutazione globale con priorita alta blocca temporaneamente la payment lane.
- Le richieste sullo stesso tavolo/movimento/fiscale restano serializzate.
- `writePaymentDb()` include anche `integration`, `posSettings`, `auditEvents` e `printSpoolJobs`, quindi chiusura tavoli, stato ordini e job stampa generati dal pagamento vengono persistiti.

## Verifiche

Comandi eseguiti con Node locale:

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/modules/runtime-metrics.js`
- `node --test cassa-frontend/backend/tests/payment-provider-transactions.test.mjs`
- `node --test cassa-frontend/backend/tests/pos-fiscal-retry.e2e.test.mjs`
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs`

Risultato:

- Syntax check OK.
- Payment provider transactions: 9/9 pass.
- POS fiscal retry e report non fiscalizzati: 4/4 pass.
- Route/security architecture: 7/7 pass.

## Prossimo step consigliato

Eseguire un load test breve con traffico misto ordini + pagamenti + ristampe per confermare:

- riduzione attesa coda globale durante incassi;
- `paymentLaneDepth` stabile;
- nessun incremento di errori su fiscal retry;
- latenza notifiche/login non degradata mentre partono pagamenti.
