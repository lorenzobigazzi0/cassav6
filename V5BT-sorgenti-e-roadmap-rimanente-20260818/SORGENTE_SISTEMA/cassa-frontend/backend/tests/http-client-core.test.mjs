import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchWithTimeout } from "../core/http-client.js";

function startSlowServer(t) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }, 100);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    t.after(() => new Promise((closeResolve) => server.close(closeResolve)));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

test("fetchWithTimeout propaga risposte rapide e rimuove timeoutMs dalle opzioni fetch", async (t) => {
  const baseUrl = await startSlowServer(t);
  const response = await fetchWithTimeout(`${baseUrl}/fast`, { timeoutMs: 500, cache: "no-store" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("fetchWithTimeout abortisce richieste lente", async (t) => {
  const baseUrl = await startSlowServer(t);
  await assert.rejects(
    () => fetchWithTimeout(`${baseUrl}/slow`, { timeoutMs: 10 }),
    (error) => error?.name === "AbortError"
  );
});
