# Bridge Retirement Plan

Legacy bridges are transitional debt. Each bridge must either move into a React feature/domain module or be removed after its behavior is covered by modern code.

| Runtime                                   | File                                                                               | Responsibility                                     | Legacy Patterns                                                                       | Risk                                                                                | Replacement Target                                                         | Status    | Priority |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------- | -------- |
| `installFrontendHotFetchCache`            | removed; was `src/mobile/installFrontendHotFetchCache.ts`                          | Global hot cache for selected API reads            | `window.fetch` patch, POST caching, global invalidation event                         | Can cache session/report/reservation calls with side effects or heartbeat semantics | `src/shared/api/apiClient.ts`; domain TanStack Query next                  | `removed` | done     |
| `installMobileBackendConnectionBridge`    | removed; was `src/mobile/installMobileBackendConnectionBridge.ts`                  | Rewrites/retries API and SSE origins               | `window.fetch` patch, `EventSource` patch, origin guessing                            | Can hide config errors and route traffic to unexpected hosts                        | Runtime config plus `src/shared/api/apiClient.ts`                          | `removed` | done     |
| `installMobileInteractionGuards`          | absorbed; now `src/app/runtime/documentInteractionGuards.ts` (+ `useGlobalDocumentGuards`) | Mobile interaction guards and press feedback       | document listeners, DOM selectors                                                     | Can conflict with React event ownership                                             | `src/app/runtime/useGlobalDocumentGuards` (root hook); logic unchanged     | `absorbed` | done     |
| `installMobileInactivityAutoLogout`       | removed; now `src/app/runtime/useInactivityAutoLogout.ts`                          | Inactivity logout runtime                          | timers, global listeners, storage access                                              | Session behavior can drift from auth store                                          | `useInactivityAutoLogout` hook tied to authStore with explicit timers      | `removed` | done     |
| `installMobileSettingsLiveSync`           | removed; now `src/app/runtime/useSettingsLiveSync.ts` (+ `SettingsSyncBanner`)     | Live sync for settings changes                     | polling, storage marker, custom domain events, DOM-injected banner                    | Can duplicate API cache behavior if query ownership grows unchecked                 | `useSettingsLiveSync` hook; TanStack invalidation + React banner           | `removed` | done     |
| `installMobileTextEncodingFix`            | absorbed; now `src/app/runtime/documentTextEncodingFix.ts` (+ `useGlobalDocumentGuards`) | Text normalization compatibility                   | DOM/text patch behavior                                                               | Can mask encoding bugs in data layer                                                | `src/app/runtime/useGlobalDocumentGuards` (root hook); logic unchanged     | `absorbed` | done     |
| `installMobilePaymentSessionRuntime`      | `src/utils/paymentSessionRuntime.ts` (install relocated to `usePaymentSessionRuntime`) | Payment session persistence runtime                | global lifecycle behavior, storage access                                             | Payment state can diverge from React state                                          | `usePaymentSessionRuntime` root hook; runtime module remains in utils      | `partial` | P1       |
| `installMobileTableGroupsBridge`          | removed; was `src/mobile/legacyBridges/installMobileTableGroupsBridge.ts`          | Table grouping and room movement compatibility     | mechanical legacy source, fetch patch, DOM selectors, storage access                  | High: operational table layout behavior                                             | `src/api/tableGroups.ts` plus React table-group dialog                     | `removed` | done     |
| `installMobileTableLockLifecycleBridge`   | removed; was `src/mobile/legacyBridges/installMobileTableLockLifecycleBridge.ts`   | Table/order/payment lock lifecycle                 | mechanical legacy source, fetch patch, `MutationObserver`, DOM state                  | High: lock correctness and conflict handling                                        | `src/api/tableLocks.ts` plus `src/pages/home/tables/hooks/useTableLock.ts` | `removed` | done     |
| `installMobileOrderServiceRecoveryBridge` | removed; was `src/mobile/legacyBridges/installMobileOrderServiceRecoveryBridge.ts` | Order correction, return, cancellation, comp flows | mechanical legacy source, modal DOM rendering, polling, timers, global window markers | Very high: order mutation workflows                                                 | `src/api/orderServiceRecovery.ts` plus React service recovery dialog       | `removed` | done     |

## Immediate Retirement Notes

`installMobileBackendConnectionBridge` and `installFrontendHotFetchCache` have been removed from source.
Their replacement is:

- runtime config;
- a shared API client;
- explicit retry policy;
- same-origin `/api` in `public/config.json`;
- optional dev proxy through `VITE_API_PROXY_TARGET` or `API_PROXY_TARGET`;
- no global fetch patching.

TanStack Query per domain is still the target for replacing ad hoc fetch lifecycles and cache behavior.

`installMobileTableLockLifecycleBridge` has been retired from bootstrap. Its persistent
composer/payment locks now live in React state through `useTableLock`, and table mutations use
explicit lock wrappers through `src/api/tableLocks.ts`.

`installMobileTableGroupsBridge` has also been retired from bootstrap. Group loading/saving,
logical table aggregation, same-room move entry, and merge/split dialogs now live in
`src/api/tableGroups.ts` and React tables components. Cross-room transfer approval should be
rebuilt as a dedicated React workflow instead of reintroducing the bridge.

`installMobileOrderServiceRecoveryBridge` has been retired from bootstrap and deleted. Correction,
cancel, reso, and zero-cost replacement flows now live in `src/api/orderServiceRecovery.ts` and
`src/pages/home/tables/components/TableServiceRecoveryDialog.tsx`, with table locks owned by
`src/api/tableLocks.ts`. Advanced catalogue-driven correction refinements should be added inside
the React dialog and API module, not through DOM bridge code.

## Phase B — src/mobile helpers absorbed into React

The four remaining `src/mobile` helpers were absorbed into root React hooks mounted once by
`src/app/AppRuntime.tsx` (inside the providers), and the `src/mobile` directory was deleted:

- `useGlobalDocumentGuards` mounts `installDocumentInteractionGuards` and
  `installDocumentTextEncodingFix` (moved verbatim to `src/app/runtime/`; logic unchanged because
  these are intrinsically DOM-global). Their per-install `window.__*` flags became module-level
  booleans.
- `useInactivityAutoLogout` replaces `installMobileInactivityAutoLogout`: it is tied to `authStore`
  (timer armed only while a token exists, reset on activity) with explicit timers and effect
  cleanup instead of global listeners + a storage poll; it preserves the timeout, lock release,
  backend logout, message, and reload behavior.
- `useSettingsLiveSync` replaces `installMobileSettingsLiveSync`: polling and TanStack invalidation
  are unchanged, but the DOM-injected banner and `<style>` are replaced by a React
  `SettingsSyncBanner` driven by hook state.
- `usePaymentSessionRuntime` relocates the `installMobilePaymentSessionRuntime` call into a root
  hook without rewriting the runtime logic, which still lives in `src/utils/paymentSessionRuntime.ts`.

As a result the static gate `window.__` budget was lowered from 8 to 0. The two moved DOM-global
guard modules (`src/app/runtime/documentInteractionGuards.ts`,
`src/app/runtime/documentTextEncodingFix.ts`) are tracked as transitional debt in the gate
whitelist for the `MutationObserver`/`!important` patterns they carry.

## Phase C — v1 asset bridges no longer injected

On 2026-05-31 the remaining external `legacy-mobile-assets/assets/mobile-*.js` bridge files were
retired from runtime injection. `vite.config.ts` now keeps `mobileLegacyBridgeScripts` empty and the
legacy asset copy step excludes JavaScript bridge files from `dist/assets`.

The full v1 bridge inventory and native target map lives in
`docs/mobile-frontend-v2/V1_BRIDGE_NATIVE_IMPORT.md`. CSS/image assets remain available because they
are static presentation assets, not imperative bridge code.
