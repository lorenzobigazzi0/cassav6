import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "../SORGENTE_SISTEMA/cassa-frontend/node_modules/mysql2/promise.js";
import { createAutomaticCashConfigSet } from "../SORGENTE_SISTEMA/cassa-frontend/backend/modules/automatic-cash/automatic-cash.domain.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const database = "cassa_v5bt";
const barWorkstationId = "workstation_bar_principale";
const barIntegrationStationName = "BAR-1";
const kitchenWorkstationId = "workstation_cucina";
const kitchenIntegrationStationName = "BAR-2";
const testCashFloatConfigPath = path.join(
  root,
  "SORGENTE_SISTEMA",
  "cassa-frontend",
  "backend",
  "fixtures",
  "fondo_cassa_test_10_euro.json",
);
const requiredRecordIds = [
  "activities",
  "activityRoomBindings",
  "areas",
  "automaticCash",
  "demoMode",
  "fiscalDevices",
  "mobileDevices",
  "printers",
  "workstations",
];
const now = new Date().toISOString();
const testCashFloatConfig = JSON.parse(
  await readFile(testCashFloatConfigPath, "utf8"),
);
const {
  validation: testCashFloatValidation,
  configSet: testCashFloatConfigSet,
} = createAutomaticCashConfigSet({
  config: testCashFloatConfig,
  uploadedAt: now,
  uploadedBy: "v5bt-test-setup",
});
if (!testCashFloatValidation.ok || !testCashFloatConfigSet) {
  throw new Error(
    `File fondo cassa V5BT non valido: ${testCashFloatValidation.errors.join("; ")}`,
  );
}

function compactJson(value) {
  return JSON.stringify(value);
}

function hashJson(rawJson) {
  return createHash("sha256").update(rawJson).digest("hex");
}

function upsertById(entries, nextEntry) {
  const list = Array.isArray(entries) ? entries : [];
  const index = list.findIndex((entry) => entry?.id === nextEntry.id);
  if (index < 0) return [...list, nextEntry];
  const copy = [...list];
  copy[index] = { ...copy[index], ...nextEntry };
  return copy;
}

function configuredPrinterIdsForRoom(roomId) {
  return roomId === "room_pizza_in_riva"
    ? ["printer_pizza_in_riva_192168136_9100"]
    : ["printer_bar_1921681195_9100"];
}

const password = String(process.env.CASSAV5BT_MYSQL_PASSWORD ?? "").trim();
if (!/^[0-9A-Fa-f]{64,128}$/.test(password)) {
  throw new Error("CASSAV5BT_MYSQL_PASSWORD mancante o non valido.");
}

const connection = await mysql.createConnection({
  host: "127.0.0.1",
  port: 3306,
  user: "cassa_v5bt_app",
  password,
  database,
});

try {
  await connection.beginTransaction();
  const placeholders = requiredRecordIds.map(() => "?").join(",");
  const [rows] = await connection.execute(
    `SELECT record_id, raw_json
       FROM app_state_domain_records
      WHERE domain = 'posSettings' AND record_id IN (${placeholders})
      FOR UPDATE`,
    requiredRecordIds,
  );
  const records = new Map(
    rows.map((row) => [String(row.record_id), JSON.parse(String(row.raw_json))]),
  );
  const missing = requiredRecordIds.filter((recordId) => !records.has(recordId));
  if (missing.length > 0) {
    throw new Error(`Record posSettings mancanti: ${missing.join(", ")}`);
  }

  const backupDirectory = path.join(root, ".runtime", "cassav5bt", "backups");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupStamp = now.replace(/[:.]/g, "-");
  const backupPath = path.join(
    backupDirectory,
    `hardware-settings-before-real-${backupStamp}.json`,
  );
  await writeFile(
    backupPath,
    `${JSON.stringify(Object.fromEntries(records), null, 2)}\n`,
    { mode: 0o600 },
  );

  let printers = (Array.isArray(records.get("printers"))
    ? records.get("printers")
    : []
  ).filter((printer) => printer?.id !== "printer_bar_principale_1921681127_9100");
  printers = upsertById(printers, {
    id: "printer_bar_1921681195_9100",
    name: "Stampante preconti e comande Bar 192.168.1.195",
    host: "192.168.1.195",
    ip: "192.168.1.195",
    port: 9100,
    purpose: "generic",
    model: "generic_tcp",
    description: "Stampante reale Bar",
    active: true,
  });
  printers = upsertById(printers, {
    id: "printer_pizza_in_riva_192168136_9100",
    name: "Stampante Pizza in Riva 192.168.1.36",
    host: "192.168.1.36",
    ip: "192.168.1.36",
    port: 9100,
    purpose: "generic",
    model: "generic_tcp",
    description: "Stampante reale Pizza in Riva",
    active: true,
  });
  records.set("printers", printers);

  records.set("fiscalDevices", [
    {
      id: "rt_bar_api",
      name: "RT Bar API",
      type: "api",
      fiscalProvider: "pos-fiscal-api",
      apiBaseUrl: "http://192.168.1.200:8765",
      statusEndpoint: "/api/fiscal/status",
      verifyEndpoint: "/api/fiscal/receipt/verify",
      receiptEndpoint: "/api/fiscal/receipt",
      reprintEndpoint: "/api/fiscal/reprint",
      voidEndpoint: "/api/fiscal/void",
      paymentMethodIds: ["pay_cash", "pay_card"],
      supportsCash: true,
      supportsElectronic: true,
      supportsReprint: true,
      description: "Registratore telematico reale Bar",
      active: true,
    },
  ]);

  let activities = Array.isArray(records.get("activities"))
    ? records.get("activities")
    : [];
  activities = upsertById(activities, {
    id: "activity_default",
    name: "Operativa",
    type: "operational",
    status: "active",
    fiscalPolicy: "standard",
    fiscalDeviceIds: ["rt_bar_api"],
    printerIds: ["printer_bar_1921681195_9100"],
    precontoPrinterIds: ["printer_bar_1921681195_9100"],
    workstationIds: [barWorkstationId, kitchenWorkstationId],
  });
  activities = upsertById(activities, {
    id: "activity_pizza_in_riva",
    name: "Pizza in Riva",
    type: "operational",
    status: "active",
    fiscalPolicy: "no_fiscal_auto_paid",
    fiscalDeviceIds: [],
    menuIds: [],
    priceListIds: [],
    printerIds: ["printer_pizza_in_riva_192168136_9100"],
    precontoPrinterIds: ["printer_pizza_in_riva_192168136_9100"],
    workstationIds: [],
    menuSchedules: [],
    priceListSchedules: [],
  });
  records.set("activities", activities);

  const areas = (Array.isArray(records.get("areas")) ? records.get("areas") : []).map(
    (area) => {
      const printerIds = configuredPrinterIdsForRoom(area?.id);
      return {
        ...area,
        printerIds,
        precontoPrinterIds: printerIds,
      };
    },
  );
  records.set("areas", areas);

  const bindings = (Array.isArray(records.get("activityRoomBindings"))
    ? records.get("activityRoomBindings")
    : []
  ).map((binding) => ({
    ...binding,
    activityId:
      binding?.roomId === "room_pizza_in_riva"
        ? "activity_pizza_in_riva"
        : "activity_default",
    status: "active",
  }));
  records.set("activityRoomBindings", bindings);

  const barRoomIds = areas
    .map((area) => String(area?.id ?? "").trim())
    .filter((roomId) => roomId && roomId !== "room_pizza_in_riva");
  const workstations = (Array.isArray(records.get("workstations"))
    ? records.get("workstations")
    : []
  ).map((workstation) => ({
    ...workstation,
    // These are the station identities emitted by Postazione Advanced.
    ...(workstation?.id === barWorkstationId
      ? { stationName: barIntegrationStationName }
      : workstation?.id === kitchenWorkstationId
        ? { stationName: kitchenIntegrationStationName }
        : {}),
    active: true,
    status: "active",
    useOwnPrinters: false,
    printOrderEnabled: true,
    printPrecontoEnabled: true,
    printTableChangesEnabled: true,
    roomIds:
      workstation?.id === barWorkstationId ||
      workstation?.id === kitchenWorkstationId
        ? barRoomIds
        : workstation?.roomIds,
  }));
  records.set("workstations", workstations);

  const automaticCash = records.get("automaticCash");
  const automaticCashConfigSets = [
    ...(Array.isArray(automaticCash?.configSets)
      ? automaticCash.configSets.filter(
          (entry) => entry?.id !== testCashFloatConfigSet.id,
        )
      : []),
    testCashFloatConfigSet,
  ];
  records.set("automaticCash", {
    ...(automaticCash && typeof automaticCash === "object" ? automaticCash : {}),
    enabled: true,
    gatewayConfigured: true,
    autoCashFloatMode: "random_file",
    configSetId: testCashFloatConfigSet.id,
    configSet: testCashFloatConfigSet,
    configSets: automaticCashConfigSets,
    gatewayInventory: {
      ok: false,
      error: null,
      inventory: { ok: false, error: null, listCassette: [] },
      activeOperation: null,
      updatedAtMs: null,
    },
  });
  records.set("demoMode", false);

  const [sessionRows] = await connection.execute(
    `SELECT device_uuid
       FROM app_state_sessions
      WHERE client_app = 'mobile-frontend' AND device_uuid IS NOT NULL
      GROUP BY device_uuid
      ORDER BY MAX(updated_at) ASC`,
  );
  let mobileDevices = Array.isArray(records.get("mobileDevices"))
    ? records.get("mobileDevices")
    : [];
  sessionRows.forEach((row, index) => {
    const deviceUuid = String(row.device_uuid ?? "").trim();
    if (!deviceUuid) return;
    const existing = mobileDevices.find(
      (device) =>
        device?.deviceId === deviceUuid ||
        device?.deviceUuid === deviceUuid ||
        device?.id === deviceUuid,
    );
    mobileDevices = upsertById(mobileDevices, {
      ...(existing ?? {}),
      id: existing?.id ?? deviceUuid,
      deviceId: deviceUuid,
      deviceUuid,
      deviceName: existing?.deviceName ?? `Palmare Advanced ${index + 1}`,
      fiscalEnabled: true,
      electronicPaymentEnabled: true,
      cashPaymentEnabled: true,
      updatedAt: now,
      updatedBy: "hardware-real-setup",
    });
  });
  records.set("mobileDevices", mobileDevices);

  for (const recordId of requiredRecordIds) {
    const rawJson = compactJson(records.get(recordId));
    await connection.execute(
      `UPDATE app_state_domain_records
          SET raw_json = ?, row_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE domain = 'posSettings' AND record_id = ?`,
      [rawJson, hashJson(rawJson), recordId],
    );
  }

  const [[appStateRow]] = await connection.execute(
    "SELECT json FROM app_state WHERE id = 1 FOR UPDATE",
  );
  if (!appStateRow) throw new Error("Riga app_state principale mancante.");
  const appState = JSON.parse(String(appStateRow.json));
  appState.meta = appState.meta && typeof appState.meta === "object" ? appState.meta : {};
  appState.meta.lastWriteAt = now;
  appState.meta.settingsLastWriteAt = now;
  await connection.execute(
    "UPDATE app_state SET json = ?, updated_at = ? WHERE id = 1",
    [compactJson(appState), now],
  );

  await connection.commit();
  console.log(`Configurazione hardware reale V5BT applicata. Backup: ${backupPath}`);
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  await connection.end();
}
