# Fase P3 - Load-50 fast path notifiche e posSettings

Data: 2026-07-03

## Esito

P3 resta in hardening, non completata.

Questo step ha rimosso un collo improprio nella `notification-lane` e ha ridotto
il costo medio del fast path ordini, ma la `order-lane` resta ancora il limite
dominante sotto `load-50`.

## Correzioni applicate

- `POST /api/mobile/waiter-pause/status` resta autenticato ma ora e' davvero
  read-only: non aggiorna heartbeat, non scrive DB e non entra nella
  `notification-lane`.
- Lo stato di una pausa scaduta viene calcolato senza mutare il record, cosi'
  la risposta resta corretta anche senza write.
- `posSettings` e' registrato nel domain split MySQL come `object-entry` e
  `posSettings.tables` come array annidato a entry.
- `writeIntegrationOrderSyncDb` puo' sincronizzare solo i tavoli
  finanziariamente cambiati tramite `posSettingsTableIds`, evitando il full
  sync del dominio `posSettings` per `orders/create` e `orders/sync`.

## Verifiche automatiche

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test \
  cassa-frontend/backend/tests/waiter-pauses.test.mjs \
  cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs \
  cassa-frontend/backend/tests/runtime-metrics.test.mjs \
  cassa-frontend/backend/tests/route-policy-architecture.test.mjs \
  cassa-frontend/backend/tests/architecture-line-budget.test.mjs \
  cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs \
  cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs
```

Risultato: 42/42 pass.

`backend/server.js`: 38.766 righe, sotto budget.

## Evidenza load ridotto

Run/snapshot usati:

- `logs/loadtest-phaseP_load-50-p3-waiterstatus/runtime-metrics-midrun.json`
- `logs/loadtest-phaseP_load-50-p3-possettings-tables/runtime-metrics-midrun.json`

Confronto principale:

| Metrica | Prima | Dopo |
|---|---:|---:|
| `waiter-pause/status` in notification lane | 103-108 enqueue/run nei tentativi precedenti | 0 nel run post-fix |
| `orders/create` run medio | 1013.76 ms | 925.03 ms |
| `orders/create` wait medio | 13651.43 ms | 11430.56 ms |
| `orders/sync` run medio | 1106.96 ms | 1007.67 ms |
| `orders/sync` wait medio | 16674.60 ms | 14221.15 ms |

La riduzione e' reale ma insufficiente per chiudere P3: sotto burst `load-50`
la coda ordini resta ancora intorno a 50 elementi.

## Diagnosi aggiornata

- Il problema `waiter-pause/status` era coda sbagliata: runtime sub-ms ma wait
  plurisecondo per la `notification-lane`. Risolto.
- Il full sync di `posSettings` durante gli aggiornamenti finanziari tavolo era
  parte del costo ordine. Ridotto a sync puntuale di `posSettings.tables`.
- Il limite residuo e' ancora il costo medio `orders/create`/`orders/sync`
  intorno a 0.9-1.0s per task sotto MySQL split, piu' burst di richieste ordine
  piu' rapido della capacita' di drain.

## Prossimo step

Continuare P3 sulla `order-lane`:

- strumentare o separare ulteriormente i sotto-step MySQL del fast path ordine
  (`orders`, `lastWriteAt/sequence`, audit recent, eventuali notifications e
  fulfillment history);
- ridurre il costo di `orders/sync`, soprattutto quando aggiorna solo stato
  operativo/preparazione;
- valutare coalescing o deduplica dei sync multipli sullo stesso ordine durante
  burst di postazione, senza perdere CAS/write-primary.
