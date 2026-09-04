import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const removedBackendFallbackAsset = "mobile-backend-connection-bridge.js";

const archivedBridgeAssets = [
  "mobile-station-availability-guard.js",
  "mobile-table-groups-bridge.js",
  "mobile-table-lock-lifecycle-bridge.js",
  "mobile-order-service-recovery-bridge.js",
  "mobile-order-history-print-buttons.js",
  "mobile-notification-reminder.js",
];

describe("mobile legacy bridge assets", () => {
  it("mantiene archiviati i bridge v1 senza iniettarli nel runtime mobile", () => {
    const viteConfig = readFileSync(resolve(repoRoot, "vite.config.ts"), "utf8");
    const apiClient = readFileSync(resolve(repoRoot, "src/shared/api/apiClient.ts"), "utf8");

    expect(
      existsSync(resolve(repoRoot, "legacy-mobile-assets/assets", removedBackendFallbackAsset))
    ).toBe(false);
    expect(viteConfig).not.toContain(`${removedBackendFallbackAsset}?v=`);
    expect(apiClient).not.toContain("BACKEND_PORT");
    expect(apiClient).not.toContain("KNOWN_BACKEND_HOST");
    for (const assetName of archivedBridgeAssets) {
      expect(existsSync(resolve(repoRoot, "legacy-mobile-assets/assets", assetName))).toBe(true);
      expect(viteConfig).not.toContain(`${assetName}?v=`);
    }
    expect(viteConfig).toContain("const mobileLegacyBridgeScripts: string[] = []");
    expect(viteConfig).toContain('/^mobile-.*\\.js$/i.test(entry)');
    expect(viteConfig).toContain("mobile-legacy-asset-copy");
  });
});
