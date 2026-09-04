# Phase 0 Baseline v4.1.0

Generated at: 2026-06-29T21:53:12.328Z

## Scope

- Source root: `/home/sentrapa/Desktop/sistemacassav4/estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source`
- Cassa root: `/home/sentrapa/Desktop/sistemacassav4/estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source/cassa-frontend`
- Git status: not available (git command not found)
- Historical device snapshot: cassa-frontend/backend/app-state.before-sync-possettings-20260628234340.json
- Snapshot note: Snapshot storico, non prova di stato live corrente.

## Metrics

- Source files without runtime/dist/log snapshots: 827
- Backend server lines: 38359
- Backend named function declarations: 708
- Backend arrow function declarations approx: 39
- Backend test files: 100
- Backend modules: 27
- Route registry entries: 173
- Handler keys in route registry: 168
- Public mutations: 6
- Non-GET read-only routes: 15
- Direct root registry routes: 27

## Routes

By method:

```json
{
  "GET": 33,
  "POST": 139,
  "PUT": 1
}
```

By policy:

```json
{
  "public": 24,
  "admin": 3,
  "authenticated": 90,
  "permission:manage_menu": 4,
  "permission:manage_users": 3,
  "debug:manage_users": 4,
  "permission:open_drawer": 1,
  "permission:print_orders": 1,
  "permission:manage_tables": 2,
  "permission:approve_room_change": 7,
  "permission:override_order_price": 1,
  "permission:create_bar_replacement": 2,
  "permission:manage_reservations": 6,
  "permission:manage_settings": 11,
  "permission:collect_payments": 5,
  "permission:fiscal_operations": 1,
  "permission:manage_smart_customers": 5,
  "service:smart-card": 1,
  "permission:manage_sale_sessions": 2
}
```

Direct root registry routes, first 25:

- POST /api/auth/login -> auth.login
- POST /api/auth/logout -> auth.logout
- POST /api/auth/session/status -> auth.sessionStatus
- POST /api/auth/change-pin -> auth.changePin
- POST /api/settings/pos/users -> users.list
- POST /api/settings/pos/users/save -> users.save
- POST /api/pos/room-change/request -> pos.roomChangeRequest
- POST /api/pos/room-change/approve -> pos.roomChangeApprove
- POST /api/pos/room-change/cancel -> pos.roomChangeCancel
- POST /api/settings/order-workflow -> settings.saveOrderWorkflow
- POST /api/settings/pos/assign-bill -> settings.assignBill
- POST /api/tables/lock/acquire -> tables.lockAcquire
- POST /api/tables/lock/heartbeat -> tables.lockHeartbeat
- POST /api/tables/lock/release -> tables.lockRelease
- POST /api/tables/lock/force-release -> tables.lockForceRelease
- POST /api/payments/table -> payments.table
- POST /api/payments/ticket -> payments.ticket
- POST /api/payments/free-split -> payments.freeSplit
- POST /api/fiscal/command -> fiscal.command
- POST /api/smart/customers -> smart.customers
- POST /api/smart/customers/upsert -> smart.customerUpsert
- POST /api/smart/customers/delete -> smart.customerDelete
- POST /api/smart/card/read -> smart.cardRead
- POST /api/smart/cash/beach-entry -> smart.beachEntry
- POST /api/smart/card/detected -> smart.cardDetected

Full route map: `docs/architecture/route-map-v4.1.0.json`

## DB And Domains

Relational domains:

- auditEvents
- users
- sessions
- saleSessions
- payments
- menuSettings
- orders
- tablesBills

Read-primary domains:

- users
- sessions
- menuSettings
- saleSessions

Migrations:

- 001_core: relational_sync_state, schema_migrations
- 002_audit_events: audit_events
- 003_users: user_authorized_rooms, user_enabled_rooms, user_payment_methods, user_permissions, users
- 004_sessions: sessions
- 005_sale_sessions: sale_sessions, solar_closures
- 006_payments: fiscal_receipts, payment_containers, payment_parts, payment_transactions
- 007_menu_settings: menu_categories, menu_item_variants, menu_items, payment_methods, pos_rooms, pos_tables
- 008_orders: order_events, order_line_variants, order_lines, orders
- 009_tables_bills: table_bills, table_locks, table_states

MySQL app-state domain defaults:

- cashTxDenoms
- commercialBenefitApplications
- commercialBenefitCampaigns
- commercialBenefitCoupons
- commercialBenefitRedemptions
- fiscalEvents
- fiscalReceipts
- handheldCashSessions
- integration
- maintenance
- menuItems
- paymentContainers
- paymentParts
- paymentProviderTransactions
- payments
- paymentTransactions
- posReservationLocks
- posReservations
- posReservationStates
- posRoomChangeRequests
- posSettings
- posTableRoomMoveRequests
- printSpoolJobs
- saleSessions
- saleSessionTemplates
- smartCustomers
- smartNonFiscal
- solarClosures
- tableLocks
- userGroups
- users

Split repositories:

- cassa-frontend/backend/db/app-state/app-state-json.repository.js
- cassa-frontend/backend/db/app-state/app-state-mysql.repository.js
- cassa-frontend/backend/db/app-state/app-state-sqlite.repository.js
- cassa-frontend/backend/db/app-state/app-state.repository.js
- cassa-frontend/backend/db/app-state/audit-events-split.repository.js
- cassa-frontend/backend/db/app-state/device-status-split.repository.js
- cassa-frontend/backend/db/app-state/mysql-audit-events-split.repository.js
- cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js
- cassa-frontend/backend/db/app-state/mysql-sessions-split.repository.js
- cassa-frontend/backend/db/app-state/mysql-table-locks.repository.js
- cassa-frontend/backend/db/app-state/orders-split.repository.js
- cassa-frontend/backend/db/app-state/payments-fiscal-split.repository.js
- cassa-frontend/backend/db/app-state/print-spool-jobs-split.repository.js
- cassa-frontend/backend/db/app-state/table-locks-split.repository.js
- cassa-frontend/backend/db/app-state/table-state-split.repository.js

DB/domain map: `docs/architecture/db-domain-map-v4.1.0.json`

## Config And Device Surface

Env vars by category:

```json
{
  "network": 11,
  "other": 64,
  "auth-session": 10,
  "printing": 11,
  "fiscal": 9,
  "db": 35,
  "battery": 5,
  "automatic-cash": 7
}
```

Hardcoded IPs, top:

- 127.0.0.1: 12 occorrenze
- 192.168.1.200: 6 occorrenze
- 0.0.0.0: 2 occorrenze
- 192.168.1.36: 2 occorrenze
- 192.168.0.28: 1 occorrenze
- 192.168.1.166: 1 occorrenze

Historical printers:

- Stampante preconti e comande Bar 192.168.1.195: 192.168.1.195:9100 active=true
- Stampante Pizza in Riva 192.168.1.36: 192.168.1.36:9100 active=true

Historical fiscal devices:

- RT Bar API: http://192.168.1.200:8765 provider=pos-fiscal-api active=true

Historical automatic cash:

```json
{
  "enabled": true,
  "gatewayBaseUrl": null,
  "mode": "random_file",
  "hasConfigSet": true
}
```

Config surface map: `docs/architecture/config-surface-v4.1.0.json`

## Architecture Debt P0/P1/P2

### P1 - server.js ancora troppo grande

Area: backend-monolith

Evidenza: 38359 righe in cassa-frontend/backend/server.js.

Azione: Continuare estrazione domain/service/handler per pagamenti, ordini, fiscalita', stampa e integration.

### P1 - Route critiche ancora dichiarate nel registry root

Area: route-handlers

Evidenza: 19 route critiche dirette: pos.roomChangeRequest, pos.roomChangeApprove, pos.roomChangeCancel, tables.lockAcquire, tables.lockHeartbeat, tables.lockRelease, tables.lockForceRelease, payments.table, payments.ticket, payments.freeSplit, fiscal.command, smart.customers, ....

Azione: Spostare prima funzioni pure e service, poi handler e route modulari con contratti invariati.

### P1 - Moduli architetturali target mancanti

Area: module-boundaries

Evidenza: Mancano ancora: print-spool, fiscal-pos, stations, realtime, observability, adapters.

Azione: Creare prima print-spool/fiscal-pos/realtime come moduli incrementali senza cambiare API.

### P1 - event_outbox non presente nelle migrazioni relazionali

Area: db-realtime

Evidenza: Le migrazioni 001-009 non dichiarano una tabella event_outbox.

Azione: Introdurre outbox transazionale per notifiche, radio, battery, stampa e side effect asincroni.

### P1 - idempotency_keys non presente nelle migrazioni relazionali

Area: idempotency

Evidenza: Le migrazioni 001-009 non dichiarano una tabella idempotency_keys.

Azione: Centralizzare idempotenza per pagamenti, ordini, fiscalita', cassa automatica e stampa.

### P2 - IP operativi ancora presenti nel sorgente

Area: configuration

Evidenza: 192.168.1.200 (6), 192.168.1.36 (2), 192.168.0.28 (1), 192.168.1.166 (1)

Azione: Spostare gli IP in DB/config effettiva e lasciare nel codice solo fallback di sviluppo dichiarati.

## Phase 0 Gate Commands

Run from `cassa-frontend`:

```bash
npm run check:backend
npm run audit:architecture-security
npm run gate:architecture-security
node --test backend/tests/route-policy-architecture.test.mjs
node --test backend/tests/security-architecture.test.mjs
```

Risultati eseguiti: `docs/architecture/PHASE0_GATE_RESULTS_v4.1.0.md`
