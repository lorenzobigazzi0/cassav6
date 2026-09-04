import { CAPABILITY_BITS } from "../../../shared/protocol/advertisement-v1.mjs";
import { HELLO_V1_NODE_ID_PATTERN_SOURCE } from "../../../shared/protocol/hello-v1.mjs";
import {
  ROUTE_HEALTH_OPERATIONAL_BUDGET_MS,
  ROUTE_HEALTH_SLA_MS,
  routeHealthWorstCaseMs
} from "../routing/RouteHealthBudgetV1.js";

export class NodeConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NodeConfigError";
    this.code = code;
  }
}

export interface BluezNodeConfig {
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly gattServerEnabled: boolean;
  readonly helloExchangeEnabled: boolean;
  readonly mutualAuthEnabled: boolean;
  readonly directControlEnabled: boolean;
  readonly reliableChannelEnabled: boolean;
  readonly routeAdvertisementEnabled: boolean;
  readonly commandBusShadowEnabled: boolean;
  readonly deviceRegistryPath: string;
  readonly transportStorePath: string;
  readonly backendHealthUrl: string;
  readonly helloBootId: number;
  readonly helloCapabilities: number;
  readonly adapterName: string;
  readonly nodeId: string;
  readonly storeId: string;
  readonly maintenanceIntervalMs: number;
  readonly metricsIntervalMs: number;
  readonly transportTickIntervalMs: number;
  readonly backendHealthIntervalMs: number;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADAPTER_PATTERN = /^hci[0-9]+$/;
const HELLO_NODE_ID_PATTERN = new RegExp(HELLO_V1_NODE_ID_PATTERN_SOURCE);

function parseFlag(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: boolean
): boolean {
  const value = environment[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (value === "1") {
    return true;
  }
  if (value === "0") {
    return false;
  }
  throw new NodeConfigError(
    "INVALID_BOOLEAN_FLAG",
    `${name} must be exactly 0 or 1`
  );
}

function parseIdentifier(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: string
): string {
  const value = environment[name] || defaultValue;
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new NodeConfigError(
      "INVALID_IDENTIFIER",
      `${name} must match ${IDENTIFIER_PATTERN.source}`
    );
  }
  return value;
}

function parseAbsolutePath(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: string
): string {
  const value = environment[name] || defaultValue;
  const isAbsolute =
    value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
  if (!isAbsolute || value.includes("\0")) {
    throw new NodeConfigError(
      "INVALID_ABSOLUTE_PATH",
      `${name} must be an absolute filesystem path`
    );
  }
  return value;
}

function parseLoopbackHealthUrl(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: string
): string {
  const value = environment[name] || defaultValue;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NodeConfigError(
      "INVALID_HEALTH_URL",
      `${name} must be a valid loopback URL`
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !new Set(["127.0.0.1", "[::1]", "localhost"]).has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/api/health" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new NodeConfigError(
      "INVALID_HEALTH_URL",
      `${name} must be a credential-free loopback /api/health URL`
    );
  }
  return url.toString();
}

function parseInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[name];
  const value = raw === undefined || raw === "" ? defaultValue : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new NodeConfigError(
      "INVALID_INTEGER",
      `${name} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return value;
}

export function loadBluezNodeConfig(
  environment: NodeJS.ProcessEnv = process.env
): Readonly<BluezNodeConfig> {
  const enabled = parseFlag(
    environment,
    "CASSA_BT_FEATURE_ENABLED",
    false
  );
  const gattServerEnabled = parseFlag(
    environment,
    "CASSA_BT_GATT_SERVER_ENABLED",
    false
  );
  if (gattServerEnabled && !enabled) {
    throw new NodeConfigError(
      "INVALID_FLAG_PREREQUISITE",
      "CASSA_BT_GATT_SERVER_ENABLED requires CASSA_BT_FEATURE_ENABLED=1"
    );
  }
  const helloExchangeEnabled = parseFlag(
    environment,
    "CASSA_BT_HELLO_ENABLED",
    false
  );
  if (helloExchangeEnabled && (!enabled || !gattServerEnabled)) {
    throw new NodeConfigError(
      "INVALID_FLAG_PREREQUISITE",
      "CASSA_BT_HELLO_ENABLED requires CASSA_BT_FEATURE_ENABLED=1 and CASSA_BT_GATT_SERVER_ENABLED=1"
    );
  }
  const mutualAuthEnabled = parseFlag(
    environment,
    "CASSA_BT_MUTUAL_AUTH_ENABLED",
    false
  );
  if (mutualAuthEnabled && !helloExchangeEnabled) {
    throw new NodeConfigError(
      "INVALID_FLAG_PREREQUISITE",
      "CASSA_BT_MUTUAL_AUTH_ENABLED requires CASSA_BT_HELLO_ENABLED=1"
    );
  }
  const directControlEnabled = parseFlag(
    environment,
    "CASSA_BT_DIRECT_CONTROL_ENABLED",
    false
  );
  if (directControlEnabled && !mutualAuthEnabled) {
    throw new NodeConfigError(
      "INVALID_FLAG_PREREQUISITE",
      "CASSA_BT_DIRECT_CONTROL_ENABLED requires CASSA_BT_MUTUAL_AUTH_ENABLED=1"
    );
  }
  const reliableChannelEnabled = parseFlag(
    environment,
    "CASSA_BT_RELIABLE_CHANNEL_ENABLED",
    false
  );
  if (reliableChannelEnabled && !directControlEnabled) {
    throw new NodeConfigError(
      "INVALID_FLAG_PREREQUISITE",
      "CASSA_BT_RELIABLE_CHANNEL_ENABLED requires CASSA_BT_DIRECT_CONTROL_ENABLED=1"
    );
  }
  const routeAdvertisementEnabled = parseFlag(
    environment,
    "CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED",
    false
  );
  if (routeAdvertisementEnabled && !reliableChannelEnabled) {
    throw new NodeConfigError(
      "INVALID_FLAG_PREREQUISITE",
      "CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED requires CASSA_BT_RELIABLE_CHANNEL_ENABLED=1"
    );
  }
  const commandBusShadowEnabled = parseFlag(
    environment,
    "CASSA_BT_COMMAND_BUS_SHADOW_ENABLED",
    false
  );
  if (commandBusShadowEnabled && !reliableChannelEnabled) {
    throw new NodeConfigError(
      "INVALID_FLAG_PREREQUISITE",
      "CASSA_BT_COMMAND_BUS_SHADOW_ENABLED requires CASSA_BT_RELIABLE_CHANNEL_ENABLED=1"
    );
  }
  if (commandBusShadowEnabled && !routeAdvertisementEnabled) {
    throw new NodeConfigError(
      "INVALID_FLAG_PREREQUISITE",
      "CASSA_BT_COMMAND_BUS_SHADOW_ENABLED requires CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED=1"
    );
  }

  const adapterName = environment.CASSA_BT_ADAPTER || "hci0";
  if (!ADAPTER_PATTERN.test(adapterName)) {
    throw new NodeConfigError(
      "INVALID_ADAPTER",
      `CASSA_BT_ADAPTER must match ${ADAPTER_PATTERN.source}`
    );
  }

  const nodeId = parseIdentifier(
    environment,
    "CASSA_BT_NODE_ID",
    "raspberry-main"
  );
  if (helloExchangeEnabled && !HELLO_NODE_ID_PATTERN.test(nodeId)) {
    throw new NodeConfigError(
      "INVALID_HELLO_NODE_ID",
      "CASSA_BT_HELLO_ENABLED requires CASSA_BT_NODE_ID to be a canonical lowercase UUID"
    );
  }
  const helloCapabilities = parseInteger(
    environment,
    "CASSA_BT_HELLO_CAPABILITIES",
    CAPABILITY_BITS.GATT_SERVER,
    0,
    0x7f
  );
  if (
    helloExchangeEnabled &&
    (helloCapabilities & CAPABILITY_BITS.GATT_SERVER) === 0
  ) {
    throw new NodeConfigError(
      "INVALID_HELLO_CAPABILITIES",
      "CASSA_BT_HELLO_CAPABILITIES must include the GATT_SERVER capability"
    );
  }
  const transportTickIntervalMs = parseInteger(
    environment,
    "CASSA_BT_TRANSPORT_TICK_INTERVAL_MS",
    250,
    50,
    5_000
  );
  const backendHealthIntervalMs = parseInteger(
    environment,
    "CASSA_BT_BACKEND_HEALTH_INTERVAL_MS",
    2_750,
    1_000,
    3_000
  );
  if (
    routeAdvertisementEnabled &&
    routeHealthWorstCaseMs({
      transportTickIntervalMs,
      backendHealthIntervalMs
    }) > ROUTE_HEALTH_OPERATIONAL_BUDGET_MS
  ) {
    throw new NodeConfigError(
      "ROUTE_HEALTH_SLA_BUDGET_EXCEEDED",
      `route advertisement timing exceeds the ${ROUTE_HEALTH_OPERATIONAL_BUDGET_MS} ms operational budget for the ${ROUTE_HEALTH_SLA_MS} ms fail-closed SLA`
    );
  }

  return Object.freeze({
    enabled,
    dryRun: parseFlag(environment, "CASSA_BT_DRY_RUN", true),
    gattServerEnabled,
    helloExchangeEnabled,
    mutualAuthEnabled,
    directControlEnabled,
    reliableChannelEnabled,
    routeAdvertisementEnabled,
    commandBusShadowEnabled,
    deviceRegistryPath: parseAbsolutePath(
      environment,
      "CASSA_BT_DEVICE_REGISTRY_PATH",
      "/var/lib/cassav5bt-bluetooth/devices.json"
    ),
    transportStorePath: parseAbsolutePath(
      environment,
      "CASSA_BT_TRANSPORT_STORE_PATH",
      "/var/lib/cassav5bt-bluetooth/transport.sqlite"
    ),
    backendHealthUrl: parseLoopbackHealthUrl(
      environment,
      "CASSA_BT_BACKEND_HEALTH_URL",
      "http://127.0.0.1:5381/api/health"
    ),
    helloBootId: parseInteger(
      environment,
      "CASSA_BT_HELLO_BOOT_ID",
      1,
      1,
      255
    ),
    helloCapabilities,
    adapterName,
    nodeId,
    storeId: parseIdentifier(environment, "CASSA_BT_STORE_ID", "store-1"),
    maintenanceIntervalMs: parseInteger(
      environment,
      "CASSA_BT_PEER_PRUNE_INTERVAL_MS",
      1_000,
      250,
      15_000
    ),
    metricsIntervalMs: parseInteger(
      environment,
      "CASSA_BT_METRICS_INTERVAL_MS",
      10_000,
      1_000,
      60_000
    ),
    transportTickIntervalMs,
    backendHealthIntervalMs
  });
}
