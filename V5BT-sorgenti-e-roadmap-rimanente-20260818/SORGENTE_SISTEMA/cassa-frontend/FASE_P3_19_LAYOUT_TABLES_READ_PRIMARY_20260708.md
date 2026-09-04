# Fase P3.19 - Layout Tavoli Read-Primary Parziale

Data: 2026-07-08
Target deploy: Raspberry `192.168.0.67`
Runtime: stampa, fiscale e cassa automatica reale disattivati

## Obiettivo

Portare una prima parte di `/api/integration/layout` verso `table_states` relazionale senza cambiare il contratto API e senza rimuovere il fallback legacy.

Il layout continua a costruire sale e tavoli dalla configurazione `posSettings`, ma i campi operativi del tavolo vengono sovrascritti dal relazionale quando il set `table_states` e' completo.

## Flag

Nuovo flag:

```env
BACKEND_RELATIONAL_LAYOUT_TABLES_READ_PRIMARY=1
```

Il flag lavora solo se e' attivo anche:

```env
BACKEND_RELATIONAL_TABLES_READ_PRIMARY=1
```

Se il relazionale non e' disponibile, manca una riga `table_states`, o avviene un errore, il layout torna al percorso legacy e incrementa il counter di fallback.

## Correzioni

- Aggiunto overlay `buildLayoutSettingsWithRelationalTableStates(settings)`.
- Aggiunto merge conservativo dei campi tavolo da `table_states` verso i tavoli POS.
- Il layout mantiene la stessa forma risposta:
  - `ok`
  - `version`
  - `rooms`
  - `tables`
- Aggiunti counter runtime:
  - `integrationLayoutRelationalTablesApplied`
  - `integrationLayoutRelationalTablesFallback`
- Aggiornato `deploy/raspberry-final/cassav4.env.example`.
- Aggiunto test architetturale:

```text
backend/tests/route-policy-architecture.test.mjs
P3.19 layout usa table_states relazionale solo dietro flag e fallback
```

## Nota Trovata Durante La Verifica

I counter P3.19 venivano incrementati dal codice ma non erano dichiarati nella lista iniziale di `runtime-metrics`, quindi `incrementCounter()` li scartava.

Correzione applicata:

- dichiarati i due counter in `backend/modules/runtime-metrics.js`;
- aggiunta asserzione in `backend/tests/runtime-metrics.test.mjs`.

## Verifiche

Test mirati su Raspberry:

```text
/usr/local/bin/node --test --test-name-pattern="runtime metrics dashboard" backend/tests/runtime-metrics.test.mjs
pass: 1/1

/usr/local/bin/node --test --test-name-pattern="P3.19" backend/tests/route-policy-architecture.test.mjs
pass: 1/1
```

Verifica runtime diretta su owner `5281`:

```text
layoutStatus: 200
tables: 56
integrationLayoutRelationalTablesApplied: 1
integrationLayoutRelationalTablesFallback: 0
```

Canary equivalenza read-primary:

```text
Run: tables_read_primary_equivalence_p3_19_r2_20260708
Verdict: PASS
Report: reports/tables_read_primary_equivalence_p3_19_r2_20260708
```

Regressione mutazioni tavoli/sale:

```text
Run: tables_rooms_write_audit_p3_19_regression_20260708
Verdict: PASS
Report: reports/tables_rooms_write_audit_p3_19_regression_20260708
```

Servizi target dopo deploy:

```text
cassav4-backend: active
cassav4-api-worker@5283: active
cassav4-api-worker@5284: active
cassav4-frontend: active
cassav4-realtime: active
```

## Decisione

P3.19 e' PASS.

Il layout ora puo' usare i campi operativi dei tavoli dal relazionale sotto flag, con fallback automatico al percorso legacy.

## Prossimo Step Consigliato

Misurare p95/p99 di `/api/integration/layout` con e senza flag P3.19 e poi scegliere il prossimo taglio:

1. spostare altri campi layout a read-primary relazionale;
2. ridurre il lavoro sincrono residuo di `syncPosTableFinancialsFromIntegrationOrders`;
3. solo dopo valutare lane tavoli/sale piu' parallele o keyed per tavolo/sala.
