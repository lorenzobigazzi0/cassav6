import { GATT_SERVICE_UUID } from "./advertisement-v1.mjs";

export const CASSA_GATT_PROFILE_VERSION = 1;
export const CASSA_GATT_SERVICE_UUID = GATT_SERVICE_UUID;

export const CASSA_GATT_CHARACTERISTIC_UUIDS = Object.freeze({
  hello: "34f16f91-8558-595d-ba61-f0b31b2aa7f0",
  controlRx: "6c4927da-180d-5e9a-a3c7-c3b7cbccc499",
  controlTx: "d9af61c0-289d-583d-877c-ef19a49413c9",
  dataRx: "520f34b8-8e37-50a7-ada0-00252a94f11c",
  dataTx: "13e8dde6-a0d5-5227-9608-5a71a65de87a",
  ackTx: "5ea76dec-cbaa-5aee-9156-6058066a3a7a",
  metrics: "544e9ea6-c9a9-56f7-a1ed-41afe8c72078"
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

