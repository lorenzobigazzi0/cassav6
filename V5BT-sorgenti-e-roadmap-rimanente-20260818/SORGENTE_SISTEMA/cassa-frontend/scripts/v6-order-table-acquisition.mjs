import { performance } from "node:perf_hooks";

export const V6_ORDER_TABLE_AVAILABILITY_TIMEOUT =
  "V6_ORDER_TABLE_AVAILABILITY_TIMEOUT";

const normalizedTableId = (table) => String(table?.id ?? "").trim();

export class V6OrderTableAvailabilityTimeoutError extends Error {
  constructor({ timeoutMs, authorizedTableCount, scanCount }) {
    super(
      `Nessun tavolo disponibile entro ${timeoutMs} ms ` +
        `(${authorizedTableCount} autorizzati, ${scanCount} scansioni).`,
    );
    this.name = "V6OrderTableAvailabilityTimeoutError";
    this.code = V6_ORDER_TABLE_AVAILABILITY_TIMEOUT;
    this.timeoutMs = timeoutMs;
    this.authorizedTableCount = authorizedTableCount;
    this.scanCount = scanCount;
  }
}

export async function acquireV6OrderCreateTable({
  authorizedTables,
  reservedTableIds = null,
  inFlightTableIds,
  selectTable = (availableTables) => availableTables[0],
  timeoutMs = 5_000,
  pollIntervalMs = 50,
  monotonicNow = () => performance.now(),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (!(inFlightTableIds instanceof Set)) {
    throw new TypeError("inFlightTableIds deve essere un Set.");
  }
  if (typeof selectTable !== "function") {
    throw new TypeError("selectTable deve essere una funzione.");
  }
  if (typeof monotonicNow !== "function" || typeof wait !== "function") {
    throw new TypeError("monotonicNow e wait devono essere funzioni.");
  }

  const tables = (Array.isArray(authorizedTables) ? authorizedTables : []).filter(
    (table, index, all) => {
      const tableId = normalizedTableId(table);
      return (
        tableId &&
        all.findIndex((candidate) => normalizedTableId(candidate) === tableId) ===
          index
      );
    },
  );
  const timeout = Math.max(0, Math.trunc(Number(timeoutMs) || 0));
  const poll = Math.max(1, Math.trunc(Number(pollIntervalMs) || 1));
  const startedAt = Number(monotonicNow());
  const deadlineAt = startedAt + timeout;
  let scanCount = 0;

  while (true) {
    scanCount += 1;
    const availableTables = tables.filter((table) => {
      const tableId = normalizedTableId(table);
      return (
        (!(reservedTableIds instanceof Set) ||
          !reservedTableIds.has(tableId)) &&
        !inFlightTableIds.has(tableId)
      );
    });

    if (availableTables.length > 0) {
      const selected = selectTable(availableTables, scanCount);
      const selectedId = normalizedTableId(selected);
      const table = availableTables.find(
        (candidate) => normalizedTableId(candidate) === selectedId,
      );
      if (!table) {
        throw new Error("selectTable deve restituire un tavolo disponibile.");
      }

      // Nessun await tra l'ultimo controllo e la prenotazione: nel runner Node
      // la selezione e l'inserimento nel Set costituiscono un'unica sezione critica.
      inFlightTableIds.add(selectedId);
      return {
        table,
        tableId: selectedId,
        scanCount,
        waitedMs: Math.max(0, Number(monotonicNow()) - startedAt),
      };
    }

    const now = Number(monotonicNow());
    const remainingMs = deadlineAt - now;
    if (remainingMs <= 0) {
      throw new V6OrderTableAvailabilityTimeoutError({
        timeoutMs: timeout,
        authorizedTableCount: tables.length,
        scanCount,
      });
    }
    await wait(Math.min(poll, remainingMs));
  }
}
