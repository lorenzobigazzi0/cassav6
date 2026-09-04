import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelAutomaticCashMovement,
  cancelAutomaticCashDeposit,
  completeAutomaticCashMovement,
  confirmAutomaticCashFloatTicketInPouch,
  closeAutomaticCashDeposit,
  confirmAutomaticCashFloatRemoved,
  getActiveAutomaticCashMovement,
  getActiveAutomaticCashWorkflow,
  getAutomaticCashMovements,
  getAutomaticCashSettlementRecords,
  generateAutomaticCashFloat,
  getAutomaticCashGatewayState,
  getLatestAutomaticCashSettlementRecord,
  getAutomaticCashPreflight,
  getAutomaticCashSettings,
  getAutomaticCashStatus,
  isAutomaticCashApiError,
  loadAutomaticCashFloatFromQr,
  markAutomaticCashFloatTicketPrinted,
  saveAutomaticCashSettlementRecordToDb,
  startAutomaticCashMovement,
  startAutomaticCashDeposit,
  updateAutomaticCashSettings,
  uploadAutomaticCashConfigSet,
  uploadAutomaticCashReserveConfig,
} from "../src/api/automaticCash";
import { AUTH_STORAGE_KEYS } from "../src/shared/storage/authStorage";
import type { AutomaticCashApiError, AutomaticCashSettings } from "../src/types/automaticCash";

type FakeResponseInit = {
  status?: number;
  body?: unknown;
  url?: string;
};

const settings: AutomaticCashSettings = {
  enabled: true,
  gatewayConfigured: true,
  feedbackEnabled: true,
  warningThresholdCents: 500,
  dangerThresholdCents: 2000,
  autoCashFloatMode: "random_file",
  configSet: {
    id: "set-2026-06-25",
    name: "Fondo cassa",
    currency: "EUR",
    combinationsCount: 100,
    minTotalCents: 12000,
    maxTotalCents: 16000,
    uniquePerUserPerBusinessEvening: true,
  },
  reserveConfig: {
    id: "reserve-2026-06-25",
    name: "Riserva",
    currency: "EUR",
    enabled: true,
    missingDenominationPolicy: "reject",
    denominationsCount: 9,
    minimumPiecesTotal: 120,
  },
};

function makeResponse({ status = 200, body, url = "/api/automatic-cash/test" }: FakeResponseInit) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => text,
  } as unknown as Response;
}

const fetchMock = () =>
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async (input) =>
    makeResponse({ body: { ok: true }, url: input })
  );

const expectLastRequest = (
  fetch: ReturnType<typeof fetchMock>,
  path: string,
  method: string,
  body?: unknown
) => {
  const [input, init] = fetch.mock.calls.at(-1) ?? [];
  expect(input).toBe(path);
  expect(String(init?.method || "GET").toUpperCase()).toBe(method);
  if (method !== "GET") {
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
  }
  if (body !== undefined) expect(JSON.parse(String(init?.body))).toEqual(body);
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("automaticCash API client", () => {
  it("uses only backend automatic-cash endpoints", async () => {
    const fetch = fetchMock();
    vi.stubGlobal("fetch", fetch);

    await getAutomaticCashSettings();
    expectLastRequest(fetch, "/api/automatic-cash/settings", "GET");

    await getAutomaticCashStatus();
    expectLastRequest(fetch, "/api/automatic-cash/status", "GET");

    await getAutomaticCashGatewayState();
    expectLastRequest(fetch, "/api/automatic-cash/gateway/state", "GET");

    await getAutomaticCashMovements();
    expectLastRequest(fetch, "/api/automatic-cash/cash-movements", "GET");

    await getActiveAutomaticCashMovement();
    expectLastRequest(fetch, "/api/automatic-cash/cash-movements/active", "GET");

    await startAutomaticCashMovement({
      clientRequestId: "movement-request-1",
      type: "withdrawal",
      amountCents: 2500,
      justification: "Prelievo acquisto urgente",
      deviceUuid: "device-1",
      roomId: "room-main",
    });
    expectLastRequest(fetch, "/api/automatic-cash/cash-movements/start", "POST", {
      clientRequestId: "movement-request-1",
      type: "withdrawal",
      amountCents: 2500,
      justification: "Prelievo acquisto urgente",
      deviceUuid: "device-1",
      roomId: "room-main",
    });

    await completeAutomaticCashMovement("cashmov-1");
    expectLastRequest(fetch, "/api/automatic-cash/cash-movements/cashmov-1/complete", "POST", {
      movementId: "cashmov-1",
    });

    await cancelAutomaticCashMovement("cashmov-1");
    expectLastRequest(fetch, "/api/automatic-cash/cash-movements/cashmov-1/cancel", "POST", {
      movementId: "cashmov-1",
    });

    await getAutomaticCashPreflight();
    expectLastRequest(fetch, "/api/automatic-cash/cash-float/preflight", "GET");

    await getActiveAutomaticCashWorkflow();
    expectLastRequest(fetch, "/api/automatic-cash/cash-float/active", "GET");

    await generateAutomaticCashFloat({ deviceUuid: "device-1", roomId: "room-main" });
    expectLastRequest(fetch, "/api/automatic-cash/cash-float/generate", "POST", {
      preferExistingAssignmentForEvening: true,
      deviceUuid: "device-1",
      roomId: "room-main",
    });

    await confirmAutomaticCashFloatRemoved({
      workflowId: "fcw-1",
      operationId: "op-1",
      cashFloatId: "FCA-1",
    });
    expectLastRequest(fetch, "/api/automatic-cash/cash-float/confirm-removed", "POST", {
      workflowId: "fcw-1",
      operationId: "op-1",
      cashFloatId: "FCA-1",
    });

    await markAutomaticCashFloatTicketPrinted({
      workflowId: "fcw-1",
      cashFloatId: "FCA-1",
      printJobId: "printer-1",
      printedAtMs: 1782468000000,
    });
    expectLastRequest(fetch, "/api/automatic-cash/cash-float/ticket/printed", "POST", {
      workflowId: "fcw-1",
      cashFloatId: "FCA-1",
      printJobId: "printer-1",
      printedAtMs: 1782468000000,
    });

    await confirmAutomaticCashFloatTicketInPouch({ workflowId: "fcw-1", cashFloatId: "FCA-1" });
    expectLastRequest(fetch, "/api/automatic-cash/cash-float/confirm-ticket-in-pouch", "POST", {
      workflowId: "fcw-1",
      cashFloatId: "FCA-1",
    });

    await loadAutomaticCashFloatFromQr({ qrPayload: "qr:payload", deviceUuid: "device-1" });
    expectLastRequest(fetch, "/api/automatic-cash/cash-float/load-from-qr", "POST", {
      qrPayload: "qr:payload",
      deviceUuid: "device-1",
    });

    await getAutomaticCashSettlementRecords();
    expectLastRequest(fetch, "/api/automatic-cash/settlements", "GET");

    await getLatestAutomaticCashSettlementRecord();
    expectLastRequest(fetch, "/api/automatic-cash/settlements/latest", "GET");

    await saveAutomaticCashSettlementRecordToDb({
      id: "FCA-1:1782468000000",
      operationId: "dep-1",
      cashFloatId: "FCA-1",
      assignmentId: "ASN-1",
      combinationId: "COMBO-1",
      businessEveningKey: "2026-06-26",
      userId: "u-admin",
      deviceUuid: "device-1",
      operatorName: "Admin",
      station: "postazione-1",
      roomId: "room-main",
      roomName: "Sala",
      expectedDepositTotalCents: 10_000,
      depositedTotalCents: 9_500,
      differenceCents: 500,
      mismatchConfirmed: false,
      feedbackKind: "sad",
      printText: "SCARICO",
      details: { snapshot: { amountToDeposit: 100 } },
      completedAtMs: 1_782_468_000_000,
    });
    expectLastRequest(fetch, "/api/automatic-cash/settlements", "POST", {
      id: "FCA-1:1782468000000",
      operationId: "dep-1",
      cashFloatId: "FCA-1",
      assignmentId: "ASN-1",
      combinationId: "COMBO-1",
      businessEveningKey: "2026-06-26",
      userId: "u-admin",
      deviceUuid: "device-1",
      operatorName: "Admin",
      station: "postazione-1",
      roomId: "room-main",
      roomName: "Sala",
      expectedDepositTotalCents: 10_000,
      depositedTotalCents: 9_500,
      differenceCents: 500,
      mismatchConfirmed: false,
      feedbackKind: "sad",
      printText: "SCARICO",
      details: { snapshot: { amountToDeposit: 100 } },
      completedAtMs: 1_782_468_000_000,
    });

    await startAutomaticCashDeposit({ deviceUuid: "device-1", cashFloatId: "FCA-1" });
    expectLastRequest(fetch, "/api/automatic-cash/deposit/start", "POST", {
      deviceUuid: "device-1",
      cashFloatId: "FCA-1",
    });

    await closeAutomaticCashDeposit({ operationId: "op-1" });
    expectLastRequest(fetch, "/api/automatic-cash/deposit/close", "POST", {
      operationId: "op-1",
    });

    await cancelAutomaticCashDeposit({ operationId: "op-1" });
    expectLastRequest(fetch, "/api/automatic-cash/deposit/cancel", "POST", {
      operationId: "op-1",
    });
  });

  it("updates mobile-admin settings with PUT /settings", async () => {
    const fetch = vi.fn(async (input: string) => makeResponse({ body: settings, url: input }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      updateAutomaticCashSettings({
        enabled: true,
        feedbackEnabled: false,
        warningThresholdCents: 600,
        dangerThresholdCents: 2200,
        autoCashFloatMode: "random_file",
        configSetId: "set-2026-06-25",
      })
    ).resolves.toEqual(settings);

    expectLastRequest(
      fetch as ReturnType<typeof fetchMock>,
      "/api/automatic-cash/settings",
      "PUT",
      {
        enabled: true,
        feedbackEnabled: false,
        warningThresholdCents: 600,
        dangerThresholdCents: 2200,
        autoCashFloatMode: "random_file",
        configSetId: "set-2026-06-25",
      }
    );
  });

  it("uploads automatic cash config sets to the backend", async () => {
    const fetch = vi.fn(async (input: string) => makeResponse({ body: settings, url: input }));
    vi.stubGlobal("fetch", fetch);
    const payload = {
      config: {
        nome: "Fondo cassa serale",
        valuta: "EUR",
        denominazioni_centesimi: {
          "1_euro": 100,
          "2_euro": 200,
        },
        combinazioni: [
          {
            id: "FC-001",
            totale_centesimi: 500,
            pezzi_totali: 3,
            tagli: {
              "1_euro": 1,
              "2_euro": 2,
            },
          },
        ],
      },
      clientSummary: {
        id: "client_fondo_cassa_serale",
        name: "Fondo cassa serale",
        currency: "EUR",
        combinationsCount: 1,
        minTotalCents: 500,
        maxTotalCents: 500,
        uniquePerUserPerBusinessEvening: true,
      },
    };

    await expect(uploadAutomaticCashConfigSet(payload)).resolves.toEqual(settings);

    expectLastRequest(
      fetch as ReturnType<typeof fetchMock>,
      "/api/automatic-cash/config-sets",
      "POST",
      payload
    );
  });

  it("uploads automatic cash reserve config to the backend", async () => {
    const fetch = vi.fn(async (input: string) => makeResponse({ body: settings, url: input }));
    vi.stubGlobal("fetch", fetch);
    const payload = {
      config: {
        schema_version: 1 as const,
        id: "reserve-main-v1",
        nome: "Riserva minima",
        valuta: "EUR" as const,
        enabled: true,
        missing_denomination_policy: "reject" as const,
        denominazioni_centesimi: {
          "1_euro": 100,
          "2_euro": 200,
        },
        riserva_minima_pezzi: {
          "1_euro": 10,
          "2_euro": 8,
        },
      },
      clientSummary: {
        id: "reserve-main-v1",
        name: "Riserva minima",
        currency: "EUR" as const,
        enabled: true,
        missingDenominationPolicy: "reject" as const,
        denominationsCount: 2,
        minimumPiecesTotal: 18,
      },
    };

    await expect(uploadAutomaticCashReserveConfig(payload)).resolves.toEqual(settings);

    expectLastRequest(
      fetch as ReturnType<typeof fetchMock>,
      "/api/automatic-cash/reserve-configs",
      "POST",
      payload
    );
  });

  it("sends stored mobile session headers to protected automatic-cash endpoints", async () => {
    window.localStorage.setItem(AUTH_STORAGE_KEYS.token, "token-1");
    window.localStorage.setItem(AUTH_STORAGE_KEYS.userId, "u_admin");
    window.localStorage.setItem(AUTH_STORAGE_KEYS.deviceUuid, "dev_1");
    const fetch = vi.fn(async (input: string) => makeResponse({ body: settings, url: input }));
    vi.stubGlobal("fetch", fetch);

    await getAutomaticCashSettings();
    expect(fetch.mock.calls.at(-1)?.[1]?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer token-1",
      "X-User-Id": "u_admin",
      "X-Device-Uuid": "dev_1",
    });

    await updateAutomaticCashSettings({ enabled: true });
    expect(fetch.mock.calls.at(-1)?.[1]?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer token-1",
      "X-User-Id": "u_admin",
      "X-Device-Uuid": "dev_1",
    });
  });

  it.each([
    [423, "AUTOMATIC_CASH_LOCKED"],
    [409, "FCA_ACTIVE_WORKFLOW"],
    [400, "BAD_REQUEST"],
    [503, "FCA_GATEWAY_UNREACHABLE"],
  ] as const)("normalizes HTTP %s automatic-cash errors", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        makeResponse({
          status,
          body: { message: "Errore automatic cash" },
          url: input,
        })
      )
    );

    const error = (await getAutomaticCashSettings().catch(
      (caught) => caught
    )) as AutomaticCashApiError;
    expect(isAutomaticCashApiError(error)).toBe(true);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.payload).toEqual({ message: "Errore automatic cash" });
  });

  it("keeps backend error codes when present in the payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        makeResponse({
          status: 400,
          body: {
            error: "AUTOMATIC_CASH_NOT_CONFIGURED",
            message: "Gateway o fondo cassa non configurati",
          },
          url: input,
        })
      )
    );

    const error = (await getAutomaticCashSettings().catch(
      (caught) => caught
    )) as AutomaticCashApiError;
    expect(error.code).toBe("AUTOMATIC_CASH_NOT_CONFIGURED");
    expect(error.message).toBe("Gateway o fondo cassa non configurati");
  });

  it("does not call RealSngGateway directly", () => {
    const source = readFileSync(resolve(process.cwd(), "src/api/automaticCash.ts"), "utf8");
    expect(source).not.toContain("RealSngGateway");
    expect(source).not.toContain("realsng");
    expect(source).not.toContain("window.fetch");
    expect(source).toContain('const BASE = "/api/automatic-cash"');
  });
});
