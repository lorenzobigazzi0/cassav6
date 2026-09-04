import assert from "node:assert/strict";
import test from "node:test";
import {
  commitStationAvailabilityNotification,
  createStationAvailabilityNotificationKey,
  reserveStationAvailabilityNotification,
} from "../modules/integration/station-availability-notifications.js";

test("station availability notifications deduplicano lo stesso evento ravvicinato", () => {
  const integration = {};
  const first = reserveStationAvailabilityNotification(integration, {
    eventType: "station_offline",
    station: "BAR-1",
    nowMs: 10_000,
    ttlMs: 120_000,
  });
  assert.equal(first.suppressed, false);
  commitStationAvailabilityNotification(integration, first, { id: "notification-1" });

  const duplicate = reserveStationAvailabilityNotification(integration, {
    eventType: "station_offline",
    station: "BAR-1",
    nowMs: 20_000,
    ttlMs: 120_000,
  });

  assert.equal(duplicate.suppressed, true);
  assert.equal(duplicate.previous.notificationId, "notification-1");
});

test("station availability notifications permettono eventi diversi o fuori TTL", () => {
  const integration = {};
  const offline = reserveStationAvailabilityNotification(integration, {
    eventType: "station_offline",
    station: "BAR-1",
    nowMs: 10_000,
    ttlMs: 120_000,
  });
  commitStationAvailabilityNotification(integration, offline, { id: "offline-1" });

  assert.equal(
    reserveStationAvailabilityNotification(integration, {
      eventType: "station_online",
      station: "BAR-1",
      nowMs: 20_000,
      ttlMs: 120_000,
    }).suppressed,
    false,
  );
  assert.equal(
    reserveStationAvailabilityNotification(integration, {
      eventType: "station_offline",
      station: "BAR-1",
      nowMs: 140_001,
      ttlMs: 120_000,
    }).suppressed,
    false,
  );
});

test("station availability notifications normalizzano restored e no active", () => {
  assert.equal(
    createStationAvailabilityNotificationKey({ eventType: "no_active_stations" }),
    "no_active_stations:global",
  );
  assert.equal(
    createStationAvailabilityNotificationKey({
      eventType: "active_stations_restored",
      activeStations: [{ station: "CUCINA" }, { station: "BAR" }],
    }),
    "active_stations_restored:BAR|CUCINA",
  );
});
