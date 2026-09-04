import {
  CASSA_GATT_CHARACTERISTICS,
  CASSA_GATT_SERVICE_UUID,
  type CassaGattCharacteristicDefinition,
  type CassaGattCharacteristicId
} from "../../../shared/protocol/gatt-profile-v1.mjs";

export const DEFAULT_GATT_APPLICATION_PATH = "/com/cassav6/gatt";

const OBJECT_PATH_PATTERN = /^(?:\/[A-Za-z0-9_]+)+$/;

export interface CassaGattCharacteristic
  extends CassaGattCharacteristicDefinition {
  readonly id: CassaGattCharacteristicId;
  readonly path: string;
}

function validateApplicationPath(value: string): string {
  if (
    value.length > 255 ||
    !OBJECT_PATH_PATTERN.test(value) ||
    value.endsWith("/")
  ) {
    throw new Error("applicationPath must be a canonical D-Bus object path");
  }
  return value;
}

export class CassaGattService {
  readonly applicationPath: string;
  readonly servicePath: string;
  readonly uuid = CASSA_GATT_SERVICE_UUID;
  readonly primary = true;
  readonly characteristics: readonly Readonly<CassaGattCharacteristic>[];

  constructor(applicationPath = DEFAULT_GATT_APPLICATION_PATH) {
    this.applicationPath = validateApplicationPath(applicationPath);
    this.servicePath = `${this.applicationPath}/service0`;
    this.characteristics = Object.freeze(
      CASSA_GATT_CHARACTERISTICS.map((definition, index) =>
        Object.freeze({
          ...definition,
          path: `${this.servicePath}/char${index}`
        })
      )
    );
  }

  snapshot(): Readonly<{
    applicationPath: string;
    servicePath: string;
    serviceUuid: string;
    primary: true;
    characteristicCount: number;
    characteristics: readonly Readonly<{
      id: CassaGattCharacteristicId;
      uuid: string;
      flags: readonly string[];
    }>[];
  }> {
    return Object.freeze({
      applicationPath: this.applicationPath,
      servicePath: this.servicePath,
      serviceUuid: this.uuid,
      primary: true,
      characteristicCount: this.characteristics.length,
      characteristics: Object.freeze(
        this.characteristics.map(({ id, uuid, flags }) =>
          Object.freeze({ id, uuid, flags })
        )
      )
    });
  }
}
