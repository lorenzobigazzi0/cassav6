import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelCashExchange,
  confirmCashExchangeDeposit,
  confirmCashExchangeRemoved,
  executeCashExchange,
  getActiveCashExchange,
  getCashExchangeState,
  startCashExchange,
} from "../src/api/cashExchange";
import { AUTH_STORAGE_KEYS } from "../src/shared/storage/authStorage";

function makeResponse({ status = 200, body, url = "/api/automatic-cash/exchange/test" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    url,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const fetchMock = () =>
  vi.fn(async (input: string) =>
    makeResponse({
      url: input,
      body: {
        ok: true,
        exchangeId: "EXC-1",
        status: "DEPOSITING",
        depositedCents: 0,
        activeExchange: null,
      },
    })
  );

const expectLastRequest = (
  fetch: ReturnType<typeof fetchMock>,
  url: string,
  method = "GET",
  body?: unknown
) => {
  const [input, init] = fetch.mock.calls.at(-1) ?? [];
  expect(String(input)).toContain(url);
  expect(init?.method ?? "GET").toBe(method);
  if (body !== undefined) expect(JSON.parse(String(init?.body))).toEqual(body);
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("cashExchange API client", () => {
  it("uses only backend automatic-cash exchange endpoints", async () => {
    const fetch = fetchMock();
    vi.stubGlobal("fetch", fetch);

    await startCashExchange({ deviceUuid: "device-1", activityId: "act-1", roomId: "room-1" });
    expectLastRequest(fetch, "/api/automatic-cash/exchange/start", "POST", {
      deviceUuid: "device-1",
      activityId: "act-1",
      roomId: "room-1",
    });

    await getCashExchangeState("EXC-1");
    expectLastRequest(fetch, "/api/automatic-cash/exchange/EXC-1/state");

    await cancelCashExchange("EXC-1");
    expectLastRequest(fetch, "/api/automatic-cash/exchange/EXC-1/cancel", "POST", {
      reason: "operator_cancelled",
    });

    await confirmCashExchangeDeposit("EXC-1");
    expectLastRequest(fetch, "/api/automatic-cash/exchange/EXC-1/confirm-deposit", "POST", {});

    await executeCashExchange("EXC-1", { "2000": 1, "500": 1 });
    expectLastRequest(fetch, "/api/automatic-cash/exchange/EXC-1/execute", "POST", {
      pieces: { "2000": 1, "500": 1 },
    });

    await confirmCashExchangeRemoved("EXC-1");
    expectLastRequest(fetch, "/api/automatic-cash/exchange/EXC-1/confirm-removed", "POST", {});

    await getActiveCashExchange();
    expectLastRequest(fetch, "/api/automatic-cash/exchange/active");
  });

  it("sends stored mobile auth headers to exchange endpoints", async () => {
    window.localStorage.setItem(AUTH_STORAGE_KEYS.token, "token-1");
    window.localStorage.setItem(AUTH_STORAGE_KEYS.userId, "u_admin");
    window.localStorage.setItem(AUTH_STORAGE_KEYS.deviceUuid, "dev_1");
    const fetch = fetchMock();
    vi.stubGlobal("fetch", fetch);

    await startCashExchange({ deviceUuid: "dev_1" });

    expect(fetch.mock.calls.at(-1)?.[1]?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer token-1",
      "X-User-Id": "u_admin",
      "X-Device-Uuid": "dev_1",
    });
  });
});
