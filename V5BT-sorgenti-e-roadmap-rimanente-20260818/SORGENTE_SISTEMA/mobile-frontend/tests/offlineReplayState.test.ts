import { describe, expect, it } from "vitest";
import type { OfflineOutboxEntry } from "../src/shared/offline/offlineStore";
import {
  classifyOfflineReplayHttpFailure,
  completeOfflineOutboxOwner,
  deriveOfflineOutboxOwner,
  evaluateOfflineReplayOwnership,
  holdExpiredOfflineRequest,
  holdOfflineRequestAfterHttpFailure,
  offlineOutboxEntryMatchesOwner,
  OFFLINE_OUTBOX_LEGACY_MIGRATION_VERSION,
  planLegacyOfflineRequestMigration,
} from "../src/shared/offline/offlineReplayState";

const makeEntry = (overrides: Partial<OfflineOutboxEntry> = {}): OfflineOutboxEntry => ({
  requestId: "request-1",
  idempotencyKey: "request-1",
  url: "/api/example",
  method: "POST",
  headers: {},
  body: "{}",
  replayMode: "automatic",
  status: "pending",
  attempts: 2,
  createdAt: 100,
  updatedAt: 100,
  nextAttemptAt: 100,
  expiresAt: 0,
  lastError: "",
  ...overrides,
});

describe("offline outbox ownership", () => {
  it("derives the owner from case-insensitive auth headers before the request body", () => {
    expect(
      deriveOfflineOutboxOwner({
        headers: {
          "X-User-Id": "header-user",
          "x-activity-id": "activity-a",
          "X-DEVICE-UUID": "device-a",
        },
        body: JSON.stringify({
          userId: "body-user",
          activityId: "body-activity",
          deviceUuid: "body-device",
        }),
      })
    ).toEqual({
      ownerUserId: "header-user",
      ownerActivityId: "activity-a",
      ownerDeviceUuid: "device-a",
    });
  });

  it("derives a legacy owner from the original JSON body", () => {
    expect(
      deriveOfflineOutboxOwner({
        headers: {},
        body: JSON.stringify({
          userId: "legacy-user",
          activityId: "legacy-activity",
          deviceUuid: "legacy-device",
        }),
      })
    ).toEqual({
      ownerUserId: "legacy-user",
      ownerActivityId: "legacy-activity",
      ownerDeviceUuid: "legacy-device",
    });
  });

  it("does not invent an owner for an opaque legacy body", () => {
    expect(deriveOfflineOutboxOwner({ headers: {}, body: "opaque-body" })).toEqual({});
  });

  it("completes a new queue owner from the authenticated activity and device", () => {
    expect(
      completeOfflineOutboxOwner(
        {
          headers: {},
          body: JSON.stringify({ userId: "request-user" }),
        },
        {
          userId: "session-user",
          activityId: "activity-a",
          deviceUuid: "device-a",
        }
      )
    ).toEqual({
      ownerUserId: "request-user",
      ownerActivityId: "activity-a",
      ownerDeviceUuid: "device-a",
    });
  });

  it("allows replay only in the original owner context", () => {
    const entry = makeEntry({
      ownerUserId: "user-a",
      ownerActivityId: "activity-a",
      ownerDeviceUuid: "device-a",
    });
    expect(
      evaluateOfflineReplayOwnership(entry, {
        userId: "user-a",
        activityId: "activity-a",
        deviceUuid: "device-a",
      }).state
    ).toBe("allowed");
    expect(
      evaluateOfflineReplayOwnership(entry, {
        userId: "user-b",
        activityId: "activity-a",
        deviceUuid: "device-a",
      }).state
    ).toBe("different-owner");
    expect(
      evaluateOfflineReplayOwnership(entry, {
        userId: "user-a",
        activityId: "activity-b",
        deviceUuid: "device-a",
      }).state
    ).toBe("different-owner");
  });

  it("blocks replay when a legacy owner cannot be determined", () => {
    expect(
      evaluateOfflineReplayOwnership(makeEntry({ body: "opaque-body" }), {
        userId: "current-user",
        activityId: "activity-a",
        deviceUuid: "device-a",
      }).state
    ).toBe("unknown-owner");
  });

  it("filters queue entries by their explicit or legacy-derived owner", () => {
    const explicit = makeEntry({ ownerUserId: "user-a", ownerActivityId: "activity-a" });
    const legacy = makeEntry({
      body: JSON.stringify({ userId: "user-b", activityId: "activity-b" }),
    });
    expect(offlineOutboxEntryMatchesOwner(explicit, { ownerUserId: "user-a" })).toBe(true);
    expect(offlineOutboxEntryMatchesOwner(explicit, { ownerUserId: "user-b" })).toBe(false);
    expect(
      offlineOutboxEntryMatchesOwner(legacy, {
        ownerUserId: "user-b",
        ownerActivityId: "activity-b",
      })
    ).toBe(true);
    expect(offlineOutboxEntryMatchesOwner(legacy, {})).toBe(false);
  });
});

describe("offline replay terminal HTTP state", () => {
  it("holds an expired request for operator review instead of deleting it", () => {
    expect(holdExpiredOfflineRequest(makeEntry({ expiresAt: 400 }), 500)).toMatchObject({
      requestId: "request-1",
      replayMode: "held",
      status: "held",
      updatedAt: 500,
      nextAttemptAt: 0,
      lastError:
        "Operazione offline oltre la finestra di invio automatico: verifica richiesta, nessun dato eliminato.",
    });
  });

  it.each([409, 412, 422])("classifies %i as a conflict", (status) => {
    expect(classifyOfflineReplayHttpFailure(status)).toEqual({
      kind: "http_conflict",
      status: "conflict",
    });
  });

  it.each([400, 401, 403, 404, 429])("classifies %i as a failed request", (status) => {
    expect(classifyOfflineReplayHttpFailure(status)).toEqual({
      kind: "http_rejected",
      status: "failed",
    });
  });

  it.each([200, 399, 500, 503])("leaves non-terminal status %i to the caller", (status) => {
    expect(classifyOfflineReplayHttpFailure(status)).toBeNull();
  });

  it("holds a rejected entry without scheduling another automatic replay", () => {
    const held = holdOfflineRequestAfterHttpFailure(
      makeEntry(),
      409,
      "Operazione rifiutata dal backend (409): versione superata",
      500
    );

    expect(held).toMatchObject({
      status: "conflict",
      replayMode: "held",
      attempts: 3,
      updatedAt: 500,
      nextAttemptAt: 0,
      lastError: "Operazione rifiutata dal backend (409): versione superata",
      terminalFailure: {
        kind: "http_conflict",
        httpStatus: 409,
        recordedAt: 500,
      },
    });
  });
});

describe("legacy offline request migration", () => {
  it("does not remigrate a current conflict", () => {
    const entry = makeEntry({
      replayMode: "held",
      status: "conflict",
      terminalFailure: { kind: "http_conflict", httpStatus: 409, recordedAt: 300 },
    });

    expect(
      planLegacyOfflineRequestMigration({ entry, isFiscalReconciliation: true, now: 500 })
    ).toBe("none");
  });

  it.each(["failed", "conflict"] as const)(
    "preserves a legacy %s fiscal entry for manual resolution",
    (status) => {
      const entry = makeEntry({ replayMode: "held", status, expiresAt: 1_000 });
      expect(
        planLegacyOfflineRequestMigration({ entry, isFiscalReconciliation: true, now: 500 })
      ).toBe("preserve-held");
    }
  );

  it("requeues only an unexpired legacy held fiscal reconciliation", () => {
    const entry = makeEntry({ replayMode: "held", status: "held", expiresAt: 1_000 });
    expect(
      planLegacyOfflineRequestMigration({ entry, isFiscalReconciliation: true, now: 500 })
    ).toBe("requeue-fiscal");
  });

  it("preserves expired and non-fiscal legacy entries", () => {
    const expired = makeEntry({ replayMode: "held", status: "held", expiresAt: 400 });
    const nonFiscal = makeEntry({ replayMode: "held", status: "held", expiresAt: 1_000 });
    expect(
      planLegacyOfflineRequestMigration({
        entry: expired,
        isFiscalReconciliation: true,
        now: 500,
      })
    ).toBe("preserve-held");
    expect(
      planLegacyOfflineRequestMigration({
        entry: nonFiscal,
        isFiscalReconciliation: false,
        now: 500,
      })
    ).toBe("preserve-held");
  });

  it("ignores entries already normalized by the conservative migration", () => {
    const entry = makeEntry({
      replayMode: "held",
      status: "failed",
      legacyMigrationVersion: OFFLINE_OUTBOX_LEGACY_MIGRATION_VERSION,
    });
    expect(
      planLegacyOfflineRequestMigration({ entry, isFiscalReconciliation: false, now: 500 })
    ).toBe("none");
  });
});
