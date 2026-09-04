import { GATT_SERVICE_UUID } from "./advertisement-v1.mjs";

export const CASSA_GATT_PROFILE_VERSION = 1;
export const CASSA_GATT_SERVICE_UUID = GATT_SERVICE_UUID;

export const CASSA_GATT_CHARACTERISTIC_UUIDS = Object.freeze({
  hello: "b1c4a500-7d1f-4f32-9a64-4f4b6c410002",
  controlRx: "b1c4a500-7d1f-4f32-9a64-4f4b6c410003",
  controlTx: "b1c4a500-7d1f-4f32-9a64-4f4b6c410004",
  dataRx: "b1c4a500-7d1f-4f32-9a64-4f4b6c410005",
  dataTx: "b1c4a500-7d1f-4f32-9a64-4f4b6c410006",
  ackTx: "b1c4a500-7d1f-4f32-9a64-4f4b6c410007",
  metrics: "b1c4a500-7d1f-4f32-9a64-4f4b6c410008"
});

function characteristic(id, flags) {
  return Object.freeze({
    id,
    uuid: CASSA_GATT_CHARACTERISTIC_UUIDS[id],
    flags: Object.freeze([...flags])
  });
}

export const CASSA_GATT_CHARACTERISTICS = Object.freeze([
  characteristic("hello", ["read", "write"]),
  characteristic("controlRx", ["write", "write-without-response"]),
  characteristic("controlTx", ["notify", "indicate"]),
  characteristic("dataRx", ["write", "write-without-response"]),
  characteristic("dataTx", ["notify"]),
  characteristic("ackTx", ["indicate"]),
  characteristic("metrics", ["read", "notify"])
]);

