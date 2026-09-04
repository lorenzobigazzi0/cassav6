import assert from "node:assert/strict";
import test from "node:test";
import { createMobileDeviceConfigHelpers } from "../modules/configuration/mobile-device-config.domain.js";

const helpers = createMobileDeviceConfigHelpers({
  normalizeConfigId: (value, fallback = "config") => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
    return normalized || fallback;
  },
});

test("mobile device config sanitizza palmare con alias e capability fiscali", () => {
  const device = helpers.sanitizeMobileDeviceSetting(
    {
      deviceUuid: " palmare-1 ",
      label: " Palmare Giada ",
      ip: " 192.168.1.51 ",
      fiscalEnabled: true,
      posPaymentEnabled: true,
      cashPaymentEnabled: true,
      updatedAt: " 2026-06-05T10:00:00.000Z ",
      updatedBy: " admin-super-lungo ".repeat(12),
    },
    "fallback"
  );

  assert.deepEqual(
    {
      id: device.id,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      deviceUuid: device.deviceUuid,
      clientIp: device.clientIp,
      fiscalEnabled: device.fiscalEnabled,
      electronicPaymentEnabled: device.electronicPaymentEnabled,
      cashPaymentEnabled: device.cashPaymentEnabled,
      updatedAt: device.updatedAt,
    },
    {
      id: "palmare-1",
      deviceId: "palmare-1",
      deviceName: "Palmare Giada",
      deviceUuid: "palmare-1",
      clientIp: "192.168.1.51",
      fiscalEnabled: true,
      electronicPaymentEnabled: true,
      cashPaymentEnabled: true,
      updatedAt: "2026-06-05T10:00:00.000Z",
    }
  );
  assert.equal(device.updatedBy.length, 80);
  assert.equal(device.updatedBy.startsWith("admin-super-lungo"), true);
});

test("mobile device config conserva deviceUuid distinto da deviceId per targeting squillo", () => {
  const device = helpers.sanitizeMobileDeviceSetting({
    deviceId: "amalia-2",
    deviceUuid: "real-device-uuid-2",
    deviceName: "Amalia 2",
    clientIp: "192.168.1.52",
  });

  assert.equal(device.deviceId, "amalia-2");
  assert.equal(device.deviceUuid, "real-device-uuid-2");
  assert.equal(device.clientIp, "192.168.1.52");
  assert.equal(device.fiscalEnabled, true);
  assert.equal(device.electronicPaymentEnabled, true);
  assert.equal(device.cashPaymentEnabled, false);
});

test("mobile device config abilita POS fiscale di default e lascia spento il contante", () => {
  const device = helpers.sanitizeMobileDeviceSetting({
    deviceId: "nuovo-palmare",
    deviceName: "Palmare Nuovo",
  });

  assert.equal(device.fiscalEnabled, true);
  assert.equal(device.electronicPaymentEnabled, true);
  assert.equal(device.cashPaymentEnabled, false);
});

test("mobile device config consente disabilitazione esplicita del POS fiscale", () => {
  const device = helpers.sanitizeMobileDeviceSetting({
    deviceId: "palmare-solo-no-pos",
    fiscalEnabled: true,
    electronicPaymentEnabled: false,
  });

  assert.equal(device.fiscalEnabled, true);
  assert.equal(device.electronicPaymentEnabled, false);
  assert.equal(device.cashPaymentEnabled, false);
});

test("mobile device config non abilita metodi fiscali se fiscalEnabled e falso", () => {
  const device = helpers.sanitizeMobileDeviceSetting({
    id: "Palmare 2",
    name: "Palmare Due",
    fiscalEnabled: false,
    electronicPaymentEnabled: true,
    cashPaymentEnabled: true,
  });

  assert.equal(device.fiscalEnabled, false);
  assert.equal(device.electronicPaymentEnabled, false);
  assert.equal(device.cashPaymentEnabled, false);
});

test("mobile device config scarta device senza identificativo", () => {
  assert.equal(helpers.sanitizeMobileDeviceSetting({ name: "Senza id" }), null);
  assert.equal(helpers.sanitizeMobileDeviceSetting(null), null);
});

test("mobile device config deduplica per deviceId e ordina per nome", () => {
  const devices = helpers.sanitizeMobileDeviceSettings([
    { deviceId: "p2", deviceName: "Zeta", fiscalEnabled: true },
    { deviceId: "p1", deviceName: "Alfa", fiscalEnabled: true },
    { deviceId: "p2", deviceName: "Beta", fiscalEnabled: true, cashPaymentEnabled: true },
  ]);

  assert.deepEqual(
    devices.map((device) => `${device.deviceId}:${device.deviceName}:${device.cashPaymentEnabled}`),
    ["p1:Alfa:false", "p2:Beta:true"]
  );
});
