import test from "node:test";
import assert from "node:assert/strict";
import { createPrecontoBrandingHelpers } from "../printing/preconto-branding.domain.js";

function centerPrintText(value, width) {
  const text = String(value ?? "").trim();
  const safeWidth = Math.max(16, Math.trunc(Number(width) || 32));
  if (!text || text.length >= safeWidth) return text;
  return `${" ".repeat(Math.floor((safeWidth - text.length) / 2))}${text}`;
}

function wrapPrintText(value, width) {
  const safeWidth = Math.max(8, Math.trunc(Number(width) || 32));
  const words = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= safeWidth || !current) {
      current = candidate;
      return;
    }
    lines.push(current);
    current = word;
  });
  if (current) lines.push(current);
  return lines;
}

const defaultPrintPreferences = {
  branding: {
    venueName: "Amalia Laghi",
    address: "Via del Lago 1",
    phone: "123",
    companyName: "Amalia SRL",
    vatNumber: "IT001",
  },
  preconto: {
    showVenueName: true,
    showAddress: true,
    showPhone: true,
    showCompanyName: true,
    showVatNumber: true,
  },
};

const helpers = createPrecontoBrandingHelpers({
  centerPrintText,
  defaultPrintPreferences,
  sanitizePosPrintPreferences: (value) => ({
    branding: {
      ...defaultPrintPreferences.branding,
      ...(value?.branding ?? {}),
    },
    preconto: {
      ...defaultPrintPreferences.preconto,
      ...(value?.preconto ?? {}),
    },
  }),
  toPrintSafeUppercase: (value) => String(value ?? "").trim().toLocaleUpperCase("it-IT"),
  wrapPrintText,
});

test("preconto branding costruisce header con locale, indirizzo e telefono", () => {
  const lines = helpers.buildIntegrationPrecontoBrandingHeader(null, 20);
  assert.equal(lines.some((line) => line.includes("AMALIA LAGHI")), true);
  assert.equal(lines.some((line) => line.includes("Via del Lago 1")), true);
  assert.equal(lines.some((line) => line.includes("TEL 123")), true);
});

test("preconto branding rispetta i toggle header", () => {
  const lines = helpers.buildIntegrationPrecontoBrandingHeader(
    {
      preconto: {
        showVenueName: false,
        showAddress: false,
        showPhone: true,
      },
    },
    20
  );
  assert.deepEqual(lines, [centerPrintText("TEL 123", 20)]);
});

test("preconto branding costruisce footer con azienda e partita iva", () => {
  const lines = helpers.buildIntegrationPrecontoBrandingFooter(null, 24);
  assert.equal(lines.some((line) => line.includes("Amalia SRL")), true);
  assert.equal(lines.some((line) => line.includes("P.IVA IT001")), true);
});

test("preconto branding rispetta i toggle footer", () => {
  const lines = helpers.buildIntegrationPrecontoBrandingFooter(
    {
      preconto: {
        showCompanyName: false,
        showVatNumber: true,
      },
      branding: {
        vatNumber: "IT999",
      },
    },
    24
  );
  assert.deepEqual(lines, [centerPrintText("P.IVA IT999", 24)]);
});

test("preconto branding filtra righe vuote", () => {
  const lines = helpers.buildIntegrationPrecontoBrandingHeader(
    {
      branding: {
        venueName: "",
        address: "",
        phone: "",
      },
    },
    20
  );
  assert.deepEqual(lines, []);
});
