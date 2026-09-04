import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeIntegrationOrderTimestamp,
  resolveIntegrationReadyAtMs,
} from "../modules/orders/order-timestamps.js";

test("normalizeIntegrationOrderTimestamp normalizes parseable date strings to ISO", () => {
  assert.equal(
    normalizeIntegrationOrderTimestamp("2026-06-07T10:15:30.000Z"),
    "2026-06-07T10:15:30.000Z"
  );
});

test("normalizeIntegrationOrderTimestamp preserves non-parseable non-empty strings", () => {
  assert.equal(normalizeIntegrationOrderTimestamp(" turno-manuale "), "turno-manuale");
});

test("normalizeIntegrationOrderTimestamp normalizes positive numeric epoch milliseconds", () => {
  const epochMs = Date.UTC(2026, 5, 7, 10, 15, 30, 123);
  assert.equal(normalizeIntegrationOrderTimestamp(epochMs), "2026-06-07T10:15:30.123Z");
});

test("normalizeIntegrationOrderTimestamp preserves numeric strings for legacy compatibility", () => {
  const epochMs = String(Date.UTC(2026, 5, 7, 10, 15, 30, 123));
  assert.equal(normalizeIntegrationOrderTimestamp(epochMs), epochMs);
});

test("normalizeIntegrationOrderTimestamp rejects empty, zero, negative and non-finite values", () => {
  assert.equal(normalizeIntegrationOrderTimestamp("   "), null);
  assert.equal(normalizeIntegrationOrderTimestamp(0), null);
  assert.equal(normalizeIntegrationOrderTimestamp(-1), null);
  assert.equal(normalizeIntegrationOrderTimestamp(Number.NaN), null);
  assert.equal(normalizeIntegrationOrderTimestamp(null), null);
});

test("resolveIntegrationReadyAtMs preserves positive readyAtMs values", () => {
  assert.equal(resolveIntegrationReadyAtMs({ readyAtMs: 1234.99 }, { fallbackNowMs: 9999 }), 1234);
  assert.equal(resolveIntegrationReadyAtMs({ readyAtMs: "5678" }, { fallbackNowMs: 9999 }), 5678);
});

test("resolveIntegrationReadyAtMs uses deterministic fallback when readyAtMs is missing or invalid", () => {
  assert.equal(resolveIntegrationReadyAtMs({}, { fallbackNowMs: 9876.54 }), 9876);
  assert.equal(resolveIntegrationReadyAtMs({ readyAtMs: 0 }, { fallbackNowMs: 9876 }), 9876);
  assert.equal(resolveIntegrationReadyAtMs({ readyAtMs: -1 }, { fallbackNowMs: 9876 }), 9876);
  assert.equal(resolveIntegrationReadyAtMs({ readyAtMs: Number.NaN }, { fallbackNowMs: 9876 }), 9876);
});

test("resolveIntegrationReadyAtMs falls back to Date.now when no deterministic fallback is supplied", () => {
  const before = Date.now();
  const resolved = resolveIntegrationReadyAtMs(null);
  const after = Date.now();
  assert.ok(resolved >= before);
  assert.ok(resolved <= after);
});
