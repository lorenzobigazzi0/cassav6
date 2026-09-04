# FASE K1 - Payments reports read-primary relazionale

Data: 2026-07-02

## Obiettivo

Chiudere K1 della `ROADMAP_REALTIME_CASSAV4_v4.md`: spostare dietro flag le letture read-only dei pagamenti/fiscale usate da report, riepiloghi e ristampa movimento, senza cambiare i flussi di incasso.

## Interventi

- Aggiunto read-model relazionale payments/fiscal basato su:
  - `payment_containers`;
  - `payment_parts`;
  - `payment_transactions`;
  - `fiscal_receipts`.
- Il read-model ricostruisce le collection app-state usando `raw_json`, cosi' il campione sincronizzato resta identico a quello JSON.
- Aggiunto fallback automatico ad app-state quando:
  - il flag e' spento;
  - il DB relazionale non e' disponibile;
  - lo shadow payments non risulta sincronizzato;
  - la lettura relazionale fallisce.
- Collegati al read-model, dietro flag `BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS=1`:
  - report vendite `/api/reports/sales`;
  - riepilogo palmari `/api/reports/handheld-session`;
  - stampa riepilogo palmari `/api/reports/handheld-session/print`;
  - ristampa movimento `/api/reports/payment-movement/reprint`.
- Nella ristampa movimento, il read-model relazionale viene usato solo per trovare container/parti/transazioni/ricevute; audit e print job restano scritti sul DB runtime originale.

## File modificati

- `cassa-frontend/backend/db/relational/payments-report-read-model.js`
- `cassa-frontend/backend/db/relational/index.js`
- `cassa-frontend/backend/modules/reports/reports.handlers.js`
- `cassa-frontend/backend/modules/payments/payments.handlers.js`
- `cassa-frontend/backend/server.js`
- `cassa-frontend/backend/tests/relational-payments-reports-read-primary.test.mjs`

## Verifiche eseguite

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/relational-payments-reports-read-primary.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/db/relational/payments-report-read-model.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments-reports-read-primary.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-equivalence.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/handheld-session-report.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/payment-weird-cases.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/payments-fiscal.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/pos-fiscal-retry.e2e.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/route-policy-architecture.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs
```

Esiti:

- `relational-payments-reports-read-primary.test.mjs`: 4/4 verdi.
- `relational-payments.test.mjs`: 16/16 verdi.
- `relational-equivalence.test.mjs`: 12/12 verdi.
- `handheld-session-report.test.mjs`: 10/10 verdi.
- `payment-weird-cases.e2e.test.mjs`: 15/15 verdi.
- `payments-fiscal.e2e.test.mjs`: 16/16 verdi.
- `pos-fiscal-retry.e2e.test.mjs`: 4/4 verdi.
- `route-policy-architecture.test.mjs`: 10/10 verdi.
- `architecture-line-budget.test.mjs`: 1/1 verde.
- `backend/server.js`: 37.953 righe, sotto budget.

## DoD K1

- Nessun impatto sui flussi di incasso: nessun write-primary introdotto.
- Report generati dal campione sincronizzato mantengono le collection payments/fiscal identiche all'app-state.
- Endpoint reale `/api/reports/sales` legge `payment_transactions` relazionale quando il flag e' attivo.
- Endpoint reale `/api/reports/sales` torna ad app-state quando il relazionale non e' disponibile.
- Ristampa movimento puo' leggere un pagamento presente solo nel relazionale, continuando a scrivere print job/audit nel DB runtime originale.

## Esito

K1 completata.

STOP/REVIEW K1 rispettato. Il prossimo step della roadmap e' K2: `revision` nativa + CAS su `payment_containers` e `payment_transactions`.
