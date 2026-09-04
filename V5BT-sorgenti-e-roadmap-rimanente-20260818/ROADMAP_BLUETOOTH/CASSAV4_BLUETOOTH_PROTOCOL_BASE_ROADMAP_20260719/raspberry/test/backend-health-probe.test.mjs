import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKEND_HEALTH_FAILURES,
  BackendHealthProbe,
  BackendHealthProbeError
} from "../dist/backend/BackendHealthProbe.js";

function response(input = {}) {
  const headers = new Map(
    Object.entries({
      "content-type": "application/json; charset=utf-8",
      ...input.headers
    }).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  const chunks = (input.chunks ?? [input.body ?? '{"ok":true}']).map((value) =>
    typeof value === "string" ? Buffer.from(value) : Buffer.from(value)
  );
  let index = 0;
  const state = { cancelled: false, reads: 0 };
  return {
    status: input.status ?? 200,
    redirected: input.redirected ?? false,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: {
      getReader: () => ({
        async read() {
          state.reads += 1;
          if (index >= chunks.length) return { done: true };
          return { done: false, value: chunks[index++] };
        },
        async cancel() { state.cancelled = true; },
        releaseLock() {}
      })
    },
    state
  };
}

test("loopback JSON health is measured without exposing endpoint details", async () => {
  const monotonic = [10, 25];
  let seen = null;
  const probe = new BackendHealthProbe({
    url: "http://127.0.0.1:5380/api/health",
    fetch: async (url, init) => {
      seen = { url, init };
      return response();
    },
    monotonicNow: () => monotonic.shift(),
    epochNow: () => 1_800_000_000_000
  });
  assert.deepEqual(await probe.probe(), {
    canReachServer: true,
    rttMs: 15,
    failure: BACKEND_HEALTH_FAILURES.NONE,
    sampledAtEpochMs: 1_800_000_000_000
  });
  assert.equal(seen.init.method, "GET");
  assert.equal(seen.init.redirect, "error");
  assert.deepEqual(probe.snapshot(), {
    attempts: 1,
    successes: 1,
    failures: 0,
    reachable: true,
    lastFailure: BACKEND_HEALTH_FAILURES.NONE
  });
  assert.equal(JSON.stringify(probe.snapshot()).includes("127.0.0.1"), false);
});

test("HTTP, content, body and transport failures are classified fail-closed", async () => {
  const cases = [
    [response({ status: 503 }), BACKEND_HEALTH_FAILURES.HTTP_STATUS],
    [
      response({ headers: { "content-type": "text/plain" } }),
      BACKEND_HEALTH_FAILURES.CONTENT_TYPE
    ],
    [
      response({ headers: { "content-type": "application/jsonp" } }),
      BACKEND_HEALTH_FAILURES.CONTENT_TYPE
    ],
    [response({ body: '{"ok":false}' }), BACKEND_HEALTH_FAILURES.INVALID_BODY],
    [
      response({ body: "x".repeat(4_097) }),
      BACKEND_HEALTH_FAILURES.RESPONSE_TOO_LARGE
    ]
  ];
  for (const [fakeResponse, expected] of cases) {
    let monotonic = 0;
    const probe = new BackendHealthProbe({
      url: "http://localhost:5380/api/health",
      fetch: async () => fakeResponse,
      monotonicNow: () => (monotonic += 1),
      epochNow: () => 1
    });
    assert.equal((await probe.probe()).failure, expected);
    assert.equal(probe.snapshot().reachable, false);
  }

  let monotonic = 0;
  const network = new BackendHealthProbe({
    url: "http://[::1]:5380/api/health",
    fetch: async () => {
      throw new Error("private network details must not escape");
    },
    monotonicNow: () => (monotonic += 1),
    epochNow: () => 2
  });
  assert.equal((await network.probe()).failure, BACKEND_HEALTH_FAILURES.NETWORK);
});

test("chunked bodies stop at the hard byte limit without reading the tail", async () => {
  const oversized = response({
    chunks: [Buffer.alloc(3_000, 0x78), Buffer.alloc(1_097, 0x78), Buffer.alloc(10, 0x78)]
  });
  let monotonic = 0;
  const probe = new BackendHealthProbe({
    url: "http://localhost:5380/api/health",
    fetch: async () => oversized,
    monotonicNow: () => (monotonic += 1),
    epochNow: () => 1
  });
  assert.equal(
    (await probe.probe()).failure,
    BACKEND_HEALTH_FAILURES.RESPONSE_TOO_LARGE
  );
  assert.equal(oversized.state.cancelled, true);
  assert.equal(oversized.state.reads, 2);
});

test("timeout and monotonic regression are explicit", async () => {
  let monotonic = 10;
  const timeout = new BackendHealthProbe({
    url: "http://localhost:5380/api/health",
    timeoutMs: 100,
    fetch: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
    monotonicNow: () => monotonic,
    epochNow: () => 3
  });
  assert.equal((await timeout.probe()).failure, BACKEND_HEALTH_FAILURES.TIMEOUT);
  monotonic = 9;
  await assert.rejects(
    () => timeout.probe(),
    (error) =>
      error instanceof BackendHealthProbeError &&
      error.code === "CLOCK_REGRESSION"
  );
});

test("health probe refuses remote, credentialed and ambiguous URLs", () => {
  for (const url of [
    "https://example.com/api/health",
    "http://user:pass@127.0.0.1/api/health",
    "http://127.0.0.1/api/health?full=1",
    "http://127.0.0.1/",
    "file:///tmp/health"
  ]) {
    assert.throws(
      () => new BackendHealthProbe({ url }),
      (error) =>
        error instanceof BackendHealthProbeError &&
        error.code === "INVALID_HEALTH_URL"
    );
  }
});
