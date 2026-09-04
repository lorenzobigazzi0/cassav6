# Fase N3 - Print state machine esplicita

Data: 2026-07-03

## Obiettivo

Formalizzare la macchina a stati della stampa prevista da
`ROADMAP_REALTIME_CASSAV4_v4.md`: `queued -> claimed -> sent -> confirmed |
failed_retryable | failed_final`, mantenendo compatibili gli stati legacy dello
spool.

## Modifiche

- Aggiunto `backend/modules/print-spool/print-state-machine.js`.
- Stati canonici: `queued`, `claimed`, `sent`, `confirmed`,
  `failed_retryable`, `failed_final`.
- API di dominio: `canTransitionPrintState`, `applyPrintStateTransition`,
  `resolvePrintRuntimeState`, `normalizePrintState` ed errore esplicito
  `INVALID_PRINT_STATE_TRANSITION`.
- Collegato `PRINT_STATE_MACHINE_ENABLED`, default-on e disattivabile con
  `PRINT_STATE_MACHINE_ENABLED=0`, allo spool server.
- `sanitizePrintSpoolJob` espone ora `printState`, `printStatePath` e
  `printStateUpdatedAt`, preservando il vecchio `status` per compatibilita' UI,
  retention e worker.
- Claim e completamento spool passano da transizioni esplicite:
  `queued/failed_retryable -> queued -> claimed`, poi `claimed -> sent ->
  confirmed/failed_retryable/failed_final`.
- I retry restano operativi sul vecchio `status=queued`, ma il dominio conserva
  `printState=failed_retryable` fino al claim successivo.
- Aggiunto guardrail architetturale N3 in `route-policy-architecture.test.mjs`.

## Invarianti protette

- Una stampa confermata non torna in coda.
- Un retry da `failed_retryable` a `queued` richiede contesto esplicito
  `allowRetry`.
- Gli stati legacy `processing`, `printed`, `failed`,
  `failed_configuration`, `disabled`, `unknown_after_crash` sono mappati senza
  migrazioni distruttive.
- La retention continua a basarsi sugli stati legacy terminali esistenti.
- Il worker veloce MySQL e il fallback serializzato condividono la stessa
  transizione di claim/completamento.

## Verifiche

Sintassi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/modules/print-spool/print-state-machine.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/print-state-machine.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/route-policy-architecture.test.mjs
```

Risultato: ok.

Test mirati state machine/spool/fiscale/architettura:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/print-state-machine.test.mjs cassa-frontend/backend/tests/print-spool-retention.test.mjs cassa-frontend/backend/tests/print-utils-core.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs cassa-frontend/backend/tests/pos-fiscal-retry.e2e.test.mjs cassa-frontend/backend/tests/relational-fiscal-command-write-primary.test.mjs cassa-frontend/backend/tests/relational-fiscal-receipts-write-primary.test.mjs
```

Risultato: 45/45 pass, durata `duration_ms=10034.05168`.

Test layout/ricevute/fiscale:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/order-correction-print.test.mjs cassa-frontend/backend/tests/order-print-labels.test.mjs cassa-frontend/backend/tests/payment-print-format-domain.test.mjs cassa-frontend/backend/tests/fiscal-receipts-domain.test.mjs cassa-frontend/backend/tests/print-location-domain.test.mjs cassa-frontend/backend/tests/printer-config-domain.test.mjs cassa-frontend/backend/tests/payments-fiscal.e2e.test.mjs cassa-frontend/backend/tests/fiscal-optimism-boundary.e2e.test.mjs
```

Risultato: 55/55 pass, durata `duration_ms=31063.622529`.

## Note operative

`backend/server.js` resta sotto budget architetturale: 38.773 righe su 39.500,
con circa 727 righe di margine.

Il full gate backend completo non e' stato rilanciato in questa fase; l'ultimo
full gate registrato resta quello post M4 da 991/991 test passati.

## Prossimo step

Fase O - Riconciliazione dei due track di roadmap.
