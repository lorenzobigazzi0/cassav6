import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRadioPreferenceId,
  normalizeRadioChannelId,
  resolveRadioPreference,
  sanitizeRadioChannels,
  sanitizeRadioPreference,
  sanitizeRadioSlots,
} from "../modules/radio/radio.domain.js";
import { cloneDefaultPosSettings } from "../lib/pos-defaults.js";

test("radio defaults espongono Bar, Generale e Cassa", () => {
  const settings = cloneDefaultPosSettings();
  assert.deepEqual(
    sanitizeRadioChannels(settings.radioChannels).map((channel) => ({
      id: channel.id,
      name: channel.name,
      enabled: channel.enabled,
      color: channel.color,
      sortOrder: channel.sortOrder,
    })),
    [
      { id: "bar", name: "Bar", enabled: true, color: "#00d2ff", sortOrder: 10 },
      { id: "generale", name: "Generale", enabled: true, color: "#2ed573", sortOrder: 20 },
      { id: "cassa", name: "Cassa", enabled: true, color: "#8b5cf6", sortOrder: 30 },
    ]
  );
});

test("radio domain normalizza e deduplica i canali globali", () => {
  const channels = sanitizeRadioChannels([
    {
      id: " Cucina Calda ",
      name: " Cucina calda ",
      enabled: true,
      color: "#FF9F43",
      sortOrder: 20,
    },
    {
      id: "bar",
      name: "Bar",
      enabled: false,
      color: "non-valido",
      sortOrder: 10,
    },
    {
      id: "bar",
      name: "Bar interno",
      enabled: true,
      color: "#00D2FF",
      sortOrder: 5,
    },
    {},
  ]);

  assert.deepEqual(
    channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      enabled: channel.enabled,
      color: channel.color,
      sortOrder: channel.sortOrder,
    })),
    [
      {
        id: "bar",
        name: "Bar interno",
        enabled: true,
        color: "#00d2ff",
        sortOrder: 5,
      },
      {
        id: "cucina_calda",
        name: "Cucina calda",
        enabled: true,
        color: "#ff9f43",
        sortOrder: 20,
      },
    ]
  );
});

test("radio domain normalizza id canale e slot invalidi a null", () => {
  const channels = sanitizeRadioChannels([
    { id: "cucina", name: "Cucina", enabled: true },
    { id: "bar", name: "Bar", enabled: false },
    { id: "cassa", name: "Cassa", enabled: true },
  ]);

  assert.equal(normalizeRadioChannelId(" Sala / Cucina "), "sala_cucina");
  assert.deepEqual(sanitizeRadioSlots([" cucina ", "bar", "cassa", "extra"], channels), [
    "cucina",
    null,
    "cassa",
  ]);
});

test("radio domain salva preference per userId e deviceUuid normalizzati", () => {
  const channels = sanitizeRadioChannels([
    { id: "cucina", name: "Cucina", enabled: true },
    { id: "bar", name: "Bar", enabled: true },
  ]);
  const preference = sanitizeRadioPreference(
    {
      userId: " Lorenzo Bigazzi ",
      deviceUuid: " Palmare 01 ",
      slots: ["cucina", "inesistente", "bar"],
      updatedAt: "2026-06-24T10:00:00.000Z",
      updatedBy: "admin",
    },
    channels
  );

  assert.equal(buildRadioPreferenceId(" Lorenzo Bigazzi ", " Palmare 01 "), "lorenzo_bigazzi:palmare_01");
  assert.deepEqual(preference, {
    id: "lorenzo_bigazzi:palmare_01",
    userId: "lorenzo_bigazzi",
    deviceUuid: "palmare_01",
    slots: ["cucina", null, "bar"],
    updatedAt: "2026-06-24T10:00:00.000Z",
    updatedBy: "admin",
  });
});

test("radio domain resolve preference restituisce fallback a tre slot null", () => {
  const preference = resolveRadioPreference(
    {
      radioChannels: [{ id: "cucina", name: "Cucina", enabled: true }],
      radioPreferences: [],
    },
    "u_lorenzo",
    "dev_1"
  );

  assert.deepEqual(preference, {
    id: "u_lorenzo:dev_1",
    userId: "u_lorenzo",
    deviceUuid: "dev_1",
    slots: [null, null, null],
    updatedAt: "",
  });
});

test("radio domain resolve preference riusa l'ultima configurazione dell'utente su un nuovo device", () => {
  const preference = resolveRadioPreference(
    {
      radioChannels: [
        { id: "bar", name: "Bar", enabled: true },
        { id: "generale", name: "Generale", enabled: true },
        { id: "cassa", name: "Cassa", enabled: true },
      ],
      radioPreferences: [
        {
          userId: "u_lorenzo",
          deviceUuid: "palmare_vecchio",
          slots: ["bar", "generale", "cassa"],
          updatedAt: "2026-06-24T09:00:00.000Z",
        },
        {
          userId: "u_altro",
          deviceUuid: "palmare_01",
          slots: ["cassa", "bar", "generale"],
          updatedAt: "2026-06-24T10:00:00.000Z",
        },
      ],
    },
    "u_lorenzo",
    "palmare_nuovo"
  );

  assert.deepEqual(preference, {
    id: "u_lorenzo:palmare_nuovo",
    userId: "u_lorenzo",
    deviceUuid: "palmare_nuovo",
    slots: ["bar", "generale", "cassa"],
    updatedAt: "2026-06-24T09:00:00.000Z",
  });
});

test("radio domain resolve preference preferisce l'ultima configurazione dell'utente", () => {
  const preference = resolveRadioPreference(
    {
      radioChannels: [
        { id: "bar", name: "Bar", enabled: true },
        { id: "generale", name: "Generale", enabled: true },
        { id: "cassa", name: "Cassa", enabled: true },
      ],
      radioPreferences: [
        {
          userId: "u_lorenzo",
          deviceUuid: "palmare_vecchio",
          slots: ["bar", "generale", "cassa"],
          updatedAt: "2026-06-24T11:00:00.000Z",
        },
        {
          userId: "u_lorenzo",
          deviceUuid: "palmare_nuovo",
          slots: ["cassa", null, "bar"],
          updatedAt: "2026-06-24T10:00:00.000Z",
        },
      ],
    },
    "u_lorenzo",
    "palmare_nuovo"
  );

  assert.deepEqual(preference, {
    id: "u_lorenzo:palmare_nuovo",
    userId: "u_lorenzo",
    deviceUuid: "palmare_nuovo",
    slots: ["bar", "generale", "cassa"],
    updatedAt: "2026-06-24T11:00:00.000Z",
  });
});

test("radio domain resolve preference mantiene il device corrente quando e' la configurazione piu recente", () => {
  const preference = resolveRadioPreference(
    {
      radioChannels: [
        { id: "bar", name: "Bar", enabled: true },
        { id: "generale", name: "Generale", enabled: true },
        { id: "cassa", name: "Cassa", enabled: true },
      ],
      radioPreferences: [
        {
          userId: "u_lorenzo",
          deviceUuid: "palmare_vecchio",
          slots: ["bar", "generale", "cassa"],
          updatedAt: "2026-06-24T10:00:00.000Z",
        },
        {
          userId: "u_lorenzo",
          deviceUuid: "palmare_nuovo",
          slots: ["cassa", null, "bar"],
          updatedAt: "2026-06-24T11:00:00.000Z",
        },
      ],
    },
    "u_lorenzo",
    "palmare_nuovo"
  );

  assert.deepEqual(preference, {
    id: "u_lorenzo:palmare_nuovo",
    userId: "u_lorenzo",
    deviceUuid: "palmare_nuovo",
    slots: ["cassa", null, "bar"],
    updatedAt: "2026-06-24T11:00:00.000Z",
  });
});
