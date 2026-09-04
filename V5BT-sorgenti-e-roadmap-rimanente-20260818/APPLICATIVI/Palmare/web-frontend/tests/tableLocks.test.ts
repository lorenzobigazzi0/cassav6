import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startTableLockHeartbeat,
  TableLockError,
  withOfflineContinuationTableLocks,
  withOptionalTableLocks,
  withRequiredTableLocks,
  type TableLockSession,
} from "../src/api/tableLocks";

const session: TableLockSession = {
  token: "token",
  userId: "u_1",
  username: "giada",
  fullName: "Giada",
  deviceUuid: "device_1",
  roomId: "room_pedana",
};

function makeResponse(status = 200, body: unknown = { ok: true }): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("table locks fail-closed", () => {
  it("mantiene il wrapper opzionale compatibile quando la sessione non e valida", async () => {
    const operation = vi.fn(async () => "ok");
    vi.stubGlobal("fetch", vi.fn());

    await expect(
      withOptionalTableLocks({ ...session, token: "" }, ["table_1"], "test:optional", operation)
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocca il wrapper obbligatorio quando manca la sessione lock", async () => {
    const operation = vi.fn(async () => "unsafe");
    vi.stubGlobal("fetch", vi.fn());

    const error = await withRequiredTableLocks(
      { ...session, token: "" },
      ["table_1"],
      "test:required",
      operation
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(TableLockError);
    expect(error.status).toBe(428);
    expect(error.payload).toMatchObject({ code: "TABLE_LOCK_SESSION_REQUIRED" });
    expect(operation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocca il wrapper obbligatorio quando manca il tavolo", async () => {
    const operation = vi.fn(async () => "unsafe");
    vi.stubGlobal("fetch", vi.fn());

    const error = await withRequiredTableLocks(session, [], "test:required", operation).catch(
      (caught) => caught
    );

    expect(error).toBeInstanceOf(TableLockError);
    expect(error.status).toBe(428);
    expect(error.payload).toMatchObject({ code: "TABLE_LOCK_TABLE_REQUIRED" });
    expect(operation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("acquisisce e rilascia il lock obbligatorio intorno alla mutation", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return makeResponse();
      })
    );

    const result = await withRequiredTableLocks(session, ["table_1"], "test:required", async () => {
      calls.push("operation");
      return "done";
    });

    expect(result).toBe("done");
    expect(calls[0]).toContain("/api/tables/lock/acquire");
    expect(calls).toContain("operation");
    expect(calls.at(-1)).toContain("/api/tables/lock/release");
  });

  it("prosegue senza lock remoto solo quando il trasporto non e disponibile", async () => {
    const operation = vi.fn(async () => "queued-locally");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await expect(
      withOfflineContinuationTableLocks(session, ["table_1"], "test:offline", operation)
    ).resolves.toBe("queued-locally");

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 409])("non aggira una risposta lock HTTP %s", async (status) => {
    const operation = vi.fn(async () => "unsafe");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse(status, {
          ok: false,
          code: status === 409 ? "TABLE_LOCKED" : "TABLE_LOCK_REJECTED",
        })
      )
    );

    const error = await withOfflineContinuationTableLocks(
      session,
      ["table_1"],
      "test:offline",
      operation
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(TableLockError);
    expect(error.status).toBe(status);
    expect(operation).not.toHaveBeenCalled();
  });

  it("segnala perdita lock quando heartbeat fallisce", async () => {
    vi.useFakeTimers();
    const onLost = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse(409, {
          ok: false,
          code: "TABLE_LOCKED",
          details: { lockedByUsername: "Roberto", tableId: "table_1" },
        })
      )
    );

    const heartbeat = startTableLockHeartbeat(session, ["table_1"], "test:heartbeat", {
      onLost,
    });
    expect(heartbeat).not.toBeNull();

    await vi.advanceTimersByTimeAsync(25_000);

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0]?.[0]).toMatchObject({
      tableId: "table_1",
      lockedByUsername: "Roberto",
    });
    if (heartbeat !== null) window.clearInterval(heartbeat);
  });
});
