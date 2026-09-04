# V1 bridge native import

Data ciclo: 2026-05-31

Obiettivo: elencare tutti i bridge JavaScript storici del mobile v1 e tracciare dove la stessa responsabilita vive ora in v2 come codice nativo React/API. Dal ciclo corrente nessun file `mobile-*.js` viene piu iniettato nel `dist/index.html` del mobile; il vecchio fallback backend e stato eliminato anche dall'archivio.

## Decisione runtime

- `vite.config.ts` mantiene `mobileLegacyBridgeScripts` vuoto.
- Il copy plugin non copia piu file `mobile-*.js` dentro `dist/assets`.
- CSS, immagini e override statici continuano a essere copiati perche fanno parte del tema mobile, non di bridge imperativi.
- I runtime globali assorbiti sono montati da `src/app/AppRuntime.tsx`, quando serve un hook radice.
- Ogni ritorno a bridge DOM deve passare da test statico e motivazione esplicita.

## Inventario completo

| Bridge v1 | Stato v2 | Target nativo |
|---|---|---|
| `mobile-backend-connection-bridge.js` | Rimosso; fallback HTTP eliminato | `src/shared/api/apiClient.ts`, `src/config/runtimeConfig.ts`, `public/config.json` |
| `mobile-battery-widget.js` | Importato nativo | `src/pages/home/components/MobileBatteryWidget.tsx`, `src/pages/home/components/SystemRow.tsx` |
| `mobile-disable-context-menu.js` | Importato nativo | `src/app/runtime/documentInteractionGuards.ts`, `src/app/runtime/useGlobalDocumentGuards.ts` |
| `mobile-giada-payment-method-filter.js` | Importato nativo, hardcode rimosso | `src/types/auth.ts`, `src/store/authStore.ts`, `src/pages/home/tables/components/TablePaymentWizard.tsx` |
| `mobile-hide-recent-badge.js` | Assorbito nativo/no-op | Il badge `recenti` non viene piu renderizzato da React; restano solo badge funzionali `Terminato` e quantita bozza |
| `mobile-home-dashboard-bridge.js` | Importato nativo | `src/pages/home/components/HomeCard.tsx`, `src/pages/home/tables/TablesWorkspace.tsx` |
| `mobile-inactivity-auto-logout.js` | Importato nativo | `src/app/runtime/useInactivityAutoLogout.ts` |
| `mobile-menu-availability-bridge.js` | Importato nativo | `src/pages/home/menu/components/MenuProductList.tsx`, `src/pages/home/menu/components/MenuProductDetail.tsx`, `src/pages/home/tables/components/TableOrderComposer.tsx` |
| `mobile-menu-scroll-restore-bridge.js` | Importato nativo | `src/pages/home/menu/MenuWorkspace.tsx` |
| `mobile-notification-poll-accelerator.js` | Importato nativo | `src/api/notifications.ts`, `src/pages/home/hooks/useNotificationCenter.ts` |
| `mobile-notification-reminder.js` | Importato nativo | `src/pages/home/hooks/useNotificationCenter.ts` |
| `mobile-order-composer-draft-badge.js` | Importato nativo | `src/pages/home/tables/components/TableOrderComposer.tsx`, `src/styles/tables.css` |
| `mobile-order-history-abbuono-bridge.js` | Importato nativo | `src/pages/home/tables/components/TableDetailPanel.tsx`, `src/pages/home/tables/components/TableServiceRecoveryDialog.tsx`, `src/api/orderServiceRecovery.ts` |
| `mobile-order-history-payment-bridge.js` | Importato nativo | `src/pages/home/tables/components/TableDetailPanel.tsx`, `src/pages/home/tables/components/TablePaymentWizard.tsx` |
| `mobile-order-history-print-buttons.js` | Importato nativo | `src/pages/home/tables/components/TableDetailPanel.tsx`, `src/api/tables.ts` |
| `mobile-order-payment-layout-fix.js` | Importato nativo | `src/pages/home/tables/components/TablePaymentWizard.tsx`, `src/styles/tables.css` |
| `mobile-order-service-recovery-bridge.js` | Importato nativo | `src/pages/home/tables/components/TableServiceRecoveryDialog.tsx`, `src/api/orderServiceRecovery.ts` |
| `mobile-order-workflow-settings-bridge.js` | Importato nativo | `src/pages/SettingsPage.tsx`, `src/api/orderWorkflowSettings.ts` |
| `mobile-payment-config-reset.js` | Importato nativo | `src/utils/paymentConfigReset.ts`, `src/store/paymentSettingsStore.ts` |
| `mobile-payment-session-persist.js` | Importato nativo | `src/utils/paymentSessionRuntime.ts`, `src/app/runtime/usePaymentSessionRuntime.ts` |
| `mobile-payments-settlement-bridge.js` | Importato nativo | `src/pages/payments/PaymentSettlementSection.tsx` |
| `mobile-product-press-feedback.js` | Importato nativo | `src/app/runtime/documentInteractionGuards.ts`, `src/styles/tables.css` |
| `mobile-reservations-header-bridge.js` | Importato nativo | `src/pages/home/reservations/ReservationsWorkspace.tsx`, `src/styles/reservations.css` |
| `mobile-room-preference-bridge.js` | Importato nativo | `src/utils/roomPreferences.ts`, `src/api/locations.ts`, `src/api/auth.ts` |
| `mobile-settings-live-sync.js` | Importato nativo | `src/app/runtime/useSettingsLiveSync.ts`, `src/app/runtime/SettingsSyncBanner.tsx` |
| `mobile-station-availability-guard.js` | Importato nativo | `src/api/stations.ts`, `src/pages/home/tables/components/TableOrderComposer.tsx` |
| `mobile-table-detail-accordion-bridge.js` | Importato nativo | `src/pages/home/tables/components/TableDetailPanel.tsx` |
| `mobile-table-groups-bridge.js` | Importato nativo | `src/api/tableGroups.ts`, `src/pages/home/tables/components/TableGroupsDialog.tsx`, `src/pages/home/tables/TablesWorkspace.tsx` |
| `mobile-table-lock-lifecycle-bridge.js` | Importato nativo | `src/api/tableLocks.ts`, `src/pages/home/tables/hooks/useTableLock.ts`, `src/main.tsx` |
| `mobile-text-encoding-fix.js` | Importato nativo | `src/app/runtime/documentTextEncodingFix.ts`, `src/app/runtime/useGlobalDocumentGuards.ts` |
| `mobile-user-menu-bridge.js` | Importato nativo | `src/pages/SettingsPage.tsx`, `src/pages/home/menu/components/MenuCategoryList.tsx`, `src/utils/menuStationBadgePreferences.ts` |

## Bridge rimasti come archivio

I file storici restanti sono conservati in `legacy-mobile-assets/assets` per confronto, ma non vengono serviti come runtime. Il bridge di connessione backend non e conservato: il client usa esclusivamente l'origine configurata, senza candidati HTTP automatici. Se una regressione richiede il vecchio comportamento, importare la logica dentro componenti/hook/API e aggiungere un test: non reinserire script DOM globali.

## Gate anti-regressione

- `tests/static/mobileLegacyBridgeAssets.test.ts` verifica che nessun `mobile-*.js` venga iniettato o copiato in build.
- `tests/static/v1BridgeNativeMigration.test.ts` verifica che l'inventario resti completo e che i principali target nativi esistano.
