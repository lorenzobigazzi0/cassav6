import { afterEach, describe, expect, it } from "vitest";
import {
  INTEGRATION_QUEUE_STORAGE_KEY,
  isIntegrationQueueActionOwnedBy,
  loadIntegrationQueueFromStorage,
  saveIntegrationQueueToStorage,
} from "../src/domain/tables/integrationQueueStorage";

const owner = {
  userId: "user-1",
  activityId: "activity-1",
  deviceUuid: "device-1",
};

describe("integration queue storage", () => {
  afterEach(() => {
    window.localStorage.removeItem(INTEGRATION_QUEUE_STORAGE_KEY);
  });

  it("loads only valid queued integration actions", () => {
    window.localStorage.setItem(
      INTEGRATION_QUEUE_STORAGE_KEY,
      JSON.stringify([
        {
          kind: "order_create",
          owner,
          roomId: "room_bar",
          tableId: "room_bar_t01",
          localOrderId: "local_1",
          payload: { ok: true, token: "expired-token" },
          queuedAtMs: 100,
        },
        {
          kind: "order_sync",
          orderId: "12345",
          payload: { workflowStatus: "ready", ...owner },
          queuedAtMs: 200,
        },
        {
          kind: "layout_sync",
          owner,
          tableId: "room_bar_t01",
          payload: {
            basePayload: { tableId: "room_bar_t01" },
            payloadWithSession: null,
          },
          queuedAtMs: 300,
        },
        {
          kind: "order_create",
          roomId: "",
          tableId: "room_bar_t01",
          payload: {},
        },
        { kind: "unknown", queuedAtMs: 400 },
      ])
    );

    expect(loadIntegrationQueueFromStorage()).toEqual([
      {
        kind: "order_create",
        owner,
        roomId: "room_bar",
        tableId: "room_bar_t01",
        localOrderId: "local_1",
        payload: { ok: true },
        queuedAtMs: 100,
      },
      {
        kind: "order_sync",
        owner,
        orderId: "12345",
        payload: { workflowStatus: "ready", ...owner },
        queuedAtMs: 200,
      },
      {
        kind: "layout_sync",
        owner,
        tableId: "room_bar_t01",
        payload: {
          basePayload: { tableId: "room_bar_t01" },
          payloadWithSession: null,
        },
        queuedAtMs: 300,
      },
    ]);
  });

  it("returns an empty queue when storage is invalid", () => {
    window.localStorage.setItem(INTEGRATION_QUEUE_STORAGE_KEY, "{invalid");

    expect(loadIntegrationQueueFromStorage()).toEqual([]);
  });

  it("saves queued actions using the stable storage key", () => {
    saveIntegrationQueueToStorage([
      {
        kind: "order_sync",
        owner,
        orderId: "12345",
        payload: { workflowStatus: "prep", token: "expired-token" },
        queuedAtMs: 123,
      },
    ]);

    expect(JSON.parse(window.localStorage.getItem(INTEGRATION_QUEUE_STORAGE_KEY) ?? "[]")).toEqual([
      {
        kind: "order_sync",
        owner,
        orderId: "12345",
        payload: { workflowStatus: "prep" },
        queuedAtMs: 123,
      },
    ]);
  });

  it("keeps queued work isolated to its user, activity and device", () => {
    const [action] = loadQueueWithOwner();

    expect(isIntegrationQueueActionOwnedBy(action, owner)).toBe(true);
    expect(isIntegrationQueueActionOwnedBy(action, { ...owner, activityId: "activity-2" })).toBe(
      false
    );
    expect(isIntegrationQueueActionOwnedBy(action, { ...owner, userId: "user-2" })).toBe(false);
  });
});

const loadQueueWithOwner = () => {
  window.localStorage.setItem(
    INTEGRATION_QUEUE_STORAGE_KEY,
    JSON.stringify([
      {
        kind: "order_sync",
        owner,
        orderId: "12345",
        payload: { workflowStatus: "prep" },
        queuedAtMs: 123,
      },
    ])
  );
  return loadIntegrationQueueFromStorage();
};
