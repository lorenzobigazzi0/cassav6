import assert from "node:assert/strict";
import test from "node:test";
import { buildRouteRegistry } from "../routes/index.js";
import { createRadioHandlers } from "../modules/radio/radio.handlers.js";
import { createRadioReadModel } from "../modules/radio/radio-read-model.js";
import { createRadioWriteModel } from "../modules/radio/radio-write-model.js";
import {
  sanitizeRadioChannels,
  sanitizeRadioPreferences,
} from "../modules/radio/radio.domain.js";

class TestHttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

function sanitizeTestPosSettings(settings = {}) {
  const radioChannels = sanitizeRadioChannels(settings.radioChannels);
  return {
    ...settings,
    radioChannels,
    radioPreferences: sanitizeRadioPreferences(settings.radioPreferences, radioChannels),
  };
}

function createHarness({ db, payload, user }) {
  let response = null;
  let writeCount = 0;
  // Le letture radio passano dal reader iniettato dal composition root: la
  // fixture lo ricostruisce sulle stesse dipendenze finte.
  const { readMobileRadioConfigView, readSettingsRadioView } = createRadioReadModel({
    async readDb() {
      return db;
    },
    resolveSettingsLastWriteAt(meta) {
      return String(meta?.settingsLastWriteAt ?? meta?.lastWriteAt ?? "").trim();
    },
    resolveSettingsVersion() {
      return 1782295200000;
    },
    sanitizePosSettings: sanitizeTestPosSettings,
    validateSessionContext() {
      return { user, session: { deviceUuid: payload.deviceUuid } };
    },
  });
  const { saveMobileRadioConfig, saveSettingsRadio } = createRadioWriteModel({
    HttpError: TestHttpError,
    hasPermission(candidate, permission) {
      return Array.isArray(candidate?.permissions) && candidate.permissions.includes(permission);
    },
    isPosPrivilegedRole(role) {
      return ["admin", "responsabile"].includes(String(role ?? "").toLowerCase());
    },
    nowIso() {
      return "2026-06-24T10:00:00.000Z";
    },
    async readDb() {
      return db;
    },
    resolveSettingsLastWriteAt(meta) {
      return String(meta?.settingsLastWriteAt ?? meta?.lastWriteAt ?? "").trim();
    },
    resolveSettingsVersion() {
      return 1782295200000;
    },
    sanitizePosSettings: sanitizeTestPosSettings,
    touchSettingsMetadata(nextDb, updatedAt) {
      nextDb.meta = { ...(nextDb.meta ?? {}), settingsLastWriteAt: updatedAt };
    },
    validateSessionContext() {
      return { user, session: { deviceUuid: payload.deviceUuid } };
    },
    async writeDb(nextDb) {
      db = nextDb;
      writeCount += 1;
    },
  });
  const handlers = createRadioHandlers({
    readMobileRadioConfigView,
    readSettingsRadioView,
    saveMobileRadioConfig,
    saveSettingsRadio,
    HttpError: TestHttpError,
    hasPermission(candidate, permission) {
      return Array.isArray(candidate?.permissions) && candidate.permissions.includes(permission);
    },
    isPosPrivilegedRole(role) {
      return ["admin", "responsabile"].includes(String(role ?? "").toLowerCase());
    },
    nowIso() {
      return "2026-06-24T10:00:00.000Z";
    },
    async readDb() {
      return db;
    },
    async readJsonBody() {
      return payload;
    },
    resolveSettingsLastWriteAt(meta) {
      return String(meta?.settingsLastWriteAt ?? meta?.lastWriteAt ?? "").trim();
    },
    resolveSettingsVersion() {
      return 1782295200000;
    },
    sanitizePosSettings: sanitizeTestPosSettings,
    sendJson(_res, status, body) {
      response = { status, body };
    },
    touchSettingsMetadata(target, updatedAt) {
      target.meta = {
        ...(target.meta ?? {}),
        lastWriteAt: updatedAt,
        settingsLastWriteAt: updatedAt,
      };
    },
    validateSessionContext() {
      return {
        user,
        session: {
          deviceUuid: payload.deviceUuid,
        },
      };
    },
    async writeDb(nextDb) {
      db = nextDb;
      writeCount += 1;
    },
  });
  return {
    handlers,
    get response() {
      return response;
    },
    get db() {
      return db;
    },
    get writeCount() {
      return writeCount;
    },
  };
}

test("settings.radio restituisce i canali globali", async () => {
  const harness = createHarness({
    db: {
      meta: { settingsLastWriteAt: "2026-06-24T09:00:00.000Z" },
      posSettings: {
        radioChannels: [{ id: "cucina", name: "Cucina", enabled: true }],
      },
    },
    payload: { token: "t", userId: "u_admin", deviceUuid: "cassa" },
    user: { id: "u_admin", role: "admin", permissions: [] },
  });

  await harness.handlers["settings.radio"]({}, {});

  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.ok, true);
  assert.deepEqual(harness.response.body.channels.map((channel) => channel.id), ["cucina"]);
  assert.equal(harness.response.body.lastWriteAt, "2026-06-24T09:00:00.000Z");
});

test("route registry espone i quattro endpoint REST radio", () => {
  const routes = buildRouteRegistry().filter((route) => String(route.path ?? "").includes("/radio"));
  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path} -> ${route.handlerKey}`),
    [
      "POST /api/settings/radio -> settings.radio",
      "POST /api/settings/radio/save -> settings.saveRadio",
      "POST /api/mobile/radio/config -> mobile.radioConfig",
      "POST /api/mobile/radio/config/save -> mobile.saveRadioConfig",
    ]
  );
  assert.equal(routes[0].mutation, false);
  assert.equal(routes[0].readOnly, true);
  assert.equal(routes[1].mutation, true);
  assert.equal(routes[1].authRequired, true);
  const handlerKeys = new Set(Object.keys(createHarness({
    db: { meta: {}, posSettings: {} },
    payload: { token: "t", userId: "u", deviceUuid: "d" },
    user: { id: "u", role: "admin", permissions: [] },
  }).handlers));
  for (const route of routes) {
    assert.equal(handlerKeys.has(route.handlerKey), true, `handler mancante: ${route.handlerKey}`);
  }
});

test("settings.saveRadio richiede ruolo privilegiato o manage_settings", async () => {
  const harness = createHarness({
    db: { meta: {}, posSettings: {} },
    payload: {
      token: "t",
      userId: "u_operator",
      deviceUuid: "cassa",
      channels: [{ id: "cucina", name: "Cucina" }],
    },
    user: { id: "u_operator", role: "operator", permissions: [] },
  });

  await assert.rejects(
    () => harness.handlers["settings.saveRadio"]({}, {}),
    (error) => error.statusCode === 403 && /radio/i.test(error.message)
  );
  assert.equal(harness.writeCount, 0);
});

test("settings.saveRadio normalizza canali e invalida slot su canali disabilitati", async () => {
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        radioChannels: [
          { id: "cucina", name: "Cucina", enabled: true, createdAt: "old" },
          { id: "bar", name: "Bar", enabled: true, createdAt: "old" },
        ],
        radioPreferences: [
          {
            userId: "u_lorenzo",
            deviceUuid: "dev_1",
            slots: ["cucina", "bar", null],
            updatedAt: "old",
          },
        ],
      },
    },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "cassa",
      channels: [
        { id: "cucina", name: "Cucina", enabled: false, sortOrder: 20 },
        { id: "bar", name: "Bar", enabled: true, sortOrder: 10 },
      ],
    },
    user: { id: "u_admin", username: "admin", role: "operator", permissions: ["manage_settings"] },
  });

  await harness.handlers["settings.saveRadio"]({}, {});

  assert.equal(harness.writeCount, 1);
  assert.deepEqual(harness.response.body.channels.map((channel) => `${channel.id}:${channel.enabled}`), [
    "bar:true",
    "cucina:false",
  ]);
  assert.deepEqual(harness.db.posSettings.radioPreferences[0].slots, [null, "bar", null]);
  assert.equal(harness.db.meta.settingsLastWriteAt, "2026-06-24T10:00:00.000Z");
});

test("mobile.radioConfig restituisce canali abilitati e slot del device", async () => {
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        radioChannels: [
          { id: "cucina", name: "Cucina", enabled: true },
          { id: "bar", name: "Bar", enabled: false },
        ],
        radioPreferences: [
          {
            userId: "u_lorenzo",
            deviceUuid: "dev_1",
            slots: ["cucina", "bar", null],
            updatedAt: "2026-06-24T09:00:00.000Z",
          },
        ],
      },
    },
    payload: { token: "t", userId: "u_lorenzo", deviceUuid: "dev_1" },
    user: { id: "u_lorenzo", role: "operator", permissions: [] },
  });

  await harness.handlers["mobile.radioConfig"]({}, {});

  assert.equal(harness.response.status, 200);
  assert.deepEqual(harness.response.body.channels.map((channel) => channel.id), ["cucina"]);
  assert.deepEqual(harness.response.body.slots, ["cucina", null, null]);
  assert.equal(harness.response.body.preference.id, "u_lorenzo:dev_1");
});

test("mobile.saveRadioConfig salva solo la preference utente-device corrente", async () => {
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        radioChannels: [
          { id: "cucina", name: "Cucina", enabled: true },
          { id: "bar", name: "Bar", enabled: true },
          { id: "cassa", name: "Cassa", enabled: false },
        ],
        radioPreferences: [
          {
            userId: "u_altro",
            deviceUuid: "dev_9",
            slots: ["bar", null, null],
            updatedAt: "old",
          },
        ],
      },
    },
    payload: {
      token: "t",
      userId: "u_lorenzo",
      deviceUuid: "dev_1",
      slots: ["cucina", "cassa", "bar"],
    },
    user: { id: "u_lorenzo", username: "lorenzo", role: "operator", permissions: [] },
  });

  await harness.handlers["mobile.saveRadioConfig"]({}, {});

  assert.equal(harness.writeCount, 1);
  assert.deepEqual(
    harness.db.posSettings.radioPreferences.map((preference) => ({
      id: preference.id,
      slots: preference.slots,
    })),
    [
      { id: "u_altro:dev_9", slots: ["bar", null, null] },
      { id: "u_lorenzo:dev_1", slots: ["cucina", null, "bar"] },
    ]
  );
  assert.deepEqual(harness.response.body.slots, ["cucina", null, "bar"]);
});
