import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");
const removedBackendFallbackAsset = "mobile-backend-connection-bridge.js";

const bridgeNames = [
  "mobile-battery-widget.js",
  "mobile-disable-context-menu.js",
  "mobile-giada-payment-method-filter.js",
  "mobile-hide-recent-badge.js",
  "mobile-home-dashboard-bridge.js",
  "mobile-inactivity-auto-logout.js",
  "mobile-menu-availability-bridge.js",
  "mobile-menu-scroll-restore-bridge.js",
  "mobile-notification-poll-accelerator.js",
  "mobile-notification-reminder.js",
  "mobile-order-composer-draft-badge.js",
  "mobile-order-history-abbuono-bridge.js",
  "mobile-order-history-payment-bridge.js",
  "mobile-order-history-print-buttons.js",
  "mobile-order-payment-layout-fix.js",
  "mobile-order-service-recovery-bridge.js",
  "mobile-order-workflow-settings-bridge.js",
  "mobile-payment-config-reset.js",
  "mobile-payment-session-persist.js",
  "mobile-payments-settlement-bridge.js",
  "mobile-product-press-feedback.js",
  "mobile-reservations-header-bridge.js",
  "mobile-room-preference-bridge.js",
  "mobile-settings-live-sync.js",
  "mobile-station-availability-guard.js",
  "mobile-table-detail-accordion-bridge.js",
  "mobile-table-groups-bridge.js",
  "mobile-table-lock-lifecycle-bridge.js",
  "mobile-text-encoding-fix.js",
  "mobile-user-menu-bridge.js",
];

const nativeTargets = [
  "src/shared/api/apiClient.ts",
  "src/app/AppRuntime.tsx",
  "src/app/runtime/documentInteractionGuards.ts",
  "src/app/runtime/documentTextEncodingFix.ts",
  "src/app/runtime/useInactivityAutoLogout.ts",
  "src/app/runtime/usePaymentSessionRuntime.ts",
  "src/app/runtime/useSettingsLiveSync.ts",
  "src/pages/home/components/HomeCard.tsx",
  "src/pages/home/components/MobileBatteryWidget.tsx",
  "src/pages/home/hooks/useNotificationCenter.ts",
  "src/pages/home/menu/MenuWorkspace.tsx",
  "src/pages/home/menu/components/MenuCategoryList.tsx",
  "src/pages/home/menu/components/MenuProductList.tsx",
  "src/pages/home/reservations/ReservationsWorkspace.tsx",
  "src/pages/home/tables/TablesWorkspace.tsx",
  "src/pages/home/tables/components/TableDetailPanel.tsx",
  "src/pages/home/tables/components/TableGroupsDialog.tsx",
  "src/pages/home/tables/components/TableOrderComposer.tsx",
  "src/pages/home/tables/components/TablePaymentWizard.tsx",
  "src/pages/home/tables/components/TableServiceRecoveryDialog.tsx",
  "src/pages/home/tables/hooks/useTableLock.ts",
  "src/pages/payments/PaymentSettlementSection.tsx",
  "src/pages/SettingsPage.tsx",
  "src/api/locations.ts",
  "src/api/notifications.ts",
  "src/api/orderServiceRecovery.ts",
  "src/api/orderWorkflowSettings.ts",
  "src/api/stations.ts",
  "src/api/tableGroups.ts",
  "src/api/tableLocks.ts",
  "src/store/authStore.ts",
  "src/store/paymentSettingsStore.ts",
  "src/types/auth.ts",
  "src/utils/menuStationBadgePreferences.ts",
  "src/utils/paymentConfigReset.ts",
  "src/utils/paymentSessionRuntime.ts",
  "src/utils/roomPreferences.ts",
];

describe("v1 mobile bridge native migration", () => {
  it("documenta tutti i bridge v1 e mantiene i target nativi nel sorgente", () => {
    const doc = readSource("docs/mobile-frontend-v2/V1_BRIDGE_NATIVE_IMPORT.md");

    expect(doc).toContain(removedBackendFallbackAsset);
    expect(
      existsSync(resolve(repoRoot, "legacy-mobile-assets/assets", removedBackendFallbackAsset))
    ).toBe(false);
    for (const bridgeName of bridgeNames) {
      expect(doc).toContain(bridgeName);
      expect(existsSync(resolve(repoRoot, "legacy-mobile-assets/assets", bridgeName))).toBe(true);
    }

    for (const targetPath of nativeTargets) {
      expect(existsSync(resolve(repoRoot, targetPath))).toBe(true);
      expect(doc).toContain(targetPath);
    }
  });

  it("non carica piu bridge JavaScript v1 dal file index generato da Vite", () => {
    const viteConfig = readSource("vite.config.ts");
    expect(viteConfig).toContain("const mobileLegacyBridgeScripts: string[] = []");

    for (const bridgeName of bridgeNames) {
      expect(viteConfig).not.toContain(`${bridgeName}?v=`);
    }
  });
});
