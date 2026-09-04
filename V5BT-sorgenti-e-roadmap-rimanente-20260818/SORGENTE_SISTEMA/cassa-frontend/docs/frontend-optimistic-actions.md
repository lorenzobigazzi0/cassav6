# Frontend optimistic actions - Step 8A

## Scope

This step enables the first frontend optimistic path behind
`CLIENT_OPTIMISTIC_ACTIONS` / `features.clientOptimisticActions`.

Implemented domains:

- notification acknowledgement;
- table/history/preconto print requests;
- non-critical settlement reprint requests.
- occupy/free table UI state.
- same-room table move and approved cross-room table move UI state.
- pending order UI state after comanda submit.

Not implemented in this slice:

- operator room change before authorization;
- payment/fiscal optimistic behavior.

Those remain separate Step 8B+ tasks because they own stronger business
invariants and need dedicated rollback/reconcile rules.

## Client pattern

```text
tap
-> local UI feedback immediately
-> backend request in background
-> success updates toast/message when available
-> failure rolls back visible state or shows an error
```

The mobile owner is `src/shared/optimistic/clientOptimisticActions.ts`.
It only reads runtime feature flags and launches background requests; it does
not own domain state.

## Notification ack

`acknowledgeNotification` and `deleteNotification` now return `boolean`.
Existing callers that ignore the result still work.

When optimistic mode is enabled, `useNotificationCenter` removes/marks the
notification immediately. If the backend returns `false` or the request throws,
the affected notification/call is restored.

## Print requests

`TableDetailPanel` now closes the preconto menu and shows a print-request toast
immediately when optimistic mode is enabled. The actual API request still uses
`src/api/printing.ts`.

`TablesWorkspace` sends the post-reso current preconto print in background and
shows an error notice only if the print request fails.

`PaymentSettlementSection` keeps the critical settlement completion path
synchronous. Only manual/non-critical reprint actions use the optimistic
background pattern.

## Table occupy/free

`TablesWorkspace` applies an immediate React Query patch for `occupa` and
`libera` when optimistic mode is enabled:

- `occupa` changes the table visual state to `seated` with the current detail
  form values;
- `libera` clears the visible table data and closes the detail modal;
- the real backend request still runs through table locks and `src/api/tables`;
- if the backend rejects the operation, the previous query snapshot and
  selected detail state are restored and the existing action error is shown.

## Table move and cross-room table move

`TablesWorkspace` now patches table move snapshots optimistically:

- same-room move patches source and target tables immediately and applies the
  next table-group snapshot;
- cross-room table move waits for the room-move request/approval first, then
  patches source and target room snapshots while the backend move runs;
- backend locks and `moveDiningTable` remain authoritative;
- rollback restores source room snapshot, target room snapshot, selected table,
  active dialog, and target-room preview state.

The operator's own room change is intentionally not optimistic before approval:
showing a room before the backend authorizes it would create a false source of
truth for permissions and table visibility.

## Pending comanda submit

`TablesWorkspace` now patches the selected table snapshot immediately after a
valid comanda submit when optimistic actions are enabled:

- a local `waiting` / `in_progress` order is inserted at the top of
  `orderHistory`;
- `ordersTaken` and `ordersInProgress` are incremented so the table leaves the
  idle visual state immediately;
- `amountDue` is not changed, matching the backend rule that a comanda becomes
  payable only after the order reaches the served/delivered path;
- the real request still runs through `ORDER_CREATE_LOCK_PURPOSE` and
  `addDiningTableOrder`;
- on success, the backend table replaces the temporary optimistic row;
- on failure, the previous snapshot and selected detail state are restored.

Fiscal, payment, receipt, and integration acknowledgement remain backend-owned.

## Flags

Enable:

```env
CLIENT_OPTIMISTIC_ACTIONS=1
```

Mobile runtime config:

```json
{
  "features": {
    "clientOptimisticActions": true
  }
}
```

Rollback:

```env
CLIENT_OPTIMISTIC_ACTIONS=0
```

and set `features.clientOptimisticActions` to `false` in `public/config.json`.

## Validation

```text
npm --prefix ../mobile-frontend run typecheck
npm --prefix ../mobile-frontend run test:phase8
npm run check:backend
```
