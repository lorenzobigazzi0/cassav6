import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runnerPath = new URL("./loadtest-full-capacity.mjs", import.meta.url);

test("il drain relazionale mantiene vivo il browser testimone SSE", async () => {
  const source = await readFile(runnerPath, "utf8");
  const mainStart = source.indexOf("async function main()");
  const workloadFinally = source.indexOf(
    "stationPresenceStop.done = true;",
    mainStart,
  );
  const drain = source.indexOf(
    "relationalAudit = await waitForRelationalDrain(admin);",
    workloadFinally,
  );
  const browserRelease = source.indexOf("activeBrowser = null;", workloadFinally);
  const browserClose = source.indexOf(
    "if (browser) await browser.close();",
    workloadFinally,
  );

  assert.notEqual(workloadFinally, -1, "finalizzazione del carico presente");
  assert.notEqual(drain, -1, "drain relazionale finale presente");
  assert.notEqual(browserRelease, -1, "rilascio browser attivo presente");
  assert.notEqual(browserClose, -1, "chiusura browser finale presente");
  assert.ok(
    workloadFinally < drain,
    "il drain deve iniziare dopo l'arresto del keeper di presenza",
  );
  assert.ok(
    drain < browserRelease,
    "il browser deve restare registrato per il cleanup durante il drain",
  );
  assert.ok(
    browserRelease < browserClose,
    "il riferimento attivo va rilasciato immediatamente prima della chiusura",
  );
});
