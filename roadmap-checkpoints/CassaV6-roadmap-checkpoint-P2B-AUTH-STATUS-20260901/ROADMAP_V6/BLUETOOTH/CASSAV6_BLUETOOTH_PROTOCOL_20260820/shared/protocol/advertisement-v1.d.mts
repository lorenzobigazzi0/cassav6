export const PROTOCOL_VERSION: 1;
export const GATT_SERVICE_UUID: string;
export const CAPABILITY_BITS: Readonly<{
  SCAN: 1;
  ADVERTISE: 2;
  GATT_CLIENT: 4;
  GATT_SERVER: 8;
  CONCURRENT_SCAN_ADVERTISE: 16;
  LOCAL_DURABILITY: 32;
  BACKEND_BRIDGE: 64;
}>;

export interface NodeAdvertisementV1 {
  protocolVersion: 1;
  nodeKind: "raspberry" | "handheld" | "station";
  rotatingAlias: string;
  bootId: number;
  capabilities: number;
  serverReachable: boolean;
  sequence: number;
}

export function encodeNodeAdvertisement(
  value: NodeAdvertisementV1
): Uint8Array;

export function decodeNodeAdvertisement(
  value: Uint8Array
): Readonly<NodeAdvertisementV1>;
