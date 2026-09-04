import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GATT_SERVICE_UUID } from "./advertisement-v1.mjs";
import {
  CASSA_GATT_CHARACTERISTICS,
  CASSA_GATT_CHARACTERISTIC_UUIDS,
  CASSA_GATT_PROFILE_VERSION,
  CASSA_GATT_SERVICE_UUID
} from "./gatt-profile-v1.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configuredUuids = JSON.parse(
  fs.readFileSync(path.join(root, "configs", "gatt-uuids.json"), "utf8")
);

test("GATT v1 executable profile matches the frozen UUID registry", () => {
  assert.equal(CASSA_GATT_PROFILE_VERSION, 1);
  assert.equal(CASSA_GATT_SERVICE_UUID, GATT_SERVICE_UUID);
  assert.equal(CASSA_GATT_SERVICE_UUID, configuredUuids.service);
  assert.equal(
    CASSA_GATT_SERVICE_UUID,
    configuredUuids.advertisementServiceData
  );
  assert.deepEqual(CASSA_GATT_CHARACTERISTIC_UUIDS, {
    hello: configuredUuids.hello,
    controlRx: configuredUuids.controlRx,
    controlTx: configuredUuids.controlTx,
    dataRx: configuredUuids.dataRx,
    dataTx: configuredUuids.dataTx,
    ackTx: configuredUuids.ackTx,
    metrics: configuredUuids.metrics
  });
});

test("GATT v1 characteristic flags remain exact, ordered and immutable", () => {
  assert.deepEqual(
    CASSA_GATT_CHARACTERISTICS.map(({ id, flags }) => [id, [...flags]]),
    [
      ["hello", ["read", "write"]],
      ["controlRx", ["write", "write-without-response"]],
      ["controlTx", ["notify", "indicate"]],
      ["dataRx", ["write", "write-without-response"]],
      ["dataTx", ["notify"]],
      ["ackTx", ["indicate"]],
      ["metrics", ["read", "notify"]]
    ]
  );
  assert.equal(Object.isFrozen(CASSA_GATT_CHARACTERISTICS), true);
  assert.equal(
    CASSA_GATT_CHARACTERISTICS.every(
      (definition) =>
        Object.isFrozen(definition) && Object.isFrozen(definition.flags)
    ),
    true
  );
  assert.equal(
    new Set(CASSA_GATT_CHARACTERISTICS.map(({ uuid }) => uuid)).size,
    CASSA_GATT_CHARACTERISTICS.length
  );
});

