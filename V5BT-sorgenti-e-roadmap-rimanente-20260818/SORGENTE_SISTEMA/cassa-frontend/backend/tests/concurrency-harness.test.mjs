import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  assertAllIdempotentReplay,
  assertExactlyOneSucceeded,
  fireConcurrent,
} from "./helpers/concurrency-harness.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startSerializedServer(t) {
  let receivedCount = 0;
  let activeCount = 0;
  let maxActiveCount = 0;
  let tail = Promise.resolve();

  const server = createServer((req, res) => {
    receivedCount += 1;
    const previous = tail;
    let releaseCurrent;
    tail = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    previous
      .then(async () => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await sleep(15);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      })
      .finally(() => {
        activeCount -= 1;
        releaseCurrent();
      });
  });

  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stats: () => ({ receivedCount, maxActiveCount }),
  };
}

test("concurrency harness rilascia le richieste solo dopo la barriera esplicita", async (t) => {
  const { baseUrl, stats } = await startSerializedServer(t);
  const requests = [
    { url: `${baseUrl}/serialized?request=1`, options: { method: "GET" } },
    { url: `${baseUrl}/serialized?request=2`, options: { method: "GET" } },
  ];

  const results = await fireConcurrent(requests, {
    beforeRelease: async ({ preparedCount, requestCount }) => {
      assert.equal(preparedCount, requestCount);
      assert.equal(stats().receivedCount, 0);
      await sleep(20);
      assert.equal(stats().receivedCount, 0);
    },
  });

  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.status === "fulfilled"), true);
  assert.equal(
    results.every((result) => result.value.status === 200),
    true,
  );
  assert.equal(stats().receivedCount, 2);
  assert.equal(stats().maxActiveCount, 1);
});

test("assertExactlyOneSucceeded richiede una sola risposta HTTP 2xx", () => {
  const ok = {
    status: "fulfilled",
    value: { response: new Response("{}", { status: 200 }), status: 200 },
  };
  const conflict = {
    status: "fulfilled",
    value: { response: new Response("{}", { status: 409 }), status: 409 },
  };

  assert.equal(assertExactlyOneSucceeded([ok, conflict]), ok);
  assert.throws(() => assertExactlyOneSucceeded([conflict, conflict]));
  assert.throws(() => assertExactlyOneSucceeded([ok, ok]));
});

test("assertAllIdempotentReplay verifica replay con body identico", async () => {
  const expectedBody = { ok: true, idempotent: true, id: "same-response" };
  const results = [1, 2, 3].map(() => ({
    status: "fulfilled",
    value: {
      response: new Response(JSON.stringify(expectedBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      status: 200,
    },
  }));

  const bodies = await assertAllIdempotentReplay(results, expectedBody);
  assert.equal(bodies.length, 3);
});
