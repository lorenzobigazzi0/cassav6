import { describe, expect, it } from "vitest";
import {
  isRealtimeEventEnvelope,
  normalizeRealtimePayload,
  rememberRealtimeEventId,
  shouldApplyRealtimeEnvelope,
} from "../src/shared/realtime/realtimeEventEnvelope";

describe("realtime event envelope", () => {
  it("riconosce e normalizza l'envelope outbox mantenendo il payload applicativo", () => {
    const envelope = {
      eventId: 42,
      type: "notification.created",
      aggregateType: "notification",
      aggregateId: "n1",
      aggregateVersion: 3,
      payload: {
        reason: "notification_publish",
        detail: { notification: { id: "n1" } },
      },
      createdAt: "2026-07-07T10:00:00.000Z",
    };

    expect(isRealtimeEventEnvelope(envelope)).toBe(true);
    expect(normalizeRealtimePayload(envelope)).toMatchObject({
      eventId: 42,
      type: "notification.created",
      aggregateType: "notification",
      aggregateId: "n1",
      aggregateVersion: 3,
      reason: "notification_publish",
      detail: { notification: { id: "n1" } },
    });
  });

  it("deduplica eventId senza perdere l'ultimo id visto", () => {
    const first = rememberRealtimeEventId([], 9);
    expect(first.duplicate).toBe(false);
    expect(first.next).toEqual([9]);

    const second = rememberRealtimeEventId(first.next, 9);
    expect(second.duplicate).toBe(true);
    expect(second.next).toEqual([9]);
  });

  it("scarta versioni aggregate piu vecchie", () => {
    const versions = new Map<string, number>();
    const current = {
      eventId: 10,
      type: "table.state",
      aggregateType: "table",
      aggregateId: "table_1",
      aggregateVersion: 4,
      payload: {},
    };
    const stale = { ...current, eventId: 11, aggregateVersion: 3 };

    expect(shouldApplyRealtimeEnvelope(versions, current)).toBe(true);
    expect(shouldApplyRealtimeEnvelope(versions, stale)).toBe(false);
  });
});
