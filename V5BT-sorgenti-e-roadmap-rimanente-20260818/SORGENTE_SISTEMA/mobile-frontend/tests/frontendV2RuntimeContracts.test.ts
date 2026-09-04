import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath: string) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("frontend v2 runtime contracts", () => {
  it("does not fall back to hardcoded mobile room lists", () => {
    const source = readSource("src/api/locations.ts");

    expect(source).not.toMatch(/BUILTIN_FALLBACK_ROOMS|buildRoomsForRole/);
    expect(source).not.toMatch(/sala_main|sala_terrazza|sala_privata|sala_eventi|sala_bar/);
    expect(source).toMatch(/postPosEndpoint\(\s*"\/api\/pos\/rooms"/);
    expect(source).toMatch(/readCachedRooms/);
    expect(source).toMatch(/Nessuna sala disponibile: verifica la configurazione backend/);
  });

  it("reads battery state locally without backend polling", () => {
    const serviceSource = readSource("src/app/runtime/batteryStatusService.ts");
    const providerSource = readSource("src/app/runtime/BatteryStatusContext.tsx");
    const widgetSource = readSource("src/pages/home/components/MobileBatteryWidget.tsx");

    expect(serviceSource).toMatch(/buildBatteryStateSignature/);
    expect(serviceSource).toMatch(/readCachedBatteryState/);
    expect(serviceSource).toMatch(/persistCachedBatteryState/);
    expect(serviceSource).toMatch(/AmaliaNativeBattery/);
    expect(serviceSource).toMatch(/amalia:native-battery/);
    expect(serviceSource).toMatch(/getBattery/);
    expect(providerSource).toMatch(/batteryStateSignatureRef/);
    expect(providerSource).toMatch(/cachedBatteryState/);
    expect(providerSource).toMatch(/subscribeNativeBatteryState/);
    expect(providerSource).toMatch(/subscribeBrowserBatteryState/);
    expect(providerSource).toMatch(/readNativeBatteryState/);
    expect(serviceSource).not.toMatch(/\/api\/mobile\/battery|window\.fetch|EventSource/);
    expect(providerSource).not.toMatch(/setInterval|setTimeout|fetchBatteryState|subscribeBatteryState/);
    expect(widgetSource).toMatch(/useMobileBatteryStatus/);
    expect(widgetSource).not.toMatch(/window\.fetch|setInterval|API_PATH/);
  });

  it("keeps protected secondary routes warm so the top system row does not reload", () => {
    const appSource = readSource("src/App.tsx");

    expect(appSource).toMatch(/BatteryStatusProvider/);
    expect(appSource).toMatch(/preloadProtectedRouteModules/);
    expect(appSource).toMatch(/void loadSettingsPage\(\);/);
    expect(appSource).toMatch(/void loadProfilePage\(\);/);
    expect(appSource).toMatch(/void loadPaymentsPage\(\);/);
    expect(appSource).toMatch(/void loadRadioPage\(\);/);
  });

  it("shows the five main top-bar page labels in uppercase", () => {
    const homeSource = readSource("src/pages/HomePage.tsx");
    const pageTitlesBlock =
      homeSource.match(/const PAGE_TITLES: Record<BottomTabKey, string> = \{[\s\S]*?\};/)?.[0] ??
      "";

    for (const [key, label] of [
      ["home", "HOME"],
      ["menu", "MENU"],
      ["tavoli", "TAVOLI"],
      ["prenotazioni", "PRENOTAZIONI"],
      ["analytics", "STATISTICHE"],
    ]) {
      expect(homeSource).toContain(`label: "${label}"`);
      expect(pageTitlesBlock).toContain(`${key}: "${label}"`);
    }
    expect(homeSource).not.toContain('label: "Agenda"');
  });

  it("keeps the counter bottom-bar icon slightly larger than the standard tabs", () => {
    const homeSource = readSource("src/pages/HomePage.tsx");
    const glassCss = readSource("src/styles/glass.css");

    expect(homeSource).toContain("bottom-btn-banco-icon");
    expect(glassCss).toContain(".bottom-btn .bottom-btn-banco-icon");
    expect(glassCss).toContain("width: 31px;");
    expect(glassCss).toContain("height: 31px;");
  });

  it("routes long-press confirmations through the shared haptic helper", () => {
    const hapticsSource = readSource("src/utils/haptics.ts");
    const topBarSource = readSource("src/pages/home/components/TopBar.tsx");
    const tablesCss = readSource("src/styles/tables.css");
    const filesWithLongPressHaptics = [
      "src/pages/home/components/BottomBar.tsx",
      "src/pages/home/components/TopBar.tsx",
      "src/pages/home/tables/TablesWorkspace.tsx",
      "src/pages/home/tables/components/TableTile.tsx",
      "src/pages/home/tables/components/TableOrderComposer.tsx",
      "src/pages/home/tables/components/TableDetailPanel.tsx",
      "src/pages/home/analytics/AnalyticsWorkspace.tsx",
      "src/pages/RadioPage.tsx",
    ];

    expect(hapticsSource).toMatch(/navigator\.vibrate\?\.\(pattern\)/);
    expect(hapticsSource).toMatch(/AmaliaNativeHaptics/);
    expect(hapticsSource).toMatch(/nativeHaptics\.pulse/);
    expect(hapticsSource).toMatch(/nativeHaptics\.pattern/);
    expect(hapticsSource).toMatch(/triggerLongPressHaptic/);
    expect(topBarSource).toMatch(/setPointerCapture\?\.\(event\.pointerId\)/);
    expect(topBarSource).not.toMatch(/onPointerLeave=\{clearTitleLongPress\}/);
    expect(tablesCss).toMatch(
      /\.topbar-title\.is-long-pressable\s*\{[\s\S]*?pointer-events:\s*auto;/
    );
    expect(tablesCss).toMatch(
      /\.topbar-title\.is-long-pressable\s*\{[\s\S]*?width:\s*clamp\(190px,\s*38vw,\s*246px\);/
    );
    expect(tablesCss).toMatch(/\.topbar-title\.is-long-pressable\s*\{[\s\S]*?min-height:\s*58px;/);
    expect(tablesCss).toMatch(
      /\.topbar-title\.is-long-pressable\s*\{[\s\S]*?touch-action:\s*none;/
    );
    for (const relativePath of filesWithLongPressHaptics) {
      expect(readSource(relativePath)).toMatch(/triggerLongPressHaptic\(\)/);
    }
  });

  it("does not expose the delivered-order toggle in mobile settings", () => {
    const source = readSource("src/pages/SettingsPage.tsx");

    expect(source).not.toMatch(/Segna consegnato/);
    expect(source).not.toMatch(/deliveryConfirmationEnabled/);
    expect(source).not.toMatch(/fetchOrderWorkflowSettings|saveOrderWorkflowSettings/);
  });

  it("keeps the system status row dimensions stable around battery and radio pill", () => {
    const glassCss = readSource("src/styles/glass.css");
    const batteryCss = readSource("public/assets/mobile-battery-widget.css");
    const userMenuCss = readSource("public/assets/mobile-user-menu-overrides.css");
    const systemRowSource = readSource("src/pages/home/components/SystemRow.tsx");

    expect(glassCss).toMatch(/\.system-status\s*\{[\s\S]*?min-height:\s*30px;/);
    expect(glassCss).toMatch(/\.system-radio-pill-slot\s*\{[\s\S]*?min-height:\s*30px;/);
    expect(systemRowSource).not.toMatch(/status-led/);
    expect(batteryCss).toMatch(/\.mobile-battery-widget\s*\{[\s\S]*?contain:\s*layout style;/);
    expect(batteryCss).toMatch(/\.mobile-battery-widget\s*\{[\s\S]*?width:\s*58px;/);
    expect(batteryCss).toMatch(
      /\.home-page \.system-row,[\s\S]*?\.settings-page \.settings-shell > \.system-row,[\s\S]*?\.payments-page \.settings-shell > \.system-row,[\s\S]*?\.profile-page \.settings-shell > \.system-row\s*\{[\s\S]*?transform:\s*translateY\(2\.5px\);[\s\S]*?z-index:\s*40;/
    );
    expect(batteryCss).toMatch(
      /\.home-page \.system-time,[\s\S]*?\.settings-page \.settings-shell > \.system-row \.system-time,[\s\S]*?\.payments-page \.settings-shell > \.system-row \.system-time,[\s\S]*?\.profile-page \.settings-shell > \.system-row \.system-time\s*\{[\s\S]*?text-shadow:/
    );
    expect(userMenuCss).toMatch(/\.settings-shell\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(userMenuCss).toMatch(/\.settings-page \.swipe-front-layer,[\s\S]*?overflow:\s*visible;/);
    const settingsSystemRowBlock =
      userMenuCss.match(/\.settings-shell > \.system-row\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(settingsSystemRowBlock).toContain("overflow: visible;");
    expect(settingsSystemRowBlock).not.toMatch(/(^|\n)\s*margin-top\s*:/);
    expect(settingsSystemRowBlock).not.toMatch(/(^|\n)\s*padding-top\s*:/);
    expect(settingsSystemRowBlock).not.toMatch(/(^|\n)\s*z-index\s*:/);
  });

  it("keeps the avatar ring tied to backend connection status, not Radio PTT status", () => {
    const topbarRightSource = readSource("src/pages/home/components/TopbarRight.tsx");
    const statusApiSource = readSource("src/api/systemStatus.ts");
    const statusProviderSource = readSource("src/app/runtime/SystemConnectionStatusContext.tsx");
    const glassCss = readSource("src/styles/glass.css");
    const markTransportHealthyBlock =
      statusProviderSource.match(
        /const markTransportHealthy = useCallback\(\(\) => \{([\s\S]*?)\}, \[probeBackendHealth\]\);/
      )?.[1] ?? "";

    expect(topbarRightSource).toMatch(/useSystemConnectionStatus/);
    expect(topbarRightSource).toMatch(/avatar-connection-ring/);
    expect(topbarRightSource).not.toMatch(/useOptionalRadio|resolveRadioRingState/);
    expect(statusApiSource).toMatch(/parseBackendHealthPayload/);
    expect(statusApiSource).toMatch(/databaseRecord\.ok === true/);
    expect(statusApiSource).not.toMatch(/fiscal/i);
    expect(markTransportHealthyBlock).toContain("probeBackendHealth();");
    expect(markTransportHealthyBlock).not.toContain('setState("online")');
    expect(glassCss).toMatch(/\.avatar\.avatar-connection-state-online::before/);
    expect(glassCss).toMatch(/\.avatar\.avatar-connection-state-reconnecting::before/);
    expect(glassCss).toMatch(/\.avatar\.avatar-connection-state-offline::before/);
  });

  it("keeps top bar left and right groups symmetric", () => {
    const glassCss = readSource("src/styles/glass.css");
    const sharedTopbarGroupBlock =
      glassCss.match(/\.topbar-left,\s*\.topbar-right\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(sharedTopbarGroupBlock).toContain("--topbar-group-gap: 12px;");
    expect(sharedTopbarGroupBlock).toContain("--topbar-control-size: 44px;");
    expect(sharedTopbarGroupBlock).toContain("gap: var(--topbar-group-gap);");
    expect(glassCss).not.toMatch(/\.topbar-left\s*\{[\s\S]*?gap:/);
    expect(glassCss).not.toContain("--topbar-left-gap");
  });

  it("keeps mobile app shells on the same height and aligns bottom bar to the top bar", () => {
    const glassCss = readSource("src/styles/glass.css");
    const userMenuCss = readSource("public/assets/mobile-user-menu-overrides.css");

    expect(glassCss).toMatch(/\.bottom-bar-wrap\s*\{[\s\S]*?var\(--home-shell-side-expand, 0px\)/);
    expect(glassCss).toMatch(/\.settings-page\s*\{[\s\S]*?padding-bottom:\s*0;/);
    expect(glassCss).toMatch(/\.settings-page\s*\{[\s\S]*?height:\s*100svh;/);
    expect(glassCss).toMatch(/\.payments-page\s*\{[\s\S]*?height:\s*100svh;/);
    expect(glassCss).toMatch(/\.profile-page\s*\{[\s\S]*?height:\s*100svh;/);
    expect(userMenuCss).toMatch(
      /\.settings-page,[\s\S]*?\.profile-page\s*\{[\s\S]*?padding-top:\s*2px;/
    );
    expect(userMenuCss).toMatch(/\.settings-shell\s*\{[\s\S]*?--home-shell-side-expand:\s*5px;/);
    expect(userMenuCss).toMatch(
      /\.settings-shell\s*\{[\s\S]*?width:\s*calc\(100% \+ \(var\(--home-shell-side-expand\) \* 2\)\);/
    );
  });

  it("keeps the mobile shell graphics on the low-cpu path", () => {
    const glassCss = readSource("src/styles/glass.css");
    const forwardKeyframes = glassCss.slice(
      glassCss.indexOf("@keyframes home-view-enter-forward"),
      glassCss.indexOf("@keyframes home-view-enter-backward")
    );
    const backwardKeyframes = glassCss.slice(
      glassCss.indexOf("@keyframes home-view-enter-backward"),
      glassCss.indexOf(".workspace-grid")
    );

    expect(forwardKeyframes).not.toContain("filter:");
    expect(backwardKeyframes).not.toContain("filter:");
    expect(glassCss).toMatch(
      /@media \(max-width: 820px\), \(pointer: coarse\)\s*\{[\s\S]*?\.home-topbar,\s*\.bottom-bar,\s*\.menu,\s*\.notif-panel\s*\{[\s\S]*?backdrop-filter:\s*none;/
    );
    expect(glassCss).toMatch(
      /@media \(max-width: 820px\), \(pointer: coarse\)\s*\{[\s\S]*?\.glass-card::after,\s*\.glass-lens\s*\{[\s\S]*?animation:\s*none;/
    );
  });
});
