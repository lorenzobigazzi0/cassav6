import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAutomaticCashGatewayClient } from "../modules/automatic-cash/automatic-cash.gateway.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createGatewayHarness({ requireRealMode, reportedMode }) {
  const calls = [];
  const gateway = createAutomaticCashGatewayClient({
    enabled: true,
    requireRealMode,
    baseUrl: "http://gateway.test",
    username: "operator",
    password: "secret",
    fetchWithTimeout: async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: options.method ?? "GET" });
      if (path === "/api/login") return jsonResponse({ token: "session-token" });
      if (path === "/api/state") {
        return jsonResponse({
          ...(reportedMode === undefined ? {} : { mode: reportedMode }),
          inventory: { ok: true, listCassette: [] },
        });
      }
      return jsonResponse({ ok: true });
    },
  });
  return { calls, gateway };
}

test("AUTOMATIC_CASH_REAL_ENABLED viene collegato alla guardia del gateway", async () => {
  const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(
    serverSource,
    /const AUTOMATIC_CASH_REAL_ENABLED\s*=\s*\n?\s*process\.env\.AUTOMATIC_CASH_REAL_ENABLED === "1";/,
  );
  assert.match(
    serverSource,
    /requireRealMode:\s*AUTOMATIC_CASH_REAL_ENABLED/,
  );
});

for (const reportedMode of ["SIMULATED", undefined]) {
  test(`modalita reale rifiuta una mutazione con mode ${reportedMode ?? "mancante"}`, async () => {
    const { calls, gateway } = createGatewayHarness({
      requireRealMode: true,
      reportedMode,
    });

    await assert.rejects(
      gateway.startCashinPayment({ operationId: "payment-1", expectedTotalCents: 500 }),
      (error) => {
        assert.equal(error.code, "AUTOMATIC_CASH_REAL_MODE_REQUIRED");
        assert.equal(error.status, 503);
        assert.deepEqual(error.details, {
          expectedMode: "REAL",
          reportedMode: reportedMode ?? null,
        });
        return true;
      },
    );

    assert.deepEqual(
      calls.map(({ path }) => path),
      ["/api/login", "/api/state"],
    );
  });
}

test("modalita reale consente una mutazione solo dopo mode REAL", async () => {
  const { calls, gateway } = createGatewayHarness({
    requireRealMode: true,
    reportedMode: "real",
  });

  await gateway.startCashinPayment({
    operationId: "payment-1",
    expectedTotalCents: 500,
  });

  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/api/login", "/api/state", "/api/cashin/start"],
  );
});

test("flag reale disattivo preserva le mutazioni senza preflight mode", async () => {
  const { calls, gateway } = createGatewayHarness({
    requireRealMode: false,
    reportedMode: undefined,
  });

  await gateway.startCashinPayment({
    operationId: "payment-1",
    expectedTotalCents: 500,
  });

  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/api/login", "/api/cashin/start"],
  );
});

test("GET stato resta disponibile e normalizza mode", async () => {
  const { calls, gateway } = createGatewayHarness({
    requireRealMode: true,
    reportedMode: "real",
  });

  const state = await gateway.getState();

  assert.equal(state.mode, "REAL");
  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/api/login", "/api/state"],
  );
});
