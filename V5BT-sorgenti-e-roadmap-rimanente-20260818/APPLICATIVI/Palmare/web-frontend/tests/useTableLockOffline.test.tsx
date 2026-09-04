import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TableLockSession } from "../src/api/tableLocks";
import { useTableLock } from "../src/pages/home/tables/hooks/useTableLock";

const session: TableLockSession = {
  token: "token",
  userId: "user_1",
  username: "giada",
  fullName: "Giada",
  deviceUuid: "device_1",
  roomId: "room_1",
};

const makeResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useTableLock offline continuation", () => {
  it("mantiene il composer utilizzabile senza mostrare un errore lock di rete", async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    const Probe = () => {
      const lock = useTableLock({
        enabled: true,
        tableId: "table_1",
        session,
        purpose: "mobile:order_composer",
        allowOfflineContinuation: true,
        onError,
      });
      return <output data-testid="lock-state">{lock.status}</output>;
    };

    const view = render(<Probe />);
    await waitFor(() => expect(view.getByTestId("lock-state")).toHaveTextContent("offline"));
    expect(onError).not.toHaveBeenCalled();
  });

  it("continua a esporre il conflitto autorevole ricevuto dal server", async () => {
    const onConflict = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse(409, {
          ok: false,
          code: "TABLE_LOCKED",
          details: { tableId: "table_1", lockedByUsername: "Paolo" },
        })
      )
    );

    const Probe = () => {
      const lock = useTableLock({
        enabled: true,
        tableId: "table_1",
        session,
        purpose: "mobile:order_composer",
        allowOfflineContinuation: true,
        onConflict,
      });
      return <output data-testid="lock-state">{lock.status}</output>;
    };

    const view = render(<Probe />);
    await waitFor(() => expect(view.getByTestId("lock-state")).toHaveTextContent("conflict"));
    expect(onConflict).toHaveBeenCalledOnce();
  });
});
