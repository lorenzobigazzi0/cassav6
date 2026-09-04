# Progetto memoria - Riduzione accurata del monolite backend

Data creazione: 2026-06-05 03:45 Europe/Rome

## Obiettivo

Ridurre progressivamente `cassa-frontend/backend/server.js` senza regressioni su:

- pagamenti e fiscalita;
- ristampe e retry fiscale;
- comande, modifiche, resi, storni;
- routing stampanti/RT;
- sale, tavoli, prenotazioni e lock;
- mobile, postazione, monitor e impostazioni;
- sessioni utente e scarico.

Il lavoro deve essere eseguito per slice piccole, testabili e reversibili. Non e' un refactor estetico: ogni estrazione deve rimuovere rischio operativo, migliorare isolamento o rendere piu semplice correggere bug reali.

## Stato corrente misurato

File monolite:

- `cassa-frontend/backend/server.js`
- righe attuali: 29.169
- funzioni dichiarate: 799
- funzioni sopra 100 righe: 51
- funzioni sopra 300 righe: 7
- funzioni sopra 500 righe: 3
- route registry totale: 118 route

Funzioni piu grandi:

| Funzione | Riga | Righe | Area |
|---|---:|---:|---|
| `handlePaymentFreeSplit` | 23211 | 799 | pagamenti |
| `handlePayTable` | 22119 | 714 | pagamenti |
| `handleIntegrationOrderComp` | 25463 | 564 | resi/storni |
| `handleIntegrationOrderSync` | 20654 | 467 | comande |
| `handleIntegrationOrderCreate` | 19712 | 433 | comande |
| `sanitizeIntegrationOrder` | 6024 | 413 | dominio comande |
| `handlePayTicket` | 22834 | 376 | pagamenti |
| `handleIntegrationLayoutTableMove` | 18477 | 288 | tavoli |
| `issueQueuedPosFiscalReceipt` | 16247 | 286 | fiscalita |
| `handleBarChargeReplacement` | 24458 | 262 | resi/sostituzioni |
| `handleIntegrationStationStateUpsert` | 19159 | 253 | postazioni |
| `handleIntegrationNotificationAck` | 21596 | 243 | notifiche |

Blocchi approssimativi nel monolite:

| Blocco | Righe circa | Note |
|---|---:|---|
| bootstrap/config | 900 | env, costanti, cache, code |
| smart-card/io | 300 | serial/push smart card |
| user/session/helpers | 400 | sessioni e user sanitization |
| menu/catalog/pricing | 2.000 | catalogo, premium, routing item |
| orders/table domain helpers | 2.900 | ordini, tavoli, gruppi, financials |
| print/preconto text | 2.300 | ESC/POS, testi comanda/preconto/pagamento |
| notifications/fulfillment | 900 | stati preparazione/notifiche |
| settings/sanitizers | 3.650 | posSettings, aree, stampanti, RT |
| print spool/routing/fiscal helpers | 3.850 | spool, routing, fiscal API |
| integration handlers table/layout | 2.050 | layout, move, room move |
| station/order transfer | 500 | transfer comande |
| order create/sync/list | 1.600 | create, list, sync |
| notifications handlers | 400 | publish/pull/ack |
| tables/payment locks | 370 | lock tavoli/pagamenti |
| payments handlers | 1.930 | table/ticket/free split |
| bar charge/comp/correction/cancel | 3.170 | resi, storni, modifiche |
| smart/fiscal/reports end handlers | 1.460 | smart, fiscal command, reports |
| route registry/server http | 490 | dispatcher e server HTTP |

## Moduli gia estratti

Core/infra:

- `backend/core/config.js`
- `backend/core/http-client.js`
- `backend/core/http.js`
- `backend/core/route-builders.js`
- `backend/core/route-policy.js`
- `backend/core/router.js`
- `backend/core/security.js`
- `backend/printing/print-utils.js`

Auth/users:

- `backend/auth/auth.handlers.js`
- `backend/auth/password.js`
- `backend/auth/permissions.js`
- `backend/users/users.handlers.js`
- `backend/users/users.service.js`
- `backend/modules/auth/auth.repository.js`

Moduli backend:

- `app-state`
- `audit`
- `configuration`
- `external-lookups`
- `integration` route registry parziale
- `menu`
- `menu-settings`
- `mobile-battery`
- `notifications`
- `orders` parziale
- `payments` parziale
- `payments-provider`
- `pos-rooms`
- `postazione-actions`
- `price-lists`
- `reports`
- `reservations`
- `sales-sessions`
- `settings`
- `status`
- `menu/menu-routing.domain.js` estratto nel ciclo 2026-06-05 per routing puro menu/postazioni.

Route registry gia centralizzato:

- `cassa-frontend/backend/routes/index.js`
- `routeHandlers` ancora dichiarato in `server.js`.

## Handler ancora nel monolite

### Integration/menu/stampa/notifiche

- `integration.menu`
- `integration.drawerOpen`
- `integration.print`
- `integration.waiters`
- `mobile.waiterPauseStatus`
- `mobile.waiterPauseStart`
- `mobile.waiterPauseStop`
- `integration.waiterPauseDeferCall`
- `integration.layout`
- `integration.tableGroups`
- `integration.tableGroupsSave`
- `integration.stationsActive`
- `integration.stationsState`
- `integration.stationsStateUpsert`
- `integration.tableSync`
- `integration.tableMove`
- `integration.tableRoomMoveRequest`
- `integration.tableRoomMoveStatus`
- `integration.tableRoomMovePending`
- `integration.tableRoomMoveResolve`
- `integration.orderCreate`
- `integration.orders`
- `integration.orderSync`
- `integration.orderLineSplit`
- `integration.orderLinePriceOverride`
- `integration.orderCorrect`
- `integration.orderCancel`
- `integration.orderCorrectPending`
- `integration.orderCorrectResolve`
- `integration.orderComp`
- `integration.orderStorno`
- `integration.barChargeReplacement`
- `integration.orderTransferRequest`
- `integration.orderTransferResolve`
- `integration.orderTransferForce`
- `integration.notificationPublish`
- `integration.notificationsPull`
- `integration.notificationsStream`
- `integration.notificationAck`

### POS/tavoli/pagamenti/fiscalita/smart

- `pos.roomChangeRequest`
- `pos.roomChangeApprove`
- `pos.roomChangeCancel`
- `settings.saveOrderWorkflow`
- `settings.assignBill`
- `tables.lockAcquire`
- `tables.lockHeartbeat`
- `tables.lockRelease`
- `tables.lockForceRelease`
- `payments.table`
- `payments.ticket`
- `payments.freeSplit`
- `reports.paymentMovementReprint`
- `reports.nonFiscalized`
- `fiscal.command`
- `smart.customers`
- `smart.customerUpsert`
- `smart.customerDelete`
- `smart.cardRead`
- `smart.beachEntry`
- `smart.cardDetected`
- `smart.customerRecharge`
- `smart.nonFiscal`

## Bug noti da considerare prima o durante lo split

Questi bug non devono essere nascosti dal refactor. Il piano deve portarli a test/fix espliciti:

1. Routing menu/postazioni mancante:
   - nessun articolo/categoria ha `stations/stationIds/workstationIds`;
   - premium/cocktail attesi su `BAR-1` producono `stationId` vuoto.

2. Retry fiscale:
   - test `pos-fiscal-retry.e2e` falliscono su retry prima/dopo 05:00.

3. Cambio tavolo profondo:
   - test `table move updates digital order...` torna 400.

4. Listino congelato:
   - test `[BE][LISTINO-16]` va in timeout sulla stampa.

5. Pausa postazione:
   - nel flusso completo `paused` torna `undefined` invece di `false`.

6. Menu:
   - duplicati attivi `Hendrick's`, `N°3`;
   - 41 articoli attivi orfani dal `menu_main`.

7. Configurazione hardcoded:
   - Pizza in Riva/Francesca ancora in costanti del monolite.

8. Dati storici:
   - print spool storico su stampante non configurata;
   - pagamenti storici su `u_niccolo`/`niccolo` dopo rename `bardo`.

## Principi non negoziabili

1. Nessun cambio contratto API senza test.
2. Nessun fallback stampante/RT nuovo.
3. Nessuna emissione fiscale duplicata.
4. Nessun pagamento duplicato su retry.
5. Nessun ordine pagato deve tornare unpaid/open da sync stale.
6. Nessun mobile fallback statico sale.
7. Nessuna route pubblica mutativa senza `allowPublicMutation`, `publicReason`, `maxBodySize`.
8. Nessuna POST read-only senza `readOnlyReason`.
9. Nessun handler di pagamento/fiscalita viene spostato senza test P0/P1.
10. Prima estrarre funzioni pure, poi service, poi handler HTTP.
11. Ogni ciclo deve poter essere revertito cancellando pochi file/modifiche.
12. Ogni ciclo deve aggiornare questa memoria.

## Strategia generale

Riduzione per strati:

1. **State/domain pure**: funzioni senza IO e senza DB.
2. **Repository thin**: accesso dati normalizzato, senza side effect esterni.
3. **Service**: orchestration con DB/audit/provider/print controllati.
4. **Handlers HTTP**: lettura payload, auth context, error mapping.
5. **Routes/registry**: spostare handler key e wiring.

Per ogni estrazione:

- misurare righe prima/dopo;
- eseguire `node --check backend/server.js`;
- eseguire test mirato;
- eseguire almeno `npm run check:backend`;
- aggiornare memoria;
- se tocca pagamenti/fiscale: eseguire anche test fiscalita/pagamenti;
- se tocca mobile/postazione: eseguire test frontend statici/GUI mirati.

## Roadmap dettagliata

### Fase 0 - Baseline e guardrail

Obiettivo:

- congelare metriche;
- creare test guardrail dove mancanti;
- non spostare ancora logica critica.

Azioni:

- aggiungere o aggiornare report metriche monolite;
- creare test statico su:
  - route count invariato;
  - handler key registrati;
  - nessun fallback mobile sale;
  - nessun fallback stampanti/RT non autorizzato;
  - nessuna costante operativa nuova tipo Pizza in Riva hardcoded.

Test:

- `npm run check:backend`
- `npm run audit:architecture-security`
- `node --test backend/tests/route-policy-architecture.test.mjs`
- `node --test backend/tests/security-architecture.test.mjs`
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs frontend-tests/postazione-bridges.test.mjs`

Gate:

- se route count cambia senza spiegazione, stop.
- se security audit fallisce, stop.

### Fase 1 - Configurazione operativa e routing postazioni/menu

Perche prima:

- bug attuale P1 su `BAR-1` e configurazione postazioni;
- routing articoli/postazioni influenza ordini, stampa, load balancing.

Nuovi moduli candidati:

- `backend/modules/configuration/workstations.domain.js`
- `backend/modules/configuration/printer-routing.domain.js`
- `backend/modules/configuration/activity-room-context.service.js`
- `backend/modules/menu/menu-routing.domain.js`

Spostare dal monolite:

- `resolveIntegrationRouteStationsForItem`
- `resolveIntegrationCatalogStationsForItem`
- `resolveIntegrationStationsForCategory`
- `resolveIntegrationDepartment`
- `resolvePrintRoutingKind`
- `findWorkstationConfig`
- `resolvePrinterFromOperationalContext`
- `resolvePrinterFromSettings`
- parti pure di `buildOrderOperationalSnapshot`

Fix da includere:

- categorie/articoli devono risolvere `BAR-1` o `BAR-2` da configurazione DB;
- deduplica/normalizzazione `Hendrick's` e `N°3`;
- `CHIRINGUITO-1`, `CHIRINGUITO-2`, `MOBILE` devono esistere solo se persistiti in `posSettings.workstations`;
- rimuovere dipendenza operativa da costanti Pizza in Riva e usare policy DB.

Test:

- `node --test backend/tests/configuration-snapshot.test.mjs`
- `node --test backend/tests/operational-context-alias.test.mjs`
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`
- `node --test backend/tests/orders-flow.e2e.test.mjs`
- `node --test backend/tests/security.test.mjs --test-name-pattern "premium alcohol"`
- `npm --prefix ../mobile-frontend run test -- tests/menuCatalogDedupe.test.ts tests/static/orderComposerSearchSubcategory.test.ts`

Gate:

- `routeStations` non deve mai essere `[""]`.
- niente fallback stampante se contesto operativo v2 e' presente.

### Fase 2 - Print spool e fiscal POS domain

Perche:

- retry fiscale fallisce;
- stampa/listino congelato fallisce;
- stampa e fiscalita sono accoppiate a pagamenti e comande.

Nuovi moduli candidati:

- `backend/modules/print-spool/print-spool-state-machine.js`
- `backend/modules/print-spool/print-spool.domain.js`
- `backend/modules/print-spool/print-spool.service.js`
- `backend/modules/fiscal-pos/fiscal-pos.domain.js`
- `backend/modules/fiscal-pos/fiscal-pos.service.js`
- `backend/modules/fiscal-pos/fiscal-retry.service.js`

Spostare dal monolite:

- `sanitizePrintSpoolJob`
- `claimNextPrintSpoolJob`
- `completePrintSpoolJob`
- `recoverPrintSpoolJobsOnStartup`
- `queuePrintSpoolWorker`
- `enqueuePrintSpoolJob`
- `buildPosFiscalReceiptPayload`
- `buildPosFiscalReprintPayload`
- `issueQueuedPosFiscalReceipt`
- `issueQueuedPosFiscalReprint`
- `maybeIssuePosFiscalReceipt`
- `linkPosFiscalReceiptToPaymentRecords`

Fix da includere:

- retry fiscale schedulato fino alle 05:00;
- marcatura scaduta dopo le 05:00;
- report non fiscalizzati con POS/contanti coerenti;
- stampa ordine/preconto deve usare snapshot prezzo al momento ordine;
- ristampa fiscale deve chiamare reprint, mai receipt.

Test:

- `node --test backend/tests/print-utils-core.test.mjs`
- `node --test backend/tests/payments-fiscal.e2e.test.mjs`
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs`
- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`
- `node --test backend/tests/listino-time-pricing.e2e.test.mjs`
- `npx playwright test --config playwright.config.mjs e2e/gui-listino-time-pricing.spec.mjs`

Gate:

- nessuna fiscal receipt duplicata;
- retry non deve generare doppio pagamento;
- stampa senza stampante configurata deve fallire chiaramente.

### Fase 3 - Orders state/domain

Perche:

- `sanitizeIntegrationOrder`, create/sync/cancel/comp sono grandi e centrali;
- servono invarianti forti su pagato/pronto/modificabile/reso.

Nuovi moduli candidati:

- `backend/modules/orders/order-state-machine.js`
- `backend/modules/orders/orders.domain.js`
- `backend/modules/orders/orders-pricing.domain.js`
- `backend/modules/orders/orders-corrections.domain.js`
- `backend/modules/orders/orders-comp.domain.js`

Spostare dal monolite:

- `sanitizeIntegrationOrder`
- `sanitizeIntegrationOrderItem`
- workflow status helpers;
- line route helpers;
- comp/replacement pure helpers;
- correction pure helpers;
- order display/id alias helpers.

Handler da non spostare subito:

- `handleIntegrationOrderCreate`
- `handleIntegrationOrderSync`
- `handleIntegrationOrderComp`
- `handleIntegrationOrderCancel`

Prima estrarre solo domain pure e testarli.

Test:

- `node --test backend/tests/orders-flow.e2e.test.mjs`
- `node --test backend/tests/orders-payments-invariants.test.mjs`
- `node --test backend/tests/postazione-preparation-selection.e2e.test.mjs`
- `node --test backend/tests/continuity.e2e.test.mjs`
- `npx playwright test --config playwright.config.mjs e2e/gui-operational-flows.spec.mjs`

Gate:

- ordine pagato non torna unpaid;
- ordine cancellato non torna pronto;
- modifica con revisione stale deve fallire;
- comp/storno deve mantenere riferimenti pagamento/articolo.

### Fase 4 - Payments provider and payments service

Perche:

- funzioni piu grandi del monolite sono pagamenti;
- rischio P0: doppio incasso, residuo errato, fiscalita incoerente.

Nuovi moduli candidati:

- `backend/modules/payments/payment-state-machine.js`
- `backend/modules/payments/payments.domain.js`
- `backend/modules/payments/payments-authoritative-total.service.js`
- `backend/modules/payments/payments.service.js`
- `backend/modules/payments/payment-session-visibility.domain.js`
- `backend/modules/payments-provider/payment-provider-state-machine.js`
- `backend/modules/payments-provider/payment-provider-reconciliation.js`

Spostare prima:

- `validateFreeSplitAuthoritativePayable`
- `applyIntegrationPaymentToOrders`
- `applyPaidAmountToIntegrationOrdersByIds`
- split normalization helpers;
- idempotency helpers;
- provider transaction state transition helpers.

Spostare dopo:

- `handlePayTable`
- `handlePayTicket`
- `handlePaymentFreeSplit`

Test:

- `node --test backend/tests/payment-splits.test.mjs`
- `node --test backend/tests/payment-provider-transactions.test.mjs`
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs`
- `node --test backend/tests/payments-fiscal.e2e.test.mjs`
- `node --test backend/tests/orders-payments-invariants.test.mjs`
- `node --test backend/tests/sales-sessions.e2e.test.mjs`

Gate:

- pagamento retry non duplica;
- articolo gia pagato non ripagabile;
- split roman/importo non abilita articolo;
- transazioni restano visibili fino a scarico utente;
- scarico precedente non deve riapparire.

### Fase 5 - Tables, locks and room move

Perche:

- cambio tavolo profondo fallisce;
- prenotazioni e table groups dipendono da questi helper.

Nuovi moduli candidati:

- `backend/modules/tables/tables.domain.js`
- `backend/modules/tables/tables-locks.domain.js`
- `backend/modules/tables/table-move.service.js`
- `backend/modules/table-room-move/table-room-move-state-machine.js`
- `backend/modules/table-room-move/table-room-move.service.js`

Spostare:

- table group helpers;
- lock helpers;
- table move pure helpers;
- room move request/resolve state machine.

Test:

- `node --test backend/tests/tables-locks.e2e.test.mjs`
- `node --test backend/tests/settings-room-table-policy.e2e.test.mjs`
- `node --test backend/tests/reservations-status.e2e.test.mjs`
- `node --test backend/tests/security.test.mjs --test-name-pattern "table move"`
- GUI cambio tavolo/unisci/dividi.

Gate:

- tavolo con ordine/pagamento deve potersi spostare se business rules lo permettono;
- stampa avviso cambio deve usare stampante corretta;
- prenotazione non deve buttare fuori operatore;
- liberazione prenotazione multi-tavolo deve ridividere.

### Fase 6 - Notifications, waiters and station state

Perche:

- logica priorita e presenza camerieri e' delicata;
- parte e' gia estratta, handler ancora nel monolite.

Nuovi moduli candidati:

- `backend/modules/notifications/notifications.handlers.js`
- `backend/modules/notifications/notifications.service.js`
- `backend/modules/stations/stations.domain.js`
- `backend/modules/stations/stations.handlers.js`
- `backend/modules/waiters/waiters.handlers.js`

Spostare:

- `handleIntegrationWaiters`
- `handleMobileWaiterPauseStatus`
- `handleMobileWaiterPauseStart`
- `handleMobileWaiterPauseStop`
- `handleIntegrationWaiterPauseDeferredCall`
- `handleIntegrationActiveStations`
- `handleIntegrationStationStates`
- `handleIntegrationStationStateUpsert`
- notification publish/pull/ack handlers.

Test:

- `node --test backend/tests/notifications-persistence.e2e.test.mjs`
- `node --test backend/tests/notifications-priority.e2e.test.mjs`
- `node --test backend/tests/waiter-pauses.test.mjs`
- `node --test backend/tests/waiters-routing.e2e.test.mjs`
- `node --test backend/tests/station-availability-alerts.e2e.test.mjs`
- `node --test frontend-tests/postazione-bridges.test.mjs`

Gate:

- nuove notifiche sopra vecchie;
- ack cameriere aggiorna postazione;
- cameriere in pausa escluso salvo unico disponibile;
- postazione offline mantiene coda riconciliabile.

### Fase 7 - Smart customer/card

Perche:

- area meno collegata a pagamenti/fiscalita POS principali;
- puo ridurre righe senza toccare ordini.

Nuovi moduli candidati:

- `backend/modules/smart/smart-card.service.js`
- `backend/modules/smart/smart-customers.domain.js`
- `backend/modules/smart/smart.handlers.js`
- `backend/modules/smart/smart.routes.js`

Spostare:

- smart card serial/push;
- smart customers;
- beach entry;
- recharge;
- non fiscal smart.

Test:

- test esistenti smart in `security.test.mjs`;
- aggiungere test dedicati se oggi non separati.

Gate:

- nessuna riabilitazione endpoint macchina contanti legacy;
- niente fallback mock smart card in produzione.

### Fase 8 - Handler extraction and route registry cleanup

Quando:

- solo dopo aver estratto domain/service.

Azioni:

- creare handler factory per:
  - `payments.handlers.js`;
  - `orders.handlers.js`;
  - `fiscal-pos.handlers.js`;
  - `tables.handlers.js`;
  - `notifications.handlers.js`;
  - `smart.handlers.js`.
- spostare handler key fuori da `server.js`;
- lasciare `server.js` con:
  - bootstrap;
  - dependency composition;
  - HTTP server;
  - route registry.

Target:

- `server.js` sotto 20.000 righe dopo fase 4;
- sotto 15.000 dopo fase 6;
- sotto 10.000 dopo fase 8;
- zero funzioni >500 righe;
- massimo 10 funzioni >100 righe.

## Gate globali per ogni ciclo

Minimo:

- `npm run check:backend`
- test mirato del modulo toccato
- `node --test backend/tests/route-policy-architecture.test.mjs`

Se tocca pagamenti/fiscale:

- `node --test backend/tests/payment-weird-cases.e2e.test.mjs`
- `node --test backend/tests/payments-fiscal.e2e.test.mjs`
- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`
- `node --test backend/tests/orders-payments-invariants.test.mjs`

Se tocca ordini/postazione:

- `node --test backend/tests/orders-flow.e2e.test.mjs`
- `node --test backend/tests/continuity.e2e.test.mjs`
- `node --test frontend-tests/postazione-bridges.test.mjs`

Se tocca mobile/menu:

- `npm --prefix ../mobile-frontend run typecheck`
- `npm --prefix ../mobile-frontend run test -- tests/menuCatalogDedupe.test.ts tests/orderEmissionPricing.test.ts`
- test statici menu/modali rilevanti.

Se tocca routing/stampanti:

- `node --test backend/tests/configuration-snapshot.test.mjs`
- `node --test backend/tests/operational-context-alias.test.mjs`
- test stampa/listino.

Gate release completo quando possibile:

- `npm run check:backend`
- `npm run audit:architecture-security`
- `npm run gate:architecture-security`
- `npm run test:backend:release`
- frontend statici
- mobile typecheck/test/build
- GUI mirata.

## Stato gate noto al momento

Passano:

- molti test mirati su configurazione, notifiche, prenotazioni, mobile/statici;
- GUI operativa mirata 25/25;
- mobile funzionale 69/69;
- mobile statico escluso budget LOC 51/51.

Falliscono attualmente:

- backend completo: 409/420;
- mobile full test: gate LOC;
- architecture security gate: `server.js` sopra budget 27.500;
- preflight package/source da deploy root per layout archivio;
- lint mobile per legacy assets e warning sorgente.

Quindi prima di dichiarare GO release vanno chiusi almeno:

- routing premium/cocktail: migliorato nel ciclo 2026-06-05 con domain puro e test mirati; resta da coprire il routing avanzato multi-postazione su configurazione reale completa;
- retry fiscale;
- cambio tavolo profondo;
- listino congelato/stampa;
- pausa postazione boolean;
- snapshot legacy.

## Regole rollback

Per ogni fase:

1. commit/log mentale o backup zip prima di modificare;
2. estrarre un modulo per volta;
3. mantenere vecchia funzione in `server.js` finche il nuovo modulo passa test;
4. sostituire wiring solo dopo test domain;
5. se fallisce gate, revert della slice appena introdotta;
6. mai modificare insieme pagamenti e fiscalita se non per test esplicito.

## Tracciamento avanzamento

Formato da aggiornare dopo ogni ciclo:

| Data | Fase | File toccati | Righe server prima/dopo | Test | Esito | Rischi |
|---|---|---|---:|---|---|---|
| 2026-06-05 | baseline | nessuno | 29169/29169 | audit memoria | OK | bug noti aperti |
| 2026-06-05 | Fase 1A menu/postazioni routing domain | `backend/modules/menu/menu-routing.domain.js`, `backend/modules/menu/index.js`, `backend/server.js`, `backend/tests/menu-routing-domain.test.mjs`, fixture test backend | 29169/29106 | menu domain, orders flow, security parziale, check backend | OK con 1 failure security preesistente su cambio tavolo | multi-postazione avanzata da testare su configurazione reale |
| 2026-06-05 | Fase 1B parziale eligibility postazioni/load-balancer | `backend/modules/menu/menu-routing.domain.js`, `backend/modules/menu/index.js`, `backend/server.js`, `backend/tests/menu-routing-domain.test.mjs` | 29106/29015 | menu domain, orders flow, load-balancer eligibility, security parziale, check backend | OK con 1 failure security preesistente su cambio tavolo | routing stampa/preconto ancora da allineare |
| 2026-06-05 | Fase 1B parziale availability articoli/postazioni | `backend/modules/menu/menu-routing.domain.js`, `backend/modules/menu/index.js`, `backend/server.js`, `backend/tests/menu-routing-domain.test.mjs` | 29015/28874 | menu domain, orders flow, load-balancer eligibility, continuity parziale, check backend | OK; continuity valida availability ma resta pausa postazione nota | pausa postazione e table move restano fuori slice |
| 2026-06-05 | Fase 1C table groups domain | `backend/modules/integration/table-groups.domain.js`, `backend/server.js`, `backend/tests/table-groups-domain.test.mjs` | 28874/28717 | table groups domain, orders flow, load-balancer eligibility, security, continuity, check backend | OK con failure gia noti: security table move 400/200 e continuity pausa postazione | table move profondo e pausa postazione restano fuori slice |
| 2026-06-05 | Fase 1D integration stations domain | `backend/modules/integration/stations.domain.js`, `backend/server.js`, `backend/tests/integration-stations-domain.test.mjs` | 28717/28670 | stations domain, domain suite, orders flow, load-balancer eligibility, security, continuity, check backend | OK con failure gia noti invariati: security table move 400/200 e continuity pausa postazione | normalizzazione runtime conserva maiuscole/minuscole legacy |
| 2026-06-05 | Fase 1E integration station states domain | `backend/modules/integration/station-states.domain.js`, `backend/server.js`, `backend/tests/integration-station-states-domain.test.mjs` | 28670/28530 | station states domain, domain suite, orders flow, load-balancer eligibility, security, continuity, check backend | OK con failure gia noti invariati; primo continuity retry fallito per bad port random harness | pausa postazione resta bug reale, bad-port e' difetto harness |
| 2026-06-05 | Fase 1F integration rooms domain | `backend/modules/integration/rooms.domain.js`, `backend/server.js`, `backend/tests/integration-rooms-domain.test.mjs` | 28530/28477 | rooms domain, domain suite, orders flow, security, continuity, check backend | OK con failure gia noti invariati: security table move e continuity pausa postazione | room helpers estratti come factory per dipendenze legacy |
| 2026-06-05 | Fase 1G integration order lookup domain | `backend/modules/integration/order-lookup.domain.js`, `backend/server.js`, `backend/tests/integration-order-lookup-domain.test.mjs` | 28477/28430 | order lookup domain, domain suite, orders flow, security, continuity, check backend | OK con failure gia noti invariati: security table move e continuity pausa postazione | preservato comportamento legacy fallback title |
| 2026-06-05 | Fase 1H payment order refs domain | `backend/modules/payments/payment-order-refs.domain.js`, `backend/server.js`, `backend/tests/payment-order-refs-domain.test.mjs` | 28430/28344 | payment refs domain, domain suite, orders flow, payment e2e, security, continuity, check backend | OK con failure gia noti invariati: security table move e continuity pausa postazione | prima slice payment pura, nessun provider/fiscale mutato |
| 2026-06-05 | Fase 1I payment money domain | `backend/modules/payments/payment-money.domain.js`, `backend/server.js`, `backend/tests/payment-money-domain.test.mjs` | 28344/28317 | payment money domain, domain suite, payment e2e, security, continuity, check backend | OK con failure gia noti invariati: security table move e continuity pausa postazione | arrotondamenti preservati tramite factory roundMoney |

## Prossimo step consigliato

Prima implementazione completata:

**Fase 1A - Menu/postazioni routing domain**

Perche:

- e' un bug reale e riproducibile;
- impatta premium/cocktail e stampa comande;
- ha test falliti gia pronti;
- consente una prima riduzione controllata del blocco menu/catalog/pricing.

Azioni completate nel ciclo 2026-06-05:

1. creato `backend/modules/menu/menu-routing.domain.js`;
2. spostata logica pura di routing categoria/articolo/postazione fuori da `server.js`;
3. aggiunti test domain per:
   - categoria Drink Premium -> `BAR-1`;
   - articolo con workstationIds esplicito;
   - articolo senza routing ma categoria con routing;
   - nessuna postazione configurata -> assenza chiara, non station vuota;
   - active station fallback nel catalogo;
   - riga premium con variante -> postazione configurata.
4. aggiornato `buildIntegrationMenuCatalog()` per ricevere `settings`;
5. aggiornata la scelta postazione delle righe ordine tramite `pickMenuRoutingStationForLine()`;
6. riallineate fixture test a `BAR-1` senza modificare runtime o reintrodurre fallback statici.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --test backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 10/10;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/security.test.mjs`: 26/27, restano solo failure cambio tavolo profondo gia noto;
- `npm run check:backend`: OK.

Prossimo step consigliato:

**Fase 1B - Routing postazioni su configurazione reale completa**

Azioni completate nel ciclo 2026-06-05:

1. spostata nel domain la ricerca della postazione configurata tramite station name;
2. spostata nel domain la verifica allow-list/exclude-list di riga ordine per postazione;
3. rimosse da `server.js` le funzioni locali:
   - `normalizeWorkstationRoutingToken`;
   - `buildWorkstationRoutingSet`;
   - `setIntersects`;
   - `findConfiguredWorkstationForStation`;
   - `resolveIntegrationLineRoutingTokens`;
   - `workstationAllowsIntegrationLine`.
4. `buildIntegrationStationEligibilityChecker()` ora resta come ponte runtime ma usa il domain puro;
5. aggiunti test su allow-list, esclusioni e lookup postazione.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/menu/menu-routing.domain.js && node --check backend/modules/menu/index.js`: OK;
- `node --test backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 13/13;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, resta solo failure cambio tavolo profondo gia noto.

Prossimo step consigliato:

**Availability articoli/postazioni completata nel ciclo 2026-06-05**

Azioni completate:

1. spostata nel domain la normalizzazione `itemAvailability`;
2. spostata nel domain la risoluzione disponibilita' globale/per postazione;
3. spostata nel domain la lista availability esposta al frontend;
4. rimossi da `server.js`:
   - `sanitizeIntegrationItemAvailabilityMap`;
   - `resolveIntegrationItemAvailabilityInfo`;
   - `resolveIntegrationItemAvailability`;
   - `buildIntegrationItemAvailabilityList`.
5. mantenuti alias importati in `server.js` per non cambiare il contratto con `postazione-actions`.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/menu/menu-routing.domain.js && node --check backend/modules/menu/index.js`: OK;
- `node --test backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 16/16;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: availability/routing OK, ma suite complessiva 66/68 per failure preesistente `station pause state clears after heartbeat returns online` (`undefined !== false`).

Prossimo step consigliato:

1. verificare `posSettings.workstations` reali con `BAR-1`, `BAR-2`, `CHIRINGUITO-1`, `CHIRINGUITO-2`, `MOBILE`;
2. aggiungere test e2e su categorie/articoli/menu abilitati per postazione;
3. garantire che nessuna comanda venga inviata a `stationId` vuoto;
4. collegare routing stampante/preconto alla stessa decisione operativa;
5. affrontare il bug pausa postazione o il cambio tavolo profondo prima dei gate completi;
6. solo dopo passare alla Fase 2 print spool/fiscale.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1C table groups domain

Obiettivo:

- continuare la riduzione del monolite su una porzione pura e fredda;
- spostare fuori da `server.js` la logica di gruppi/unioni tavolo usata da layout, comande e stampa;
- non cambiare il comportamento delle API di tavoli, merge/split, spostamenti e storico.

File modificati:

- `cassa-frontend/backend/modules/integration/table-groups.domain.js`: nuovo domain puro per gruppi tavolo;
- `cassa-frontend/backend/server.js`: rimosso il blocco locale dei gruppi tavolo e importate le funzioni dal domain;
- `cassa-frontend/backend/tests/table-groups-domain.test.mjs`: nuovi test puri per normalizzazione, deduplica, leaf IDs, label e link.

Funzioni rimosse dal monolite:

- `sanitizeIntegrationTableGroupNode`;
- `collectIntegrationTableGroupLeafIds`;
- `sanitizeIntegrationTableGroups`;
- `sanitizeIntegrationTableLabel`;
- `formatIntegrationTableNumberGroupLabel`;
- `resolveIntegrationLogicalTableLabel`;
- `findIntegrationTableGroupContaining`;
- `areIntegrationTablesLinkedByGroup`;
- `resolveIntegrationLinkedTableIds`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.874 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.717 righe;
- riduzione netta fase: 157 righe;
- riduzione totale da baseline memoria: 452 righe;
- nuovo domain testabile: 184 righe;
- nuovo test domain: 84 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/table-groups.domain.js`: OK;
- `node --test backend/tests/table-groups-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- il bug table move digitale resta da trattare in slice dedicata;
- il bug pausa postazione resta aperto;
- non sono stati modificati pagamenti, fiscalita', print spool o routing stampanti.

Prossimo step consigliato:

1. chiudere il bug pausa postazione se blocca i gate di continuita';
2. chiudere il bug table move digitale se blocca security gate;
3. solo dopo proseguire con una nuova estrazione pura, preferibilmente `table-room-move` state machine o print-spool state helpers.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1D integration stations domain

Obiettivo:

- ridurre ancora `server.js` con una micro-slice pura;
- spostare fuori dal monolite normalizzazione, deduplica e risoluzione delle postazioni configurate;
- evitare qualunque fallback statico: le postazioni restano lette da `posSettings.workstations`.

File modificati:

- `cassa-frontend/backend/modules/integration/stations.domain.js`: nuovo domain puro per nomi e liste postazioni;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali e importato il nuovo domain;
- `cassa-frontend/backend/tests/integration-stations-domain.test.mjs`: nuovi test per placeholder invalidi, deduplica e postazioni abilitate.

Funzioni rimosse dal monolite:

- `normalizeIntegrationStationName`;
- `normalizeOptionalIntegrationStationName`;
- `isInvalidIntegrationStationName`;
- `normalizeConfiguredIntegrationStationName`;
- `dedupeConfiguredIntegrationStations`;
- `resolveConfiguredIntegrationStationsFromSettings`;
- `resolveConfiguredIntegrationStations`;
- `resolvePrimaryIntegrationStation`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.717 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.670 righe;
- riduzione netta fase: 47 righe;
- riduzione totale da baseline memoria: 499 righe;
- nuovo domain testabile: 57 righe;
- nuovo test domain: 48 righe.

Nota comportamento:

- `normalizeIntegrationStationName()` conserva il comportamento legacy: non forza maiuscolo su nomi runtime non riconosciuti;
- `normalizeConfiguredIntegrationStationName()` continua invece a normalizzare la configurazione in maiuscolo;
- questo evita regressioni su confronti esistenti e mantiene separati input runtime e configurazione.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/stations.domain.js`: OK;
- `node --test backend/tests/integration-stations-domain.test.mjs`: OK, 3/3;
- `node --test backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 23/23;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- pausa postazione resta il failure principale di continuita';
- table move digitale resta il failure principale di security;
- prima di estrarre altri handler conviene chiudere almeno uno dei due bug noti.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1E integration station states domain

Obiettivo:

- proseguire la riduzione nell'area postazioni senza toccare handler, pagamenti o stampa;
- spostare fuori da `server.js` heartbeat, stale detection, fingerprint e normalizzazione stati postazione;
- mantenere le soglie runtime da `.env` passando una configurazione esplicita al domain.

File modificati:

- `cassa-frontend/backend/modules/integration/station-states.domain.js`: nuovo domain factory per stati postazione;
- `cassa-frontend/backend/server.js`: rimosso il blocco locale degli station states e istanziata la factory;
- `cassa-frontend/backend/tests/integration-station-states-domain.test.mjs`: nuovi test su stale, demo fallback, placeholder configurati e throttle heartbeat.

Funzioni rimosse dal monolite:

- `isIntegrationDemoStationEntry`;
- `isIntegrationStationStale`;
- `integrationStationStateKey`;
- `integrationStationStateStableFingerprint`;
- `shouldPersistIntegrationStationHeartbeat`;
- `sanitizeIntegrationStationStateEntry`;
- `buildIntegrationStationStates`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.670 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.530 righe;
- riduzione netta fase: 140 righe;
- riduzione totale da baseline memoria: 639 righe;
- nuovo domain testabile: 185 righe;
- nuovo test domain: 103 righe.

Nota tecnica:

- il nuovo domain espone `createIntegrationStationStateHelpers()`;
- `server.js` passa esplicitamente:
  - `normalizeUsername`;
  - `normalizeClientApp`;
  - `normalizeIntegrationStationName`;
  - `dedupeConfiguredIntegrationStations`;
  - `INTEGRATION_STATIONS`;
  - `PRIMARY_INTEGRATION_STATION`;
  - `INTEGRATION_STATION_STALE_MS`;
  - `INTEGRATION_STATION_HEARTBEAT_WRITE_MIN_INTERVAL_MS`;
  - `SHOW_DEMO_STATIONS`.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/station-states.domain.js`: OK;
- `node --test backend/tests/integration-station-states-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 28/28;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- primo `node --test backend/tests/continuity.e2e.test.mjs`: fallito all'avvio per `fetch failed: bad port`, dovuto al random port harness;
- secondo `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- il bug pausa postazione resta reale e impatta il gate continuity;
- il bug table move digitale resta reale e impatta il gate security;
- il test `continuity.e2e` puo' fallire randomicamente se `freePort()` sceglie una porta vietata da `fetch`.

Prossimo step consigliato:

1. chiudere il bug pausa postazione, ora che la logica station-state e' isolata;
2. correggere l'harness `continuity.e2e` per evitare bad-port randomici;
3. chiudere il bug table move digitale prima di estrarre handler piu' caldi;
4. solo dopo passare a `table-room-move` state machine o print-spool state helpers.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1F integration rooms domain

Obiettivo:

- proseguire la riduzione del monolite con helper puri su sale/layout/prenotazioni;
- spostare fuori da `server.js` normalizzazione roomId, risoluzione sale e parsing orario prenotazione;
- non cambiare contratti API ne' logica di tavoli, ordini, pagamenti o stampa.

File modificati:

- `cassa-frontend/backend/modules/integration/rooms.domain.js`: nuovo domain factory per helper sale;
- `cassa-frontend/backend/server.js`: rimosso il blocco locale sale/prenotazione e istanziata la factory;
- `cassa-frontend/backend/tests/integration-rooms-domain.test.mjs`: nuovi test su slug, sale duplicate, area configurata e orari prenotazione.

Funzioni rimosse dal monolite:

- `toIntegrationRoomSlug`;
- `resolveIntegrationRoomFromType`;
- `normalizePosRoomId`;
- `resolveIntegrationRoomFromTable`;
- `parseIntegrationReservationAt`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.530 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.477 righe;
- riduzione netta fase: 53 righe;
- riduzione totale da baseline memoria: 692 righe;
- nuovo domain testabile: 80 righe;
- nuovo test domain: 88 righe.

Nota tecnica:

- il domain espone `createIntegrationRoomHelpers()`;
- `server.js` passa esplicitamente `normalizeConfigId` e `toTitle`, evitando import circolari e preservando normalizzazione legacy.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/rooms.domain.js`: OK;
- `node --test backend/tests/integration-rooms-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 32/32;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- bug pausa postazione ancora aperto;
- bug table move digitale ancora aperto;
- harness continuity conserva rischio bad-port randomico, anche se in questo ciclo il run finale e' entrato correttamente nei flussi.

Prossimo step consigliato:

1. chiudere il bug pausa postazione;
2. valutare correzione harness bad-port;
3. chiudere il bug table move digitale;
4. poi procedere con `table-room-move` state machine o helper print-spool puri.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1G integration order lookup domain

Obiettivo:

- proseguire la riduzione del monolite con helper puri su lookup e titolo comanda;
- isolare la logica che riconosce id comanda in formati diversi (`272`, `00272`, `#272`, `comanda #272`, `order_00272`);
- non cambiare handler, DB, pagamenti, fiscalita' o stampa.

File modificati:

- `cassa-frontend/backend/modules/integration/order-lookup.domain.js`: nuovo domain puro per lookup/titoli comanda;
- `cassa-frontend/backend/server.js`: rimosso il blocco locale lookup/titoli e importato il domain;
- `cassa-frontend/backend/tests/integration-order-lookup-domain.test.mjs`: nuovi test su alias id e titoli storico ordine.

Funzioni rimosse dal monolite:

- `buildIntegrationOrderLookupCandidates`;
- `findIntegrationOrderIndexByLookup`;
- `buildIntegrationOrderTitleFromItems`;
- `resolveIntegrationOrderDisplayTitle`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.477 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.430 righe;
- riduzione netta fase: 47 righe;
- riduzione totale da baseline memoria: 739 righe;
- nuovo domain testabile: 52 righe;
- nuovo test domain: 52 righe.

Nota comportamento:

- `resolveIntegrationOrderDisplayTitle()` conserva il comportamento legacy: `order.title` viene usato solo se passato come fallback esplicito;
- questo evita una modifica semantica silenziosa nello storico ordini.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/order-lookup.domain.js`: OK;
- `node --test backend/tests/integration-order-lookup-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/integration-order-lookup-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 36/36;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- bug pausa postazione ancora aperto;
- bug table move digitale ancora aperto;
- harness continuity conserva rischio bad-port randomico.

Prossimo step consigliato:

1. chiudere pausa postazione o table move digitale prima di continuare con handler caldi;
2. se si prosegue solo con riduzione, scegliere un altro blocco puro e piccolo;
3. evitare per ora pagamenti/fiscalita'/print spool finche i gate noti non sono chiariti.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1H payment order refs domain

Obiettivo:

- ridurre il monolite in area pagamenti senza toccare incassi, provider POS, fiscalita' o write DB;
- isolare la logica pura che collega bill, line selections, tableId e orderId;
- proteggere casi con piu' comande nello stesso tavolo e pagamenti per articolo/split.

File modificati:

- `cassa-frontend/backend/modules/payments/payment-order-refs.domain.js`: nuovo domain puro per riferimenti ordine pagamento;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali di raccolta/normalizzazione order refs e importato il domain;
- `cassa-frontend/backend/tests/payment-order-refs-domain.test.mjs`: nuovi test su bill multipli, selezioni articolo, target order e rimozione tableId.

Funzioni rimosse dal monolite:

- `collectPosBillOrderIds`;
- `collectOrderIdsFromBills`;
- `collectOrderIdsFromSelectedBills`;
- `collectOrderIdsFromLineSelections`;
- `normalizePaymentOrderIdList`;
- `resolvePaymentOrderRefs`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.430 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.344 righe;
- riduzione netta fase: 86 righe;
- riduzione totale da baseline memoria: 825 righe;
- nuovo domain testabile: 93 righe;
- nuovo test domain: 79 righe.

Nota tecnica:

- questa e' una slice payment, ma solo di pure reference resolution;
- non sono stati modificati:
  - provider POS;
  - fiscal API;
  - idempotency;
  - apply payment;
  - writeDb;
  - print/fiscal replay.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/payments/payment-order-refs.domain.js`: OK;
- `node --test backend/tests/payment-order-refs-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/payment-order-refs-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 41/41;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- bug pausa postazione ancora aperto;
- bug table move digitale ancora aperto;
- harness continuity conserva rischio bad-port randomico;
- prossime slice in area payment vanno fatte solo se pure o con test P0/P1 completi.

Prossimo step consigliato:

1. chiudere i due bug gate aperti;
2. correggere harness bad-port;
3. se si continua la riduzione, preferire helper puri non provider/fiscalita'.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1I payment money domain

Obiettivo:

- ridurre ancora il monolite in area pagamenti con helper puri;
- isolare conversioni euro/centesimi, normalizzazione billIds e ricerca linea pagamento;
- preservare arrotondamenti legacy senza modificare provider, fiscalita', writeDb o print.

File modificati:

- `cassa-frontend/backend/modules/payments/payment-money.domain.js`: nuovo domain factory per helper importi/linee pagamento;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali e istanziata la factory;
- `cassa-frontend/backend/tests/payment-money-domain.test.mjs`: nuovi test su rounding, clamp, billIds e matching linea.

Funzioni rimosse dal monolite:

- `moneyToCents`;
- `centsToMoney`;
- `normalizePaymentBillIds`;
- `findPaymentBillLine`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.344 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.317 righe;
- riduzione netta fase: 27 righe;
- riduzione totale da baseline memoria: 852 righe;
- nuovo domain testabile: 51 righe;
- nuovo test domain: 43 righe.

Nota tecnica:

- il domain espone `createPaymentMoneyHelpers()`;
- `server.js` passa esplicitamente `normalizeUsername` e `roundMoney`;
- nessun cambiamento a POS provider, fiscal API, idempotency, applicazione pagamenti o spool.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/payments/payment-money.domain.js`: OK;
- `node --test backend/tests/payment-money-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/payment-money-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 45/45;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- bug pausa postazione ancora aperto;
- bug table move digitale ancora aperto;
- harness continuity conserva rischio bad-port randomico;
- prossime slice payment devono restare pure o richiedere test P0/P1 completi.

Prossimo step consigliato:

1. chiudere pausa postazione e table move digitale;
2. solo dopo considerare estrazioni piu' calde in pagamento/fiscalita';
3. in alternativa continuare con helper puri di stampa/formattazione, senza toccare spool.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1J payment print format domain

Obiettivo:

- proseguire la riduzione conservativa del monolite seguendo questa memoria;
- isolare helper puri di formattazione stampa/pagamento:
  - data/ora ricevuta;
  - riferimento comanda;
  - label sala/tavolo;
  - riconoscimento metodo contanti/POS per ricevuta;
  - label metodo pagamento;
  - label azione rimborso/storno;
  - note di stampa pagamento;
  - riferimenti pagamento collegati a storno;
- non modificare spool, fiscalita', provider POS, endpoint o contratti API.

File modificati:

- `cassa-frontend/backend/modules/payments/payment-print-format.domain.js`: nuovo domain factory per helper di formattazione pagamento/stampa;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali duplicate e istanziata la factory;
- `cassa-frontend/backend/tests/payment-print-format-domain.test.mjs`: nuovi test mirati su formattazione, riferimenti ordine, note, metodi e storni.

Funzioni rimosse da `server.js`:

- `formatIntegrationPrintDateTime`;
- `formatIntegrationPrintOrderId`;
- `formatIntegrationPrintDisplayName`;
- `isElectronicPaymentReceiptMethod`;
- `buildMobilePaymentOrderReferenceLabel`;
- `normalizePaymentPrintNote`;
- `formatPaymentMethodPrintLabel`;
- `formatRefundActionPrintLabel`;
- `normalizeStornoPaymentReferences`.

Configurazione passata dal server al domain:

- `normalizePaymentMethodType`;
- `normalizeStringList`;
- `roundMoney`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.317 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.166 righe;
- riduzione netta fase: 151 righe;
- riduzione totale da baseline memoria: 1.003 righe;
- nuovo domain testabile: 188 righe;
- nuovo test domain: 116 righe.

Nota tecnica:

- la slice e' volutamente pura;
- il domain non apre socket, non scrive DB, non accoda job di stampa e non chiama API fiscali;
- i chiamanti in `server.js` mantengono gli stessi nomi di funzione tramite destructuring della factory;
- la funzione data/ora continua a usare timezone locale del server come prima.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/modules/payments/payment-print-format.domain.js && node --test backend/tests/payment-print-format-domain.test.mjs`: OK, 8/8;
- `node --test backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/payment-money-domain.test.mjs backend/tests/payment-print-format-domain.test.mjs`: OK, 53/53;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- bug pausa postazione ancora aperto;
- bug table move digitale ancora aperto;
- harness continuity conserva rischio bad-port randomico;
- non sono stati risolti in questa slice per non mischiare refactor monolite con bugfix funzionali.

Prossimo step consigliato:

1. se si continua la riduzione, estrarre solo altri helper puri gia copribili da test;
2. evitare side effect POS/fiscale/spool finche' i due gate rossi non sono chiusi;
3. prossimo candidato sicuro: helper puri di statistiche/report o normalizzazioni di print model, ma solo dopo inventory puntuale.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1K fiscal receipts domain

Obiettivo:

- continuare con una seconda micro-slice pura nello stesso ciclo;
- isolare la sanitizzazione dei receipt fiscali gia' emessi e dei riferimenti scalari ricevuti dall'API fiscale;
- non cambiare emissione fiscale, retry, ristampa, provider, endpoint o persistenza.

File modificati:

- `cassa-frontend/backend/modules/payments/fiscal-receipts.domain.js`: nuovo domain factory per sanitizzazione receipt fiscali;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali e istanziata la factory;
- `cassa-frontend/backend/tests/fiscal-receipts-domain.test.mjs`: nuovi test su scalari fiscali, fallback e receipt completo.

Funzioni rimosse dal monolite:

- `normalizeFiscalApiScalar`;
- `firstFiscalApiScalar`;
- `sanitizeFiscalReceipt`.

Configurazione passata dal server al domain:

- `normalizeConfigId`;
- `normalizePosFiscalApiPath`;
- `nowIso`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.166 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.124 righe;
- riduzione netta fase: 42 righe;
- riduzione totale da baseline memoria: 1.045 righe;
- nuovo domain testabile: 71 righe;
- nuovo test domain: 105 righe.

Nota tecnica:

- il domain e' puro e non esegue chiamate fiscali;
- mantiene il comportamento conservativo precedente:
  - rifiuta `"[object Object]"` come scalare fiscale;
  - usa fallback `ISSUED` quando manca uno stato fiscale esplicito;
  - delega al server la normalizzazione path esistente senza introdurre nuovo schema.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/modules/payments/fiscal-receipts.domain.js && node --test backend/tests/fiscal-receipts-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/payment-money-domain.test.mjs backend/tests/payment-print-format-domain.test.mjs backend/tests/fiscal-receipts-domain.test.mjs`: OK, 57/57;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- bug pausa postazione ancora aperto;
- bug table move digitale ancora aperto;
- non sono stati corretti in questa iterazione per mantenere separati refactor puro e bugfix funzionale.

Prossimo step consigliato:

1. fermare ulteriori estrazioni fiscal/payment non pure finche' non si chiudono i due gate rossi;
2. valutare come prossima slice solo normalizzazioni pure di report/statistiche o print model;
3. aprire un ciclo separato per bugfix table move digitale e pausa postazione.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1L ESC-POS style helpers

Obiettivo:

- continuare la riduzione del monolite con helper puri di stampa;
- estrarre solo la generazione di sequenze ESC/POS di stile:
  - allineamento;
  - grassetto;
  - corsivo;
  - sottolineato;
  - spaziatura caratteri;
  - dimensione testo;
  - reset inline;
  - styling di una o piu' righe;
- non modificare socket, spool, code di stampa, routing stampanti o payload fiscali.

File modificati:

- `cassa-frontend/backend/printing/escpos-style.js`: nuovo modulo factory per helper ESC/POS puri;
- `cassa-frontend/backend/tests/escpos-style.test.mjs`: nuovi test sui byte ESC/POS e formattazione righe;
- `cassa-frontend/backend/server.js`: rimosse le funzioni locali ESC/POS e usato il nuovo modulo;
- `cassa-frontend/backend/tests/pos-fiscal-retry.e2e.test.mjs`: piccolo fix harness per attendere lo stato persistito `ISSUED`;
- `cassa-frontend/backend/server.js`: piccolo bugfix recovery fiscale legacy per receipt POS senza `fiscalDeviceId`.

Funzioni rimosse dal monolite:

- `escPos`;
- `escPosAlign`;
- `escPosBold`;
- `escPosUnderline`;
- `escPosItalic`;
- `escPosCharSpacing`;
- `escPosSize`;
- `escPosInlineReset`;
- `styleEscPosPrintLine`;
- `styleEscPosPrintLines`.

Configurazione passata dal server al modulo:

- `clampInt`.

Bugfix emerso durante i test:

- `pos-fiscal-retry.e2e.test.mjs` era rosso per i retry di receipt storici senza RT salvata;
- `buildRecoveredPosFiscalJob()` ora ricostruisce il device fiscale in ordine:
  1. device salvato sul receipt;
  2. RT configurata in `posSettings`;
  3. recovery legacy dal provider `pos-fiscal-api` e `POS_FISCAL_API_BASE_URL`;
- il fallback legacy e' limitato al recupero di receipt gia' tracciati e non cambia il routing ordinario di stampanti/RT.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.124 righe;
- `cassa-frontend/backend/server.js` dopo fase e fix recovery: 28.099 righe;
- riduzione netta fase: 25 righe;
- riduzione totale da baseline memoria: 1.070 righe;
- nuovo modulo testabile: 69 righe;
- nuovo test modulo: 58 righe.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/printing/escpos-style.js && node --test backend/tests/escpos-style.test.mjs backend/tests/print-utils-core.test.mjs`: OK, 8/8;
- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`: OK, 4/4;
- `node --test backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/payment-money-domain.test.mjs backend/tests/payment-print-format-domain.test.mjs backend/tests/fiscal-receipts-domain.test.mjs backend/tests/escpos-style.test.mjs`: OK, 61/61;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 38/38;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- table move digitale ancora aperto;
- pausa postazione ancora aperta;
- dopo questo ciclo il retry fiscale POS e' piu' coperto e verde, ma resta da evitare ulteriore refactor fiscale non puro senza gate completi.

Prossimo step consigliato:

1. aprire un ciclo bugfix dedicato per i due gate rossi storici;
2. se si continua la riduzione prima dei bugfix, scegliere solo helper puri di report/statistiche;
3. non estrarre service con side effect finche' i gate rossi non sono chiusi.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1M printer config domain

Obiettivo:

- continuare la riduzione del monolite con helper puri di configurazione stampanti e RT;
- estrarre normalizzazione di purpose, modello, porta, host, target esplicito, stampanti e dispositivi fiscali;
- non modificare routing operativo, spool, socket, API fiscale, DB, pagamenti o stampa reale.

File modificati:

- `cassa-frontend/backend/printing/printer-config.domain.js`: nuovo modulo factory per helper configurazione stampanti/RT;
- `cassa-frontend/backend/tests/printer-config-domain.test.mjs`: test su normalizzazione stampanti, RT, capability fiscali e target espliciti;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali stampanti/RT e usato il nuovo modulo;
- `cassa-frontend/backend/tests/configuration-snapshot.test.mjs`: allineata aspettativa `precontoPrinterIds`;
- `cassa-frontend/backend/tests/pos-fiscal-retry.e2e.test.mjs`: data del test retry entro finestra calcolata sul momento corrente.

Funzioni rimosse dal monolite:

- `normalizePrinterPurpose`;
- `normalizePrinterModelId`;
- `normalizePrinterPort`;
- `normalizePrinterHost`;
- `resolveExplicitPrinterTarget`;
- `sanitizePosPrinter`;
- `sanitizePosFiscalDevice`.

Configurazione passata dal server al modulo:

- `DEFAULT_FISCAL_PRINTER_MODEL`;
- `DEFAULT_NETWORK_PRINTER_PORT`;
- `POS_PRINTER_MODELS`;
- `POS_PRINTER_PURPOSES`;
- `normalizeConfigId`;
- `normalizeReferenceIdList`;
- `normalizePosFiscalApiPath`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.099 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.001 righe;
- riduzione netta fase: 98 righe;
- riduzione totale da baseline memoria dopo fase: 1.168 righe;
- nuovo modulo testabile: 141 righe;
- nuovo test modulo: 176 righe.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/printing/printer-config.domain.js && node --test backend/tests/printer-config-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/configuration-snapshot.test.mjs`: OK, 7/7;
- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`: OK, 4/4;
- `node --test backend/tests/printer-config-domain.test.mjs backend/tests/configuration-save-contract.test.mjs backend/tests/configuration-snapshot.test.mjs backend/tests/operational-context-alias.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs`: OK, 21/21;
- `node --test backend/tests/print-utils-core.test.mjs backend/tests/escpos-style.test.mjs backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs`: OK, 31/31;
- `npm run check:backend`: OK;
- suite domini fino a printer config: OK, 66/66;
- `node --test backend/tests/orders-payments-invariants.test.mjs`: OK, 15/15;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- table move digitale ancora aperto;
- pausa postazione ancora aperta;
- evitare estrazioni con side effect finche' questi gate non sono chiusi.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1N activity config domain

Obiettivo:

- continuare con un micro-taglio puro nell'area configurazione locale/attivita/sale;
- estrarre sanitizzazione attivita, policy fiscale attivita, binding attivita-sale e fallback automatico dei binding;
- non modificare DB, endpoint impostazioni, snapshot, stampa, RT, menu/listini o routing operativo.

File modificati:

- `cassa-frontend/backend/modules/configuration/activity-config.domain.js`: nuovo modulo factory per helper configurazione attivita-sale;
- `cassa-frontend/backend/tests/activity-config-domain.test.mjs`: test su alias legacy, schedule, policy fiscale, binding filtrati e fallback automatici;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali attivita-sale e usato il nuovo modulo.

Funzioni rimosse dal monolite:

- `sanitizePosActivityFiscalPolicy`;
- `sanitizePosActivity`;
- `sanitizePosActivityRoomBinding`;
- `buildDefaultPosActivityRoomBindings`.

Configurazione passata dal server al modulo:

- `normalizeConfigId`;
- `normalizeReferenceIdList`;
- `normalizeMenuScheduleRules`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.001 righe;
- `cassa-frontend/backend/server.js` dopo fase: 27.921 righe;
- riduzione netta fase: 80 righe;
- riduzione totale da baseline memoria: 1.248 righe;
- nuovo modulo testabile: 115 righe;
- nuovo test modulo: 136 righe.

Test eseguiti:

- `node --check backend/modules/configuration/activity-config.domain.js && node --check backend/server.js && node --test backend/tests/activity-config-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/activity-config-domain.test.mjs backend/tests/printer-config-domain.test.mjs backend/tests/configuration-save-contract.test.mjs backend/tests/configuration-snapshot.test.mjs backend/tests/operational-context-alias.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs`: OK, 26/26;
- suite domini completa: `node --test backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/payment-money-domain.test.mjs backend/tests/payment-print-format-domain.test.mjs backend/tests/fiscal-receipts-domain.test.mjs backend/tests/escpos-style.test.mjs backend/tests/printer-config-domain.test.mjs backend/tests/activity-config-domain.test.mjs`: OK, 71/71;
- `npm run check:backend`: OK;
- `node --test backend/tests/print-utils-core.test.mjs backend/tests/escpos-style.test.mjs backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 46/46;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- nessuna regressione osservata su configurazione, domini, pagamenti, fiscale simulato e invarianti ordini/pagamenti;
- i due gate rossi noti restano invariati e vanno trattati come ciclo bugfix separato prima di estrazioni con side effect.

Prossimo step consigliato:

1. chiudere i due gate rossi storici su table move digitale e pausa postazione;
2. se si continua a ridurre prima dei bugfix, estrarre solo helper puri di snapshot/report/statistiche;
3. non spostare service di stampa, fiscale, pagamenti o lock finche' i gate rossi non sono verdi.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1O locale e mobile device config domain

Obiettivo:

- continuare la riduzione del monolite seguendo solo helper puri di configurazione;
- estrarre normalizzazione del locale operativo e dei palmari/mobile devices;
- mantenere invariata la semantica su locale, alias legacy, palmari, fiscalEnabled, pagamento elettronico e pagamento contanti;
- non modificare DB, API, stampa, fiscalita', routing postazioni, batteria o sessioni.

File modificati:

- `cassa-frontend/backend/modules/configuration/locale-config.domain.js`: nuovo modulo factory per helper locale/locali;
- `cassa-frontend/backend/modules/configuration/mobile-device-config.domain.js`: nuovo modulo factory per helper palmari/mobile devices;
- `cassa-frontend/backend/tests/locale-config-domain.test.mjs`: test su alias legacy, fallback e deduplica locali;
- `cassa-frontend/backend/tests/mobile-device-config-domain.test.mjs`: test su alias device, capability fiscali, deduplica e ordinamento palmari;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali equivalenti e usati i due nuovi moduli.

Funzioni rimosse dal monolite:

- `sanitizePosLocale`;
- `sanitizePosLocales`;
- `sanitizeMobileDeviceSetting`;
- `sanitizeMobileDeviceSettings`.

Configurazione passata dal server ai moduli:

- `normalizeConfigId`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 27.921 righe;
- `cassa-frontend/backend/server.js` dopo fase: 27.861 righe;
- riduzione netta fase: 60 righe;
- riduzione totale da baseline memoria: 1.308 righe;
- nuovo modulo locale: 40 righe;
- nuovo modulo mobile devices: 56 righe;
- nuovi test: 161 righe complessive.

Test eseguiti:

- `node --check backend/modules/configuration/locale-config.domain.js && node --check backend/modules/configuration/mobile-device-config.domain.js && node --check backend/server.js && node --test backend/tests/locale-config-domain.test.mjs backend/tests/mobile-device-config-domain.test.mjs`: OK, 7/7;
- `node --test backend/tests/locale-config-domain.test.mjs backend/tests/mobile-device-config-domain.test.mjs backend/tests/activity-config-domain.test.mjs backend/tests/printer-config-domain.test.mjs backend/tests/configuration-save-contract.test.mjs backend/tests/configuration-snapshot.test.mjs backend/tests/operational-context-alias.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs`: OK, 33/33;
- suite domini completa con locale/mobile devices: OK, 78/78;
- `npm run check:backend`: OK;
- `node --test backend/tests/print-utils-core.test.mjs backend/tests/escpos-style.test.mjs backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 46/46;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- nessuna regressione osservata su configurazione, dominio, pagamento/fiscale simulato e invarianti ordini/pagamenti;
- gate rossi storici invariati.

Prossimo step consigliato:

1. chiudere i due gate rossi storici prima di estrarre service con side effect;
2. se si continua la riduzione, restare su pure helper di area/workstation/cash point oppure snapshot/report;
3. non introdurre fallback su stampanti, RT, postazioni o palmari.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1P area config domain

Obiettivo:

- continuare la riduzione del monolite su helper puri di configurazione;
- estrarre regole di sale, cash point, postazioni di sala e numero minimo tavoli;
- mantenere invariata la logica di menu/listini, stampanti preconto, stampanti operative, fiscal printer legacy e scope postazioni;
- non modificare DB, endpoint, routing operativo, spool, fiscale, pagamento o sessioni.

File modificati:

- `cassa-frontend/backend/modules/configuration/area-config.domain.js`: nuovo modulo factory per helper sale/cash point/postazioni;
- `cassa-frontend/backend/tests/area-config-domain.test.mjs`: test su minimum tables, cash point, postazioni, sala completa e input invalidi;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali equivalenti e usato il nuovo modulo.

Funzioni rimosse dal monolite:

- `resolveConfiguredAreaMinimumTables`;
- `sanitizePosAreaCashPoint`;
- `sanitizePosAreaWorkstation`;
- `sanitizePosArea`.

Configurazione passata dal server al modulo:

- `normalizeConfigId`;
- `normalizeReferenceIdList`;
- `normalizeStringList`;
- `normalizeMenuScheduleRules`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 27.861 righe;
- `cassa-frontend/backend/server.js` dopo fase: 27.756 righe;
- riduzione netta fase: 105 righe;
- riduzione totale da baseline memoria: 1.413 righe;
- nuovo modulo area: 136 righe;
- nuovo test area: 183 righe.

Test eseguiti:

- `node --check backend/modules/configuration/area-config.domain.js && node --check backend/server.js && node --test backend/tests/area-config-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/area-config-domain.test.mjs backend/tests/locale-config-domain.test.mjs backend/tests/mobile-device-config-domain.test.mjs backend/tests/activity-config-domain.test.mjs backend/tests/printer-config-domain.test.mjs backend/tests/configuration-save-contract.test.mjs backend/tests/configuration-snapshot.test.mjs backend/tests/operational-context-alias.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs`: OK, 38/38;
- suite domini completa con area config: OK, 83/83;
- `npm run check:backend`: OK;
- `node --test backend/tests/print-utils-core.test.mjs backend/tests/escpos-style.test.mjs backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 46/46;
- `node --test backend/tests/security.test.mjs`: 26/27, failure gia noto su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure gia noto su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- nessuna regressione osservata su configurazione sale/postazioni, dominio, pagamenti/fiscale simulato e invarianti;
- gate rossi storici invariati.

Prossimo step consigliato:

1. chiudere i due gate rossi storici prima di service con side effect;
2. se si continua con monolite, scegliere helper puri di print preferences o snapshot/report;
3. non introdurre fallback su stampanti, RT, sale o postazioni.

## Aggiornamento ciclo 2026-06-07 - chiusura gate load balancing/preparation queue

Obiettivo:

- chiudere i gate rossi storici prima di ulteriori estrazioni dal monolite;
- correggere un punto reale del load balancing V3 emerso dalle prove operative: dopo cambio device/relogin o identita' incompleta, una postazione poteva non pesare correttamente nel carico;
- riallineare i test alla regola architetturale V3 `1 postazione = 1 utente`.

File modificati:

- `cassa-frontend/backend/integration/load-balancer.service.js`;
- `cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs`;
- `cassa-frontend/backend/tests/continuity.e2e.test.mjs`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Modifica logica:

- `estimateStationWorkload()` non scarta piu' una comanda assegnata alla stessa postazione solo per mismatch/mancanza di identita' operatore;
- nel modello V3 la postazione e' esclusiva, quindi il carico aperto deve pesare sulla postazione fisica;
- i test E2E non provano piu' due operatori contemporanei sulla stessa postazione;
- la coda preparazione viene testata su una lane isolata per evitare contaminazioni dal carico aperto precedente della continuity suite.

Metriche:

- `cassa-frontend/backend/server.js`: invariato a 28.596 righe;
- `cassa-frontend/backend/integration/load-balancer.service.js`: 698 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB schema.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/tests/continuity.e2e.test.mjs`: OK;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- gate security chiuso;
- gate continuity chiuso;
- si puo' tornare a ridurre il monolite con rischio minore.

Prossimo step consigliato:

1. estrarre una slice pura di `order-preparation-queue` o `station assignment/load balancing adapter` dal monolite;
2. mantenere `load-balancer.service.js` come service esterno e spostare solo adapter/server glue testabile;
3. rieseguire sempre `continuity.e2e`, `test:security`, `check:backend`.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1Q coda preparazione

Obiettivo:

- proseguire la riduzione V3 dopo gate continuity/security verdi;
- estrarre una regola pura dalla coda preparazione;
- non modificare endpoint, DB, stampa, fiscalita', pagamenti o routing postazioni.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Funzione rimossa dal monolite:

- `countPreparingIntegrationOrdersInLane`.

Funzione estratta:

- `countPreparingIntegrationOrdersInLane(db, targetOrder, options, dependencies)`;
- dipendenze iniettate:
  - `integrationOrderQueueLaneKey`;
  - `normalizeIntegrationWorkflowStatus`;
  - `sanitizeIntegrationOrder`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.596 -> 28.585 righe;
- riduzione netta fase: 11 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 134 righe;
- nuovo test: 160 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 4/4;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna regressione osservata su coda preparazione, load balancing, pagamenti/stampe coperti da continuity e security;
- V2/current non toccata;
- nessun riavvio.

Prossimo step consigliato:

1. estrarre il calcolo puro delle lane attive o la scelta del prossimo waiting da promuovere;
2. continuare a lasciare `reconcileIntegrationPreparationQueue()` nel server finche' non si separano bene mutation DB e dominio puro;
3. ripetere continuity/security/check backend dopo ogni slice.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1R selettore coda preparazione

Obiettivo:

- continuare la riduzione sulla stessa area coda preparazione;
- estrarre la decisione pura di promozione `waiting -> prep`;
- lasciare nel server solo la mutazione DB e gli effetti collegati.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- costruzione locale di:
  - `lanesWithPreparation`;
  - `waitingByLane`;
  - selezione dell'ordine piu' vecchio per lane da promuovere.

Funzione estratta:

- `selectPreparationQueuePromotionIds(orders, activeQueue, dependencies)`;
- dipendenze iniettate:
  - `integrationOrderQueueLaneKey`;
  - `isIntegrationOrderOpenForPreparationQueue`;
  - `isIntegrationOrderQueueLaneActive`;
  - `normalizeIntegrationWorkflowStatus`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.585 -> 28.553 righe;
- riduzione netta fase: 32 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 214 righe;
- test modulo: 260 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 6/6;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna regressione osservata sui flussi continuity;
- V2/current non toccata;
- nessun riavvio.

Prossimo step consigliato:

1. estrarre `isIntegrationOrderOpenForPreparationQueue` e `isIntegrationOrderQueueLaneActive` nel modulo coda;
2. oppure estrarre un adapter puro per lane attive mantenendo in server il recupero stati postazione;
3. non spostare ancora `promoteIntegrationOrderToPreparation()` finche' dipende da route transitions e sanitize server.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1S regole coda preparazione

Obiettivo:

- spostare fuori dal monolite altre due regole pure della coda preparazione;
- mantenere la semantica di pagamento residuo, workflow e lane operatore;
- non toccare endpoint, DB, stampa, fiscale, pagamenti o V2/current.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Funzioni rimosse dal monolite:

- `isIntegrationOrderOpenForPreparationQueue`;
- `isIntegrationOrderQueueLaneActive`.

Funzioni estratte:

- `isIntegrationOrderOpenForPreparationQueue(order, dependencies)`;
- `isIntegrationOrderQueueLaneActive(order, activeQueue, dependencies)`.

Dipendenze iniettate dal server:

- per ordine aperto:
  - `normalizeIntegrationWorkflowStatus`;
  - `roundMoney`;
- per lane attiva:
  - `integrationOrderQueueStation`;
  - `integrationOrderQueueLaneKey`;
  - `integrationOrderQueueOperatorKey`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.553 -> 28.539 righe;
- riduzione netta fase: 14 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 259 righe;
- test modulo: 326 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 8/8;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna regressione osservata;
- V2/current non toccata;
- nessun riavvio.

Prossimo step consigliato:

1. estrarre il builder puro delle lane attive a partire da station states gia' normalizzati;
2. non spostare ancora `promoteIntegrationOrderToPreparation()` perche' dipende da route transition e sanitize server;
3. valutare una factory domain per `reconcileIntegrationPreparationQueue()` solo dopo aver isolato lane active e promotion metadata.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1T builder lane attive

Obiettivo:

- completare il prossimo micro-step sulla coda preparazione V3;
- estrarre dal monolite la costruzione delle lane/postazioni attive partendo dagli station states gia' recuperati dal server;
- mantenere endpoint, DB, stampa, fiscalita', pagamenti e V2/current invariati.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- ciclo locale in `buildActiveIntegrationOrderQueueLaneKeys(db)` per:
  - leggere le postazioni attive da `getActiveStations`;
  - normalizzare il nome postazione;
  - costruire `stations`;
  - costruire le lane `station::operatorKey`;
  - filtrare station state incompleti o non validi.

Funzione estratta:

- `buildActivePreparationQueueLaneKeys(stationStates, dependencies)`.

Dipendenze iniettate dal server:

- `allowDemoStations`;
- `getActiveStations`;
- `integrationStationStateQueueOperatorKey`;
- `normalizeOptionalIntegrationStationName`.

Garanzie mantenute:

- il server resta responsabile di `buildIntegrationStationStatesWithSessionRecovery(db)`;
- la policy demo/fallback resta runtime e non viene hardcodata nel modulo;
- il modulo puro non accede a DB, socket, filesystem, stampa o fiscale;
- in caso di dati incompleti ritorna set vuoti invece di inventare postazioni.

Metriche:

- `cassa-frontend/backend/server.js`: 28.539 -> 28.533 righe;
- riduzione netta fase: 6 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 293 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 420 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 10/10;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna regressione osservata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- il load balancing resta ancorato a postazioni reali attive e non a mock.

Prossimo step consigliato:

1. estrarre un builder puro del contesto di riconciliazione, lasciando nel server solo lettura DB e scrittura finale;
2. mantenere `promoteIntegrationOrderToPreparation()` nel monolite finche' non sono isolate route transitions e sanitize;
3. aggiungere test di non regressione sulla scelta lane in presenza di piu' postazioni attive prima di ulteriori spostamenti.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1U record promozione

Obiettivo:

- proseguire con un micro-step a rischio molto basso;
- spostare fuori dal monolite la costruzione del payload di promozione restituito da `reconcileIntegrationPreparationQueue()`;
- lasciare invariati workflow, DB write, route transitions, stampa, fiscale e pagamenti.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- costruzione inline del record:
  - `orderId`;
  - `station`;
  - `operatorUserId`;
  - `operatorUsername`;
  - `operatorName`.

Funzione estratta:

- `buildPreparationQueuePromotionRecord(order, dependencies)`.

Dipendenze iniettate dal server:

- `integrationOrderQueueStation`.

Garanzie mantenute:

- la funzione e' pura;
- non legge e non scrive DB;
- non usa stato globale;
- non inventa record se manca id ordine o adapter postazione;
- il server continua a chiamare `promoteIntegrationOrderToPreparation()` e a gestire la scrittura finale.

Metriche:

- `cassa-frontend/backend/server.js`: 28.533 -> 28.531 righe;
- riduzione netta fase: 2 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 309 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 458 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 11/11;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna regressione osservata;
- nessuna modifica alla V2/current;
- nessun riavvio.

Prossimo step consigliato:

1. consolidare una factory del dominio coda preparazione solo quando restano abbastanza helper puri gia' estratti;
2. evitare di spostare side effect finche' non esiste test mirato su `reconcileIntegrationPreparationQueue()`;
3. mantenere sempre `continuity.e2e`, security e static frontend come gate minimi per ogni ulteriore step.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1V normalizzazione ordini coda

Obiettivo:

- continuare il refactor conservativo della coda preparazione;
- spostare dal server la normalizzazione degli ordini usati dalla riconciliazione;
- mantenere nel monolite solo la coordinazione DB e gli effetti collaterali ancora non isolati.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- mapping inline di `db.integration.orders`;
- generazione inline dei fallback id `00001`, `00002`, ecc.;
- chiamata diretta a `sanitizeIntegrationOrder()` dentro `reconcileIntegrationPreparationQueue()` per preparare `normalizedOrders`.

Funzione estratta:

- `normalizePreparationQueueOrders(orders, dependencies)`.

Dipendenze iniettate dal server:

- `sanitizeIntegrationOrder`.

Garanzie mantenute:

- funzione pura;
- nessun accesso DB diretto;
- nessun cambio a workflow, pagamenti, fiscalita', stampa o sale;
- fallback deterministico testato;
- input invalido non produce side effect e ritorna lista vuota.

Metriche:

- `cassa-frontend/backend/server.js`: 28.531 -> 28.530 righe;
- riduzione netta fase: 1 riga;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 319 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 485 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 12/12;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna regressione osservata;
- nessuna modifica alla V2/current;
- nessun riavvio.

Prossimo step consigliato:

1. aggiungere un test mirato per il piano di riconciliazione completo della coda;
2. poi valutare estrazione di una factory `buildPreparationQueueReconciliationPlan()`;
3. non spostare `promoteIntegrationOrderToPreparation()` prima di isolare le dipendenze di workflow route.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1W piano riconciliazione coda

Obiettivo:

- completare lo step consigliato nel ciclo precedente;
- introdurre un piano puro di riconciliazione coda preparazione;
- ridurre il ruolo di `reconcileIntegrationPreparationQueue()` a coordinatore runtime.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- combinazione inline tra normalizzazione ordini e calcolo `promoteIds`;
- import diretto server di `selectPreparationQueuePromotionIds`;
- dettaglio di calcolo del piano promozioni dentro `reconcileIntegrationPreparationQueue()`.

Funzione estratta:

- `buildPreparationQueueReconciliationPlan(orders, activeQueue, dependencies)`.

Dipendenze iniettate dal server:

- `sanitizeIntegrationOrder`;
- `integrationOrderQueueLaneKey`;
- `isIntegrationOrderOpenForPreparationQueue`;
- `isIntegrationOrderQueueLaneActive`;
- `normalizeIntegrationWorkflowStatus`.

Garanzie mantenute:

- nessuna scrittura DB dentro la nuova funzione;
- nessuna chiamata a stampa, fiscale, pagamenti, socket o filesystem;
- nessuna modifica dei contratti endpoint;
- il server resta responsabile di `lastWriteAt`, `meta.lastWriteAt` e promozione concreta.

Nota test:

- primo run mirato fallito per fixture incompleto: il fake `sanitizeIntegrationOrder` non preservava `receivedAtMs`;
- fix applicato solo al test fixture;
- run successivo OK 14/14.

Metriche:

- `cassa-frontend/backend/server.js`: 28.530 -> 28.529 righe;
- riduzione netta fase: 1 riga;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 339 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 540 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 14/14;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna regressione osservata;
- nessuna modifica alla V2/current;
- nessun riavvio.

Prossimo step consigliato:

1. valutare `applyPreparationQueuePromotionPlan()` pura con `promoteOrder` e `buildPromotionRecord` iniettati;
2. prima aggiungere test mirato con promozione singola, nessuna promozione e record nullo;
3. non spostare ancora `promoteIntegrationOrderToPreparation()` fuori dal server.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1X applicazione piano promozioni

Obiettivo:

- completare il prossimo step pianificato;
- estrarre l'applicazione del piano promozioni in funzione pura;
- mantenere nel server workflow side effect, sanitize reale, timestamp e write DB.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- mapping inline degli ordini promossi;
- accumulo inline dei record `promoted`;
- chiamata diretta inline a `buildPreparationQueuePromotionRecord()` dentro il ciclo `map`.

Funzione estratta:

- `applyPreparationQueuePromotionPlan(orders, promoteIds, dependencies)`.

Dipendenze iniettate dal server:

- `promoteOrder`;
- `buildPromotionRecord`.

Garanzie mantenute:

- funzione pura rispetto al DB;
- non muta l'array input;
- non esegue side effect;
- non conosce `promoteIntegrationOrderToPreparation()`;
- se adapter mancanti o ritorni non validi, mantiene gli ordini originali.

Metriche:

- `cassa-frontend/backend/server.js`: 28.529 -> 28.527 righe;
- riduzione netta fase: 2 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 379 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 609 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 17/17;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: primo run KO intermittente sul caso 20, rerun completo OK, 69/69.

Nota stability:

- il failure sul caso 20 riguarda escalation notifica pickup dopo timeout;
- il secondo run completo ha passato lo stesso scenario;
- non e' stata toccata logica notifiche in questo ciclo;
- classificazione: instabilita' test/tempo da monitorare, non regressione riprodotta.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- gate finale accettato dopo rerun completo verde.

Prossimo step consigliato:

1. non estrarre ancora `promoteIntegrationOrderToPreparation()`;
2. se si resta sulla coda, limitarsi a helper puri minori o test di stabilita';
3. in alternativa spostarsi su un'altra area gia' inventariata dove le dipendenze sono meno accoppiate a workflow route.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1Y helper identita lane

Obiettivo:

- proseguire solo con helper puri e non con side effect;
- estrarre risoluzione postazione, operatore e lane della coda preparazione;
- verificare esplicitamente il load balancing dopo il cambio.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- priorita' postazione coda:
  - `assignedStationId`;
  - `ownerStation`;
  - `lockedByStationId`;
  - `station`;
  - fallback `PRIMARY_INTEGRATION_STATION`;
- costruzione chiave operatore ordine;
- costruzione chiave operatore station-state;
- composizione lane `station::operatorKey`.

Funzioni estratte:

- `resolveIntegrationOrderQueueStation(order, dependencies)`;
- `buildIntegrationOrderQueueOperatorKey(order, dependencies)`;
- `buildIntegrationStationStateQueueOperatorKey(stationState, dependencies)`;
- `buildIntegrationOrderQueueLaneKey(order, dependencies)`.

Garanzie mantenute:

- le funzioni server locali restano come adapter compatibili;
- nessuna modifica di endpoint o DB;
- nessun cambio intenzionale di load balancing;
- nessun mock o fallback statico introdotto.

Metriche:

- `cassa-frontend/backend/server.js`: 28.527 -> 28.524 righe;
- riduzione netta fase: 3 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 445 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 700 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- continuity caso 20 passato nel ciclo corrente.

Prossimo step consigliato:

1. non estrarre ancora la promozione reale ordine;
2. scegliere nuova area pura oppure aggiungere test intorno a `promoteIntegrationOrderToPreparation()` prima di eventuali spostamenti;
3. continuare con gate load-balancer ogni volta che si toccano lane, postazioni o operatori.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 1Z helper attore promozione

Obiettivo:

- completare un ultimo micro-step sicuro nella coda preparazione;
- estrarre la risoluzione attore/owner/lock dalla promozione in preparazione;
- non estrarre side effect, sanitize o route transitions.

File modificati:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- calcolo `actorUserId`;
- calcolo `actorUsername`;
- calcolo `lockedByUserId`;
- calcolo `ownerOperator`;
- calcolo `ownerRole`;
- calcolo `ownerAtMs`.

Funzione estratta:

- `resolvePreparationPromotionActor(order, context, dependencies)`.

Garanzie mantenute:

- `promoteIntegrationOrderToPreparation()` resta nel server;
- `sanitizeIntegrationOrder()` resta nel server;
- `applyIntegrationWorkflowRouteTransitions()` resta nel server;
- nessun contratto endpoint modificato;
- nessuna scrittura DB dentro il nuovo helper.

Metriche:

- `cassa-frontend/backend/server.js`: 28.524 -> 28.511 righe;
- riduzione netta fase: 13 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 475 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 766 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 21/21;
- `npm run check:backend`: OK;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: primo run KO `ECONNREFUSED` sul server statico del test, test singolo OK, rerun completo OK 27/27.

Nota stability:

- il KO security non e' riprodotto e non riguarda logica toccata;
- da monitorare se il test static server continua a mostrare avvii lenti/porta non pronta.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- limite raggiunto sulla coda preparazione prima di side effect reali.

Prossimo step consigliato:

1. scegliere una nuova area del monolite meno accoppiata;
2. se si continua su ordini, prima creare test dedicati a `sanitizeIntegrationOrder()` / route transitions;
3. non spostare ulteriormente `promoteIntegrationOrderToPreparation()` in questo stato.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 2A targeting notifiche pickup

Obiettivo:

- avviare una nuova area di riduzione dopo il limite raggiunto sulla coda preparazione;
- estrarre helper puri di targeting/rimozione notifiche pickup mobile;
- rafforzare i test su ritiro comanda e ack correlati.

File modificati:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`;
- `cassa-frontend/backend/tests/notification-records.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `isMobilePickupNotificationForOrder`;
- `removeMobilePickupNotificationsForOrder`;
- match per:
  - `orderId`;
  - `sourceNotificationId`;
  - tipo `bell`;
  - `eventType=order_ready`;
  - `eventType=bell_claimed_by_other`;
  - filtro `targetClientApp=mobile-frontend`.

Funzioni estratte:

- `isMobilePickupNotificationForOrder(notification, options)`;
- `removeMobilePickupNotificationsForOrder(notifications, options)`.

Garanzie mantenute:

- nessuna modifica al formato delle notifiche;
- nessuna modifica agli endpoint;
- nessun cambio alla persistenza;
- nessun side effect fuori dal comportamento gia' esistente;
- la rimozione resta mutativa sull'array come prima, per compatibilita' con il punto d'uso server.

Metriche:

- `cassa-frontend/backend/server.js`: 28.511 -> 28.486 righe;
- riduzione netta fase: 25 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 145 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 236 righe.

Test eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js && node --check backend/server.js && node --test backend/tests/notification-records.test.mjs`: OK, 5/5;
- `npm run check:backend`: OK;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- test pickup/ack coperti sia da test mirato sia da continuity caso 20.

Prossimo step consigliato:

1. restare sulle notifiche solo per helper puri ancora isolabili;
2. possibile candidato: `findPendingBellNotificationByOrderId`;
3. mantenere gate notifiche + continuity per ogni ulteriore estrazione.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 2B bell pending dedup

Obiettivo:

- completare il candidato indicato nella Fase 2A;
- estrarre la ricerca della bell pendente per ordine dal monolite;
- mantenere invariata la deduplica di `queueBellNotification()`.

File modificati:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`;
- `cassa-frontend/backend/tests/notification-records.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- normalizzazione `orderId`;
- iterazione reverse sulle notifiche;
- sanitizzazione con fallback id `ntf_existing_N`;
- filtro tipo `bell`;
- filtro `meta.orderId`;
- filtro claim gia' presente.

Funzione estratta:

- `findPendingBellNotificationByOrderId(integration, orderIdRaw, dependencies)`.

Dipendenze iniettate:

- `sanitizeIntegrationNotification`;
- `hasBellClaim`.

Garanzie mantenute:

- nessun cambio al formato notifiche;
- nessuna modifica endpoint;
- nessuna modifica alla persistenza;
- nessun nuovo side effect;
- dedup bell ancora guidata da `queueBellNotification()`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.486 -> 28.473 righe;
- riduzione netta fase: 13 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 171 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 300 righe.

Test eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js && node --check backend/server.js && node --test backend/tests/notification-records.test.mjs`: OK, 7/7;
- `npm run check:backend`: OK;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- dedup bell coperta da test unitario e flussi continuity.

Prossimo step consigliato:

1. valutare estrazione payload bell solo con clock/resolver iniettati;
2. se troppo accoppiata al DB, cambiare area;
3. mantenere sempre gate notifiche + continuity per step in questa zona.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 2C pausa cameriere

Obiettivo:

- completare un altro taglio a basso rischio nell'area notifiche;
- estrarre dal monolite la decisione su notifiche da non consegnare a camerieri in pausa;
- mantenere il server responsabile solo delle dipendenze operative e non della regola.

File modificati:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`;
- `cassa-frontend/backend/tests/notification-records.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- valutazione pausa/grace pause del cameriere;
- riconoscimento notifiche `waiter`/`bell` sopprimibili;
- esclusione di notifiche urgenti o `forcePausedDelivery`;
- risoluzione sala target da notifica/requester;
- ricerca di un altro cameriere disponibile nella sala o globalmente;
- decisione finale `shouldSuppressNotificationForWaiterPause`.

Funzioni estratte:

- `waiterIsPausedForNotifications(waiter)`;
- `notificationTargetsPausedWaiter(notification)`;
- `resolveNotificationRoomId(notification, requester)`;
- `hasOtherAvailableWaiterForNotification(db, notification, requester, dependencies)`;
- `shouldSuppressNotificationForWaiterPause(db, notification, requester, requesterUser, dependencies)`.

Dipendenze iniettate:

- `collectActiveWaitersInRoom`;
- `collectLoggedInWaiters`;
- `resolveWaiterPauseState`;
- `activeWaiterWindowMs`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamento/fiscalita'/stampa;
- nessun side effect nuovo;
- le notifiche urgenti e force delivery continuano a non essere soppresse;
- se non esiste altro cameriere disponibile, il cameriere in pausa continua a ricevere la notifica come da logica precedente.

Metriche:

- `cassa-frontend/backend/server.js`: 28.473 -> 28.436 righe;
- riduzione netta fase: 37 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 232 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 378 righe.

Test eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/notification-records.test.mjs`: OK, 9/9;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- area pausa/notifiche piu' modulare e coperta da test unitari + e2e.

Prossimo step consigliato:

1. fermarsi prima di estrarre payload bell se richiede DB resolver non ancora isolati;
2. cercare un helper puro in un'altra area o isolare prima resolver piccoli;
3. mantenere gate completi per evitare regressioni su chiamate camerieri, pickup e priorita.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 2D target bell da sessioni

Obiettivo:

- continuare l'estrazione controllata nell'area notifiche;
- rendere testabile la risoluzione del target bell da hint cameriere e sessioni mobile attive;
- rimuovere codice bell inutilizzato dal monolite.

File modificati:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`;
- `cassa-frontend/backend/tests/notification-records.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- match hint cameriere contro username, nome completo e primo nome;
- scansione sessioni mobile attive;
- scelta della sessione piu' recente per target personale;
- filtro sessioni stale in base alla finestra di attivita';
- funzione non referenziata `resolveBellTargetFromRoomActiveSessions`.

Funzioni estratte:

- `waiterHintMatchesUser(waiterHint, user)`;
- `resolveBellTargetFromActiveSessions(db, waiterHint, options)`.

Opzioni introdotte nel resolver:

- `nowMs`, per test deterministici;
- `activeWindowMs`, per preservare la finestra `INTEGRATION_WAITER_ACTIVE_WINDOW_MS` senza hardcode nel modulo.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamento/fiscalita'/stampa;
- nessun nuovo side effect;
- target personale bell invariato;
- sessioni cassa/postazione continuano a non essere considerate come palmari mobile.

Metriche:

- `cassa-frontend/backend/server.js`: 28.436 -> 28.330 righe;
- riduzione netta fase: 106 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 299 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 452 righe.

Test eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/notification-records.test.mjs`: OK, 11/11;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- rimosso anche un helper bell non piu' raggiungibile.

Prossimo step consigliato:

1. non spostare ancora `prepareBellNotificationPayload()` intera;
2. isolare prima eventuali resolver piccoli residui oppure cambiare dominio;
3. continuare con tagli reversibili e testati, preferendo funzioni pure o con dipendenze esplicite.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 2E escalation bell

Obiettivo:

- continuare con un helper piccolo e reversibile nell'area notifiche;
- spostare dal monolite la transizione di escalation delle notifiche bell mirate;
- rendere il calcolo temporale configurabile e testabile.

File modificati:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`;
- `cassa-frontend/backend/tests/notification-records.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- controllo tipo `bell`;
- blocco escalation se gia' ackata;
- riconoscimento target personale/sala/stazione;
- calcolo timeout da `bellEscalateAtMs` o `createdAt + BELL_TARGET_TIMEOUT_MS`;
- rimozione dei target;
- salvataggio `originalWaiter`;
- marcatura `targetClientApp` e `escalatedToAllAtMs`.

Funzione estratta:

- `maybeEscalateBellNotification(notification, options)`.

Opzioni introdotte:

- `nowMs`;
- `defaultTargetTimeoutMs`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/stampa;
- nessun nuovo side effect esterno;
- la funzione continua a mutare solo la notifica ricevuta, come faceva prima il monolite;
- timeout operativo ancora fornito dal server tramite `BELL_TARGET_TIMEOUT_MS`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.330 -> 28.296 righe;
- riduzione netta fase: 34 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 348 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 536 righe.

Test eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/notification-records.test.mjs`: OK, 13/13;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- area notifiche sempre piu' modulare, ma i prossimi pezzi sono piu' accoppiati.

Prossimo step consigliato:

1. non estrarre `prepareBellNotificationPayload()` senza prima disaccoppiare resolver DB/comande;
2. cercare un nuovo helper puro fuori dall'area notifiche o un sotto-helper bell chiaramente isolabile;
3. continuare a registrare metriche e gate in memoria a ogni passo.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 3A marker varianti ordine

Obiettivo:

- cambiare area dopo molte estrazioni notifiche;
- estrarre una funzione pura dal dominio righe ordine;
- iniziare una decomposizione prudente della logica varianti/supplementi senza toccare pricing runtime o persistenza.

File modificati:

- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`;
- `cassa-frontend/backend/tests/listino-time-pricing.e2e.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- raccolta marker da `variant`;
- raccolta marker da `variantName`;
- raccolta marker da `variantId` / `variant_id`;
- visita di `selectedVariant` / `selected_variant`;
- visita di `variants`;
- visita annidata di array, oggetti e flag booleani;
- deduplica marker finale.

Funzione estratta:

- `collectIntegrationVariantMarkers(line)`.

Nota test/listino:

- durante i gate e' emersa una configurazione test legacy incompleta per il preconto LISTINO-16;
- il backend rispondeva correttamente con `PRINTER_NOT_AVAILABLE`;
- e' stato aggiornato solo il setup del test per includere attivita', binding sala-attivita' e workstation coerente;
- non e' stato reintrodotto alcun fallback stampanti/RT.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/stampa runtime;
- nessun nuovo side effect;
- comportamento marker legacy conservato, incluse chiavi testuali usate come marker;
- varianti premium e supplementi restano protetti da test listino, ordini e continuity.

Metriche:

- `cassa-frontend/backend/server.js`: 28.296 -> 28.254 righe;
- riduzione netta fase: 42 righe;
- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`: 42 righe;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`: 63 righe.

Test eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 3/3;
- `node --test --test-name-pattern "LISTINO-16" backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 1/1;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 42/42;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- dominio varianti riga ordine avviato con test dedicato.

Prossimo step consigliato:

1. valutare `resolveIntegrationLineExplicitVariantDelta` solo se si introduce dependency injection per `readIntegrationMoneyValue`/`roundMoney`;
2. evitare di spostare `assertIntegrationLineVariantSelection` finche' dipende direttamente da `HttpError` e costanti HTTP;
3. continuare con piccoli helper puri o factory domain testate.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 3B delta variante esplicito

Obiettivo:

- proseguire sul dominio righe ordine;
- estrarre parsing e risoluzione del delta variante esplicito;
- non spostare ancora parti accoppiate a HTTP, catalogo runtime o persistenza.

File modificati:

- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- parsing candidato delta variante;
- filtro valori non positivi;
- lettura campi diretti:
  - `variantPriceDelta`;
  - `variant_price_delta`;
  - `variantDelta`;
  - `variant_delta`;
  - `modifierPriceDelta`;
  - `modifier_price_delta`;
- lettura campi annidati da `selectedVariant`, `selected_variant`, `variants` oggetto;
- somma delta da array `variants`.

Funzioni estratte:

- `readIntegrationVariantDeltaCandidate(value)`;
- `resolveIntegrationLineExplicitVariantDelta(line)`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/stampa runtime;
- nessun nuovo side effect;
- listino runtime con variante resta coperto;
- correzioni ordine con varianti/supplementi restano coperte da continuity.

Metriche:

- `cassa-frontend/backend/server.js`: 28.254 -> 28.205 righe;
- riduzione netta fase: 49 righe;
- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`: 112 righe;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`: 124 righe.

Test eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 6/6;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 45/45;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- dominio varianti riga ordine consolidato.

Prossimo step consigliato:

1. candidato: `resolveIntegrationLineSupplementMarkerDelta`;
2. mantenere test dedicati su note/descrizioni/supplementi;
3. non estrarre selezione obbligatoria variante premium finche' non si separa errore dominio da `HttpError`.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 3C supplemento marker

Obiettivo:

- proseguire con un helper puro del dominio righe ordine;
- estrarre la lettura supplemento da marker/note/descrizione;
- non toccare routing, persistenza o validazioni HTTP.

File modificati:

- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- composizione stringa marker da varianti + note + descrizione;
- parsing `+ N` con decimali;
- arrotondamento e fallback a zero.

Funzione estratta:

- `resolveIntegrationLineSupplementMarkerDelta(line)`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/stampa runtime;
- nessun nuovo side effect;
- supplementi continuano a essere riconosciuti solo con segno `+`;
- casi correzione ordine con varianti/supplementi restano coperti da continuity.

Metriche:

- `cassa-frontend/backend/server.js`: 28.205 -> 28.194 righe;
- riduzione netta fase: 11 righe;
- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`: 124 righe;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`: 161 righe.

Test eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 9/9;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 48/48;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- dominio varianti riga ordine ulteriormente consolidato.

Prossimo step consigliato:

1. valutare estrazione matching variante menu solo se si accetta una factory con lookup helpers iniettati;
2. evitare `assertIntegrationLineVariantSelection` finche' il dominio non espone un errore puro;
3. considerare un nuovo dominio se i prossimi helper varianti risultano troppo accoppiati.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 3D applicazione delta prezzo

Obiettivo:

- completare un altro helper puro del dominio varianti riga ordine;
- estrarre la decisione di applicare o meno il delta variante al prezzo base;
- conservare il comportamento legacy senza introdurre parsing nuovo su `variantDelta`.

File modificati:

- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- normalizzazione base price;
- normalizzazione delta;
- calcolo prezzo premium atteso;
- protezione da doppia applicazione del delta;
- applicazione delta solo quando il prezzo base e' ancora quello menu.

Funzione estratta:

- `applyIntegrationVariantDeltaToBasePrice(basePrice, menuBasePrice, variantDelta)`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/stampa runtime;
- nessun nuovo side effect;
- `variantDelta` stringa con virgola resta non supportato qui, come nel monolite;
- pricing listino con variante resta coperto da test e2e.

Metriche:

- `cassa-frontend/backend/server.js`: 28.194 -> 28.184 righe;
- riduzione netta fase: 10 righe;
- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`: 135 righe;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`: 178 righe.

Test eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 12/12;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 51/51;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- dominio varianti riga ordine maturo per helper puri, ma i prossimi pezzi sono piu' accoppiati.

Prossimo step consigliato:

1. non estrarre `assertIntegrationLineVariantSelection` senza prima separare errore dominio da HTTP;
2. valutare matching variante menu come factory con lookup helpers iniettati;
3. se il guadagno non e' sufficiente, cambiare dominio per continuare il monolite reduction in sicurezza.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 3E normalizzazione dati variante

Obiettivo:

- continuare il consolidamento del dominio varianti riga ordine;
- estrarre `normalizeIntegrationVariantData` dal monolite;
- mantenere identico il comportamento legacy su varianti oggetto, array, stringa e input non serializzabile.

File modificati:

- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- clone JSON delle varianti gia' strutturate;
- fallback `{ label: variantName }` per varianti legacy testuali;
- fallback `{}` quando non ci sono dati variante;
- fallback `{}` quando il clone JSON non e' possibile.

Funzione estratta:

- `normalizeIntegrationVariantData(rawVariants, rawVariantName)`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/stampa runtime;
- nessun nuovo side effect;
- array e oggetti continuano a essere clonati come nel `cloneJson` legacy;
- dati circolari/non serializzabili continuano a essere neutralizzati in `{}`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.184 -> 28.176 righe;
- riduzione netta fase: 8 righe;
- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`: 152 righe;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`: 204 righe.

Test eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 15/15;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 54/54;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- dominio varianti riga ordine piu' completo.

Prossimo step consigliato:

1. non estrarre helper varianti che dipendono da lookup/catalogo senza factory esplicita;
2. cercare un dominio alternativo con funzioni pure piccole, per esempio normalizzatori di stampa o stato tavoli;
3. mantenere gate continuity dopo ogni slice che tocca ordini, tavoli o stampa.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 4A dominio supplementi preconto

Obiettivo:

- cambiare area dopo il completamento dei micro-helper varianti puri;
- estrarre un blocco coeso e puro dalla generazione preconto;
- proteggere comportamento apericena/supplementi con test diretti;
- non toccare spool, routing stampanti, fiscalita' o pagamenti.

File modificati:

- `cassa-frontend/backend/printing/preconto-supplements.domain.js`;
- `cassa-frontend/backend/tests/preconto-supplements-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `normalizePrecontoInlineSupplementLabel`;
- `isPrecontoApericenaLabel`;
- `formatPrecontoApericenaLabel`;
- `parsePrecontoLooseMoneyValue`;
- `extractPrecontoSupplementUnitValue`;
- `extractPrecontoSupplementTargetUnitValue`;
- `stripPrecontoSupplementUnitSuffix`;
- `extractPrecontoEntryNameUnitHintValue`;
- `shouldKeepPrecontoSupplementLabel`;
- `splitPrecontoSupplementSegments`;
- `buildPrecontoSupplementEntry`;
- `resolvePrecontoApericenaSupplementUnitValue`;
- `extractPrecontoSupplementEntries`;
- `getPrecontoEntrySupplementEntries`.

Implementazione:

- creato `createPrecontoSupplementHelpers(options)`;
- la factory riceve:
  - `apericenaStandardTargetPrice`;
  - `roundMoney`;
- il server configura la factory con `APERICENA_STANDARD_TARGET_PRICE` e `roundMoney`, evitando costanti duplicate nel runtime.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/stampa runtime;
- nessun nuovo side effect;
- il comportamento di supplementi e apericena e' stato mantenuto e testato;
- il primo rilancio continuity ha segnalato helper non collegati, poi corretti e ritestati.

Metriche:

- `cassa-frontend/backend/server.js`: 28.176 -> 27.925 righe;
- riduzione netta fase: 251 righe;
- `cassa-frontend/backend/printing/preconto-supplements.domain.js`: 289 righe;
- `cassa-frontend/backend/tests/preconto-supplements-domain.test.mjs`: 97 righe.

Test eseguiti:

- `node --check backend/printing/preconto-supplements.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/preconto-supplements-domain.test.mjs`: OK, 6/6;
- `node --test backend/tests/preconto-supplements-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 27/27;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- riduzione sostanziale ma confinata a dominio puro.

Prossimo step consigliato:

1. valutare estrazione layout colonne preconto solo se si riesce a separare formattazione pura da preferenze/stato ordine;
2. non spostare ancora `buildIntegrationPrecontoPrintTextWithOptions` perche' combina modello, preferenze e output completo;
3. possibile alternativa piu' sicura: normalizzatori tavoli/lock con test dedicati.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 4B dominio etichette posizione stampa

Obiettivo:

- continuare nel perimetro stampa/preconto con una slice piu' piccola;
- estrarre solo normalizzatori puri di label posizione;
- mantenere nel monolite la composizione completa di preconto/comanda e i side effect di stampa.

File modificati:

- `cassa-frontend/backend/printing/print-location.domain.js`;
- `cassa-frontend/backend/tests/print-location-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `buildPrecontoReferenceLabel`;
- `buildPrecontoLocationLabel`;
- `resolvePrintRoomLabel`;
- `resolvePrintTableDisplayLabelFromOrder`;
- `buildPrintLocationLabel`;
- `buildIntegrationOrderLocationLabel`;
- `buildTableLocationLabel`.

Implementazione:

- creato `createPrintLocationHelpers(options)`;
- dipendenze iniettate:
  - `findPosRoomById`;
  - `formatIntegrationPrintDisplayName`;
  - `formatIntegrationPrintOrderId`;
  - `sanitizeIntegrationOrder`;
  - `sanitizeIntegrationTableLabel`;
  - `toPrintSafeUppercase`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessun nuovo side effect;
- label di spostamento tavoli, preconti, comande e modifiche restano coperte dalla continuity.

Metriche:

- `cassa-frontend/backend/server.js`: 27.925 -> 27.871 righe;
- riduzione netta fase: 54 righe;
- `cassa-frontend/backend/printing/print-location.domain.js`: 92 righe;
- `cassa-frontend/backend/tests/print-location-domain.test.mjs`: 67 righe.

Test eseguiti:

- `node --check backend/printing/print-location.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/print-location-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/print-location-domain.test.mjs backend/tests/preconto-supplements-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 32/32;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- dominio stampa piu' modulare senza spostare side effect.

Prossimo step consigliato:

1. prima di estrarre layout colonne preconto, valutare dipendenze da `collectPrecontoEntryLayoutUnitValues` e `resolvePrecontoEntryDisplayTotalValue`;
2. preferire una factory se servono formatter di denaro o funzioni supplementi;
3. evitare ancora handlers HTTP, spool e routing stampante.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 4C dominio layout preconto

Obiettivo:

- proseguire sul perimetro stampa/preconto con un blocco ancora puro;
- estrarre layout colonne e righe articolo senza spostare composizione documento completa;
- mantenere invariati preconti, modifiche ordine, spostamenti tavolo e listino congelato.

File modificati:

- `cassa-frontend/backend/printing/preconto-layout.domain.js`;
- `cassa-frontend/backend/tests/preconto-layout-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `buildIntegrationPrecontoColumnLayout`;
- `resolvePrecontoEntryDisplayTotalValue`;
- `resolvePrecontoEntryBaseUnitValue`;
- `collectPrecontoEntryLayoutUnitValues`;
- `buildIntegrationPrecontoItemLines`.

Implementazione:

- creato `createPrecontoLayoutHelpers(options)`;
- dipendenze iniettate:
  - `extractPrecontoEntryNameUnitHintValue`;
  - `formatPrintMoneyCompact`;
  - `getPrecontoEntrySupplementEntries`;
  - `isPrecontoApericenaLabel`;
  - `padPrintRight`;
  - `roundMoney`;
  - `wrapPrintText`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessun nuovo side effect;
- rendering preconto cash/non cash resta coperto da continuity e listino.

Metriche:

- `cassa-frontend/backend/server.js`: 27.871 -> 27.708 righe;
- riduzione netta fase: 163 righe;
- `cassa-frontend/backend/printing/preconto-layout.domain.js`: 201 righe;
- `cassa-frontend/backend/tests/preconto-layout-domain.test.mjs`: 127 righe.

Test eseguiti:

- `node --check backend/printing/preconto-layout.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/preconto-layout-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/preconto-layout-domain.test.mjs backend/tests/print-location-domain.test.mjs backend/tests/preconto-supplements-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 37/37;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio;
- server.js ora sotto 27.800 righe.

Prossimo step consigliato:

1. possibile micro-step: estrarre `buildIntegrationPrecontoBrandingHeader/Footer` in factory pura;
2. prima verificare dipendenze da `sanitizePosPrintPreferences` e `DEFAULT_POS_SETTINGS`;
3. mantenere continuity obbligatoria dopo qualsiasi altra modifica preconto.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 5A dominio prenotazioni multi-tavolo

Obiettivo:

- cambiare area rispetto al perimetro preconto/stampa;
- estrarre logica pura delle prenotazioni multi-tavolo;
- mantenere invariati stato prenotazioni, attivazione, lock, pagamento, stampa e DB.

File modificati:

- `cassa-frontend/backend/modules/reservations/reservations.domain.js`;
- `cassa-frontend/backend/modules/reservations/index.js`;
- `cassa-frontend/backend/tests/reservations-domain.test.mjs`;
- `cassa-frontend/backend/tests/reservations-multi-table-static.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `normalizePosReservationTableIds`;
- `posReservationAssignedTableIds`;
- `posReservationIncludesTable`.

Implementazione:

- creato modulo puro `reservations.domain.js`;
- mantenuto comportamento legacy:
  - trim ID tavolo;
  - limite 64 caratteri per ID;
  - deduplica case-insensitive durante normalizzazione;
  - fallback da `assignedTableId`;
  - cap a 24 tavoli assegnati;
  - match inclusione tavolo esatto dopo trim input;
- `server.js` importa gli helper dal dominio;
- `modules/reservations/index.js` riesporta gli helper per rendere il dominio discoverable.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio.

Metriche:

- `cassa-frontend/backend/server.js`: 27.684 -> 27.658 righe;
- riduzione netta fase: 26 righe;
- nuovo modulo `reservations.domain.js`: 30 righe;
- nuovo test `reservations-domain.test.mjs`: 43 righe.

Test eseguiti:

- `node --check backend/modules/reservations/reservations.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/reservations-domain.test.mjs backend/tests/reservations-multi-table-static.test.mjs`: OK, 8/8;
- `node --test backend/tests/reservations-status.e2e.test.mjs backend/tests/continuity.e2e.test.mjs`: OK, 71/71;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- dominio prenotazioni multi-tavolo isolato;
- continuity conferma prenotazioni create/delete/no-show/arrived, lock, pagamenti, movimenti tavolo e load balancing.

Prossimo step consigliato:

1. proseguire con un secondo blocco prenotazioni solo se resta puro, ad esempio classificazione distanza prenotazione e label disponibilita';
2. non spostare ancora `activateDuePosReservationsOnLayout` o handler HTTP perche' toccano DB/stati/layout;
3. mantenere test `reservations-status.e2e` e `continuity.e2e` obbligatori per ogni slice sulle prenotazioni.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 5B disponibilita prenotazioni

Obiettivo:

- continuare il dominio prenotazioni con un blocco puro;
- estrarre calcolo disponibilita, classificazione distanza e label operatore;
- mantenere invariati attivazione prenotazioni, stati tavolo, lock, DB, pagamenti e stampa.

File modificati:

- `cassa-frontend/backend/modules/reservations/reservations.domain.js`;
- `cassa-frontend/backend/modules/reservations/index.js`;
- `cassa-frontend/backend/tests/reservations-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `classifyPosReservationDistance`;
- `posClockFromTimestamp`;
- `findPosNearestReservation`;
- `buildPosAvailabilityLabel`.

Implementazione:

- aggiunta factory `createPosReservationAvailabilityHelpers(options)`;
- soglie iniettate dal server:
  - `POS_RESERVATION_MIN_TABLE_GAP_MINUTES`;
  - `POS_RESERVATION_DANGER_GAP_MINUTES`;
  - `POS_RESERVATION_WARNING_GAP_MINUTES`;
- preservate le label legacy:
  - `Disponibile`;
  - `Conflitto con ...`;
  - `Rischio alto (...)`;
  - `Attenzione (...)`;
  - `Sequenziale (...)`;
- mantenuto match esatto su tavolo usando `posReservationIncludesTable`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio.

Metriche:

- `cassa-frontend/backend/server.js`: 27.658 -> 27.626 righe;
- riduzione netta fase: 32 righe;
- `reservations.domain.js`: 30 -> 94 righe;
- `reservations-domain.test.mjs`: 43 -> 100 righe.

Test eseguiti:

- `node --check backend/modules/reservations/reservations.domain.js && node --check backend/modules/reservations/index.js && node --check backend/server.js`: OK;
- `node --test backend/tests/reservations-domain.test.mjs backend/tests/reservations-multi-table-static.test.mjs`: OK, 12/12;
- `node --test backend/tests/reservations-status.e2e.test.mjs backend/tests/continuity.e2e.test.mjs`: OK, 71/71;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- dominio disponibilita prenotazioni isolato;
- test e2e confermano disponibilita, conflitti, no-show, arrived, lock e cleanup.

Prossimo step consigliato:

1. fermarsi prima di `normalizePosReservationSaveInput` perche' usa `HttpError` e validazioni HTTP;
2. candidato sicuro successivo: helper puri di stato prenotazione (`shouldActivatePosReservation`, `isPosReservationReleased`) con factory su finestre temporali;
3. non estrarre ancora `activateDuePosReservationsOnLayout` o `releaseActivatedPosReservationTableGroup` finche' non sono state protette da test state-machine dedicati.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 4D dominio branding preconto

Obiettivo:

- chiudere un altro micro-step puro nel perimetro preconto;
- estrarre solo header/footer branding;
- non spostare composizione preconto completa, profilo cash, riepilogo pagamento o routing stampa.

File modificati:

- `cassa-frontend/backend/printing/preconto-branding.domain.js`;
- `cassa-frontend/backend/tests/preconto-branding-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `buildIntegrationPrecontoBrandingHeader`;
- `buildIntegrationPrecontoBrandingFooter`.

Implementazione:

- creato `createPrecontoBrandingHelpers(options)`;
- dipendenze iniettate:
  - `centerPrintText`;
  - `defaultPrintPreferences`;
  - `sanitizePosPrintPreferences`;
  - `toPrintSafeUppercase`;
  - `wrapPrintText`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessun nuovo side effect;
- header/footer restano coperti da test diretto e continuity.

Metriche:

- `cassa-frontend/backend/server.js`: 27.708 -> 27.684 righe;
- riduzione netta fase: 24 righe;
- `cassa-frontend/backend/printing/preconto-branding.domain.js`: 49 righe;
- `cassa-frontend/backend/tests/preconto-branding-domain.test.mjs`: 119 righe.

Test eseguiti:

- `node --check backend/printing/preconto-branding.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/preconto-branding-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/preconto-branding-domain.test.mjs backend/tests/preconto-layout-domain.test.mjs backend/tests/print-location-domain.test.mjs backend/tests/preconto-supplements-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 42/42;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- nessuna modifica alla V2/current;
- nessun riavvio.

Prossimo step consigliato:

1. cambiare area rispetto al preconto per evitare eccessivo churn nello stesso dominio;
2. candidato: normalizzatori tavolo/lock o reservation/table-room helpers puri;
3. mantenere test e2e continuity se il prossimo step tocca tavoli o lock.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 5C stato prenotazioni

Obiettivo:

- completare il mini-perimetro puro sulle prenotazioni;
- estrarre attivazione temporale e riconoscimento rilascio/terminalita';
- non toccare attivazione layout, rilascio gruppi tavolo, handler, DB o route.

Check di allineamento:

- working directory confermata: `/srv/applicazione/v3`;
- V2/current non modificata;
- nessun riavvio;
- memoria V3 coerente con ultimo step Fase 5B;
- monolite iniziale ciclo: 27.626 righe.

File modificati:

- `cassa-frontend/backend/modules/reservations/reservations.domain.js`;
- `cassa-frontend/backend/modules/reservations/index.js`;
- `cassa-frontend/backend/tests/reservations-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `shouldActivatePosReservation`;
- `isPosReservationReleased`.

Implementazione:

- aggiunta factory `createPosReservationStateHelpers(options)`;
- finestre temporali iniettate dal server:
  - `POS_RESERVATION_BLOCK_WINDOW_MS`;
  - `POS_RESERVATION_LATE_GRACE_MS`;
- mantenuti gli stati terminali legacy:
  - `arrived`;
  - `no_show`;
  - `cancelled`;
  - `released`;
- mantenuto fallback `releasedAt > 0`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio.

Metriche:

- `cassa-frontend/backend/server.js`: 27.626 -> 27.617 righe;
- riduzione netta fase: 9 righe;
- `reservations.domain.js`: 94 -> 125 righe;
- `reservations-domain.test.mjs`: 100 -> 127 righe.

Test eseguiti:

- `node --check backend/modules/reservations/reservations.domain.js && node --check backend/modules/reservations/index.js && node --check backend/server.js`: OK;
- `node --test backend/tests/reservations-domain.test.mjs backend/tests/reservations-multi-table-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/reservations-status.e2e.test.mjs backend/tests/continuity.e2e.test.mjs`: OK, 71/71;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- dominio stato prenotazioni isolato;
- test e2e confermano no-show, arrived, lock, cleanup, pagamento, spostamenti e load balancing.

Prossimo step consigliato:

1. non estrarre ancora `activateDuePosReservationsOnLayout` o `releaseActivatedPosReservationTableGroup`;
2. se si continua sulle prenotazioni, prima aggiungere test state-machine dedicati su attivazione/rilascio gruppi tavolo;
3. alternativa piu' sicura: cambiare area verso helper puri di lock tavolo o table-room move.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 6A dominio lock tavolo

Obiettivo:

- cambiare area dopo le prenotazioni;
- estrarre il dominio lock tavolo senza spostare handler, audit o mutazioni DB;
- preservare blocchi concorrenti su tavolo e payment lock.

File modificati:

- `cassa-frontend/backend/modules/tables/table-work-lock.domain.js`;
- `cassa-frontend/backend/modules/tables/index.js`;
- `cassa-frontend/backend/tests/table-work-lock-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `sanitizeTableWorkLock`;
- `isTableWorkLockExpired`;
- `isSameTableLockOwner`;
- `canOverrideTableWorkLock`;
- `buildTableWorkLock`;
- `shouldReuseRecentTableWorkLock`.

Implementazione:

- aggiunta factory `createTableWorkLockHelpers(options)`;
- dipendenze iniettate:
  - `hasPermission`;
  - `isAdminUser`;
  - `nowIso`;
  - `nowMs`;
  - `tableLockTtlMs`;
  - `heartbeatWriteMinIntervalMs`;
- default runtime conservativi se la factory viene usata senza opzioni;
- test domain diretto per sanitize, expiry, owner matching, override, build e heartbeat reuse.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio.

Metriche:

- `cassa-frontend/backend/server.js`: 27.617 -> 27.558 righe;
- riduzione netta fase: 59 righe;
- `table-work-lock.domain.js`: 96 righe;
- `table-work-lock-domain.test.mjs`: 111 righe.

Test eseguiti:

- `node --check backend/modules/tables/table-work-lock.domain.js && node --check backend/modules/tables/index.js && node --check backend/server.js`: OK;
- `node --test backend/tests/table-work-lock-domain.test.mjs backend/tests/tables-locks.e2e.test.mjs`: OK, 10/10;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- dominio lock tavolo isolato;
- test P0/e2e confermano concorrenza tavolo, heartbeat, release, force release e blocco mutazioni altrui.

Prossimo step consigliato:

1. non spostare ancora `acquireOrRefreshTableWorkLock`, `assertActiveTableWorkLock` o `releaseTableWorkLock` senza service/repository test;
2. candidato successivo: table-room move, ma prima documentare/testare la policy timeout_approved;
3. mantenere security e continuity obbligatori se si toccano lock, tavoli o pagamenti.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 6B dominio cambio sala tavolo

Obiettivo:

- proteggere e rendere esplicita la policy `timeout_approved`;
- estrarre normalizzazione richiesta, risposta API e risoluzione pending;
- non cambiare il comportamento business del cambio sala tavolo.

File modificati:

- `cassa-frontend/backend/modules/table-room-move/table-room-move.domain.js`;
- `cassa-frontend/backend/modules/table-room-move/index.js`;
- `cassa-frontend/backend/tests/table-room-move-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `sanitizePosTableRoomMoveRequestRecord`;
- `buildPosTableRoomMoveResponse`;
- `resolvePendingPosTableRoomMoveRequest`.

Implementazione:

- aggiunta factory `createTableRoomMoveHelpers(options)`;
- dipendenze iniettate:
  - `approvalTimeoutMs`;
  - `nowMs`;
- aggiunta costante `AUTO_APPROVE_TABLE_ROOM_MOVE_ON_TIMEOUT = true`;
- normalizzazione liste e clamp valori locali al modulo per evitare accoppiamento al monolite;
- test diretti su:
  - record valido/invalido;
  - shape risposta;
  - `pending -> timeout_approved`;
  - `pending -> approved`;
  - `pending -> rejected`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio.

Metriche:

- `cassa-frontend/backend/server.js`: 27.558 -> 27.467 righe;
- riduzione netta fase: 91 righe;
- `table-room-move.domain.js`: 138 righe;
- `table-room-move-domain.test.mjs`: 120 righe.

Test eseguiti:

- `node --check backend/modules/table-room-move/table-room-move.domain.js && node --check backend/modules/table-room-move/index.js && node --check backend/server.js`: OK;
- `node --test backend/tests/table-room-move-domain.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 12/12;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- table-room move domain isolato;
- policy timeout auto-approve esplicita e testata;
- handler HTTP e notifiche restano nel monolite.

Prossimo step consigliato:

1. non spostare ancora gli handler table-room move;
2. se si continua su questa area, isolare prima eventuali builder di notifiche con test dedicati;
3. alternativa: tornare a una state-machine pura ordini/pagamenti se si vuole maggiore riduzione con rischio controllato.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 6C notifiche cambio sala tavolo

Obiettivo:

- completare il perimetro puro del table-room move estraendo i payload notifica;
- lasciare nel monolite solo il wrapper di enqueue, per evitare side effect nel modulo domain;
- preservare routing notifiche request/timeout/resolved.

File modificati:

- `cassa-frontend/backend/modules/table-room-move/table-room-move.domain.js`;
- `cassa-frontend/backend/tests/table-room-move-domain.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- costruzione payload notifica cambio sala tavolo:
  - richiesta;
  - timeout auto-approvato;
  - risolta approvata/rifiutata.

Implementazione:

- aggiunta `buildPosTableRoomMoveNotificationPayload(request, kind)`;
- `queuePosTableRoomMoveNotification(db, request, kind)` ora:
  - costruisce payload tramite domain;
  - chiama `queueIntegrationNotification` solo se payload valido;
- nessuna modifica a `queueIntegrationNotification` o stream refresh.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio.

Metriche:

- `cassa-frontend/backend/server.js`: 27.467 -> 27.415 righe;
- riduzione netta fase: 52 righe;
- `table-room-move.domain.js`: 138 -> 197 righe;
- `table-room-move-domain.test.mjs`: 120 -> 171 righe.

Test eseguiti:

- `node --check backend/modules/table-room-move/table-room-move.domain.js && node --check backend/server.js`: OK;
- `node --test backend/tests/table-room-move-domain.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 15/15;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- table-room move domain ora copre sanitize/response/resolve/notification payload;
- side effect enqueue e handler HTTP restano nel monolite.

Prossimo step consigliato:

1. non spostare ancora handler table-room move;
2. cambiare area verso helper puri ordini/notifiche generiche o aggiungere prima test service;
3. mantenere continuity e security obbligatorie per ogni slice su tavoli, notifiche o pagamenti.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 7A state machine workflow ordini base

Obiettivo:

- iniziare l'estrazione della state machine ordini senza toccare handler o mutazioni DB;
- preservare gli errori HTTP runtime tramite injection;
- proteggere regressioni workflow e transizioni vietate.

File modificati:

- `cassa-frontend/backend/modules/orders/order-state-machine.js`;
- `cassa-frontend/backend/tests/order-state-machine.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `assertIntegrationWorkflowTransitionAllowed`;
- `resolveIntegrationWorkflowRank`;
- `isIntegrationWorkflowRegression`.

Implementazione:

- aggiunta costante `INTEGRATION_WORKFLOW_RANK`;
- aggiunta costante `INVALID_ORDER_STATUS_TRANSITION_CODE`;
- aggiunto helper `getIntegrationWorkflowTransitionViolation`;
- aggiunta factory `createIntegrationWorkflowStateMachine(options)`;
- il server usa `createTransitionError` per continuare a lanciare `HttpError(409, ...)`.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio.

Metriche:

- `cassa-frontend/backend/server.js`: 27.415 -> 27.384 righe;
- riduzione netta fase: 31 righe;
- `order-state-machine.js`: 74 righe;
- `order-state-machine.test.mjs`: 78 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-state-machine.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 26/26;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- state machine workflow ordini base isolata;
- regressioni e transizioni vietate coperte da test domain + e2e/invariants.

Prossimo step consigliato:

1. non estrarre ancora `normalizeIntegrationWorkflowStatus` senza test dedicati;
2. possibile micro-step: helper puri timestamp/progresso route workflow;
3. se si lavora su workflow, eseguire sempre orders-flow, orders-payments-invariants, security e continuity.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 7B route progress workflow ordini

Obiettivo:

- proseguire la riduzione prudente della state machine ordini;
- spostare solo helper puri senza side effect;
- lasciare invariata la semantica di inferenza stato ordine;
- mantenere V2/current intatta e senza riavvii.

File modificati:

- `cassa-frontend/backend/modules/orders/order-state-machine.js`;
- `cassa-frontend/backend/tests/order-state-machine.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `hasIntegrationRouteTimestamp`;
- `hasIntegrationRouteReadyProgress`.

Implementazione:

- gli helper route progress sono esportati dal modulo `orders/order-state-machine.js`;
- `createIntegrationWorkflowStateMachine()` espone anche gli helper per eventuale uso domain futuro;
- il server continua a usarli nello stesso punto del flusso;
- i test verificano timestamp non vuoti e distinzione tra `receivedAt` e progresso ready.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio.

Metriche:

- `cassa-frontend/backend/server.js`: 27.384 -> 27.371 righe;
- riduzione netta fase: 13 righe;
- `order-state-machine.js`: 74 -> 93 righe;
- `order-state-machine.test.mjs`: 78 -> 95 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-state-machine.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 28/28;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- modulo ordini ora contiene rank, regressione, transizioni vietate e helper puri route progress;
- il monolite conserva ancora normalizzazione completa e mutazioni workflow.

Prossimo step consigliato:

1. scrivere test specifici per `normalizeIntegrationWorkflowStatus` prima di estrarla;
2. mantenere invariants ordine/pagamento obbligatori per ogni modifica workflow;
3. non spostare handler o side effect finche' non esiste un domain/service ordini piu' completo.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 7C normalizzazione workflow ordini

Obiettivo:

- chiudere il micro-step raccomandato nella fase precedente;
- portare fuori dal monolite la normalizzazione workflow ordini;
- proteggere alias e inferenze da item/route progress con test dedicati;
- non modificare semantica di stato.

File modificati:

- `cassa-frontend/backend/modules/orders/order-state-machine.js`;
- `cassa-frontend/backend/tests/order-state-machine.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `isCancelledIntegrationWorkflowStatus`;
- `normalizeIntegrationWorkflowStatus`.

Implementazione:

- `order-state-machine.js` contiene ora:
  - rank workflow;
  - regressione workflow;
  - transizione workflow;
  - helper route progress;
  - normalizzazione workflow;
  - alias cancellazione;
- `server.js` importa la normalizzazione e mantiene inalterati i punti di chiamata;
- `createIntegrationWorkflowStateMachine()` espone anche normalizzazione e cancelled helper.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio;
- comportamento `completedAtMs !== null -> delivered` preservato volutamente.

Metriche:

- `cassa-frontend/backend/server.js`: 27.371 -> 27.321 righe;
- riduzione netta fase: 50 righe;
- `order-state-machine.js`: 93 -> 148 righe;
- `order-state-machine.test.mjs`: 95 -> 160 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-state-machine.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 33/33;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- state machine workflow ordini sensibilmente piu' autonoma;
- monolite ridotto senza cambiare flussi runtime.

Prossimo step consigliato:

1. non estrarre ancora `sanitizeIntegrationOrder` in blocco: e' troppo grande e mischia prezzo, righe, workflow, pagamenti e route;
2. possibile prossimo micro-step: testare ed estrarre helper puro di timestamp ordine/ready/completed;
3. valutare con attenzione l'invariante `completedAtMs !== null`, perche' una correzione semantica potrebbe incidere su storico ordini e pagamenti.

## Aggiornamento ciclo 2026-06-07 - riduzione monolite Fase 7D timestamp ordini

Obiettivo:

- proseguire con un micro-step puro e reversibile;
- non modificare `sanitizeIntegrationOrder` in blocco;
- iniziare a separare il dominio timestamp ordini dalla state machine e dal monolite;
- preservare compatibilita' legacy sui valori gia' salvati.

File modificati:

- `cassa-frontend/backend/modules/orders/order-timestamps.js`;
- `cassa-frontend/backend/tests/order-timestamps.test.mjs`;
- `cassa-frontend/backend/server.js`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`.

Logica rimossa dal monolite:

- `normalizeIntegrationOrderTimestamp`.

Implementazione:

- creato modulo dedicato `orders/order-timestamps.js`;
- `server.js` importa l'helper senza cambiare i punti di chiamata;
- aggiunti test su:
  - stringhe data parsabili;
  - stringhe manuali non parsabili;
  - numeri epoch millisecondi;
  - stringhe numeriche legacy;
  - valori vuoti/non validi.

Garanzie mantenute:

- nessuna modifica contratti API;
- nessuna modifica DB;
- nessuna modifica a pagamenti/fiscalita'/spool/stampanti runtime;
- nessuna modifica a V2/current;
- nessun riavvio;
- le stringhe numeriche restano stringhe, come nel comportamento storico.

Metriche:

- `cassa-frontend/backend/server.js`: 27.321 -> 27.310 righe;
- riduzione netta fase: 11 righe;
- `order-timestamps.js`: 11 righe;
- `order-timestamps.test.mjs`: 33 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-timestamps.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 38/38;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- dominio timestamp ordini avviato;
- monolite ridotto senza cambio semantico.

Prossimo step consigliato:

1. non estrarre ancora `resolveIntegrationReadyAtMs` senza clock controllato, perche' usa `Date.now()`;
2. possibile prossimo micro-step: helper puro `buildIntegrationOrderLineSignature` oppure line-id deterministico;
3. mantenere continuity/security obbligatorie per ogni modifica sotto `sanitizeIntegrationOrder`.
