import { createHash } from "node:crypto";

export const B11_VIRTUAL_HANDHELD_COUNT = 10;
export const B11_VIRTUAL_STATION_COUNT = 3;
export const B11_VIRTUAL_RASPBERRY_COUNT = 1;
export const B11_VIRTUAL_AUTOMATIC_CASH_COUNT = 1;
export const B11_VIRTUAL_FISCAL_RT_COUNT = 1;
export const B11_VIRTUAL_ACTIONS_PER_ANDROID = 200;
export const B11_VIRTUAL_PERIPHERAL_TRANSACTIONS = 100;

const ANDROID_COUNT = B11_VIRTUAL_HANDHELD_COUNT + B11_VIRTUAL_STATION_COUNT;
const ALLOWED_OPTION_KEYS = new Set([
  "seed",
  "handheldCount",
  "stationCount",
  "raspberryCount",
  "automaticCashCount",
  "fiscalRtCount",
  "actionsPerAndroidDevice",
  "peripheralCycles"
]);

export class B11VirtualBusinessWorkloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "B11VirtualBusinessWorkloadError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new B11VirtualBusinessWorkloadError(code, message);
}

function exactInteger(value, expected, field) {
  const resolved = value ?? expected;
  if (!Number.isSafeInteger(resolved) || resolved !== expected) {
    fail("INVALID_PROFILE", `${field} must be exactly ${expected}`);
  }
  return resolved;
}

function canonicalSeed(value) {
  const resolved = value ?? "b11-hybrid-business-v1";
  if (typeof resolved !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(resolved)) {
    fail("INVALID_PROFILE", "seed is not canonical");
  }
  return resolved;
}

function keyFor(seed, kind, index) {
  return createHash("sha256")
    .update(`V6:B11:VIRTUAL-BUSINESS:${seed}:${kind}:${index}`, "utf8")
    .digest("hex");
}

function frozenTopology() {
  const androidPairCount = ANDROID_COUNT * (ANDROID_COUNT - 1) / 2;
  const androidRaspberryLinkCount = ANDROID_COUNT * B11_VIRTUAL_RASPBERRY_COUNT;
  return Object.freeze({
    totalActors:
      ANDROID_COUNT +
      B11_VIRTUAL_RASPBERRY_COUNT +
      B11_VIRTUAL_AUTOMATIC_CASH_COUNT +
      B11_VIRTUAL_FISCAL_RT_COUNT,
    bluetoothNodeCount: ANDROID_COUNT + B11_VIRTUAL_RASPBERRY_COUNT,
    androidNodeCount: ANDROID_COUNT,
    handheldCount: B11_VIRTUAL_HANDHELD_COUNT,
    stationCount: B11_VIRTUAL_STATION_COUNT,
    raspberryCount: B11_VIRTUAL_RASPBERRY_COUNT,
    automaticCashCount: B11_VIRTUAL_AUTOMATIC_CASH_COUNT,
    fiscalRtCount: B11_VIRTUAL_FISCAL_RT_COUNT,
    androidPairCount,
    androidRaspberryLinkCount,
    transportLinkCount: androidPairCount + androidRaspberryLinkCount
  });
}

export function buildB11HybridTopology() {
  return frozenTopology();
}

class VirtualIdempotentPeripheral {
  #kind;
  #online = true;
  #records = new Map();
  #completedTransactions = 0;
  #exactReplays = 0;
  #mutatedReplaysRejected = 0;
  #outageFaults = 0;
  #recoveries = 0;
  #totalCents = 0;

  constructor(kind) {
    this.#kind = kind;
  }

  setOnline(online) {
    if (typeof online !== "boolean") fail("INVALID_OPERATION", "online must be boolean");
    if (this.#online === false && online === true) this.#recoveries += 1;
    this.#online = online;
  }

  execute(key, amountCents) {
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) {
      fail("INVALID_OPERATION", "idempotency key is not canonical");
    }
    if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 1_000_000) {
      fail("INVALID_OPERATION", "amountCents is outside its canonical range");
    }
    if (!this.#online) {
      this.#outageFaults += 1;
      throw new B11VirtualBusinessWorkloadError(
        `${this.#kind}_UNAVAILABLE`,
        "virtual peripheral is unavailable"
      );
    }
    const previous = this.#records.get(key);
    if (previous !== undefined) {
      if (previous !== amountCents) {
        this.#mutatedReplaysRejected += 1;
        throw new B11VirtualBusinessWorkloadError(
          `${this.#kind}_IDEMPOTENCY_CONFLICT`,
          "mutated idempotent replay was rejected"
        );
      }
      this.#exactReplays += 1;
      return Object.freeze({ accepted: false, replay: true });
    }
    this.#records.set(key, amountCents);
    this.#completedTransactions += 1;
    this.#totalCents += amountCents;
    return Object.freeze({ accepted: true, replay: false });
  }

  close() {
    this.#records.clear();
    this.#online = false;
  }

  snapshot(expectedTransactions) {
    return Object.freeze({
      expectedTransactions,
      completedTransactions: this.#completedTransactions,
      exactReplays: this.#exactReplays,
      mutatedReplaysRejected: this.#mutatedReplaysRejected,
      outageFaults: this.#outageFaults,
      recoveries: this.#recoveries,
      totalCents: this.#totalCents,
      pendingTransactions: this.#records.size
    });
  }
}

function isCommandOrdinal(ordinal) {
  const position = (ordinal - 1) % 5;
  return position === 0 || position === 2;
}

export function runB11VirtualBusinessWorkload(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("INVALID_PROFILE", "options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      fail("INVALID_PROFILE", `unknown profile field: ${key}`);
    }
  }
  const seed = canonicalSeed(options.seed);
  const handheldCount = exactInteger(
    options.handheldCount,
    B11_VIRTUAL_HANDHELD_COUNT,
    "handheldCount"
  );
  const stationCount = exactInteger(
    options.stationCount,
    B11_VIRTUAL_STATION_COUNT,
    "stationCount"
  );
  const raspberryCount = exactInteger(
    options.raspberryCount,
    B11_VIRTUAL_RASPBERRY_COUNT,
    "raspberryCount"
  );
  exactInteger(
    options.automaticCashCount,
    B11_VIRTUAL_AUTOMATIC_CASH_COUNT,
    "automaticCashCount"
  );
  exactInteger(
    options.fiscalRtCount,
    B11_VIRTUAL_FISCAL_RT_COUNT,
    "fiscalRtCount"
  );
  const actionsPerAndroid = exactInteger(
    options.actionsPerAndroidDevice,
    B11_VIRTUAL_ACTIONS_PER_ANDROID,
    "actionsPerAndroidDevice"
  );
  const peripheralCycles = exactInteger(
    options.peripheralCycles,
    B11_VIRTUAL_PERIPHERAL_TRANSACTIONS,
    "peripheralCycles"
  );

  const coveredHandhelds = new Set();
  const coveredStations = new Set();
  let handheldActions = 0;
  let stationActions = 0;
  let handheldCommands = 0;
  for (let index = 0; index < handheldCount; index += 1) {
    for (let ordinal = 1; ordinal <= actionsPerAndroid; ordinal += 1) {
      coveredHandhelds.add(index);
      handheldActions += 1;
      if (isCommandOrdinal(ordinal)) handheldCommands += 1;
    }
  }
  for (let index = 0; index < stationCount; index += 1) {
    for (let ordinal = 1; ordinal <= actionsPerAndroid; ordinal += 1) {
      coveredStations.add(index);
      stationActions += 1;
    }
  }

  const automaticCash = new VirtualIdempotentPeripheral("AUTOMATIC_CASH");
  const fiscalRt = new VirtualIdempotentPeripheral("FISCAL_RT");
  try {
    automaticCash.setOnline(false);
    try {
      automaticCash.execute(keyFor(seed, "cash", 0), 1_000);
      fail("FAULT_NOT_EXERCISED", "automatic cash outage did not fail");
    } catch (error) {
      if (error?.code !== "AUTOMATIC_CASH_UNAVAILABLE") throw error;
    }
    automaticCash.setOnline(true);

    fiscalRt.setOnline(false);
    try {
      fiscalRt.execute(keyFor(seed, "rt", 0), 1_000);
      fail("FAULT_NOT_EXERCISED", "fiscal RT outage did not fail");
    } catch (error) {
      if (error?.code !== "FISCAL_RT_UNAVAILABLE") throw error;
    }
    fiscalRt.setOnline(true);

    for (let cycle = 0; cycle < peripheralCycles; cycle += 1) {
      const amountCents = 100 + ((cycle * 137) % 50_000);
      const cashKey = keyFor(seed, "cash", cycle);
      const rtKey = keyFor(seed, "rt", cycle);
      automaticCash.execute(cashKey, amountCents);
      automaticCash.execute(cashKey, amountCents);
      fiscalRt.execute(rtKey, amountCents);
      fiscalRt.execute(rtKey, amountCents);
      if (cycle === 0) {
        for (const [peripheral, key] of [
          [automaticCash, cashKey],
          [fiscalRt, rtKey]
        ]) {
          try {
            peripheral.execute(key, amountCents + 1);
            fail("FAULT_NOT_EXERCISED", "mutated replay did not fail");
          } catch (error) {
            if (!String(error?.code ?? "").endsWith("_IDEMPOTENCY_CONFLICT")) {
              throw error;
            }
          }
        }
      }
    }

    const expectedActions = (handheldCount + stationCount) * actionsPerAndroid;
    const cashSnapshot = automaticCash.snapshot(peripheralCycles);
    const rtSnapshot = fiscalRt.snapshot(peripheralCycles);
    automaticCash.close();
    fiscalRt.close();
    const cashAfterClose = automaticCash.snapshot(peripheralCycles);
    const rtAfterClose = fiscalRt.snapshot(peripheralCycles);
    return Object.freeze({
      actionsPerAndroid,
      expectedActions,
      completedActions: handheldActions + stationActions,
      handheldActions,
      stationActions,
      handheldCommands,
      coveredHandhelds: coveredHandhelds.size,
      coveredStations: coveredStations.size,
      raspberryCount,
      raspberryBrokeredActions: expectedActions,
      automaticCash: Object.freeze({
        ...cashSnapshot,
        pendingTransactions: cashAfterClose.pendingTransactions
      }),
      fiscalRt: Object.freeze({
        ...rtSnapshot,
        pendingTransactions: rtAfterClose.pendingTransactions
      }),
      businessTransport: "LAN_HTTP_SSE",
      bluetoothBusinessMessagesForwarded: 0,
      externalAccess: false,
      cleanupComplete:
        cashAfterClose.pendingTransactions === 0 && rtAfterClose.pendingTransactions === 0
    });
  } finally {
    automaticCash.close();
    fiscalRt.close();
  }
}
