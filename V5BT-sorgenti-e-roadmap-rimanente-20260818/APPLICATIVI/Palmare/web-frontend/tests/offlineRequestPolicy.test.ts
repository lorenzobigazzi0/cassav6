import { describe, expect, it } from "vitest";
import {
  classifyOfflineRequest,
  isOfflineFailureStatus,
  shouldQueueMutationAfterHttpResponse,
} from "../src/shared/offline/offlineRequestPolicy";
import { offlineCacheKey } from "../src/shared/offline/offlineStore";

describe("Palmare offline request policy", () => {
  it("caches normal reads and selected POST read models", () => {
    expect(classifyOfflineRequest("/api/integration/menu", "GET").mode).toBe("read-cache");
    expect(classifyOfflineRequest("/api/pos/rooms", "POST").mode).toBe("read-cache");
    expect(classifyOfflineRequest("/api/auth/session/status", "POST").mode).toBe("read-cache");
  });

  it("leaves integration order/layout retries to their existing domain queue", () => {
    expect(classifyOfflineRequest("/api/integration/orders/create", "POST").mode).toBe("none");
    expect(classifyOfflineRequest("/api/integration/layout/table/sync", "POST").mode).toBe("none");
    expect(classifyOfflineRequest("/api/integration/layout/table/move", "POST").mode).toBe("none");
    expect(
      classifyOfflineRequest("/api/integration/layout/table/room-move/request", "POST").mode
    ).toBe("none");
  });

  it("non salva operazioni critiche che non hanno riconciliazione autorevole", () => {
    expect(classifyOfflineRequest("/api/payments/free-split", "POST").mode).toBe("none");
    expect(classifyOfflineRequest("/api/automatic-cash/settlement/start", "POST").mode).toBe(
      "none"
    );
    expect(classifyOfflineRequest("/api/integration/print", "POST").mode).toBe("none");
    expect(classifyOfflineRequest("/api/mobile/waiter-pause/start", "POST").mode).toBe("none");
    expect(classifyOfflineRequest("/api/mobile/radio/config/save", "POST").mode).toBe("none");
    expect(classifyOfflineRequest("/api/monitor/control", "POST").mode).toBe("none");
  });

  it("riconcilia automaticamente emissione e annullamento fiscale", () => {
    expect(classifyOfflineRequest("/api/reports/payment-movement/fiscal/issue", "POST").mode).toBe(
      "automatic"
    );
    expect(classifyOfflineRequest("/api/reports/payment-movement/fiscal/void", "POST").mode).toBe(
      "automatic"
    );
  });

  it("automatically replays ordinary idempotent mutations", () => {
    expect(classifyOfflineRequest("/api/pos/reservations/create", "POST").mode).toBe("automatic");
    expect(classifyOfflineRequest("/api/pos/reservations/status", "POST").mode).toBe("automatic");
    expect(classifyOfflineRequest("/api/integration/notifications/ack", "POST").mode).toBe(
      "automatic"
    );
  });

  it("recognizes only network/proxy failure statuses as offline failures", () => {
    expect(isOfflineFailureStatus(0)).toBe(true);
    expect(isOfflineFailureStatus(503)).toBe(true);
    expect(isOfflineFailureStatus(409)).toBe(false);
  });

  it("accoda solo le mutazioni dotate di replay idempotente o riconciliazione", () => {
    const fiscal = classifyOfflineRequest("/api/reports/payment-movement/fiscal/issue", "POST");
    const payment = classifyOfflineRequest("/api/payments/free-split", "POST");
    const ordinary = classifyOfflineRequest("/api/pos/reservations/create", "POST");

    expect(shouldQueueMutationAfterHttpResponse(fiscal, 502)).toBe(true);
    expect(shouldQueueMutationAfterHttpResponse(fiscal, 503)).toBe(true);
    expect(shouldQueueMutationAfterHttpResponse(payment, 503)).toBe(false);
    expect(shouldQueueMutationAfterHttpResponse(ordinary, 503)).toBe(true);
  });

  it("does not duplicate cache entries for timestamp cache-busters", () => {
    const first = offlineCacheKey("GET", "https://pos.local/api/tables?_=100&room=b", null);
    const second = offlineCacheKey("GET", "https://pos.local/api/tables?room=b&_=200", null);
    expect(first).toBe(second);
  });
});
