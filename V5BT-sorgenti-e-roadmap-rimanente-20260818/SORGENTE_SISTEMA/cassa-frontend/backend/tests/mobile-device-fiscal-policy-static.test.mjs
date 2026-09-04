import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
const settingsRoutesSource = await readFile(new URL("../modules/settings/settings.routes.js", import.meta.url), "utf8");

test("policy fiscale palmari abilita sempre il POS prima del controllo device", () => {
  assert.match(
    serverSource,
    /function\s+isMobileDeviceFiscalAllowed[\s\S]*?if\s*\(\s*normalizedMethodType === "POS" \|\| normalizedMethodId === "pay_card"\s*\)\s*\{\s*return true;\s*\}[\s\S]*?const configured = findConfiguredMobileDeviceForFiscal/
  );
});

test("policy fiscale palmari blocca contanti non configurati", () => {
  assert.match(
    serverSource,
    /function\s+isMobileDeviceFiscalAllowed[\s\S]*?const configured = findConfiguredMobileDeviceForFiscal[\s\S]*?if \(!configured\) return false;/
  );
});

test("policy fiscale palmari riconosce anche il deviceUuid salvato da impostazioni", () => {
  assert.match(
    serverSource,
    /function\s+findConfiguredMobileDeviceForFiscal[\s\S]*?configuredDeviceUuid[\s\S]*?configuredDeviceUuid === normalizedDeviceUuid/
  );
});

test("gestione palmari espone route impostazioni dedicate e protette", () => {
  assert.match(settingsRoutesSource, /\/api\/settings\/mobile-devices\/save/);
  assert.match(settingsRoutesSource, /handlerKey: "settings\.saveMobileDevices"/);
  assert.match(settingsRoutesSource, /permission: "manage_settings"/);
  assert.match(settingsRoutesSource, /\/api\/settings\/mobile-devices\/ring/);
  assert.match(settingsRoutesSource, /handlerKey: "settings\.ringMobileDevice"/);
});
