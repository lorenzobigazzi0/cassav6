# Mobile Frontend V2 Architecture

## Current Classification

This project is no longer treated as pure greenfield. It is a source-first migration of the legacy mobile frontend with a strict retirement path for legacy runtime code.

The target remains:

- visual parity with the original mobile UI;
- React source ownership for business behavior;
- explicit runtime configuration;
- API access through shared clients;
- storage access through adapters;
- legacy bridge retirement by domain.

## Target Structure

The long-term source layout is:

```txt
src/
  app/
  shared/
  domain/
  features/
  pages/
  styles/
```

The current layout still contains legacy-oriented folders. Refactors must move incrementally toward the target without breaking visual parity.

## Runtime Boundaries

- App bootstrapping belongs in `src/main.tsx`.
- Runtime configuration belongs in `public/config.json` and `src/config/runtimeConfig.ts`.
- API base selection must come from runtime config or `VITE_API_BASE_URL`, and source code
  should call `src/shared/api/apiClient.ts` instead of composing backend origins directly.
- React pages compose features. Feature modules must not become containers for unrelated domains.
- DOM-based bridge code has been removed from bootstrap and must not be reintroduced.

## Bridge Policy

Bridge code is allowed only when it is already documented in `BRIDGE_RETIREMENT_PLAN.md`. New bridge files, new global fetch patches, new EventSource patches, and new business `MutationObserver` flows are prohibited.

Each bridge must have:

- a responsibility;
- known legacy patterns;
- a replacement target;
- a removal priority;
- a status.

## API Policy

The desired model is a single shared API layer with domain clients and declarative query caching.
`src/shared/api/apiClient.ts` owns runtime-configured URL construction and the current retry
policy. Components and feature UI must not introduce raw endpoint strings. Existing direct
endpoints are debt and should be moved behind domain API modules during feature work.

## Product Pricing And Listini Policy

From this point on, products must be treated as potentially belonging to multiple price lists
(`listini`). Each product can expose metadata that says which listini include it, and each listino
can define a different price for the same product.

Frontend rules:

- do not assume a product has one global price only;
- keep `price`, `basePrice`, `activePrice`, and `currentPrice` backward-compatible;
- accept future backend fields for listino membership and per-listino prices without making them
  mandatory;
- preserve the active backend-provided display price and any emitted order price snapshot;
- do not calculate the authoritative final price on the frontend;
- payment must keep using the price captured when the order line was emitted.

## Session Revocation And Native Notifications

Mobile logout is a fail-closed lifecycle transition, not only a route change:

- \`src/app/session/endSession.ts\` captures the credentials needed for remote cleanup, revokes the
  Zustand session immediately, then releases table locks and calls \`/api/auth/logout\` best-effort;
- \`mobile:session-ending\` is the synchronous boundary for query caches, notification queues,
  realtime transports, radio capture/playback, pending tones, vibration, and late optimistic
  callbacks;
- notification intake must remain gated by the current authenticated session after every async
  boundary, so a polling/SSE response created before logout cannot repopulate the UI;
- the definitive Android bridge is \`window.AmaliaNativeNotifications.updateSessionContext(json)\`
  and \`clearSession()\`. Its payload uses camelCase
  \`{ token, userId, username, fullName, deviceUuid, roomId, roomName, clientApp }\`;
- \`clearSession()\` is invoked before local auth data is removed, allowing the APK to cancel native
  notifications, queued delivery, sound, and vibration atomically with web logout.

The packaged Palmare keeps \`installOfflineRuntime()\` mounted. Auth-protected outbox entries are not
discarded on logout, but each entry belongs to its original user, activity, and device. Stored
entries never retain a token: replay overlays the current session credentials and runs only when
the complete owner scope matches. Session ending aborts replay requests already in flight; the
logout endpoint itself has offline policy \`none\` and is never added to the outbox.

## Offline Operational Configuration

- Rooms, table layout, menus, reservation windows, and local table order history are persisted in
  IndexedDB under a user/activity scope.
- A resident runtime refreshes snapshots after login, every 60 seconds while online, and after
  network, realtime, focus, or settings recovery. Domain queries still execute while offline and
  return the last complete compatible snapshot.
- Authoritative empty server responses replace cached rooms and products; they are not interpreted
  as transport failures. Pending assigned reservations are projected before layout reconciliation,
  so removing a room or table cannot erase an active local service.
- Reserve, seat/arrival, release, and order-create may continue only when lock acquisition failed
  because of transport unavailability or `502/503/504`. Authorization, missing-resource, and
  conflict responses remain blocking.
- Removed seated, ordered, or unpaid tables stay operational until release. Removed reserved tables
  require a visible `Mantieni` or `Sposta` decision, and neither path recreates the removed source
  in the authoritative layout.
- Payments, fiscal actions, automatic-cash operations, printing, refunds, table moves, and other
  irreversible or lock-sensitive workflows are never placed in the generic outbox.

## Storage Policy

The desired model is:

```txt
src/shared/storage/
  storageAdapter.ts
  authStorage.ts
  roomPreferenceStorage.ts
  paymentSessionStorage.ts
  tableFilterStorage.ts
  reservationReminderStorage.ts
```

Current storage utilities may remain during transition, but new direct storage calls outside adapters are prohibited.

Current adapter entry points:

- `src/shared/storage/storageAdapter.ts`
- `src/shared/storage/authStorage.ts`
- `src/shared/storage/roomPreferenceStorage.ts`
- `src/shared/storage/paymentSessionStorage.ts`
- `src/shared/storage/tableFilterStorage.ts`
- `src/shared/storage/reservationReminderStorage.ts`
- `src/shared/storage/preferenceStorage.ts`
