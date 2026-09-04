import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeMobileSessionEnding } from "./session/sessionLifecycle";
import { useGlobalDocumentGuards } from "./runtime/useGlobalDocumentGuards";
import { useInactivityAutoLogout } from "./runtime/useInactivityAutoLogout";
import { usePaymentSessionRuntime } from "./runtime/usePaymentSessionRuntime";
import { useSettingsLiveSync } from "./runtime/useSettingsLiveSync";
import { useThemeModeRuntime } from "./runtime/useThemeModeRuntime";
import { SettingsSyncBanner } from "./runtime/SettingsSyncBanner";
import { installOfflineRuntime } from "../shared/offline/offlineRuntime";
import { PaymentOverviewProvider } from "../pages/payments/PaymentOverviewProvider";
import { useOfflineConfigurationSync } from "./runtime/useOfflineConfigurationSync";
import { OfflineQueueStatusBanner } from "./runtime/OfflineQueueStatusBanner";

/**
 * Hosts the app-root runtime concerns that were previously installed imperatively
 * in main.tsx. Mounted once inside the providers, it owns the lifecycle of the
 * absorbed src/mobile helpers (document guards, payment session runtime, inactivity
 * auto-logout, settings live-sync) through React hooks.
 */
export function AppRuntime({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeMobileSessionEnding(() => {
        void queryClient.cancelQueries();
        queryClient.clear();
      }),
    [queryClient]
  );

  useGlobalDocumentGuards();
  useThemeModeRuntime();
  usePaymentSessionRuntime();
  useInactivityAutoLogout();
  const settingsBannerVisible = useSettingsLiveSync(queryClient);
  useOfflineConfigurationSync(queryClient);

  useEffect(() => {
    installOfflineRuntime();
  }, []);

  return (
    <PaymentOverviewProvider>
      {children}
      <SettingsSyncBanner visible={settingsBannerVisible} />
      <OfflineQueueStatusBanner />
    </PaymentOverviewProvider>
  );
}
