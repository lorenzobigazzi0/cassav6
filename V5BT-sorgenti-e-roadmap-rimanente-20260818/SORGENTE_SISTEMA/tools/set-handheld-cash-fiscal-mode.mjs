#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const mode = String(process.argv[2] ?? "").trim().toLowerCase();
const enabled = mode === "on" || mode === "true" || mode === "enabled";
const disabled = mode === "off" || mode === "false" || mode === "disabled" || mode === "pos-only";

if (!enabled && !disabled) {
  console.error("Uso: set-handheld-cash-fiscal-mode.mjs on|off");
  process.exit(2);
}

const appRoot = "/srv/applicazione/v3";
const dbPath = path.join(appRoot, "cassa-frontend/backend/app-state.json");
const logPath = path.join(appRoot, "logs/handheld-cash-fiscal-scheduler.log");

function nowIso() {
  return new Date().toISOString();
}

function appendLog(message) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${nowIso()} ${message}\n`);
}

const raw = fs.readFileSync(dbPath, "utf8");
const db = JSON.parse(raw);
const devices = Array.isArray(db?.posSettings?.mobileDevices) ? db.posSettings.mobileDevices : [];
const updatedAt = nowIso();

for (const device of devices) {
  if (!device || typeof device !== "object") continue;
  device.fiscalEnabled = true;
  device.electronicPaymentEnabled = true;
  device.cashPaymentEnabled = enabled;
  device.updatedAt = updatedAt;
  device.updatedBy = "scheduled-pos-only-at-0300";
}

db.meta = db.meta && typeof db.meta === "object" ? db.meta : {};
db.meta.settingsUpdatedAt = updatedAt;
db.meta.settingsLastWriteAt = updatedAt;
db.meta.settingsVersion = Date.now();

const tempPath = `${dbPath}.tmp-${process.pid}`;
fs.writeFileSync(tempPath, `${JSON.stringify(db, null, 2)}\n`);
fs.renameSync(tempPath, dbPath);

appendLog(
  JSON.stringify({
    action: "set-handheld-cash-fiscal-mode",
    mode: enabled ? "cash-and-pos" : "pos-only",
    dbPath,
    devices: devices.map((device) => ({
      deviceId: device.deviceId ?? device.id ?? null,
      cashPaymentEnabled: device.cashPaymentEnabled === true,
      electronicPaymentEnabled: device.electronicPaymentEnabled === true,
    })),
  })
);

console.log(
  JSON.stringify(
    {
      ok: true,
      mode: enabled ? "cash-and-pos" : "pos-only",
      updatedAt,
      devices: devices.length,
    },
    null,
    2
  )
);
