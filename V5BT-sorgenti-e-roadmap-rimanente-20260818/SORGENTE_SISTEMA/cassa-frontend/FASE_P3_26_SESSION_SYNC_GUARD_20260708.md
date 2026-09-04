# Fase P3.26 - price cache, session split guard e canary C3/50

Data: 2026-07-08
Target: Raspberry `192.168.0.67`
Profilo: multi-processo con owner `5281`, api-worker `5283/5284`, realtime attivo, stampa/fiscale/cassa reale disattivati.

## Obiettivo

Chiudere il prossimo collo emerso dopo P3.25:

- ridurre un costo CPU certo visto nel profilo (`getMenuPriceScheduleMinutes`);
- eliminare i `401` intermittenti sotto canary C3/50 causati da sincronizzazione sessioni non additiva;
- riallineare il canary al routing corrente `orders/create -> api-worker`.

## Modifiche

1. `backend/modules/price-lists/price-lists.domain.js`
   - Cache bounded per `Intl.DateTimeFormat` per timezone.
   - Cache bounded dei minuti schedule per bucket minuto.
   - Effetto verificato nel profilo precedente: il costo `price-lists.domain.js` era sceso da circa `5223.99 ms / 2.24%` a `184.27 ms / 0.08%`.

2. `backend/server.js`
   - Aggiunto `resolveSessionsSplitSyncOptions()`.
   - La sync split delle sessioni ora e additiva di default: `deleteMissing` diventa `true` solo se richiesto esplicitamente.
   - Anche `deviceStatusSplitRepository` riceve le stesse opzioni sessioni protette.

3. `backend/auth/auth.handlers.js`
   - Login fallito: write scoped solo su `auditEvents`.
   - Session status: `readDb({ refreshExternalizedSessions: true })` quando manca `req.__authDb`; write scoped su `sessions` o `sessions + integration + auditEvents`, sempre con `deleteMissing:false`.
   - Cambio PIN: read con sessioni fresche e write scoped.
   - Logout: unico percorso esplicito con `sessionsSync: { deleteMissing: true }`.

4. `scripts/order-worker-sync-e2e-canary.mjs`
   - Default `CANARY_EXPECT_CREATE_PROXY_ROLE` aggiornato da `api-owner` ad `api-worker`.

5. `scripts/order-worker-sync-e2e-batch-canary.test.mjs`
   - Aggiunto test statico per evitare regressione del default del canary.

## Verifiche

Sul target:

- `node --check backend/server.js`: OK
- `node --check backend/auth/auth.handlers.js`: OK
- `node --test backend/tests/route-policy-architecture.test.mjs`: 88/88 OK
- `node --test backend/tests/mysql-sessions-split.repository.test.mjs backend/tests/device-status-split.repository.test.mjs`: 2/2 OK
- `node --test backend/tests/price-lists-domain.test.mjs`: 5/5 OK
- `node --test scripts/order-worker-sync-e2e-batch-canary.test.mjs`: 3/3 OK

Servizi dopo restart:

- `cassav4-backend`: active
- `cassav4-api-worker@5283`: active
- `cassav4-api-worker@5284`: active
- `cassav4-realtime`: active
- `https://127.0.0.1:5280/api/health`: 200

I/O reale:

- `PRINTING_ENABLED=0`
- worker stampa/fiscale/scheduler owner disattivati sugli api-worker
- log backend: stampa disabilitata e fiscal POS real I/O disabilitato per test

## Canary C3/50 finale

Run:

`p3_26_session_guard_c3_50x_fixed_canary_20260708`

Report:

`/opt/cassav4/releases/20260707-test-safe-real-io-223951/logs/order-worker-sync-e2e-batch-p3_26_session_guard_c3_50x_fixed_canary_20260708`

Esito:

- PASS
- 50/50 OK
- failed: 0
- create p95: `1701.63 ms`
- sync p95: `1269.17 ms`
- readback p95: `664.48 ms`
- cleanup p95: `1289.38 ms`

Routing:

- create: `api-worker` 50/50
- sync: `api-worker` 50/50
- readback: `api-worker` 50/50
- cleanup: `api-worker` 50/50

Residui dopo il run:

- lock canary: 0
- ordini canary attivi: 0
- sessioni canary: 100 (attese: 2 login per run, mobile + postazione)

## Note sui falsi negativi intermedi

1. Primo run P3.26 post-patch fallito 0/50 per credenziali implicite del canary (`lorenzo/1234`) non valide sul target. Ha attivato il rate limit login; risolto con restart e credenziali esplicite `amalia/182018`.
2. Secondo run con credenziali corrette ha eseguito create/sync/readback/cleanup 50/50, ma falliva il gate per `routeOk=false`: il canary aspettava ancora `orders/create -> api-owner`, mentre il routing corrente corretto e `api-worker`.

## Stato

Gate C3/50 sessioni/lock: verde.

La prossima fase utile e P3.27: continuare l'abbattimento CPU sui top cost rimasti dal profilo P3.25/P3.26, soprattutto sanitize/hydrate ordini, audit mapper e fan-out realtime/SSE.
