# Codex Handoff

## Status

Snapshot restored from `CONTESTO_FRONTENDV2_CODEX.zip`, specifically
`frontendv2-src-nuovo-20260519-124308.zip`.

The frontend has strong visual-parity progress, but it is currently a source-first legacy
migration rather than a clean greenfield frontend. This handoff establishes permanent project
rules, bridge retirement tracking, runtime config, and quality gates.

Second stabilization pass completed: the backend connection bridge and hot fetch cache were
removed from source and replaced by a runtime-configured API client.

Third stabilization pass completed: `installMobileSettingsLiveSync` no longer patches
`window.fetch`. Settings APIs publish explicit version events, and the runtime invalidates
TanStack Query caches through controlled domain sync.

Fourth stabilization pass completed: `installMobileTableLockLifecycleBridge` has been removed.
Table lock acquire/heartbeat/release now runs through `src/api/tableLocks.ts`,
`src/pages/home/tables/hooks/useTableLock.ts`, and explicit table-operation lock wrappers in the
React tables workspace.

Fifth stabilization pass completed: `installMobileTableGroupsBridge` has been removed. Table
groups now load through `src/api/tableGroups.ts`, `fetchTablesForSession` returns React-owned
logical table data, and the Tavoli workspace owns long-press merge/split/same-room move dialogs.

Sixth stabilization pass completed: `installMobileOrderServiceRecoveryBridge` and the legacy
bridge bootstrap have been removed. Order correction, cancellation, reso, and zero-cost
replacement now run through `src/api/orderServiceRecovery.ts` and the React-owned
`TableServiceRecoveryDialog`.

Seventh stabilization pass completed: direct `localStorage.` and `sessionStorage.` calls have
been removed from application source. Persistence now runs through `src/shared/storage` adapters
and domain-specific wrappers for auth, rooms, payments, table filters, reservation reminders, and
general preferences.

Eighth stabilization pass completed: protected routes, Home tab workspaces, and payment settlement
are lazy-loaded. The production build now emits route/feature chunks for Home, Settings, Profile,
Payments, Tavoli, Menu, Prenotazioni, Statistiche, and Scarico cassa, removing the Vite
`chunk > 500 kB` warning without changing visual behavior.

Ninth frontend pass completed: product/menu pricing now supports optional timed price data from
the backend without making the frontend authoritative. Menu normalization accepts `activePrice`,
`currentPrice`, `basePrice`, schedule fields, `pricingLabel`, `pricingSource`, `pricingMeta`, and
`nextPriceChangeAt`; menu cards and order composer display normalized preview prices; draft order
lines preserve `productId` and a non-authoritative client price snapshot; timed pricing refresh is
scheduled from backend-provided `nextPriceChangeAt`.

Tenth frontend pass completed: payment flows now explicitly preserve the listino/prezzo captured
when the order is emitted. Existing order totals and line `unitFinalPrice` values are used for
later payment, including article-level split payments, so an order emitted at 17:30 and paid at
18:30 keeps the 17:30 price snapshot instead of the current menu/listino.

Eleventh frontend audit pass completed: the remaining conservative frontend-only fixes were
applied without touching backend code. `npm ci` was verified, the Node target is aligned with the
current toolchain, mock auth is gated by explicit dev/test configuration, order payloads carry
retrocompatible idempotency metadata, notification intake is deduplicated, inactivity logout uses
the API client, integration order fingerprints include totals/items/line prices, and the default
order station is now runtime-configurable with the previous `BAR PRINCIPALE` fallback.

Twelfth handoff note: product pricing must now be modeled as listino-aware. Every article/product
may belong to multiple listini, and each listino may define a different price for the same article.
The frontend must preserve this metadata when the backend exposes it, but the backend remains the
authoritative source for the active/final price.

Thirteenth architecture pass completed: started reducing feature monolith pressure without
changing UI behavior. Currency formatting moved to `src/shared/format/currency.ts`, so payment and
analytics pages no longer import table feature utilities. The pure article-payment expansion and
invoice normalization/validation logic were extracted from `TablePaymentWizard` into
`src/pages/home/tables/payment`, with focused tests covering emitted-price article units and
invoice helpers.

Fourteenth pass completed (resilience + error-handling infrastructure, Phase 1 of the stabilization
prompt). No UI/behavior change for existing flows:

- `src/shared/api/apiClient.ts` was rewritten, retro-compatible with `apiFetch`. It now adds a
  per-attempt timeout via `AbortController` (default ~15s) that also honors a caller-provided
  `signal`; exponential backoff with jitter between idempotent retries (GET/HEAD on 502/503/504);
  a normalized `ApiError { message, status, code, url, body }`; an `apiJson<T>()` helper that parses
  JSON and throws `ApiError` on non-2xx / network / timeout / abort; and a centralized
  `setUnauthorizedHandler(handler)` invoked once when the backend answers 401.
- `src/store/authStore.ts` registers the 401 handler (`if (token) logout()`), centralizing session
  expiry. This is additive: existing domain 401 branches in `src/api/auth.ts` (session-status →
  "invalid") and `src/api/tables.ts` (layout-sync fallback) remain valid non-logout business logic.
- `src/shared/errors/ErrorBoundary.tsx` (new) is a route/workspace error boundary with a readable
  fallback and a "Riprova" action; it is mounted around `<App/>` in `src/main.tsx` with `scope="app"`
  and reuses the `glass-card`/`btn` classes for visual parity.
- `src/api/baseUrl.ts` now also re-exports `apiJson`, `ApiError`, and `setUnauthorizedHandler`.
- Conservative consumer rewiring (only behavior-identical "swallow failure → null" cases):
  `src/api/stations.ts` and `fetchRoomsFromLegacyLayout` in `src/api/locations.ts` now use
  `apiJson`. Deeper rewiring of behavior-sensitive modules (`company.ts` message precedence,
  `printing.ts` 2xx-`ok:false` branch, `locations.ts` `postPosEndpoint` ok/error/unavailable
  distinction, `tables.ts`, `reservations.ts`, `menu.ts`) is intentionally deferred to Phase C
  decomposition where behavior can be preserved with tests.
- Static gate extended with three new checks (`tests/static/architectureRules.test.ts`):
  monotonically-decreasing per-file LOC budgets (seeded at current values measured with
  `split(/\r?\n/).length`); a ban on importing `pages/home/tables/utils` from outside the tables
  feature; and a tenant-data ban (IBAN `IT\d{2}…`, "Ristorante Demo", "Banca Demo", "Dolce Vita SRL")
  with a temporary whitelist on `TablePaymentWizard.tsx` and `payment/paymentInvoice.ts`.

Fifteenth pass completed (Phase B — the residual `src/mobile` helpers were absorbed into React).
The `src/mobile` directory is now deleted. All runtime concerns mount once from
`src/app/AppRuntime.tsx` (inside the providers), and `src/main.tsx` no longer imperatively installs
them:

- `useGlobalDocumentGuards` mounts the interaction guards and the text-encoding fix, moved verbatim
  to `src/app/runtime/documentInteractionGuards.ts` and `src/app/runtime/documentTextEncodingFix.ts`
  (logic unchanged — they are intrinsically DOM-global; their `window.__*` flags became module-level
  booleans).
- `usePaymentSessionRuntime` relocates the `installMobilePaymentSessionRuntime` call into a root hook
  without rewriting the runtime, which still lives in `src/utils/paymentSessionRuntime.ts`.
- `useInactivityAutoLogout` replaces the inactivity helper with an `authStore`-tied hook using
  explicit timers and effect cleanup, preserving the timeout, lock release, backend logout, message,
  and reload behavior.
- `useSettingsLiveSync` replaces the settings sync helper; TanStack invalidation and polling are
  unchanged, and the DOM-injected banner/`<style>` are replaced by a React `SettingsSyncBanner`.
- The static gate `window.__` budget was lowered from 8 to 0. The two moved DOM-global guard modules
  are tracked in the gate whitelist for their `MutationObserver`/`!important` patterns.

2026-07-24 administrative ownership update: Palmare Advanced settings no longer expose the
automatic cash configuration uploader, minimum-reserve uploader, JSON combination-file controls,
or the informational POS statistics block. Operational automatic-cash payment, cash-float,
settlement, and analytics flows remain unchanged. Automatic-cash administration remains in the
central `/impostazioni` frontend, whose Pagamenti section now also renders administrative POS
statistics from the existing `POST /api/reports/sales` contract.

2026-07-24 resident payment-overview update: `PaymentOverviewProvider` is the TanStack Query owner
for payment terminals and operational cash/gateway state while an authenticated session with
`collect_payments` is active. Its queries are keyed by user, device, and `sessionStartedAt`, poll
outside the Payments route, retain the last valid snapshot during offline failures, and are removed
on the synchronous session-ending boundary. `PaymentsPage` observes those same query keys with
fetching disabled, so opening Quadro pagamenti renders the resident snapshot without starting a
second initial request. The provider is mounted at the app root but remains auth- and
permission-aware, so the login route and sessions without payment access never start its polling.
Gateway data remains visible for diagnosis after a failed refresh, but it is operational only
while the latest read succeeded, the browser is online, and the snapshot is at most 30 seconds old.
Every automatic-cash hardware entry point, including automatic settlement, consumes that gate;
manual settlement remains available. Settings live-sync also queues the newest version received
during an active banner cycle and runs a second invalidation instead of dropping the update.

2026-07-24 offline operational-configuration update: Palmare Advanced keeps a
user/activity-scoped IndexedDB snapshot of available rooms, the integration table layout, every
room menu, and the reservation window. `useOfflineConfigurationSync` refreshes that snapshot after
login, on network and realtime recovery, on focus/settings changes, and every 60 seconds while
online. React Query runs domain query functions in `networkMode: "always"`, so a cold start without
connectivity still executes the repository fallbacks instead of leaving queries paused. Menu,
room, table, and reservation screens therefore continue from the last complete local configuration
and replace it incrementally when the server becomes reachable again.

Ordinary idempotent mutations use the persistent offline outbox; table layout/order mutations keep
their existing domain queue. Both queues are scoped by user, activity, and device, strip stored
tokens, and replay with fresh session credentials only for their original owner. The
`mobile:session-ending` boundary aborts in-flight generic replay. Synthetic
`202 X-Palmare-Offline-Queued` responses are treated as an accepted local operation, and
reservation snapshots are updated immediately so the UI never rolls back an action already waiting
for replay. Payments, fiscal operations, automatic-cash settlement, printing, refunds, and other
irreversible hardware operations remain deliberately outside the generic queue. Backend rejections
are retained as `conflict` or `failed` for operator-visible reconciliation.

Table reserve, seat/arrival, release, and order-create flows now use an explicit offline lock
continuation policy. The normal server lock remains mandatory whenever an authoritative response
is available; only transport failures and `502/503/504` may continue into the local mutation and
persistent queue. `403`, `404`, `409`, and every other application response remain fail-closed.
The order composer exposes this as an `offline` lock state without showing a false lock error,
while payment, move, and other non-queueable workflows remain strict.

Local table order history is persisted inside the scoped configuration snapshot and rehydrated on
an offline restart. Layout refresh keeps pending local history, and successful order replay
replaces the local order ID in both memory and the persisted snapshot. Session ending also clears
all in-memory room tables and integration/layout fingerprints, preventing a second user in the same
room from inheriting the previous operator's optimistic state.

Layout reconciliation retains a server-removed table only while it still has an active local
service. A seated, ordered, or unpaid table is kept until release. A removed reserved table is
marked with a blinking configuration warning and requires an explicit `Mantieni` or `Sposta`
decision. `Mantieni` preserves it for the current service; `Sposta` transfers its operational data
and active orders to an existing locked destination without restoring the removed source to the
server layout. Once freed or moved, the tombstone and any room retained only for it are removed.

The backend accepts lock, order creation, release, and same-room move for that removed operational
table without recreating it in configuration, including when the whole source room was deleted.
The exception requires persisted server evidence and remains limited to the room session, the
recorded operational actor, or the current lock owner; a fabricated tombstone is rejected.

Focused verification passed on 2026-07-24: 121 source web tests, 174 packaged-web tests, 8 backend
end-to-end tombstone cases, 3 central `/impostazioni` ownership tests, both TypeScript builds, and
both web production builds. Palmare Advanced `1.0.33` (`versionCode 34`) embeds the synchronized
bundle and passed 179 Android unit tests, Android Lint, and debug APK assembly.

## Current Architecture Notes

- 2026-06-04 operational configuration update: mobile room context now preserves backend
  `activityId`/`activityIds` with `roomId`; Tavoli/Menu queries use `activityId+roomId`; order
  creation sends `operationalSchemaVersion: 2` and `activityId`; production runtime no longer
  generates default mock tables or falls back to the static menu catalog when backend configuration
  is unavailable.
- Legacy assets are allowed for visual parity.
- No legacy bridge is installed from `src/mobile` at bootstrap.
- `installMobileBackendConnectionBridge` and `installFrontendHotFetchCache` have been deleted.
- API calls in the migrated API modules now use `src/shared/api/apiClient.ts`.
- `src/shared/api/apiClient.ts` builds API/SSE URLs from `public/config.json`,
  `VITE_API_BASE_URL`, or `VITE_SSE_BASE_URL`.
- `src/shared/api/apiClient.ts` also exposes `apiJson<T>()` (parse + normalized `ApiError`),
  per-attempt timeout/abort, idempotent backoff retry, and `setUnauthorizedHandler` for centralized
  401 handling. Prefer `apiJson<T>()`/`ApiError` for new API calls instead of manual `response.json()`
  parsing.
- Backend 401 handling is centralized in `src/store/authStore.ts` via `setUnauthorizedHandler`.
- Route/workspace render errors are contained by `src/shared/errors/ErrorBoundary.tsx`, mounted
  around `<App/>` in `src/main.tsx` with `scope="app"`.
- `vite.config.ts` proxies same-origin `/api` in development through `VITE_API_PROXY_TARGET`,
  `API_PROXY_TARGET`, or the local fallback `http://127.0.0.1:5181`.
- `installMobileSettingsLiveSync` now polls health through `apiFetch`, listens to explicit
  settings-version events, emits `pos:settings-sync`, and invalidates known query families instead
  of reloading or wrapping fetch.
- Table order composer and payment wizard now hold persistent table locks with React lifecycle
  ownership. Occupy/reserve/update/free/move/serve/payment/order mutations acquire explicit
  operation locks through the API client.
- Service recovery mutations acquire explicit table locks through `src/api/tableLocks.ts`.
- Storage reads/writes are centralized in `src/shared/storage`.
- Route and feature-level code splitting is active for the heaviest mobile surfaces.
- Timed/listino pricing is frontend display and payload metadata only; final pricing remains a
  backend responsibility.
- Products must not be treated as having only one global price. They may include listino
  membership metadata and per-listino prices; frontend code should accept that shape
  retrocompatibly and use the backend-provided active/display price.
- Once an order is emitted, payment UI must use the stored order total and line final prices, not
  the current menu price.
- Shared formatting must live under `src/shared/format`; pages outside Tavoli must not import
  `src/pages/home/tables/utils` just to format money.
- Mock auth is disabled in production unless `VITE_ENABLE_MOCK_AUTH` is explicitly enabled.
- Order creation payloads may include `clientOrderId`, `localOrderId`, and `idempotencyKey`; these
  are additive and backend-optional.
- The default order station resolves from an explicit value, `VITE_DEFAULT_ORDER_STATION`, runtime
  config, or the fallback `BAR PRINCIPALE`.
- `public/config.json` is the first runtime config surface:
  - `apiBaseUrl: /api`
  - `sseBaseUrl: /api`
  - `defaultOrderStation: BAR PRINCIPALE`
  - `features: {}`

## Verification Log

Executed on 2026-05-19 in `/home/sentrapa/Desktop/frontend2`.

- `npm install -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks eslint-plugin-react-refresh globals prettier vitest @testing-library/react @testing-library/jest-dom jsdom @playwright/test`
  passed.
- `npm run typecheck` passed.
- `npm run lint` passed with 34 warnings from existing React/dependency debt.
- `npm run format` passed and formatted non-ignored source files.
- `npm run format:check` passed.
- `npm run test:static` passed: 9 static architecture tests.
- `npm run test` passed: 1 test file, 9 tests.
- `npm run test:e2e` passed with `--pass-with-no-tests`; real Playwright specs are not present yet.
- `npm run build` passed.
- Static architecture budgets were reduced after removing the two P0 bridges, the settings fetch
  patch, the table lock lifecycle bridge, the table groups bridge, and the order service recovery
  bridge:
  - `window.fetch =` budget is now 0.
  - `window.EventSource =` budget is now 0.
  - `MutationObserver` budget is now 1.
  - `querySelector` budget is now 3.
  - `localStorage.` budget is now 0.
  - `sessionStorage.` budget is now 0.
  - `window.__` budget is now 8.

Bundle split verification after the eighth pass:

```txt
dist/assets/index-BmQTT8Rw.css 243.06 kB
dist/assets/index-YTyFJ1km.js  257.50 kB, gzip 82.99 kB
dist/assets/TablesWorkspace-DyBVJrp7.js 134.27 kB, gzip 34.50 kB
```

The previous Vite `Some chunks are larger than 500 kB` warning is resolved.

Additional verification on 2026-05-22 after timed pricing support:

- `npm run typecheck` passed.
- `npm run test:static` passed: 9 static architecture tests.
- `npm run test` passed: 5 test files, 25 tests.
- `npm run lint` passed with 34 warnings from existing React/dependency debt.
- `npm run format:check` passed.
- `npm run test:e2e` passed with `--pass-with-no-tests`; real Playwright specs are still not
  present.
- `npm run build` passed.
- A manual extra attempt `npm run test -- --runInBand` failed because Vitest does not support the
  Jest-style `--runInBand` flag; the normal package `npm run test` passed afterward.

Additional verification on 2026-05-22 after the eleventh frontend audit pass:

- `npm ci` passed; it reports the existing 3 dependency audit findings.
- `npm install --package-lock-only` passed after aligning the package engine target.
- `npm run typecheck` passed.
- `npm run test` passed: 6 test files, 29 tests.
- `npm run test:static` passed: 9 static architecture tests.
- `npm run lint` passed with 34 warnings from existing React/dependency debt.
- `npm run test:e2e` passed with `--pass-with-no-tests`; real Playwright specs are still not
  present.
- `npm run build` passed.

Additional handoff update on 2026-05-22 before packaging:

- Documented the product/listino pricing model in `ARCHITECTURE.md` and this handoff.
- No functional source change was made for this packaging-only update.

Additional verification on 2026-05-22 after the thirteenth architecture pass:

- `npm run typecheck` passed after extracting payment article and invoice helpers.
- `npm run format:check` passed.
- `npm run test` passed: 8 test files, 34 tests.
- `npm run test:static` passed: 9 static architecture tests.
- `npm run lint` passed with 34 warnings from existing React/dependency debt.
- `npm run build` passed.

`npm audit --json` exits non-zero because the current dependency tree reports 3 vulnerabilities:

- `vite` moderate;
- `esbuild` moderate via Vite;
- `rollup` high.

The automatic Vite fix suggested by npm is semver-major, so it was not applied in this
architecture-stabilization pass.

Additional verification on 2026-05-30 after the fourteenth pass (resilience + error handling).
Toolchain note: this Windows environment had no Node.js; Node 24.16.0 / npm 11.13.0 were installed
(via winget `OpenJS.NodeJS.LTS`) under `C:\Program Files\nodejs` to run the gates.

- `npm ci` passed (261 packages; the same 3 dependency audit findings remain — 2 moderate, 1 high).
- Baseline (pre-change) re-confirmed green first: typecheck, lint (34 warnings, 0 errors), test
  (9 files / 37 tests), test:static (9 tests).
- `npm run typecheck` passed.
- `npm run lint` passed with 34 warnings and 0 errors (no new lint debt; an interim unused-import
  warning in the new test was removed).
- `npm run test` passed: 10 test files, 55 tests (added `tests/apiClient.test.ts` with 15 tests
  covering ApiError mapping, the 401 handler path, per-attempt timeout, caller abort vs timeout,
  pre-aborted signal, backoff bounds, and idempotent GET retry on 503 / network error).
- `npm run test:static` passed: 12 architecture tests (9 prior + 3 new gates).
- `npm run build` passed; the production build emits the same route/feature chunks with no
  `chunk > 500 kB` warning.
- No `.orig` files were present.

Static architecture budgets are unchanged for the existing needles and remain monotonically
decreasing: `window.fetch = 0`, `window.EventSource = 0`, `MutationObserver <= 1`,
`querySelector <= 3`, `localStorage. = 0`, `sessionStorage. = 0`, `window.__ <= 8`,
`!important <= 267`, raw `/api/` strings in `.tsx` `<= 5`.

New per-file LOC ceilings (seeded at current values; lower them when decomposing in Phase C):

```txt
src/api/tables.ts                                              2442
src/pages/home/tables/components/TablePaymentWizard.tsx        2092
src/pages/home/tables/components/TableOrderComposer.tsx        1564
src/pages/home/reservations/ReservationsWorkspace.tsx          1414
src/pages/home/tables/components/TableDetailPanel.tsx          1375
src/pages/home/tables/TablesWorkspace.tsx                      1310
src/pages/payments/PaymentSettlementSection.tsx                1259
src/api/reservations.ts                                         931
src/pages/SettingsPage.tsx                                      929
src/api/menu.ts                                                 914
src/api/analyticsPaymentMovements.ts                            741
src/pages/home/tables/components/TableServiceRecoveryDialog.tsx 734
src/pages/home/hooks/useNotificationCenter.ts                   628
src/pages/home/analytics/AnalyticsWorkspace.tsx                 565
src/pages/home/menu/MenuWorkspace.tsx                           515
```

## Known Legacy Debt

- No runtime helper currently patches `window.fetch` or `window.EventSource`.
- Runtime helpers remain in `src/mobile` for interaction guards, inactivity logout, settings sync,
  and text encoding compatibility.
- CSS override debt remains in `src/styles` and `public/assets/mobile-*.css`.
- Storage usage now goes through adapters, but some domain wrappers still live in transitional
  utility modules.
- Several large feature files need future decomposition.
- `TablePaymentWizard`, `TableOrderComposer`, `TableDetailPanel`, `TablesWorkspace`,
  `ReservationsWorkspace`, and `PaymentSettlementSection` remain large feature files. The payment
  wizard has started moving pure logic out, but it still needs component-level decomposition.
- CSS remains globally large, and Tavoli still has large feature files even though the main JS
  chunk is now below the Vite warning threshold.
- Backend timed-price calculation/storage/endpoints are not implemented in this frontend-only pass.
- ESLint warnings remain as tracked debt; lint is now a real gate and exits successfully.
- E2E coverage is only scaffolded, not functionally meaningful yet.
- `git` is not available in the current environment, so repository status cannot be checked from
  the terminal here.

## Next Recommended Prompt

Implementare lato backend il listino/prezzi a orario come fonte autoritativa, esponendo
per ogni articolo i listini a cui appartiene, il prezzo per ciascun listino, e il listino/prezzo
attivo come `activePrice`/`currentPrice`, `pricingLabel` e `nextPriceChangeAt` nel menu senza
cambiare il contratto frontend esistente.

Additional integration update on 2026-05-22 after replacing the previous mobile frontend:

- FrontendV2 was integrated into the previous full application under `mobile-frontend` and its production build was emitted to `mobile-frontend/dist` with Vite base `/mobile/`.
- `src/config/runtimeConfig.ts` now checks the base-scoped runtime config first (`/mobile/config.json` when served under `/mobile/`) and then falls back to `/config.json`.
- `package-lock.json` was synchronized so `npm ci` can install the Vite/React toolchain consistently.
- Runtime smoke verification passed through the previous static launcher and backend proxy: `/mobile/`, `/mobile/config.json`, the main JS asset, proxied `/api/health`, login, session status, and `/api/pos/rooms`.

Additional integration test update on 2026-05-22:

- The previous application's `cassa-frontend/frontend-tests` suite was adapted for the FrontendV2 replacement: legacy mobile bridge tests now skip when the retired legacy mobile assets are absent, and `mobile-frontendv2-static.test.mjs` verifies the new `/mobile/` dist, runtime config, referenced assets, and absence of retired bridge globals.
- `npm run test:frontend` in `cassa-frontend` passes after the adaptation; legacy mobile bridge cases are intentionally skipped because FrontendV2 owns those behaviors through React/source modules.

Additional mobile graphics performance update on 2026-06-22:

- The mobile shell keeps the same layout and visual hierarchy, but the always-visible Home/Tavoli chrome no longer pays continuous GPU/CPU cost for runtime backdrop blur on coarse/mobile viewports.
- Home tab transitions now animate only opacity/transform; the previous keyframe blur was removed so the final stable view does not keep a `filter: blur(0)` rendering path.
- Infinite glass lens/sheen and payment alert pulse animations are disabled on mobile/coarse viewports; the static gradients remain in place for visual parity.
- Verification after production build, served through `serve-frontends.mjs` with the backend proxy, measured approximate main-thread CPU over 5s samples: Home stable `5.48%`, Tavoli stable `6.62%`.

Additional mobile tables refresh update on 2026-06-23:

- Tavoli keeps the operator-requested hot refresh interval at `3_000ms`.
- Available rooms and tables now refetch while the app is backgrounded and after reconnect, preserving faster cross-device table/room visibility at the cost of higher mobile CPU/network load.

Additional mobile test alignment update on 2026-06-23:

- Analytics payment movement printing again uses one visible `STAMPA` button: tap prints normally,
  long press prints the advanced detail. The separate `STAMPA AVANZATA` button was removed.
- `documentTextEncodingFix` now performs only the initial text repair pass. The optional
  storage-enabled DOM mutation observer path was removed, so it cannot be re-enabled at runtime.
- Static tests were realigned with the current API ownership: integration order query parameters
  are asserted in `src/api/tables/integrationClient.ts`, and session-status 401 remains handled by
  the auth check path while protected endpoint 401 still triggers the central unauthorized handler.

Additional mobile service-recovery visual update on 2026-06-23:

- The React-owned `Gestisci comanda`, `Modifica comanda`, and `Reso` modals now anchor from the top
  of the mobile viewport and reserve bottom space for the app bottom bar.
- Replacement/reso item cards no longer receive the expanded `is-open` visual state when selected;
  the row keeps a fixed compact height even when it is the only item in the modal.

Additional mobile Tavoli containment update on 2026-06-23:

- The Home shell now applies a derived `home-shell-tavoli` class while the Tavoli tab is active.
  That shell disables the generic lateral expansion used elsewhere and keeps
  `glass-card home-card workspace-card tables-workspace-card` constrained inside
  `home-tab-pane-tavoli`.

Additional mobile table-detail reservation update on 2026-06-23:

- The table detail header no longer shows the `Dettaglio Tavolo` kicker.
- Reservation entry fields now use required `*` marks instead of `(obbligatorio)`, and covers/time
  stay on the same row in reservation mode.
- The `Prenota` action shows a same-day reservation count badge for the selected table. When
  same-day reservations exist, `Gestisci prenotazioni` opens a table-scoped list and a second action
  modal for `Arrivati`, `No show`, and `Elimina`, using the `arrivati.png`, `noshow.png`, and
  `cancel.png` assets from `public/assets`.

Additional mobile service-recovery containment update on 2026-06-23:

- The React-owned `Gestisci comanda`, `Modifica comanda`, and `Reso` overlay is now card-local
  inside `glass-card home-card workspace-card tables-workspace-card`: it no longer uses the full
  viewport shell and sizes itself against the Tavoli workspace dimensions.

Additional Radio PTT architecture update on 2026-06-24:

- The first mobile Radio PTT layer is now mounted inside protected routes through
  `src/radio/RadioProvider.tsx`, under the existing notification provider.
- Radio configuration reads/writes use `src/api/radio.ts` and the shared `apiJson` client.
- The WebSocket client in `src/radio/radioWsClient.ts` builds its URL from runtime API config,
  performs the authenticated hello, subscribes to active slots, reconnects with bounded backoff,
  and only accepts audio frames after the backend grants a PTT or Echo stream.
- `src/radio/radioProtocol.ts` owns the pure frame/slot/name/time helpers. The real audio engine
  and visual bottom-bar/top-bar integration remain the next Radio PTT tasks.

Additional Radio PTT audio update on 2026-06-24:

- `src/radio/mulaw.ts` and `src/radio/resample.ts` now own deterministic audio codec/resampling
  helpers with focused tests.
- `src/radio/radioAudioEngine.ts` captures microphone audio through `AudioWorklet`, requests mono
  audio with echo cancellation/noise suppression/auto gain control, downsamples to 16 kHz, builds
  20 ms μ-law `RPT1` frames, and exposes throttled capture levels for future waveform UI.
- `src/radio/radioPlaybackEngine.ts` decodes incoming μ-law frames and plays them through an
  `AudioWorklet` playback queue with an initial 60 ms jitter buffer.
- `RadioProvider` now starts capture only after backend `ptt:grant` or `echo:grant`, stops capture
  on release/error/disconnect, forwards received binary frames to playback, and releases the radio
  lock if microphone permission or AudioWorklet setup fails.
- Bottom-bar PTT controls, incoming pill, and the Radio page are still pending in the
  next Radio PTT tasks.

Additional Radio PTT bottom-bar update on 2026-06-24:

- `src/pages/home/components/BottomBar.tsx` now supports press-and-hold PTT while preserving the
  existing tap and horizontal drag tab navigation.
- The PTT gesture uses the required timings: 200 ms pre-start glow, 700 ms local chirp, and
  1700 ms `startPtt` request. Release before the final threshold cancels the radio path and does
  not request microphone capture.
- `src/radio/radioUi.ts` owns the deterministic 1/2/3 active-channel zone resolution and channel
  color fallback used by the bottom bar.
- During transmission the bottom bar shows waveform levels from `RadioProvider.audioLevels`, an
  elapsed `mm:ss` timer, and `RILASCIA PER TERMINARE`; busy/error states show operator-readable
  text and keep the feedback localized to the selected channel zone.
- Incoming pill, Radio page, and settings UI remain in the following Radio PTT tasks. The avatar
  ring remains system/backend connection UI, not Radio PTT UI.

Additional Radio PTT top-bar update on 2026-06-24:

- `SystemRow` no longer renders the separate backend status LED next to the battery. The center of
  the system row is now reserved for the radio incoming pill, while the battery remains anchored on
  the right.
- `RadioIncomingPill` displays the receiving channel and caller name in the `Nome C.` format, uses
  the channel color, and keeps the requested fixed-height expand/collapse animation from/to the
  center.
- `TopbarRight` keeps the avatar ring reserved for backend connection status: server connected,
  reconnecting, or offline. This replaces the previous separate status LED without coupling the
  avatar to Radio PTT state.
- `src/radio/radioUi.ts` owns only Radio PTT visual helpers for channel colors and bottom-bar
  zones. Backend connection ring mapping lives under app runtime system status helpers.
- Radio page and settings UI remain in the following Radio PTT tasks.

Additional Radio PTT page update on 2026-06-24:

- `/radio` is now a protected lazy route under the existing `RadioProvider`.
- The avatar menu now includes a `Radio` entry. Home closes the menu and navigates to `/radio`,
  matching the existing Profile/Settings/Payments route pattern.
- `src/pages/RadioPage.tsx` owns the mobile Radio page shell. It reuses the secondary-page
  `settings-page/settings-shell/settings-card` layout, exposes the three per-device slot selects,
  saves each change through `radio.saveSlots`, and shows radio/microphone status without adding
  endpoints to UI components.
- Slot PTT buttons and the central Echo Test use the provider methods
  `startPtt(..., "radio-page")`, `stopPtt`, `startEchoTest`, and `stopEchoTest`. Gesture timings and
  the local chirp are shared through `src/radio/radioGesture.ts`, so the Radio page and bottom bar
  stay aligned on the 200 ms / 700 ms / 1700 ms flow.
- Focused tests cover the avatar `Radio` menu item, slot save behavior, and disabled PTT/Echo
  controls when the radio is not ready.
- Settings UI for global radio channel administration remains in the following Radio PTT task.

Additional Radio PTT settings update on 2026-06-24:

- Global Radio channel administration now lives in `/impostazioni` through
  `settings-frontend/dist/assets/settings-app.js`, which is the effective settings UI in this
  package because no separate settings source tree is present.
- The settings UI adds a native `Radio` section with add/remove/reorder, enabled, name, id, and
  color controls. It reads from `POST /api/settings/radio` and saves atomically through
  `POST /api/settings/radio/save`.
- Radio channel inputs intentionally avoid the generic `data-path` autosave pipeline. Validation
  runs before save so partially typed channel ids/names/colors are not persisted by background
  autosave while the operator is still editing.
- The mobile `/radio` page and bottom bar continue to consume the saved channel list through the
  existing mobile Radio config endpoint.

Additional Radio PTT hardening update on 2026-06-24:

- `backend/modules/radio/radio-hub.js` now exposes the pure
  `isRadioSocketBackpressured` helper and uses it before forwarding binary audio frames, keeping
  WebSocket backpressure behavior testable without opening real sockets.
- Radio hub regression coverage now verifies that PTT requests on disabled channels are rejected and
  that sockets over the configured buffered-byte threshold are treated as backpressured.
- `src/radio/radioAudioEngine.ts` and `src/radio/radioPlaybackEngine.ts` now fall back to
  `webkitAudioContext` when the standard `AudioContext` constructor is not available, covering
  Safari/iOS-style browser runtimes.
- Focused mobile regression tests cover the AudioContext compatibility fallback and confirm that a
  bottom-bar press released before the 1700 ms PTT activation threshold never starts or stops a
  transmission.
- Manual Radio QA still needs real device/browser coverage for microphone permission prompts,
  HTTPS/proxy deployment, live two-device PTT, busy-channel flashes, parallel channels, Echo Test,
  incoming pill animations, avatar backend-connection ring state changes, and cleanup on tab close
  or network loss.

Additional Radio main-channel PTT update on 2026-06-26:

- The first configured radio slot (`slots[0]`) is now treated as the main channel on mobile.
  `src/radio/radioPriority.ts` owns the pure priority rules: resolve the primary channel, identify
  primary streams, and choose the next audible stream.
- `RadioProvider` now keeps an internal incoming-stream map and one active incoming stream id. Only
  frames from the active stream reach `radioPlaybackEngine`, so simultaneous incoming radio streams
  cannot overlap locally.
- Incoming audio on the main channel preempts any currently audible secondary stream. While the
  main channel is active, secondary streams remain ignored by playback and do not change the
  incoming pill; when the main channel ends, the provider can resume the most recent still-active
  secondary stream.
- `src/radio/useNativePrimaryPtt.ts` listens for the Android WebView
  `amalia:native-radio-ptt` event. Volume+ long press starts PTT on `slots[0]` with source
  `volume-primary`; release/cancel stops only that hardware-started PTT and leaves bottom-bar or
  Radio-page PTT untouched.
- The Radio page labels slot 1 as `Canale 1 · principale`. The Android WebView wrapper in the
  sibling `android-webview-app-source` now maps long press Volume+ to the same native event, while
  short Volume+ presses still raise media volume once.

Additional avatar connection ring correction on 2026-06-24:

- The avatar ring is not Radio PTT state. It now represents the former backend/network status LED:
  `Server connesso`, `Server in riconnessione`, or `Server offline`.
- `SystemConnectionStatusProvider` owns backend connection state under app runtime. It probes
  `/api/health`, listens to browser online/offline events, and accepts transport health/failure
  signals from the notification stream.
- `TopbarRight` reads only `useSystemConnectionStatus` for the avatar ring. Radio PTT state remains
  visible through the bottom bar zones, incoming pill, Echo/PTT controls, and Radio page status.
- `src/radio/radioUi.ts` no longer owns avatar ring helpers; it is limited to Radio channel colors
  and bottom-bar zone resolution.

Additional HTTPS LAN update on 2026-06-24:

- `vite.config.ts` now binds Vite LAN HTTPS mode to `0.0.0.0:5280` with `strictPort: true`.
- The Vite dev root path `/` redirects to the configured mobile base `/mobile/`, so
  `https://192.168.0.28:5280` opens the mobile app entry instead of a blank root.
- HTTPS LAN is opt-in through `npm run dev:lan:https`, Vite mode `lanhttps`, and
  `.env.lanhttps`.
- Normal Vite development remains on the regular dev port path; the complete V3 stack owns port
  `5280` through `serve-frontends.mjs`.
- `serve-frontends.mjs` can now run HTTPS when `FRONTEND_HTTPS=true`, using the same
  `mobile-frontend/certs/192.168.0.28.pem` and key. `tools/start-cassav2-current.ps1` starts the
  complete stack that way so `/mobile/`, `/postazione/`, `/impostazioni/`, `/api`, and WebSocket
  upgrade traffic are exposed over HTTPS on the LAN.
- `npm run cert:lan` generates the mkcert certificate/key for `192.168.0.28`, `localhost`,
  and `127.0.0.1`; certificates and CA material are ignored by `.gitignore`.
- `public/mic-test.html` provides the static microphone permission check expected at
  `https://192.168.0.28:5280/mic-test.html`.

Additional mobile Bancone update on 2026-06-26:

- Tavoli now has an authorized Bancone mode toggled by long-pressing the top-bar `TAVOLI` title.
  Admin users and users with `counter_mode` can switch between the normal table layout and `BANCONE`.
- The Bancone mode reuses `TableOrderComposer`, `AdminPaymentAdjustmentDialog`, and
  `TablePaymentWizard` with a virtual `counter:banco` table. It does not create, occupy, free, or
  poll a real table while active.
- The bottom tab label/icon changes to `BANCONE` with the `bancone.png` asset when the mode is
  active. Dashboard quick filters force the workspace back to normal Tavoli so those filters remain
  one-shot table filters.
- Counter order lines now preserve product VAT metadata (`vatRate`/`vatCode`) from the menu
  catalog. Bancone blocks collection when a product has no VAT rate instead of printing with a
  hardcoded fallback.
- Counter collection uses the dedicated backend endpoint
  `POST /api/tables/counter/orders/collect`, owned by the new backend `counter` module. The handler
  records payment containers, parts, transactions, legacy payment rows, audit events, and non-fiscal
  receipt VAT details with idempotency on `clientPaymentId`.

Additional settlement ledger phase 1 update on 2026-06-29:

- `src/pages/payments/settlementLedger.ts` now owns the pure mobile settlement ledger rules for
  converting analytics payment movements into cash/POS/other gross, refunds, and net totals.
- The ledger treats `payment` movements as positive entries, POS recharge payments as positive
  `pos_recharge` entries, and `storno` movements as negative entries split by
  `refundPlan.allocations` when available.
- `tests/paymentSettlementLedger.test.ts` covers simple cash, cash refund, same-turn POS
  void+recharge, next-turn POS void+recharge, and mixed cash/POS refund allocation.
- `PaymentSettlementSection.tsx` is intentionally not wired to the ledger yet; that remains the
  next roadmap phase so the domain helper is testable before changing UI, print, or automatic cash
  behavior.

Additional settlement ledger phase 2 update on 2026-06-29:

- `PaymentSettlementSection.tsx` now uses `buildSettlementLedgerEntries` and
  `summarizeSettlementLedger` for analytics-backed scarico cassa snapshots.
- `cashTotal`, `posTotal`, `otherTotal`, `totalAmount`, and `amountToDeposit` are net values when
  analytics movements are available. POS void plus recharge and cash refunds are included in the
  same shift totals instead of being dropped by the previous positive-payment-only filter.
- Settlement summaries, automatic settlement records, close-session payloads, the completion event,
  UI summary cards, the confirmation/report modal, and print text now carry/display gross,
  refunds/storni, and net totals. Old/local fallback summaries stay readable through compatibility
  display defaults.

Additional settlement automatic-cash phase 3 update on 2026-06-29:

- The automatic cash expected-deposit formula remains unchanged: it receives
  `snapshot.cashTotal`, which is now the net cash value after phase 2.
- `tests/automaticCashSettlementArchive.test.ts` now covers the required case
  `cash gross 30 - cash refund 8 + automatic float 100 = expected deposit 122`, proving the cassa
  automatica path uses net cash rather than gross cash.

Additional settlement launch update on 2026-06-29:

- Mobile scarico cassa now defaults to automatic settlement even when the cash float was loaded
  manually. The launch button starts automatic settlement on tap.
- Long-pressing the scarico launch button switches that button to manual mode with the shared
  haptic feedback; the next tap opens the manual settlement flow and resets the button back to the
  automatic default.
- Persisted settlement summaries now store `automaticSettlement` so UI/report behavior follows the
  actual settlement flow rather than inferring it from `cashMode`.
- Automatic settlement completion resolves `amountToDeposit` from the cassa automatica expected
  total, so manual cash floats are still included in the close-session payload and completion event
  when the operator uses automatic scarico.

Additional settlement print phase 6 update on 2026-06-29:

- Settlement ledger summaries now expose `posRechargeTotal` separately from POS gross totals.
  POS recharges created after a full void remain positive ledger entries for the net balance, but
  the operator printout and UI show them on the dedicated `RIADDEBITI POS` line.
- Mobile scarico snapshots, persisted summaries, close-session payloads, automatic settlement
  records, and completion events carry the new `posRechargeTotal` field with backward-compatible
  zero defaults for older summaries.
- Backend sales/handheld settlement totals use the same POS gross/recharge split, and the handheld
  report print includes `POS lordo`, `Void/Storni POS`, `Riaddebiti POS`, and `POS netto`.

Additional CASSAv4 4.0.1 native cash-exchange update on 2026-06-29:

- The automatic-cash backend cash-exchange workflow now produces native change states
  `CHANGE_STARTED`, `CHANGE_REQUESTED`, and `WAITING_CHANGE_REMOVAL` while keeping legacy
  `WITHDRAWAL_STARTED` / `WAITING_CASH_REMOVAL` readable only for recovery of old records.
- `automatic-cash.gateway.js` now exposes dedicated native SNG change primitives:
  `startCashinChange`, `getCashinDeposit`, `getReturnChange`, `executeNativeChange`,
  `getChangeRemoved`, and `cancelCashinChange`. The cash-exchange handler no longer calls
  `replenishment/start`, `replenishment/close`, `withdrawal/execute`, or `PRELEVA_REALE` for new
  change operations.
- Cash-exchange state payloads now include `availableDenominations`, and the mobile change selector
  shows per-denomination `Erogabili` badges while preventing increments above the backend-reported
  available pieces.
- `tools/fake-automatic-cash-gateway.mjs` implements the same native change endpoints so local
  device testing can run without endpoint-not-found errors.

Additional commercial benefits v6 update on 2026-06-29:

- `src/api/commercialBenefits.ts` is the mobile API owner for commercial benefits. Components must
  use `validateCommercialBenefit`, `releaseCommercialBenefit`, and
  `createCommercialBenefitCampaign` instead of raw `/api/commercial-benefits/*` calls.
- `TableCommercialBenefitApplication` is now a table-domain payload type, and
  `buildBackendFreeSplitPaymentPayload` forwards `commercialBenefitApplications` to
  `POST /api/payments/free-split`.
- `TablePaymentWizard` has a first operator-facing `Buono/Sconto` button in the payment details
  summary row. The initial UI path supports manual code validation/reservation, shows the applied
  reduction, forwards the application on receipt/invoice confirmation, and releases the reservation
  if the operator removes it before payment.
- Backend free-split payment now treats commercial benefits as separate pre-payment reductions:
  payment containers keep `commercialBenefitApplicationIds` and `commercialBenefitAmount`, while
  order settlement credits `paid amount + commercial benefit amount` without turning benefits into
  a payment method.
- The backend `commercial-benefits` module owns campaign creation, validation/reservation,
  release, redemption, and residual policy rules for `value_voucher`.

Additional realtime push-first update on 2026-07-07:

- `src/shared/realtime/realtimeEventEnvelope.ts` now owns the mobile contract helpers for
  CASSAv4 realtime envelopes: `eventId` dedupe, aggregate version checks, and legacy-compatible
  payload normalization.
- `useNotificationTransportSync` keeps the existing notification stream owner but now stores the
  last applied SSE/outbox `eventId`, passes it back as `lastEventId` on reconnect, ignores duplicate
  events, and handles `event: recovery` by falling back to a scoped notification snapshot.
- Push-first mode is feature-gated through runtime config. The current `public/config.json` enables
  `features.clientPushFirst` and `features.wideInvalidateDisabled`; rollback is to set both to
  `false` and re-enable backend `SSE_LEGACY_REFRESH=1`.
- No new `window.fetch` or `window.EventSource` patches were added. EventSource remains owned by
  the existing React hook.

Additional frontend optimistic actions update on 2026-07-07:

- `src/shared/optimistic/clientOptimisticActions.ts` owns the mobile helper for
  `features.clientOptimisticActions` / `CLIENT_OPTIMISTIC_ACTIONS`. It only reads runtime flags
  and launches background requests; domain state remains owned by the existing hooks/components.
- Notification acknowledgement now returns a boolean from `src/api/notifications.ts`. Existing
  fire-and-forget callers still work, while `useNotificationCenter` can restore a call or unread
  notification if the backend rejects the optimistic ack.
- `TableDetailPanel` closes the preconto menu and shows print feedback immediately when optimistic
  actions are enabled; print failures are reported through the existing toast.
- `TablesWorkspace` no longer waits for the post-reso current preconto print when optimistic
  actions are enabled; it only shows a notice if the print request fails.
- `PaymentSettlementSection` keeps settlement completion synchronous. Only non-critical reprint
  actions use the optimistic background request path.
- Rollback is to set `features.clientOptimisticActions=false` in `public/config.json` and
  `CLIENT_OPTIMISTIC_ACTIONS=0` in the runtime profile.

Additional frontend optimistic tables update on 2026-07-07:

- `src/pages/home/tables/workspaceRuntime.ts` owns pure optimistic table patch helpers for
  `occupa` and `libera`; they patch React Query snapshots only and do not call backend APIs.
- `TablesWorkspace` now applies those patches immediately when `features.clientOptimisticActions`
  is enabled, while the actual request still runs through `withRequiredTableLocks` and
  `src/api/tables.ts`.
- If the backend or lock layer rejects the operation, the previous table snapshot and selected
  detail state are restored and the existing action error surface is used.
- At this point Step 8B covered only occupy/free; table move is covered by the following Step 8C
  note.

Additional frontend optimistic table move update on 2026-07-07:

- `workspaceRuntime.ts` now also owns pure move helpers for same-room and cross-room optimistic
  patches: `buildOptimisticTableMove`, `applyOptimisticMoveTablesToSnapshot`, and
  `applyOptimisticMoveTablesBetweenSnapshots`.
- Same-room table move immediately patches source/target tables and the next table-group snapshot
  while backend locks and `moveDiningTable` run in the background.
- Cross-room table move remains conservative until the backend room-move request is approved; after
  approval it patches source and target room snapshots while the backend move runs.
- Rollback restores source room snapshot, target room snapshot, selected table, active dialog, and
  room-move preview state.
- The operator/postazione room change itself is not optimistic before approval, because room
  visibility is permission-owned by the backend.

Additional frontend optimistic pending order update on 2026-07-07:

- `workspaceRuntime.ts` now owns `applyOptimisticOrderPendingToSnapshot`, a pure React Query
  snapshot patch that inserts a temporary `waiting` / `in_progress` order for the selected seated
  table.
- `TablesWorkspace` applies that patch only when `features.clientOptimisticActions` /
  `CLIENT_OPTIMISTIC_ACTIONS` is enabled. The real submit still runs through
  `ORDER_CREATE_LOCK_PURPOSE` and `addDiningTableOrder`.
- The optimistic patch increments `ordersTaken` and `ordersInProgress` but does not change
  `amountDue`, matching the backend rule that a comanda becomes payable only after the served path.
- Success replaces the temporary row with the backend table; failure restores the previous snapshot
  and selected table state.

Additional table capacity alignment on 2026-07-14:

- `src/domain/tables/capacity.ts` is the mobile source of truth for the single-table capacity:
  minimum 1 person and maximum 100 people; a free table may still carry zero covers.
- Table detail, reservation editing, optimistic updates, integration parsers, and payment split
  initialization consume the same rule. Joined-table aggregates remain sums of their leaf tables.
- The backend independently enforces the same invariant at its trust boundary; the input `max`
  remains an operator aid and is not the only protection.

Additional local native battery update on 2026-07-14:

- The mobile battery provider no longer requests `/api/mobile/battery`, opens battery SSE, or
  runs polling/retry timers.
- Android wrappers provide the current device-local snapshot through the read-only
  `window.AmaliaNativeBattery` interface and push changes with `amalia:native-battery`.
- Standard browsers use the local Battery Status API when available. No server fallback is used.

Additional waiter-call and order-ready latency update on 2026-07-14:

- Live runtime metrics identified the backend mutation queue as the delay owner, not the mobile
  renderer or SSE transport. Notification ACK writes were serializing the full integration state
  and could keep new waiter calls and order-ready transitions waiting for several seconds.
- `backend/modules/notifications/notification-persistence-writer.js` now owns punctual MySQL
  persistence for notification publish, pull, and ACK. Publish updates only the new notification
  plus `sequence`/`lastWriteAt`; pull updates only notifications whose delivery/escalation changed
  and the touched session; ACK atomically replaces the notification collection together with the
  affected bell claim and order row, then updates only the touched session.
- `backend/db/app-state/mysql-domains-split.repository.js` supports atomic replacement of selected
  object-array fields inside the existing bulk transaction. This preserves notification deletion
  and one-shot pickup semantics without reintroducing JSON or the relational SQLite runtime.
- The notification mutation lane now accepts explicit task priority. New publish requests use the
  existing backend priority `4`, while ACK requests use `7`, so a fresh call can pass queued ACKs
  while FIFO remains unchanged within the same priority.
- `postazione/src/App.jsx` no longer publishes a second `bell` after `orders/sync`. The backend order
  transition remains the single owner of `order_ready`, avoiding duplicate notifications and an
  extra notification-lane write.
- The production launcher enables `BACKEND_NOTIFICATION_PUNCTUAL_WRITER=1`. Rollback is to set the
  flag to `0` and restart; the writer then uses the previous split full-state persistence path.
- No mobile transport owner changed: `useNotificationTransportSync` remains the only EventSource
  owner. Live canary results after restart were 10 ms SSE / 16 ms publish HTTP without backlog and
  13 ms SSE / 18 ms publish HTTP with 12 ACKs already queued. The full publish -> SSE -> pull
  visible contract fell from about 1.44 s to 32 ms; no punctual-writer fallback was recorded.

Additional service-recovery consistency update on 2026-07-15:

- Integration order parsing now preserves the backend `currentRevision` through the table read
  model. Correction, cancellation, and unpaid-return requests therefore send the latest known
  revision instead of falling back to revision `1` after the first successful edit.
- The revision participates in the integration-order fingerprint, so a revision-only backend
  update refreshes the React Query snapshot used by the next recovery operation.
- Service-recovery validation errors are rendered as a nested `alertdialog`; in particular,
  `Inserisci il motivo del reso.` is no longer inserted as an inline card inside the operation
  form.

Additional service-recovery correction-list update on 2026-07-15:

- Correction article rows are direct children of
  `msr-correction-list table-order-cart table-order-cart-drawer`; the unused swipe-row wrapper was
  removed from this modal.
- Each article keeps the existing explicit expand/collapse control. Compact rows no longer render
  variant/modifier/note chips; an article with those details shows a single `*` after its name and
  exposes the editable fields only when expanded.

Additional service-recovery replacement-list update on 2026-07-15:

- Return article rows remain direct children of
  `msr-replacement-cart table-order-cart table-order-cart-drawer`. Compact rows show only the
  article name, optional detail `*`, selection, quantity controls, and a price badge anchored to
  the lower-right corner.
- A 560 ms long press on an article with metadata opens its variant, additions, and note inside the
  same row. The gesture uses the shared native haptic bridge and consumes the following click so it
  cannot accidentally alter the return selection.
- Return reason validation now mirrors the API invariant before any write: fewer than three trimmed
  characters marks the textarea red and opens an `alertdialog`. `OK` closes only the alert and keeps
  the invalid field visible; nested recovery dialogs stop click propagation to the parent backdrop.
- Correction headers now include order, table, and room. Correction footers expose only the submit
  action because the top-right close control already owns cancellation.
- Cancellation confirmation actions are labeled `ANNULLA` and `CONFERMA` and use equal dimensions.

Additional payment-action color update on 2026-07-15:

- The `Azioni pagamento` modal uses explicit semantic classes and distinct colors: dark orange for
  payment adjustment, blue for the complete pre-bill, and petrol teal for the current pre-bill.
- The semantic selectors match the specificity of the generic light-theme button rule, preserving
  white text and icon contrast in both light and dark modes.
- `tests/static/paymentActionButtonsVisual.test.ts` protects class wiring, palette, and the
  high-specificity white-text rule.

Additional table-payment layout update on 2026-07-15:

- `TableDetailPanel` now renders inside `card-body tables-card-body`, so table-detail and payment
  backdrops inherit the same containing block, width, height, and clipping as the workspace body.
- On the payment details step, the selected payment method back control is part of
  `table-payment-head` and contains only the imported back icon plus the selected method label.
  The centered title uses the concise `Tavolo - Sala` form (for example, `Tavolo 1 - Gazebo`).
- The shared slide-to control now has stable dimensions, a rounded-square handle, clearer movement
  affordance, focus/drag/disabled states, reduced-motion handling, and semantic colors for payment,
  table release, and cash-float confirmation in both themes.
- Focused component/static tests pass in both source trees. The main frontend TypeScript/Vite build
  passes. Playwright at 430 x 932 confirmed that card body and payment backdrop both measure
  408 x 732 and captured light/dark visual evidence under `verification/`.

Additional cancelled-order table-state update on 2026-07-17:

- The integration workflow contract now preserves backend `cancelled` orders instead of degrading
  them to `waiting`; the parser also accepts the backend aliases `annullata` and `voided`.
- `src/domain/tables/integrationOrderTransforms.ts` owns terminal/open workflow predicates.
  Cancelled orders remain visible in table history but are excluded from active-order counts,
  payable totals, and occupancy promotion.
- Table history labels cancelled orders as `Annullata`, and service-recovery actions are not
  offered for them. Regression tests cover the real case where cancellation previously left a
  seated table stuck with one order in progress.

Additional Palmare fiscal reconciliation update on 2026-07-17:

- The avatar counter, `Azioni` menu entry, and manual offline-action dialog were removed. The
  bottom banner initially owned only real offline state and automatically replayable queue depth.
- Fiscal issue and void are the only critical operations persisted for automatic replay. The
  backend verifies the durable idempotency key against the authoritative fiscal gateway before
  every retry, so the mobile client never decides whether a second fiscal write is safe.
- Other money, hardware, print, radio, and waiter-pause commands are not persisted while offline.
  They fail explicitly instead of creating a hidden manual queue.
- Startup migration converts legacy held fiscal issue/void entries to automatic reconciliation.
  Other legacy held/failed/conflict entries are removed without executing them.
- The gateway contract is documented in
  `CASSAV4_V4.6_CURRENT/FISCAL_GATEWAY_VERIFY_API_CODEX.md`; the default gateway path is
  `POST /api/fiscal/receipt/verify`.

Additional invisible automatic queue update on 2026-07-17:

- `OfflineStatusBanner` and its stylesheet were removed from the Palmare source. Operators no
  longer see queue depth, `IN CODA`, or a manual `RIPROVA` control.
- `installOfflineRuntime` remains mounted once by `AppRuntime`. Automatic replay still runs after
  startup migration, browser online events, realtime reconnection, foreground return, and the
  15-second fallback interval.
- Queue persistence, idempotency, retry backoff, and authoritative fiscal reconciliation are
  unchanged; only the operator-facing representation was removed.

Additional payment-detail fiscal action separation on 2026-07-17:

- The 2000 ms print hold now has one transition only: `STAMPA` becomes persistent
  `STAMPA AVANZATA`. Releasing that hold does not submit a print and a further hold cannot enter a
  fiscal state.
- Fiscal issue/void is a separate admin-only action. Failed or missing fiscal outcomes expose
  `EMETTI FISCALE`; an issued document exposes `ANNULLA DOCUMENTO` and uses the existing confirmation
  dialog.
- A voided receipt preserves the original fiscal reference and exposes separate void provider,
  movement, date, and document-number fields. Advanced print details list both documents.
- The backend reprint path keys claims/idempotency by receipt versus void document. After a void,
  normal print targets only the cancellation document; missing legacy cancellation references fail
  explicitly instead of falling back to the original receipt.

Additional best-seller ordering update on 2026-07-20:

- Best-seller mode no longer filters the order catalogue. It promotes at most seven ranked
  products and leaves every other filtered product visible in stable relative order.
- The custom `Varie` row remains pinned before the promoted products in both `Nuova Comanda` and
  `Ordine Banco`.
- Focused unit, component, and static tests protect the seven-product limit, the retained catalogue,
  and the `Varie, best-seller, other products` DOM order.
- The packaged frontend build and typecheck pass. The complete frontend suite still has 11
  unrelated pre-existing failures; all focused best-seller tests pass.
- Palmare Advanced `1.0.26` (`versionCode 27`) was rebuilt with the B5.5 lab flags, passed Android
  unit tests and lint, and was installed in place on the first physical Palmare. The distributable is
  `artifacts/Palmare-Advanced-v1.0.26-V5BT-Bluetooth-B5.5-Lab-debug.apk` with SHA-256
  `1833c368d4cced655d7942cb6c2bf583cab8ab57d12532f7896d4cd2df8e36f6`.

Additional login system-row alignment on 2026-07-21:

- The unauthenticated login now reuses the same `home-page > home-shell > SystemRow` structure as
  the authenticated app. Time and local battery are therefore pinned to the same top position and
  are no longer rendered inside the access card; the radio activity pill is disabled on login.
- The authentication content owns an internal vertical scroll area for short landscape viewports
  while preserving the centered portrait layout and preventing horizontal overflow.
- The shared system time is rendered as an accessible `time` element. Focused component tests and
  Playwright checks at 320 x 568, 360 x 640, 430 x 932, and 640 x 360 protect hierarchy, spacing,
  reachability, and viewport containment.
- Palmare Advanced `1.0.27` (`versionCode 28`) embeds the verified login bundle, passed all 149
  Android unit tests plus lint, and was installed in place on the first physical Palmare. The APK is
  `artifacts/Palmare-Advanced-v1.0.27-V5BT-Bluetooth-B5.5-Lab-debug.apk` with SHA-256
  `510447df1a593179b937d36bf3ccd8255c871bd782247bca9ecf514e33782dc7`.
- The same APK was installed on the second physical Palmare after replacing its incompatible
  old-signer `1.0.24` package. The login layout and Android background battery consent were verified
  on the physical device; V4 packages were left untouched.

Additional Bluetooth mutual-auth handoff on 2026-07-21:

- B5.6 mutual authentication passed in two separate physical Palmare-to-Raspberry runs. Each run
  completed exactly one HELLO, client proof, server proof, and finish; reached `AUTHENTICATED` once;
  reported zero failures; and returned the authenticated-session count to zero during cleanup.
- The final Palmare Advanced APK is `1.0.27` (`versionCode 28`) and the final Postazione Advanced
  APK is `2.0.19` (`versionCode 21`). Both enable the B5.6 mutual-auth client while keeping
  enrollment, Direct Server, Peer Link, session key, heartbeat, and business traffic disabled.
- The tablet did not participate in this gate. The Postazione APK was built, but no physical tablet
  installation or certification is asserted by this handoff.
- The two server reports are the redacted
  `reports/physical/v5bt-b5-6-phone-a-20260721.json` and
  `reports/physical/v5bt-b5-6-phone-b-20260721.json` files in the Bluetooth roadmap package. They
  contain no stable device identifiers, Bluetooth addresses, credentials, cryptographic material,
  or payloads.
- The temporary enrollment endpoint is off and its service is inactive and disabled. B5.7 session
  key derivation and binding is the next increment; heartbeat, `ACTIVE`, business traffic, and the
  100-session B5 gate remain pending.

Additional authenticated-session logout hardening on 2026-07-21:

- Logout now revokes local authentication synchronously before best-effort backend cleanup and
  publishes one session-ending lifecycle event. Query caches, SSE/poll transports, notification
  audio, vibration, radio capture/playback, and late asynchronous results are all gated by it.
- The Android notification bridge mirrors the authenticated web session. Clearing that session
  cancels native notifications and audio and stops both the always-on and Bluetooth failover
  foreground runtimes, so a logged-out device cannot receive or play delayed work.
- Notification targeting accepts explicit user/room audiences and the backend can hand an
  unacknowledged ready order to online waiters in the same room before falling back to other rooms.
- The focused web regression set passes 51/51 tests in both source trees. Palmare Advanced
  `1.0.28` (`versionCode 29`) embeds the rebuilt frontend and passes all 160 Android unit tests. The
  APK is `artifacts/Palmare-Advanced-v1.0.28-V5BT-Logout-Handoff-debug.apk` with SHA-256
  `7a705ff7cdca9b86a7f14dfb1dfb12f9c18ef1bb79f6bb28d47194d890028a07`.

Additional Palmare logout teardown race hardening on 2026-07-21:

- `AlwaysOnService` now refuses unauthenticated creation and restart, returns
  `START_NOT_STICKY` when its session disappears, and safely tears down a partially initialized
  service. A stale Android restart can therefore no longer recreate its foreground runtime after
  logout.
- Native notification delivery, delivered-notification cleanup, and notification vibration share
  one lifecycle lock. Logout cleanup cannot race behind an in-flight callback, and unauthenticated
  cleanup bypasses the normal 500 ms clear deduplication window.
- Six focused logout/notification suites pass 23/23 tests, TypeScript typecheck passes, and the
  production Vite bundle was rebuilt. The complete frontend suite still reports unrelated existing
  static/application expectation failures. Android Gradle gates were intentionally not executed in
  this source-only audit.

Additional offline operational-configuration snapshot on 2026-07-24:

- Palmare Advanced now keeps a versioned IndexedDB snapshot strictly namespaced by authenticated
  `userId + activityId`. Rooms, the integration layout, per-room menu catalogues, and reservation
  day slices are refreshed continuously while online and are used by the existing domain APIs when
  the backend is unavailable.
- The root runtime performs one integration-layout read per refresh, bounded menu/reservation
  prefetches, and targeted TanStack invalidation. It never hydrates a tables query with the partial
  layout, so live orders and table groups remain owned by `fetchTablesForSession`.
- A table removed centrally remains as an offline tombstone only while operationally active and is
  discarded after release. A cancelled or missing reservation linked to an active table creates a
  persistent blinking conflict with explicit `Mantieni` and `Sposta` choices; `Sposta` is recorded
  only after the existing table-transfer operation succeeds.
- Pure reconciliation coverage protects namespace isolation, date windows, active-table tombstones,
  persistent cancellation conflicts, operator decisions, and cleanup after release. The focused
  TypeScript and Vitest gates are recorded with this handoff; Android/ADB/server deployment is out
  of scope for this source tranche.

Additional session-bound notification hardening on 2026-08-05:

- Login now consumes the authoritative backend `sessionStartedAt`, persists that exact epoch and
  mirrors it to the Android session bridge. Local time is used only for mock or legacy login
  responses that do not expose the field; an explicitly invalid server value is rejected.
- Notification snapshots are filtered against the current session epoch before reconciliation,
  deduplication, UI, audio or vibration. Logout, rapid login switches and same-identity epoch
  rollover invalidate in-flight poll/stream work and reset session-scoped deduplication.
- Native polling, queued commands, delayed render/audio signals, intent delivery, FCM and the JS
  bridge all fail closed across session changes. FCM and JS ingress require an exact device,
  session and user audience; FCM must be data-only.
- Both frontend copies are byte-identical for the changed source and focused tests. Each copy
  passes 17/17 focused Vitest cases and TypeScript typecheck; the Palmare production bundle builds
  successfully. Android passes 27/27 focused unit cases, including 4/4 battery-policy checks for
  the 120-second heartbeat. No ADB, hardware access, installation or deployment was performed.
