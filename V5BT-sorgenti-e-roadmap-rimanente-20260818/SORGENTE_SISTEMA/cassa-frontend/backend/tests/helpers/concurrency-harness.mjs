import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function responseFromSettledResult(result) {
  if (result?.status !== "fulfilled") return null;
  const value = result.value;
  if (value?.response) return value.response;
  return value ?? null;
}

function responseStatusFromSettledResult(result) {
  const response = responseFromSettledResult(result);
  return Number(response?.status ?? result?.value?.status ?? 0);
}

function isSuccessfulHttpResult(result) {
  const status = responseStatusFromSettledResult(result);
  return result?.status === "fulfilled" && status >= 200 && status < 300;
}

async function readJsonBodyForAssertion(result) {
  const response = responseFromSettledResult(result);
  assert.ok(response, "Risultato senza Response HTTP.");
  const contentType = String(response.headers?.get?.("content-type") ?? "");
  if (contentType.includes("application/json")) {
    return response.clone().json();
  }
  const text = await response.clone().text();
  return text ? JSON.parse(text) : null;
}

export async function fireConcurrent(requests, options = {}) {
  assert.ok(Array.isArray(requests), "fireConcurrent richiede un array.");
  assert.ok(requests.length > 0, "fireConcurrent richiede almeno una richiesta.");

  const startGate = deferred();
  const allPrepared = deferred();
  let preparedCount = 0;

  const tasks = requests.map(async (request, index) => {
    preparedCount += 1;
    if (preparedCount === requests.length) allPrepared.resolve();
    await startGate.promise;
    const startedAtMs = performance.now();
    const response = await fetch(request.url, request.options ?? {});
    const endedAtMs = performance.now();
    return {
      index,
      request,
      response,
      status: response.status,
      ok: response.ok,
      startedAtMs,
      endedAtMs,
      durationMs: endedAtMs - startedAtMs,
    };
  });

  await allPrepared.promise;
  if (typeof options.beforeRelease === "function") {
    await options.beforeRelease({ preparedCount, requestCount: requests.length });
  }
  startGate.resolve();
  return Promise.allSettled(tasks);
}

export function assertExactlyOneSucceeded(results) {
  assert.ok(Array.isArray(results), "Risultati concorrenza non validi.");
  const successes = results.filter(isSuccessfulHttpResult);
  assert.equal(
    successes.length,
    1,
    `Attesa una sola richiesta HTTP 2xx, ottenute ${successes.length}.`,
  );
  return successes[0];
}

export async function assertAllIdempotentReplay(results, expectedBody) {
  assert.ok(Array.isArray(results), "Risultati concorrenza non validi.");
  assert.ok(results.length > 0, "Nessun risultato da verificare.");
  for (const result of results) {
    assert.equal(result.status, "fulfilled", "Una richiesta concorrente e' fallita.");
    assert.ok(
      isSuccessfulHttpResult(result),
      `Risposta HTTP non OK: ${responseStatusFromSettledResult(result)}.`,
    );
  }
  const bodies = await Promise.all(results.map(readJsonBodyForAssertion));
  bodies.forEach((body) => assert.deepEqual(body, expectedBody));
  return bodies;
}
