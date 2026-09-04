import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoots = ["src", "public/assets"];
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".ts", ".tsx"]);

const legacyDebtFiles = new Set([
  "src/api/tables.ts",
  // DOM-global runtime debt absorbed from the retired src/mobile helpers into root
  // React hooks (Phase B). These remain intrinsically DOM-global and are tracked at
  // their new location.
  "src/app/runtime/documentInteractionGuards.ts",
  "src/app/runtime/documentTextEncodingFix.ts",
  "src/pages/home/components/MobileBatteryWidget.tsx",
  "src/pages/home/hooks/useNotificationCenter.ts",
  "src/pages/home/hooks/useThemeMode.ts",
  "src/pages/home/menu/MenuWorkspace.tsx",
  "src/pages/HomePage.tsx",
  "src/pages/home/components/HomeCard.tsx",
  "src/pages/home/tables/TablesWorkspace.tsx",
  "src/pages/home/tables/components/TableDetailPanel.tsx",
  "src/pages/home/tables/components/TableOrderComposer.tsx",
  "src/pages/payments/PaymentSettlementSection.tsx",
  "src/store/authStore.ts",
  "src/store/paymentSettingsStore.ts",
  "src/utils/analyticsTransactions.ts",
  "src/utils/device.ts",
  "src/utils/menuStationBadgePreferences.ts",
  "src/utils/orderPreferences.ts",
  "src/utils/paymentConfigReset.ts",
  "src/utils/paymentSessionRuntime.ts",
  "src/utils/reservationReminderPreferences.ts",
  "src/utils/roomPreferences.ts",
  "src/utils/tableFilterPreferences.ts",
]);

const componentEndpointDebtFiles = new Set([
  "src/pages/PaymentsPage.tsx",
  "src/pages/home/components/MobileBatteryWidget.tsx",
  "src/pages/payments/PaymentSettlementSection.tsx",
]);

// Per-file LOC ceilings seeded at the current v2 stabilization baseline
// (measured with the same split(/\r?\n/).length metric the gate uses). These
// are MONOTONICALLY DECREASING from this baseline: when a file is decomposed,
// lower its ceiling in the same change.
const fileLineBudgets: Record<string, number> = {
  "src/api/tables.ts": 2688,
  "src/pages/home/tables/components/TablePaymentWizard.tsx": 2309,
  "src/pages/home/tables/components/TableOrderComposer.tsx": 1758,
  "src/pages/home/reservations/ReservationsWorkspace.tsx": 2127,
  "src/pages/home/tables/components/TableDetailPanel.tsx": 1632,
  "src/pages/home/tables/TablesWorkspace.tsx": 2393,
  "src/pages/payments/PaymentSettlementSection.tsx": 1577,
  "src/api/reservations.ts": 983,
  "src/pages/SettingsPage.tsx": 929,
  "src/api/menu.ts": 920,
  "src/api/analyticsPaymentMovements.ts": 315,
  "src/pages/home/tables/components/TableServiceRecoveryDialog.tsx": 797,
  "src/pages/home/hooks/useNotificationCenter.ts": 679,
  "src/pages/home/analytics/AnalyticsWorkspace.tsx": 565,
  "src/pages/home/menu/MenuWorkspace.tsx": 515,
};

const TABLES_DIR_PREFIX = "src/pages/home/tables/";
const TABLES_UTILS_MODULE = "src/pages/home/tables/utils";

// Tenant/business data must come from runtime config or the API, not be hardcoded
// in source. The whitelist is temporary debt removed as TablePaymentWizard and
// paymentInvoice externalize this data (see Phase C of the stabilization plan).
const tenantDataPatterns: { name: string; regex: RegExp }[] = [
  { name: "IBAN", regex: /\bIT\d{2}[A-Z0-9]{10,}\b/ },
  { name: "Ristorante Demo", regex: /Ristorante Demo/ },
  { name: "Banca Demo", regex: /Banca Demo/ },
  { name: "Dolce Vita SRL", regex: /Dolce Vita SRL/ },
];

const tenantDataWhitelist = new Set([
  "src/pages/home/tables/components/TablePaymentWizard.tsx",
  "src/pages/home/tables/payment/paymentInvoice.ts",
]);

function countLines(text: string) {
  return text.split(/\r?\n/).length;
}

function resolveRelativeImport(fromPath: string, specifier: string) {
  const stack = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/").replace(/\.(ts|tsx)$/, "");
}

type SourceFile = {
  path: string;
  text: string;
};

type NeedleRule = {
  name: string;
  needle: string;
  budget: number;
};

const rules: NeedleRule[] = [
  { name: "global fetch patch", needle: "window.fetch =", budget: 0 },
  { name: "global EventSource patch", needle: "window.EventSource =", budget: 0 },
  { name: "MutationObserver", needle: "MutationObserver", budget: 1 },
  { name: "querySelector", needle: "querySelector", budget: 3 },
  { name: "localStorage direct usage", needle: "localStorage.", budget: 0 },
  { name: "sessionStorage direct usage", needle: "sessionStorage.", budget: 0 },
  { name: "window private globals", needle: "window.__", budget: 0 },
  { name: "important CSS overrides", needle: "!important", budget: 267 },
];

function toRepoPath(path: string) {
  return path
    .replace(repoRoot + sep, "")
    .split(sep)
    .join("/");
}

function collectFiles(dir: string): SourceFile[] {
  const fullDir = resolve(repoRoot, dir);
  const entries = readdirSync(fullDir);
  return entries.flatMap((entry) => {
    const fullPath = resolve(fullDir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return collectFiles(toRepoPath(fullPath));
    }
    if (!stats.isFile() || !textExtensions.has(extname(entry))) {
      return [];
    }
    return [{ path: toRepoPath(fullPath), text: readFileSync(fullPath, "utf8") }];
  });
}

function countNeedle(text: string, needle: string) {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = text.indexOf(needle, offset);
    if (next === -1) return count;
    count += 1;
    offset = next + needle.length;
  }
}

function isLegacyDebtPath(path: string) {
  return (
    path.startsWith("src/mobile/") ||
    path.startsWith("public/assets/") ||
    path.startsWith("src/styles/") ||
    legacyDebtFiles.has(path)
  );
}

describe("static architecture rules", () => {
  const files = sourceRoots.flatMap(collectFiles);

  for (const rule of rules) {
    it(`does not increase ${rule.name} debt`, () => {
      const matches = files.flatMap((file) => {
        const count = countNeedle(file.text, rule.needle);
        return count > 0 ? [{ ...file, count }] : [];
      });
      const total = matches.reduce((sum, match) => sum + match.count, 0);
      const unexpectedFiles = matches
        .filter((match) => !isLegacyDebtPath(match.path))
        .map((match) => `${match.path} (${match.count})`);

      expect(unexpectedFiles).toEqual([]);
      expect(total).toBeLessThanOrEqual(rule.budget);
    });
  }

  it("does not add raw /api/ endpoint strings inside React components", () => {
    const componentFiles = files.filter((file) => file.path.endsWith(".tsx"));
    const matches = componentFiles.flatMap((file) => {
      const count = [...file.text.matchAll(/["']\/api\//g)].length;
      return count > 0 ? [{ ...file, count }] : [];
    });
    const total = matches.reduce((sum, match) => sum + match.count, 0);
    const unexpectedFiles = matches
      .filter((match) => !componentEndpointDebtFiles.has(match.path))
      .map((match) => `${match.path} (${match.count})`);

    expect(unexpectedFiles).toEqual([]);
    expect(total).toBeLessThanOrEqual(5);
  });

  it("keeps large files within their monotonically-decreasing LOC budgets", () => {
    const fileByPath = new Map(files.map((file) => [file.path, file]));
    const offenders = Object.entries(fileLineBudgets).flatMap(([path, budget]) => {
      const file = fileByPath.get(path);
      if (!file) {
        return [`${path} (missing — update budget after move/rename)`];
      }
      const loc = countLines(file.text);
      return loc > budget ? [`${path} (${loc} > ${budget})`] : [];
    });

    expect(offenders).toEqual([]);
  });

  it("does not import pages/home/tables/utils from outside the tables feature", () => {
    const codeFiles = files.filter(
      (file) => file.path.endsWith(".ts") || file.path.endsWith(".tsx")
    );
    const specifierPattern = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    const offenders = codeFiles.flatMap((file) => {
      if (file.path.startsWith(TABLES_DIR_PREFIX)) return [];
      const hits: string[] = [];
      for (const match of file.text.matchAll(specifierPattern)) {
        const specifier = match[1] ?? match[2];
        if (!specifier || !specifier.startsWith(".")) continue;
        const resolved = resolveRelativeImport(file.path, specifier);
        if (resolved === TABLES_UTILS_MODULE || resolved.startsWith(`${TABLES_UTILS_MODULE}/`)) {
          hits.push(`${file.path} -> ${specifier}`);
        }
      }
      return hits;
    });

    expect(offenders).toEqual([]);
  });

  it("does not hardcode tenant/business data outside the temporary whitelist", () => {
    const offenders = files.flatMap((file) => {
      if (tenantDataWhitelist.has(file.path)) return [];
      return tenantDataPatterns
        .filter((pattern) => pattern.regex.test(file.text))
        .map((pattern) => `${file.path} (${pattern.name})`);
    });

    expect(offenders).toEqual([]);
  });
});
