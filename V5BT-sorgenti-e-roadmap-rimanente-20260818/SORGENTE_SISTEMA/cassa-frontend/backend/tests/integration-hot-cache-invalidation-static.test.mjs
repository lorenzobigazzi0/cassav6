import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const serverSource = await readFile(
  new URL("../server.js", import.meta.url),
  "utf8",
);
const authHandlersSource = await readFile(
  new URL("../auth/auth.handlers.js", import.meta.url),
  "utf8",
);
// Il ramo heartbeat-only della postazione e uscito da server.js con MIG-031.
const stationUpsertSource = await readFile(
  new URL("../modules/integration/station-state-upsert.handlers.js", import.meta.url),
  "utf8",
);

test("station heartbeat-only updates preserve integration hot caches", () => {
  assert.match(
    stationUpsertSource,
    /req\.__preserveIntegrationHotCaches\s*=\s*true/,
    "station heartbeat-only branch must mark the request as cache-preserving",
  );
  assert.match(
    serverSource,
    /shouldPreserveHotCaches:\s*\(\)\s*=>\s*req\.__preserveIntegrationHotCaches\s*===\s*true/,
    "serialized API mutations must pass the request cache-preservation marker into withDbMutation",
  );
  assert.match(
    serverSource,
    /if\s*\(!shouldPreserveHotCaches\?\.\(\)\)\s*\{\s*clearIntegrationHotResponseCaches\(\);/s,
    "withDbMutation must skip hot-cache clearing only when the marker explicitly allows it",
  );
});

test("session status no-op updates preserve integration hot caches", () => {
  assert.match(
    authHandlersSource,
    /req\.__preserveIntegrationHotCaches\s*=\s*true/,
    "auth session/status no-op branch must preserve hot caches",
  );
  assert.match(
    serverSource,
    /isAuthSessionStatusFastPathRequest\(req\.method,\s*pathname\)/,
    "auth session/status deve uscire dalla coda globale quando e' un no-op",
  );
  // Il rientro in coda e passato in `retrySessionStatusPersistently` (server.js)
  // con MIG-031: il handler si limita a delegare quando il write model dichiara
  // che la scrittura va persistita.
  assert.match(
    authHandlersSource,
    /req\.__authSessionStatusFastPath\s*===\s*true/,
    "auth session/status deve propagare il marcatore di fast path al write model",
  );
  assert.match(
    authHandlersSource,
    /outcome\s*===\s*"retry_persistently"[\s\S]{0,200}retrySessionStatusPersistently\(req,\s*res\)/,
    "auth session/status deve delegare al rientro in coda quando deve persistere",
  );
  assert.match(
    serverSource,
    /async function retrySessionStatusPersistently\([\s\S]{0,400}req\.__authSessionStatusFastPath\s*=\s*false[\s\S]{0,400}withSessionStatusLaneMutation/,
    "il rientro in coda deve azzerare il fast path e ripassare dalla lane serializzata",
  );
});

test("layout read bypasses the room mutation lane", () => {
  const roomPaths =
    serverSource.match(
      /const ROOM_LANE_PATHS = new Set\(\[([\s\S]*?)\]\);/,
    )?.[1] ?? "";
  const roomPredicate =
    serverSource.match(/function isRoomLaneRequest\([\s\S]*?\n\}/)?.[0] ?? "";

  assert.doesNotMatch(
    roomPaths,
    /["']\/api\/integration\/layout["']/,
    "la GET layout non deve condividere la coda delle mutazioni room",
  );
  assert.match(
    roomPredicate,
    /safeMethod === ["']POST["']/,
    "la room lane deve accettare soltanto mutazioni POST",
  );
  assert.doesNotMatch(
    serverSource,
    /isIntegrationLayoutReadRequest/,
    "non devono restare callback morte dedicate alla GET layout",
  );
});
