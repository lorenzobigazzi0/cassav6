import assert from "node:assert/strict";
import test from "node:test";
import { createPosLocaleConfigHelpers } from "../modules/configuration/locale-config.domain.js";

const helpers = createPosLocaleConfigHelpers({
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

test("locale config sanitizza locale con alias legacy e limiti", () => {
  assert.deepEqual(
    helpers.sanitizePosLocale({
      localeId: " Locale Amalia ",
      label: " Amalia Laghi ",
      shortName: " Amalia ",
      ragioneSociale: " Amalia Laghi SRL ",
      piva: " 12345678901 ",
      indirizzo: " Via Lago 1 ",
      sdi: " ABC1234 ",
      legaleRappresentante: " Titolare ",
      enabled: false,
    }),
    {
      id: "locale_amalia",
      name: "Amalia Laghi",
      alias: "Amalia",
      businessName: "Amalia Laghi SRL",
      vatNumber: "12345678901",
      address: "Via Lago 1",
      sdiCode: "ABC1234",
      legalRepresentative: "Titolare",
      status: "disabled",
    }
  );
});

test("locale config usa fallback sicuro per input assente", () => {
  assert.deepEqual(helpers.sanitizePosLocale(null), {
    id: "locale_default",
    name: "Locale",
    alias: "Locale",
    businessName: "",
    vatNumber: "",
    address: "",
    sdiCode: "",
    legalRepresentative: "",
    status: "active",
  });
});

test("locale config deduplica per id e ordina per alias includendo il primario", () => {
  const primary = helpers.sanitizePosLocale({ id: "locale_primary", name: "Primario", alias: "Beta" });
  const locales = helpers.sanitizePosLocales(
    [
      { id: "locale_z", name: "Zeta", alias: "Zeta" },
      { id: "locale_a", name: "Alfa", alias: "Alfa" },
      { id: "locale_z", name: "Zeta 2", alias: "Gamma" },
    ],
    primary
  );

  assert.deepEqual(
    locales.map((locale) => `${locale.id}:${locale.alias}`),
    ["locale_a:Alfa", "locale_primary:Beta", "locale_z:Gamma"]
  );
});
