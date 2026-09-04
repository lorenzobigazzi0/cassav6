import { defineConfig, loadEnv, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE_BASE = process.env.VITE_MOBILE_BASE || "/mobile/";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const legacyMobileAssetsDir = resolve(process.cwd(), "legacy-mobile-assets/assets");
const distAssetsDir = resolve(process.cwd(), "dist/assets");
// The v1 mobile bridge scripts are intentionally no longer injected. Their
// behavior is covered by React/API modules documented in
// docs/mobile-frontend-v2/V1_BRIDGE_NATIVE_IMPORT.md. Legacy CSS/image assets
// are still copied below, but JS bridge files are excluded from dist.
const mobileLegacyBridgeScripts: string[] = [];
const mobileOverrideStyles = [
  "mobile-battery-widget.css?v=20260715-centered-value",
  "mobile-dropdown-overrides.css?v=20260513-variant-required",
  "mobile-menu-availability-overrides.css?v=20260417-1920",
  "mobile-menu-section-dividers.css?v=20260715-section-labels",
  "mobile-menu-category-badge.css?v=20260506-db-only",
  "mobile-menu-department-badge.css?v=20260506-menu-dept-badge",
  "mobile-table-groups-overrides.css?v=20260721-context-header",
  "mobile-table-lock-modal.css?v=20260517-table-lock-modal",
  "mobile-product-press-feedback.css?v=20260329-2358",
  "mobile-home-dashboard-overrides.css?v=20260625-table-filter-colors",
  "mobile-user-menu-overrides.css?v=20260623-shell-fit",
  "mobile-analytics-overrides.css?v=20260408-1840",
  "mobile-reservations-header-overrides.css?v=20260408-1902",
  "mobile-payments-settlement-overrides.css?v=20260408-2248",
  "mobile-order-payment-layout-fix.css?v=20260513-history-pay-wallet",
  "mobile-order-composer-draft-badge.css?v=20260407-2012",
  "mobile-order-history-print-buttons.css?v=20260513-pay-left-of-order",
  "mobile-order-service-recovery.css?v=20260515-hide-stale-modified-lines",
  "mobile-order-history-contrast.css?v=20260507-contrast",
  "mobile-product-image-overrides.css?v=20260410-1201",
  "mobile-night-modal-overrides.css?v=20260514-night-modals",
  "mobile-order-touch-interactions.css?v=20260517-order-touch-interactions",
];

const mobileLegacyBridgePlugin = {
  name: "mobile-legacy-bridge-order",
  transformIndexHtml: {
    order: "pre" as const,
    handler() {
      return mobileLegacyBridgeScripts.map((fileName) => ({
        tag: "script",
        attrs: {
          defer: true,
          src: `${MOBILE_BASE}assets/${fileName}`,
        },
        injectTo: "head" as const,
      }));
    },
  },
};

const mobileOverrideStylePlugin = {
  name: "mobile-override-style-order",
  transformIndexHtml: {
    order: "post" as const,
    handler() {
      return mobileOverrideStyles.map((fileName) => ({
        tag: "link",
        attrs: {
          rel: "stylesheet",
          href: `${MOBILE_BASE}assets/${fileName}`,
        },
        injectTo: "head" as const,
      }));
    },
  },
};

const mobileLegacyAssetCopyPlugin = {
  name: "mobile-legacy-asset-copy",
  closeBundle() {
    if (!existsSync(legacyMobileAssetsDir)) {
      return;
    }

    mkdirSync(distAssetsDir, { recursive: true });
    for (const entry of readdirSync(legacyMobileAssetsDir)) {
      if (/^mobile-.*\.js$/i.test(entry)) {
        continue;
      }
      const source = resolve(legacyMobileAssetsDir, entry);
      if (!statSync(source).isFile()) {
        continue;
      }
      copyFileSync(source, resolve(distAssetsDir, entry));
    }
  },
};

const mobileRootRedirectPlugin = {
  name: "mobile-root-redirect",
  configureServer(server: ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/" || req.url === "") {
        res.statusCode = 302;
        res.setHeader("Location", MOBILE_BASE);
        res.end();
        return;
      }
      if (req.url === MOBILE_BASE.replace(/\/+$/, "")) {
        res.statusCode = 302;
        res.setHeader("Location", MOBILE_BASE);
        res.end();
        return;
      }
      next();
    });
  },
};

function resolveFromProject(relativeOrAbsolutePath: string | undefined) {
  if (!relativeOrAbsolutePath) return null;
  return isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : resolve(__dirname, relativeOrAbsolutePath);
}

function getLanHttpsOptions(env: Record<string, string>) {
  const enabled = env.VITE_LAN_HTTPS === "true";
  if (!enabled) return undefined;

  const lanIp = env.VITE_LAN_IP || "192.168.0.28";
  const certPath = resolveFromProject(env.VITE_HTTPS_CERT || `certs/${lanIp}.pem`);
  const keyPath = resolveFromProject(env.VITE_HTTPS_KEY || `certs/${lanIp}-key.pem`);

  if (!certPath || !keyPath || !existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(
      [
        "Certificati HTTPS LAN mancanti.",
        "Attesi:",
        `- ${certPath}`,
        `- ${keyPath}`,
        "Esegui: npm run cert:lan",
      ].join("\n")
    );
  }

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isLanHttps = env.VITE_LAN_HTTPS === "true";
  const lanIp = env.VITE_LAN_IP || "192.168.0.28";
  const host = env.VITE_DEV_HOST || "0.0.0.0";
  const port = Number(env.VITE_DEV_PORT || (isLanHttps ? 5280 : 5173));
  const apiProxyTarget =
    env.VITE_API_PROXY_TARGET || env.API_PROXY_TARGET || "http://127.0.0.1:5281";

  return {
    base: MOBILE_BASE,
    plugins: [
      mobileRootRedirectPlugin,
      mobileLegacyBridgePlugin,
      react(),
      mobileOverrideStylePlugin,
      mobileLegacyAssetCopyPlugin,
    ],
    server: {
      host,
      port,
      strictPort: isLanHttps,
      https: getLanHttpsOptions(env),
      allowedHosts: [lanIp, "nonprophetic-geraldo-friarly.ngrok-free.dev"],
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
      },
    },
  };
});
