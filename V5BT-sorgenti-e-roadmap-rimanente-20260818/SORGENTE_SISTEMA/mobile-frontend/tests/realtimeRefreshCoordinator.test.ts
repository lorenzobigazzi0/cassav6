import { describe, expect, it, vi } from "vitest";
import {
  createRealtimeRefreshCoordinator,
  MOBILE_REALTIME_REFRESH_COOLDOWN_MS,
  realtimeRefreshKey,
} from "../src/shared/realtime/realtimeRefreshCoordinator";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

describe("realtime refresh coordinator", () => {
  it("mantiene un solo lavoro attivo e un solo trailing con l'ultimo aggiornamento", async () => {
    const first = deferred();
    const last = deferred();
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const coordinator = createRealtimeRefreshCoordinator<string>({
      run: async (value) => {
        started.push(value);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await (value === "first" ? first.promise : last.promise);
        active -= 1;
      },
    });

    coordinator.enqueue("event:1", "first");
    await flush();
    coordinator.enqueue("event:2", "second");
    coordinator.enqueue("event:3", "third");
    coordinator.enqueue("event:4", "last");

    expect(started).toEqual(["first"]);
    first.resolve();
    await flush();
    expect(started).toEqual(["first", "last"]);
    expect(maximumActive).toBe(1);

    last.resolve();
    await flush();
    coordinator.dispose();
  });

  it("segnala quanti aggiornamenti trailing sono stati sostituiti", async () => {
    const running = deferred();
    const seen: Array<{ value: string; supersededCount: number }> = [];
    const coordinator = createRealtimeRefreshCoordinator<string>({
      run: async (value, context) => {
        seen.push({ value, supersededCount: context.supersededCount });
        if (value === "active") await running.promise;
      },
    });

    coordinator.enqueue("event:1", "active");
    await flush();
    coordinator.enqueue("event:2", "oldest-trailing");
    coordinator.enqueue("event:3", "middle-trailing");
    coordinator.enqueue("event:4", "latest-trailing");
    running.resolve();
    await flush();

    expect(seen).toEqual([
      { value: "active", supersededCount: 0 },
      { value: "latest-trailing", supersededCount: 2 },
    ]);
    coordinator.dispose();
  });

  it("deduplica la coppia payload e refresh dello stesso evento", async () => {
    const run = vi.fn();
    const coordinator = createRealtimeRefreshCoordinator<string>({ run });

    expect(coordinator.enqueue("event:42", "payload")).toBe(true);
    expect(coordinator.enqueue("event:42", "refresh")).toBe(false);
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("payload", expect.objectContaining({ supersededCount: 0 }));
    coordinator.dispose();
  });

  it("accetta nuovamente una chiave dopo la finestra di deduplica", async () => {
    let now = 10_000;
    const run = vi.fn();
    const coordinator = createRealtimeRefreshCoordinator<string>({
      run,
      dedupeWindowMs: 500,
      now: () => now,
    });

    coordinator.enqueue("legacy:refresh", "first");
    await flush();
    now += 501;
    expect(coordinator.enqueue("legacy:refresh", "second")).toBe(true);
    await flush();

    expect(run).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("non avvia callback accodate dopo dispose", async () => {
    const run = vi.fn();
    const coordinator = createRealtimeRefreshCoordinator<string>({ run });

    coordinator.enqueue("event:1", "queued");
    coordinator.dispose();
    await flush();

    expect(run).not.toHaveBeenCalled();
    expect(coordinator.enqueue("event:2", "after-logout")).toBe(false);
  });

  it("annulla il contesto attivo e scarta il trailing durante dispose", async () => {
    const running = deferred();
    const started: string[] = [];
    let activeSignal: AbortSignal | null = null;
    const coordinator = createRealtimeRefreshCoordinator<string>({
      run: async (value, { signal }) => {
        started.push(value);
        activeSignal = signal;
        await running.promise;
      },
    });

    coordinator.enqueue("event:1", "active");
    await flush();
    coordinator.enqueue("event:2", "trailing");
    coordinator.dispose();

    expect(activeSignal?.aborted).toBe(true);
    running.resolve();
    await flush();
    expect(started).toEqual(["active"]);
  });

  it("continua con il trailing dopo un errore senza rejection non gestite", async () => {
    const onError = vi.fn();
    const running = deferred();
    const started: string[] = [];
    const coordinator = createRealtimeRefreshCoordinator<string>({
      onError,
      run: async (value) => {
        started.push(value);
        if (value === "first") {
          await running.promise;
          throw new Error("refresh failed");
        }
      },
    });

    coordinator.enqueue("event:1", "first");
    await flush();
    coordinator.enqueue("event:2", "latest");
    running.resolve();
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(started).toEqual(["first", "latest"]);
    coordinator.dispose();
  });

  it("limita i refresh continui conservando l'ultimo aggiornamento", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const seen: string[] = [];
    const coordinator = createRealtimeRefreshCoordinator<string>({
      minimumRunIntervalMs: MOBILE_REALTIME_REFRESH_COOLDOWN_MS,
      run: async (value) => {
        seen.push(value);
      },
    });

    coordinator.enqueue("event:1", "first");
    await flush();
    coordinator.enqueue("event:2", "old-trailing");
    coordinator.enqueue("event:3", "latest-trailing");
    await flush();
    expect(seen).toEqual(["first"]);

    await vi.advanceTimersByTimeAsync(MOBILE_REALTIME_REFRESH_COOLDOWN_MS - 1);
    expect(seen).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(seen).toEqual(["first", "latest-trailing"]);

    coordinator.dispose();
    vi.useRealTimers();
  });

  it("coalesca 48 secondi di eventi continui nel cooldown mobile", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const seen: string[] = [];
    const coordinator = createRealtimeRefreshCoordinator<string>({
      minimumRunIntervalMs: MOBILE_REALTIME_REFRESH_COOLDOWN_MS,
      run: async (value) => {
        seen.push(value);
      },
    });

    for (let index = 0; index < 480; index += 1) {
      coordinator.enqueue(`event:${index + 1}`, `value-${index + 1}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    await flush();
    expect(seen.length).toBeLessThanOrEqual(17);

    coordinator.dispose();
    vi.useRealTimers();
  });

  it("esegue l'ultimo refresh dopo il cooldown e annulla quello pendente al logout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const seen: string[] = [];
    const coordinator = createRealtimeRefreshCoordinator<string>({
      minimumRunIntervalMs: MOBILE_REALTIME_REFRESH_COOLDOWN_MS,
      run: async (value) => {
        seen.push(value);
      },
    });

    coordinator.enqueue("event:1", "first");
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.enqueue("event:2", "old-trailing");
    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.enqueue("event:3", "final-trailing");
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(seen).toEqual(["first", "final-trailing"]);

    coordinator.enqueue("event:logout", "must-not-run");
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(MOBILE_REALTIME_REFRESH_COOLDOWN_MS);
    expect(seen).not.toContain("must-not-run");
    expect(coordinator.enqueue("event:after-logout", "ignored")).toBe(false);
    vi.useRealTimers();
  });

  it("costruisce la stessa chiave per payload e refresh normalizzati", () => {
    const detail = {
      eventId: 77,
      reason: "order_created",
      atMs: 123,
      aggregateType: "order",
      aggregateId: "order-7",
      aggregateVersion: 2,
    };

    expect(realtimeRefreshKey(detail)).toBe("event:77");
    expect(realtimeRefreshKey({ ...detail })).toBe(realtimeRefreshKey(detail));
    expect(realtimeRefreshKey({ reason: "table_updated", atMs: 456 })).toBe(
      "table_updated:456:::0"
    );
  });
});
