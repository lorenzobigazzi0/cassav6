import { copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAuditEventsSplitRepository,
  createDeviceStatusSplitRepository,
  createOrdersSplitRepository,
  createPaymentsFiscalSplitRepository,
  createPrintSpoolJobsSplitRepository,
  createTableLocksSplitRepository,
  createTableStateSplitRepository,
  readJsonStateFile,
  writeJsonStateFile,
} from "../db/app-state/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, "..");
const defaultStatePath = path.join(backendDir, "app-state.json");
const defaultSplitDbPath = path.join(backendDir, "app-state-split.sqlite");

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function backupTimestamp() {
  return new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\..+$/, "").replace("T", "-");
}

function backupPathFor(statePath) {
  const parsed = path.parse(statePath);
  return path.join(parsed.dir, `${parsed.name}.partial-split-backup-${backupTimestamp()}${parsed.ext}`);
}

function collectionLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function summarizeState(state) {
  const paymentFiscalKeys = [
    "paymentContainers",
    "paymentParts",
    "paymentTransactions",
    "paymentProviderTransactions",
    "payments",
    "fiscalReceipts",
    "fiscalEvents",
    "cashTxDenoms",
    "smartNonFiscal",
  ];
  const paymentFiscal = Object.fromEntries(paymentFiscalKeys.map((key) => [key, collectionLength(state?.[key])]));
  const tables = Array.isArray(state?.posSettings?.tables) ? state.posSettings.tables : [];

  return {
    splitMetadata: Boolean(state?.meta?.appStateSplitDomains),
    auditEvents: collectionLength(state?.auditEvents),
    printSpoolJobs: collectionLength(state?.printSpoolJobs),
    sessions: collectionLength(state?.sessions),
    stationStates: collectionLength(state?.integration?.stationStates),
    orders: collectionLength(state?.integration?.orders),
    tables: tables.length,
    tablesWithStatus: tables.filter((table) => typeof table?.status === "string" && table.status.trim()).length,
    tablesWithPendingBills: tables.filter((table) => Array.isArray(table?.pendingBills) && table.pendingBills.length > 0)
      .length,
    tableLocks: collectionLength(state?.tableLocks),
    paymentFiscal,
  };
}

function createExternalizedSplitRepositories(splitDbPath) {
  const commonOptions = {
    mode: "externalized",
    dbPath: splitDbPath,
    cloneJson,
  };

  return [
    createAuditEventsSplitRepository(commonOptions),
    createPrintSpoolJobsSplitRepository(commonOptions),
    createDeviceStatusSplitRepository(commonOptions),
    createTableLocksSplitRepository(commonOptions),
    createTableStateSplitRepository(commonOptions),
    createOrdersSplitRepository(commonOptions),
    createPaymentsFiscalSplitRepository(commonOptions),
  ];
}

async function hydrateFromSplitDb(state, splitDbPath) {
  const repositories = createExternalizedSplitRepositories(splitDbPath);
  try {
    let hydrated = state;
    for (const repository of repositories) {
      hydrated = await repository.hydrateAppState(hydrated);
    }
    return hydrated;
  } finally {
    for (const repository of repositories.toReversed()) {
      try {
        repository.close?.();
      } catch {
        // noop
      }
    }
  }
}

async function main() {
  const statePath = path.resolve(String(process.env.BACKEND_DB_PATH ?? defaultStatePath).trim() || defaultStatePath);
  const splitDbPath = path.resolve(
    String(process.env.BACKEND_APP_STATE_SPLIT_DB_PATH ?? defaultSplitDbPath).trim() || defaultSplitDbPath
  );
  const tmpPath = `${statePath}.tmp-full-json`;
  const backupPath = backupPathFor(statePath);

  await stat(splitDbPath);
  const state = await readJsonStateFile(statePath);
  const before = summarizeState(state);
  const hydrated = await hydrateFromSplitDb(state, splitDbPath);

  if (!hydrated.meta || typeof hydrated.meta !== "object") {
    hydrated.meta = {};
  }
  delete hydrated.meta.appStateSplitDomains;

  await copyFile(statePath, backupPath);
  const serialized = await writeJsonStateFile(statePath, tmpPath, hydrated);

  const after = summarizeState(hydrated);
  console.log(
    JSON.stringify(
      {
        statePath,
        splitDbPath,
        backupPath,
        bytesWritten: Buffer.byteLength(serialized, "utf8"),
        before,
        after,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
