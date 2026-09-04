import assert from "node:assert/strict";
import test from "node:test";

import {
  isStatusOnlyReadyDuplicateOrderSync,
  isTerminalDuplicateOrderSyncNoop,
} from "../modules/orders/terminal-duplicate-sync-prelane.js";

test("terminal duplicate sync accepts delivered regressions and status-only ready duplicates", () => {
  assert.equal(
    isTerminalDuplicateOrderSyncNoop(
      { id: "ord_1", workflowStatus: "delivered" },
      "ready",
      { workflowStatus: "ready", items: [{ id: "line_1", done: false }] },
    ),
    true,
  );
  assert.equal(
    isTerminalDuplicateOrderSyncNoop(
      { id: "ord_1", workflowStatus: "delivered" },
      "delivered",
      { workflowStatus: "delivered", lineRoutes: [{ station: "bar" }] },
    ),
    true,
  );
  assert.equal(
    isTerminalDuplicateOrderSyncNoop(
      { id: "ord_2", workflowStatus: "ready" },
      "ready",
      { workflowStatus: "ready", station: "bar", ownerStation: "bar" },
    ),
    true,
  );
});

test("ready duplicate sync refuses payloads that can mutate order details", () => {
  assert.equal(
    isStatusOnlyReadyDuplicateOrderSync({
      workflowStatus: "ready",
      station: "bar",
      ownerStation: "bar",
    }),
    true,
  );
  for (const rawOrder of [
    { workflowStatus: "ready", items: [] },
    { workflowStatus: "ready", lineRoutes: [] },
    { workflowStatus: "ready", orderNote: "senza ghiaccio" },
    { workflowStatus: "ready", lockedByStationId: "bar" },
    { station: "bar", ownerStation: "bar" },
  ]) {
    assert.equal(
      isTerminalDuplicateOrderSyncNoop(
        { id: "ord_3", workflowStatus: "ready" },
        "ready",
        rawOrder,
      ),
      false,
      JSON.stringify(rawOrder),
    );
  }
});
