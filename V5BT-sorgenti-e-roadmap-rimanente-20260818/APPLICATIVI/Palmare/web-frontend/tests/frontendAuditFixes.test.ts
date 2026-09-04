import { afterEach, describe, expect, it, vi } from "vitest";
import { isMockAuthEnabled } from "../src/api/auth";
import { resolveOrderStationName } from "../src/api/menu";
import { buildIntegrationOrderFingerprint } from "../src/api/tables";

describe("frontend audit fixes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps mock auth disabled in production unless explicitly enabled", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("MODE", "production");
    vi.stubEnv("VITE_ENABLE_MOCK_AUTH", "");

    expect(isMockAuthEnabled()).toBe(false);
  });

  it("allows mock auth with the explicit frontend flag", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("MODE", "production");
    vi.stubEnv("VITE_ENABLE_MOCK_AUTH", "true");

    expect(isMockAuthEnabled()).toBe(true);
  });

  it("resolves the order station from an explicit value before fallback config", () => {
    expect(resolveOrderStationName("CUCINA")).toBe("CUCINA");
    expect(resolveOrderStationName("")).toBe("");
  });

  it("includes line price data in integration order fingerprints", () => {
    const makeOrder = (unitPriceApplied: number) =>
      ({
        id: "ord_1",
        roomId: "sala_main",
        tableId: "table_1",
        tableNumber: 1,
        title: "1x Spritz",
        total: unitPriceApplied,
        workflowStatus: "waiting",
        paymentStatus: "unpaid",
        dueAmount: unitPriceApplied,
        paidAmount: 0,
        orderNote: "",
        orderComment: "",
        createdAtMs: 1,
        updatedAtMs: 2,
        items: [
          {
            id: "item_1",
            lineId: "line_1",
            productId: "prd_1",
            name: "Spritz",
            variant: "",
            note: "",
            unitPriceApplied,
            listPriceAtTime: unitPriceApplied,
            lineType: "",
            voidedAt: "",
            done: false,
          },
        ],
      }) as Parameters<typeof buildIntegrationOrderFingerprint>[0];

    expect(buildIntegrationOrderFingerprint(makeOrder(7))).not.toEqual(
      buildIntegrationOrderFingerprint(makeOrder(9))
    );
  });
});
