import { TablesBillsRelationalRepository } from "../../db/relational/index.js";
import { normalizeScopedReadId } from "./scoped-reads.domain.js";

function sanitizeRelationalScopedTable(table) {
  if (!table || typeof table !== "object") return null;
  const tableId = normalizeScopedReadId(table.tableId ?? table.id);
  if (!tableId) return null;
  return {
    ...table,
    id: tableId,
    tableId,
    roomId: normalizeScopedReadId(table.roomId),
  };
}

export function createRelationalScopedTableReader(options = {}) {
  const {
    enabled = false,
    logger = console,
    relationalRuntime = null,
  } = options;

  async function createRepository() {
    if (!enabled || !relationalRuntime) return null;
    await relationalRuntime.initialize?.();
    if (!relationalRuntime.db) return null;
    return new TablesBillsRelationalRepository(relationalRuntime.db);
  }

  async function getTable(tableId) {
    const id = normalizeScopedReadId(tableId);
    if (!id) return null;
    try {
      const repository = await createRepository();
      if (!repository) return null;
      return sanitizeRelationalScopedTable(repository.getTableState(id));
    } catch (error) {
      logger.warn?.(
        `[scoped-reads] relational table fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async function listRoomTables(roomId) {
    const id = normalizeScopedReadId(roomId);
    if (!id) return null;
    try {
      const repository = await createRepository();
      if (!repository) return null;
      return repository
        .listTableStates({ roomId: id })
        .map(sanitizeRelationalScopedTable)
        .filter(Boolean);
    } catch (error) {
      logger.warn?.(
        `[scoped-reads] relational room tables fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  return {
    enabled,
    getTable,
    listRoomTables,
  };
}
