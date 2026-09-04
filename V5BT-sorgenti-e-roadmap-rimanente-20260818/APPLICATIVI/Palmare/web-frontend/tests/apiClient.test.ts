import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiFetch,
  apiJson,
  computeBackoffDelay,
  setUnauthorizedHandler,
} from "../src/shared/api/apiClient";

type FakeResponseInit = {
  status?: number;
  body?: unknown;
  url?: string;
};

function makeResponse({ status = 200, body, url = "/api/test" }: FakeResponseInit = {}): Response {
  const text =
    body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => text,
  } as unknown as Response;
}

/** A fetch that never resolves on its own; it rejects only when the signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        }
      })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe("apiClient — ApiError mapping (apiJson)", () => {
  it("returns the parsed JSON body on a 2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ status: 200, body: { value: 42 } })));
    await expect(apiJson<{ value: number }>("/api/test")).resolves.toEqual({ value: 42 });
  });

  it("resolves to null for an empty (204) body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ status: 204 })));
    await expect(apiJson("/api/test")).resolves.toBeNull();
  });

  it("throws a normalized ApiError carrying backend message, code, status, url, body", async () => {
    const body = { error: "Tavolo occupato", code: "table_busy" };
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ status: 409, body, url: "/api/x" })));

    const error = await apiJson("/api/x").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "Tavolo occupato",
      code: "table_busy",
      status: 409,
      url: "/api/x",
      body,
    });
  });

  it("derives a code from the status when the body has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ status: 500, body: {} })));
    const error = (await apiJson("/api/test").catch((caught) => caught)) as ApiError;
    expect(error.code).toBe("server_error");
    expect(error.status).toBe(500);
  });

  it("maps a network failure to ApiError code network_error with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const error = (await apiJson("/api/test").catch((caught) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("network_error");
    expect(error.status).toBe(0);
  });
});

describe("apiClient — 401 unauthorized handler", () => {
  it("invokes the registered handler for protected API endpoints only", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ status: 401 })));

    const sessionResponse = await apiFetch("/api/auth/session/status", { method: "POST" });
    const protectedResponse = await apiFetch("/api/tables");

    expect(sessionResponse.status).toBe(401);
    expect(protectedResponse.status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not logout on auxiliary/public endpoints", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ status: 401 })));

    await expect(apiFetch("/api/ip-coords")).resolves.toMatchObject({ status: 401 });
    await expect(apiFetch("/api/health")).resolves.toMatchObject({ status: 401 });
    await expect(apiFetch("/api/auth/login", { method: "POST" })).resolves.toMatchObject({
      status: 401,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not invoke the handler on a successful response", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ status: 200, body: {} })));

    await apiFetch("/api/secure");
    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows handler errors so the request flow is unaffected", async () => {
    setUnauthorizedHandler(() => {
      throw new Error("handler boom");
    });
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ status: 401 })));
    await expect(apiFetch("/api/tables")).resolves.toMatchObject({
      status: 401,
    });
  });
});

describe("apiClient — timeout and abort", () => {
  it("aborts a slow request and surfaces an ApiError with code timeout", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const error = (await apiJson("/api/slow", { method: "POST" }, { timeoutMs: 20 }).catch(
      (caught) => caught
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("timeout");
    expect(error.status).toBe(0);
  });

  it("propagates a caller-initiated abort as code aborted (not timeout)", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const pending = apiJson("/api/slow", { method: "POST", signal: controller.signal }).catch(
      (caught) => caught
    );
    controller.abort();
    const error = (await pending) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("aborted");
  });

  it("does not call fetch when the caller signal is already aborted", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await apiFetch("/api/slow", { signal: controller.signal }).catch(() => undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("apiClient — backoff and retry", () => {
  it("computes exponential backoff within jitter bounds and caps the growth", () => {
    for (const attempt of [0, 1, 2, 3]) {
      const expected = Math.min(4000, 300 * 2 ** attempt);
      const delay = computeBackoffDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(expected);
      expect(delay).toBeLessThanOrEqual(expected * 1.5 + 1);
    }
    // Large attempts stay capped (cap 4000 + up to 50% jitter).
    expect(computeBackoffDelay(20)).toBeLessThanOrEqual(6001);
  });

  it("retries idempotent GET on 503 then returns the eventual success", async () => {
    const fetchMock = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(makeResponse({ status: 503 }))
      .mockResolvedValueOnce(makeResponse({ status: 503 }))
      .mockResolvedValueOnce(makeResponse({ status: 200, body: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiFetch("/api/list", undefined, { retryAttempts: 2, retryDelayMs: 0 });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-idempotent POST and returns the failing response", async () => {
    const fetchMock = vi.fn(async () => makeResponse({ status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiFetch("/api/create", { method: "POST" }, { retryDelayMs: 0 });
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries idempotent GET on a network error", async () => {
    const fetchMock = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(makeResponse({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiFetch("/api/list", undefined, { retryAttempts: 1, retryDelayMs: 0 });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
