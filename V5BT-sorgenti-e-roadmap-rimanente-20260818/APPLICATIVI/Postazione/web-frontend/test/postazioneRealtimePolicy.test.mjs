import assert from "node:assert/strict";
import test from "node:test";
import { shouldPullStationNotificationsForReason } from "../src/postazioneRealtimePolicy.js";

test("la Postazione interroga le notifiche solo per eventi notificativi", () => {
  for (const reason of [
    "notification_publish",
    "notification_escalated",
    "waiter_call_deferred",
    "bell_ack_pickup",
  ]) {
    assert.equal(shouldPullStationNotificationsForReason(reason), true, reason);
  }
  for (const reason of [
    "order_created",
    "order_updated",
    "print_requested",
    "table_updated",
    "station_state",
    "",
  ]) {
    assert.equal(
      shouldPullStationNotificationsForReason(reason),
      false,
      reason,
    );
  }
});
