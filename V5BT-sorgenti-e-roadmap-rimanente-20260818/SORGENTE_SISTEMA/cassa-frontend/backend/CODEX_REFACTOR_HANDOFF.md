# Codex backend refactor handoff

Data ultimo aggiornamento: 2026-05-07.

## Obiettivo generale

Ridurre progressivamente `backend/server.js` estraendo domini backend in moduli piccoli, reversibili e testabili, senza cambiare comportamento degli endpoint e senza toccare frontend, dist, database, `node_modules`, file runtime o `package-lock` salvo necessita reale.

## Stato attuale

- Route registry completa: 95 route.
- Nessun fallback legacy operativo: fallback solo 404.
- Routing, policy e dispatch sono centralizzati in:
  - `backend/core/router.js`
  - `backend/core/route-policy.js`
  - `backend/routes/index.js`
- `backend/modules/README.md` documenta il pattern modulare.
- `backend/server.js` e ancora grande, circa 18850 righe dopo step 13.
- Shim temporanei ancora presenti per app-state:
  - `backend/app-state/app-state.handlers.js`
  - `backend/app-state/initial-state.js`

## Moduli estratti

### `backend/modules/status/`

Responsabilita:
- Health e stato workflow ordine.

Route:
- `GET /api/health -> health`
- `GET /api/settings/order-workflow -> settings.orderWorkflow`

### `backend/modules/settings/`

Responsabilita:
- Sottoinsieme impostazioni POS non legato a tavoli/conti/ordini.

Route:
- `POST /api/settings/pos -> settings.pos`
- `POST /api/settings/pos/areas -> settings.posAreas`
- `POST /api/settings/pos/areas/save -> settings.savePosAreas`
- `POST /api/settings/pos/print-preferences/save -> settings.savePrintPreferences`
- `POST /api/settings/pos/general/save -> settings.saveGeneral`
- `POST /api/settings/pos/payment-methods -> settings.savePaymentMethods`

### `backend/modules/menu/`

Responsabilita:
- Catalogo menu runtime e gestione menu settings.

Route:
- `POST /api/menu/catalog -> menu.catalog`
- `POST /api/settings/menu -> settings.menu`

### `backend/modules/reports/`

Responsabilita:
- Audit list/delete e report vendite.

Route:
- `POST /api/audit/events -> audit.events`
- `POST /api/audit/events/delete -> audit.eventDelete`
- `POST /api/reports/sales -> reports.sales`

Nota: il modulo contiene sia letture sia una mutazione audit leggera. Ogni route dichiara `mutation` e permission esplicite.

### `backend/modules/app-state/`

Responsabilita:
- Handler app-state, route app-state e initial state condiviso.

Route:
- `GET /api/app-state -> appState.get`
- `POST /api/app-state/sync -> appState.sync`
- `POST /api/maintenance/app-state/reset -> appState.reset`
- `POST /api/app-state/reset -> appState.reset` legacy
- `GET /api/mock-db -> appState.get` legacy
- `POST /api/mock-db/reset -> appState.reset` legacy

Shim:
- `backend/app-state/*` re-esporta dal modulo nuovo per compatibilita temporanea.

### `backend/modules/sales-sessions/`

Responsabilita:
- Sales sessions status/open/close e helper puri/domain condivisibili.

Route:
- `POST /api/sales/sessions/status -> sales.sessionStatus`
- `POST /api/sales/sessions/open -> sales.sessionOpen`
- `POST /api/sales/sessions/close -> sales.sessionClose`

Nota: questo endpoint non e read-only puro. Mantiene il side effect esistente di `runAutomaticSaleLifecycle(db)` e possibile `writeDb(db)` se il lifecycle cambia. La route era gia `mutation: true` in registry.

File domain/utils:
- `backend/modules/sales-sessions/sales-sessions.domain.js`

Helper puri spostati:
- `localDateKeyFromDate`
- `timeToMinutes`
- `isOvernightWindow`
- `isNowInsideWindow`
- `sessionIntersectsLocalDay`
- `collectSessionSolarDayKeys`
- `computeBusinessDateForStart`
- `sanitizeSaleSessionTemplate`
- `sanitizeSaleSession`
- `sanitizeSolarClosure`
- `findActiveSaleSession`
- `suggestSaleSessionTemplate`
- `buildDaySummary`
- `createSaleSessionStatusBuilder`

Nota: `POST /api/sales/sessions/open` e `POST /api/sales/sessions/close` sono stati estratti nello stesso modulo preservando ordine logico, audit `shift.opened`/`shift.closed`, `runAutomaticSaleLifecycle(db)`, `writeDb(db)`, status code e response shape. Restano nel monolite `runAutomaticSaleLifecycle`, `closeExpiredSaleSessions`, `processAutomaticSolarClosures` e `createSolarClosureRecord` perche hanno side effect o dipendono da clock/write/audit orchestration; vengono passati via context dove serve.

Dipendenze passate a `createSalesSessionsHandlers(context)`:
- `HttpError`
- `SALE_SESSION_MAX_MS`
- `appendAuditEvent`
- `buildAuditActor`
- `hasPermission`
- `nowIso`
- `randomUUID`
- `readDb`
- `readJsonBody`
- `runAutomaticSaleLifecycle`
- `sendJson`
- `validateSessionContext`
- `writeDb`

### `backend/modules/pos-rooms/`

Responsabilita:
- Lettura/status leggero stanze POS per mobile room selection.

Route:
- `POST /api/pos/rooms -> pos.rooms`

Nota: endpoint storico `POST` ma read/status senza `writeDb`; la route mantiene `mutation: false`. Gli helper condivisi per layout/stanze e initial room restano nel monolite e sono passati via context.

### `backend/modules/reservations/`

Responsabilita:
- Sottoinsieme coerente POS reservations: lista, availability, create/update/delete e lock reservation-specific.

Route:
- `POST /api/pos/reservations/list -> pos.reservationsList`
- `POST /api/pos/reservations/create -> pos.reservationsCreate`
- `POST /api/pos/reservations/lock/acquire -> pos.reservationsLockAcquire`
- `POST /api/pos/reservations/lock/release -> pos.reservationsLockRelease`
- `POST /api/pos/reservations/update -> pos.reservationsUpdate`
- `POST /api/pos/reservations/delete -> pos.reservationsDelete`
- `POST /api/pos/reservations/availability -> pos.reservationsAvailability`
- `POST /api/pos/reservations/lock/state -> pos.reservationsLockState`

Nota: tutte le route mantengono `mutation: true`, inclusi list/availability/lock-state, per preservare side effect storici di prune lock, creazione stato e `writeDb` quando presenti. Il lock estratto e solo reservation-specific (`db.posReservationLocks`), non table workLock.

## Domini ancora nel monolite

Lasciati volutamente in `backend/server.js`:

- `POST /api/settings/pos/assign-bill -> settings.assignBill`
- `POST /api/pos/room-change/request -> pos.roomChangeRequest`
- `POST /api/pos/room-change/approve -> pos.roomChangeApprove`
- `POST /api/pos/room-change/cancel -> pos.roomChangeCancel`
- pagamenti reali
- fiscalita
- stampa operativa
- ordini/comande e integrazione ordini complessa
- smart card
- auth/sessioni
- lock tavoli
- reservation/table mutation complesse

Motivo: hanno side effect operativi, audit, pagamenti/fiscalita, lock tavoli, tavoli o ordini intrecciati. Le route reservations sono state estratte solo preservando i side effect esistenti e lasciando nel monolite gli helper condivisi/rischiosi.

## Pattern tecnico

Ogni modulo dovrebbe avere:

- `backend/modules/<domain>/index.js`
- `backend/modules/<domain>/<domain>.handlers.js`
- `backend/modules/<domain>/<domain>.routes.js`

Il file routes esporta `build<Domain>Routes()` con metadata completi:

- `method`
- `path`
- `handlerKey`
- `mutation`
- `authRequired`
- `permission`, `admin`, `debug`, `service`, `legacy`, `note` quando servono

Il file handlers esporta `create<Domain>Handlers(context)` e restituisce:

```js
{
  "domain.handlerKey": handlerFunction,
}
```

I moduli non devono importare `server.js`. Le dipendenze ancora nel monolite vanno passate via factory/context.

## Vincoli invarianti

Non modificare intenzionalmente:

- path
- method
- handlerKey
- auth policy
- permission
- mutation flag
- status code
- response shape
- side effect
- audit/writeDb esistenti
- schema dati

Non modificare:

- frontend
- dist
- database runtime
- `node_modules`
- file runtime
- `package-lock`

Non introdurre nuove dipendenze o framework.

## Comandi di verifica obbligatori

Da `cassa-frontend/`:

```bash
npm run check:backend
npm run test:backend
```

Per ogni file JS nuovo o modificato:

```bash
node --check <file>
```

## Ultimi risultati noti

Eseguiti dopo step 13:

- `node --check backend/server.js`: OK
- `node --check backend/routes/index.js`: OK
- `node --check backend/modules/sales-sessions/index.js`: OK
- `node --check backend/modules/sales-sessions/sales-sessions.domain.js`: OK
- `node --check backend/modules/sales-sessions/sales-sessions.handlers.js`: OK
- `node --check backend/modules/sales-sessions/sales-sessions.routes.js`: OK
- `npm run check:backend`: OK
- `npm run test:backend`: OK, 21/21

## Prossimo dominio consigliato

Prossimo passo consigliato:

1. Valutare se estrarre un servizio lifecycle sales-sessions (`runAutomaticSaleLifecycle`, solar closures) solo con piano mirato su app-state reset/status e `writeDb`.
2. In alternativa, valutare estrazione dei helper puri reservation-specific in una libreria condivisa, solo se non rompe reset/normalizzazione app-state.

Evitare per ora:

- estrazione pagamenti
- estrazione fiscalita
- estrazione stampa operativa
- estrazione ordini/comande
- estrazione lock tavoli
- estrazione `assign-bill`

## Rischi principali

- Spostare handler mutativi senza preservare `writeDb`, audit e response shape.
- Perdere policy route (`permission`, `admin`, `debug`, `service`, `mutation`).
- Creare import circolari importando `server.js` da un modulo.
- Toccare file runtime o package lock.
- Cambiare payload frontend/backend accidentalmente.
