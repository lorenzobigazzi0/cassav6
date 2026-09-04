export const CASSA_GATT_PROFILE_VERSION: 1;
export const CASSA_GATT_SERVICE_UUID: string;

export const CASSA_GATT_CHARACTERISTIC_UUIDS: Readonly<{
  hello: string;
  controlRx: string;
  controlTx: string;
  dataRx: string;
  dataTx: string;
  ackTx: string;
  metrics: string;
}>;

export type CassaGattCharacteristicId =
  keyof typeof CASSA_GATT_CHARACTERISTIC_UUIDS;

export interface CassaGattCharacteristicDefinition {
  readonly id: CassaGattCharacteristicId;
  readonly uuid: string;
  readonly flags: readonly string[];
}

export const CASSA_GATT_CHARACTERISTICS:
  readonly Readonly<CassaGattCharacteristicDefinition>[];

