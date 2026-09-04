# 01 — Audit sorgente attuale (REV2)

> Aggiornato il 2026-08-31 con verifica diretta sul sorgente. I conteggi della
> REV1 sono confermati; sono aggiunti i rilievi su `server.js`, sulla topologia di
> processo e sull'hardware. Vedi `00_REVISIONE_20260831.md`.

## Persistenza oggi

La V6 contiene contemporaneamente:

1. MariaDB/MySQL per l'app-state e split/domain persistence;
2. SQLite `backend-relational.sqlite` per il percorso relazionale;
3. SQLite `app-state-split.sqlite` per split state;
4. stato Node in memoria;
5. Redis volatile già predisposto ma disabilitato nel profilo standard;
6. outbox/idempotenza/relational feature flags già presenti ma non completamente primary nel runtime standard.

`start-v5bt.sh` imposta ancora `BACKEND_RELATIONAL_ENABLED=0`, `EVENT_OUTBOX_ENABLED=0`, `IDEMPOTENCY_STORE_ENABLED=0`, `REDIS_ENABLED=0` salvo override e mantiene MariaDB + due file SQLite.

## Gate relazionale attuale

`backend/db/persistence-mode.js` dichiara i domini relazionali:

`auditEvents, users, sessions, saleSessions, payments, menuSettings, orders, tablesBills, reservations`.

Il read-primary generico è ammesso solamente per:

`users, sessions, menuSettings, saleSessions`.

`isDomainWritePrimary()` ritorna sempre `false`; esistono comunque numerosi feature flag/write-primary puntuali nei workflow più recenti. Questo conferma che il sistema è in una fase di transizione, non in un cutover relazionale completo.

## App-state da eliminare

Top-level rilevati in `backend/modules/app-state/initial-state.js`:

users, userGroups, sessions, saleSessionTemplates, menuItems, posSettings, payments, paymentContainers, paymentParts, paymentTransactions, paymentProviderTransactions, cashTxDenoms, handheldCashSessions, commercialBenefitCampaigns, commercialBenefitCoupons, commercialBenefitApplications, commercialBenefitRedemptions, fiscalReceipts, fiscalEvents, printSpoolJobs, smartNonFiscal, auditEvents, smartCustomers, integration, posRoomChangeRequests, posTableRoomMoveRequests, posReservationStates, posReservationLocks, saleSessions, solarClosures, meta.

Sotto `integration`:

orders, barChargeReplacements, orderComps, orderCorrections, orderCorrectionRequests, orderFulfillmentHistory, fulfillmentAnomalyStats, notifications, waiterPauses, waiterDeferredCalls, noActiveStationsAlert, recentBellClaims, itemAvailability, tableGroups, stationStates, sequence, lastWriteAt.

Top-level `posSettings` rilevati:

beachEntryItemId, pointsPerEuro, demoMode, sideBars, locale, locales, activities, activityRoomBindings, paymentMethods, paymentTerminals, smartCash, tables, menus, areaMenus, priceLists, priceListSchedules, menuSchedules, printers, fiscalDevices, mobileDevices, radioChannels, radioPreferences, workstations, areas, orderWorkflow, printPreferences.

## Accessi legacy

- `readDb(`: **228** occorrenze runtime/non-test in **35** file.
- `writeDb(`: **91** occorrenze runtime/non-test in **20** file.

Le liste complete con file/riga sono in `reports/readDb_locations.csv` e `reports/writeDb_locations.csv`.

Distribuzione verificata dei primi chiamanti:

| File | `readDb(` | `writeDb(` |
|---|---:|---:|
| `backend/server.js` | 86 | 26 |
| `modules/automatic-cash/automatic-cash.handlers.js` | 32 | 0 |
| `modules/reservations/reservations.handlers.js` | 12 | 13 |
| `modules/settings/settings.handlers.js` | 11 | 7 |
| `modules/commercial-benefits/commercial-benefits.handlers.js` | 8 | 6 |
| `auth/auth.handlers.js` | 5 | 10 |

Questo è il backlog reale da azzerare.

## `server.js`: il vincolo che la REV1 non registrava

`backend/server.js` è **38.799 righe, 1,4 MB**, e concentra da solo il **38% dei
`readDb`** e il **29% dei `writeDb`** del progetto.

Più importante della dimensione è la semantica. `readDb()` non è un accessor di
entità: chiama `appStateRepository.readDb()` e poi applica in sequenza
`refreshExternalizedSessionsForRead`, `refreshExternalizedIntegrationOrderTarget`,
`refreshExternalizedTableLocksForRead`,
`refreshExternalizedIntegrationStationStatesForRead` e
`refreshExternalizedIntegrationSequenceForRead`, restituendo **l'intero grafo di
stato**. Gli handler lo mutano in memoria e lo riscrivono con `writeDb()`, che
applica dirty tracking sui domini split.

Conseguenza: **non esiste oggi un layer di accesso dati sostituibile**, e i
bounded context non hanno confini fisici. Da qui nasce la fase P2b, descritta in
`14_SERVER_DECOMPOSITION.md`, prerequisito di ogni migrazione di dominio.

## Topologia di processo attuale

`start-v5bt.sh` imposta `BACKEND_API_WORKER_ENABLED=0` e
`BACKEND_REALTIME_GATEWAY_ENABLED=0`: il profilo standard è **monoprocesso**.
È il motivo per cui Redis esce dal perimetro della migrazione
(`ANNEX_A_FUORI_PERIMETRO.md` A.3): non esiste oggi un problema di cache o di
fanout fra processi da risolvere.

## Hardware di produzione

Server Raspberry ARM64, MariaDB con schema di produzione a 480 tabelle InnoDB
(~121k righe), più due file SQLite. Durante la transizione i motori di persistenza
coesistenti diventano tre. Vincoli e gate in `13_HARDWARE_CAPACITY.md`.

## Relational SQLite già disponibile

Sono state trovate **57** tabelle già definite nelle migration `001..028`, fra cui utenti/sessioni, ordini/righe/eventi, tavoli/conti/lock, pagamenti, fiscale, prenotazioni, idempotenza, outbox, command inbox, print spool e Commercial Configuration V2.

Non va buttato questo lavoro: i repository e i test esistenti sono una specifica comportamentale utile. Il target però deve essere PostgreSQL, non un terzo persistence layer aggiunto sopra SQLite.

## Menu, ingredienti e ricette

`menu.domain.js` gestisce, tra gli altri:

- `ingredients`/`ingredienti` come array/stringhe;
- allergeni HACCP;
- varianti e delta prezzo;
- IVA/tax code;
- prezzi per listino;
- routing workstation/station;
- menu/category ids;
- tags, SKU, barcode, unità, reparto;
- schedule di prezzo.

La ricerca su tutto `SORGENTE_SISTEMA`, esclusi asset/dependency generati, non mostra un modello persistente di ricette/BOM con componenti, quantità, unità, resa o versioni. Questo è un **gap da modellare**, non un dato da dedurre.

## Commerciale già presente

Commercial Configuration V2 supporta:

- products;
- catalogs/categories/groups/entries;
- price lists con inheritance;
- offers con `fixed` o `sum_components`;
- included items;
- choice groups/options e supplementi;
- assignment per `global/channel/activity/room/workstation/role/user_group/user`;
- finestre temporali e giorni della settimana;
- draft/publish/archive e audit config.

Commercial Benefits è un sottodominio distinto con:

- fixed discount;
- value voucher;
- percentage discount;
- residual policies;
- acquisizione via code/QR/NFC;
- applications/redemptions e usage limits.

La roadmap mantiene questi concetti separati da un eventuale **motore promozioni automatiche** generico.
