# Fase H3c - Worker periodico event outbox e ripartenza backend

Data: 2026-07-01

## Obiettivo

Completare il primo backbone realtime con un drain periodico dell'`event_outbox`, cosi' gli eventi pendenti non dipendono solo da:

- publish immediato nel punto applicativo;
- apertura di un nuovo stream SSE.

## Flag e configurazione

Attivazione:

```bash
EVENT_OUTBOX_ENABLED=1
BACKEND_RELATIONAL_ENABLED=1
BACKEND_RELATIONAL_MODE=shadow
```

Nuova configurazione:

```bash
EVENT_OUTBOX_DRAIN_INTERVAL_MS=250
```

Il valore e' normalizzato dal coordinator tra 25 ms e 60.000 ms. Nei test e' stato usato `50` ms per rendere osservabile il worker senza rallentare la suite.

## Interventi

- `modules/realtime-backbone/event-outbox.js` ora espone:
  - `startPolling({ intervalMs })`;
  - `stopPolling()`.
- Il worker:
  - usa `setInterval`;
  - chiama `unref()` per non tenere vivo il processo;
  - evita reentry se un drain precedente e' ancora in corso;
  - usa lo stesso `publishPending()` gia' validato in H3a/H3b.
- `server.js` avvia il worker dopo:
  - `relationalRuntime.initialize()`;
  - `relationalRuntime.syncAfterAppStateWrite(initialAppState)`.
- `server.js` ferma il worker in:
  - `exit`;
  - `SIGINT`;
  - `SIGTERM`.

## Semantica

Il worker pubblica solo quando ci sono client SSE collegati (`canPublish`). Se non ci sono client, l'evento resta in outbox con `published_at = NULL` e verra' pubblicato:

- appena si apre uno stream SSE;
- oppure dal worker, se lo stream e' gia' aperto e l'evento arriva da un retry/insert pendente.

## Test aggiunti

In `cassa-frontend/backend/tests/realtime-event-outbox.e2e.test.mjs`:

- `event outbox worker pubblica eventi con stream gia aperto`
- `event outbox sopravvive a riavvio backend e pubblica evento pendente`

Il primo test inserisce direttamente un evento in `event_outbox` mentre lo stream e' gia' aperto: senza worker non verrebbe pubblicato.

Il secondo test:

1. avvia il backend;
2. crea un ordine;
3. verifica che `order.created` sia pendente in `event_outbox`;
4. spegne il backend;
5. riavvia usando lo stesso app-state e lo stesso SQLite relazionale;
6. apre lo stream SSE;
7. verifica ricezione evento e `published_at` valorizzato.

## Verifiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/server.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/modules/realtime-backbone/event-outbox.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/realtime-event-outbox.e2e.test.mjs
```

Esito: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-event-outbox.e2e.test.mjs
```

Esito:

```text
tests 4
pass 4
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/payments-fiscal.e2e.test.mjs
```

Esito:

```text
tests 16
pass 16
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/realtime-backbone.test.mjs
```

Esito:

```text
tests 6
pass 6
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/notification-stream-payload.test.mjs
```

Esito:

```text
tests 1
pass 1
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/orders-payments-invariants.test.mjs
```

Esito:

```text
tests 16
pass 16
fail 0
```

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs
```

Esito:

```text
tests 1
pass 1
fail 0
```

`backend/server.js`: 40.381 righe, sotto il budget G1 di 40.500.

## Stato

H3c completata: l'outbox realtime ora ha retry periodico leggero, stop pulito e test di sopravvivenza a riavvio backend.

Prossimo step consigliato: chiudere Fase H con pulizia/retention delle righe outbox pubblicate oppure iniziare Fase I0, verifica equivalenza shadow ordini.
