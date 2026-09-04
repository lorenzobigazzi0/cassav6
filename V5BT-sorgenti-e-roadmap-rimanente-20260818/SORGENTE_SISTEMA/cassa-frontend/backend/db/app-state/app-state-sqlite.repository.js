import { promises as fs } from "node:fs";
import path from "node:path";

export class AppStateSqliteRepository {
  constructor(options = {}) {
    this.dbPath = options.dbPath;
    this.importJsonPath = options.importJsonPath ?? "";
    this.buildInitialState = options.buildInitialState;
    this.isValidState = options.isValidState;
    this.loadSeedState = options.loadSeedState;
    this.nowIso = options.nowIso;
    this.safePathExists = options.safePathExists;
    this.canInitializeMissingDb = options.canInitializeMissingDb;
    this.canInitializeExistingEmptyDb = options.canInitializeExistingEmptyDb;
    this.buildEmptyDbInitDeniedMessage = options.buildEmptyDbInitDeniedMessage;
    this.db = null;
    this.DatabaseSyncClass = null;
  }

  async loadDatabaseSync() {
    if (!this.DatabaseSyncClass) {
      const sqliteModule = await import("node:sqlite");
      this.DatabaseSyncClass = sqliteModule.DatabaseSync;
    }
    return this.DatabaseSyncClass;
  }

  async resolveSeedState() {
    const imported = this.importJsonPath ? await this.loadSeedState?.(this.importJsonPath) : null;
    return imported ?? this.buildInitialState();
  }

  runImmediateTransaction(db, callback) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // noop
      }
      throw error;
    }
  }

  async ensure() {
    if (this.db) return { db: this.db, seededState: null, serialized: "", updatedAt: "" };

    const existedBeforeOpen = this.safePathExists(this.dbPath);
    if (!existedBeforeOpen && !this.canInitializeMissingDb()) {
      throw new Error(this.buildEmptyDbInitDeniedMessage("Database SQLite", this.dbPath));
    }

    if (!existedBeforeOpen) {
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    }

    const DatabaseSync = await this.loadDatabaseSync();
    const db = new DatabaseSync(this.dbPath);
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);

    const appStateTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_state'")
      .get();
    const mayCreateAppState =
      (!existedBeforeOpen && this.canInitializeMissingDb()) ||
      (existedBeforeOpen && this.canInitializeExistingEmptyDb());

    if (!appStateTable) {
      if (!mayCreateAppState) {
        this.closeDb(db);
        throw new Error(this.buildEmptyDbInitDeniedMessage("Database SQLite", this.dbPath));
      }
      db.exec(`
        CREATE TABLE app_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }

    const existingRow = db.prepare("SELECT json, updated_at FROM app_state WHERE id = 1").get();
    if (!existingRow) {
      if (!mayCreateAppState) {
        this.closeDb(db);
        throw new Error(this.buildEmptyDbInitDeniedMessage("Database SQLite", this.dbPath));
      }

      const seededState = await this.resolveSeedState();
      const serialized = JSON.stringify(seededState);
      const updatedAt = String(seededState.meta?.lastWriteAt ?? this.nowIso());
      this.runImmediateTransaction(db, () => {
        db.prepare("INSERT INTO app_state (id, json, updated_at) VALUES (1, ?, ?)").run(serialized, updatedAt);
      });
      this.db = db;
      return { db, seededState, serialized, updatedAt };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(existingRow.json);
    } catch (error) {
      this.closeDb(db);
      throw error;
    }

    if (!this.isValidState(parsed)) {
      this.closeDb(db);
      throw new Error("Invalid sqlite db shape");
    }

    this.db = db;
    return { db, seededState: null, serialized: "", updatedAt: "" };
  }

  async read() {
    await this.ensure();
    const row = this.db.prepare("SELECT json, updated_at FROM app_state WHERE id = 1").get();
    if (!row || typeof row.json !== "string") {
      throw new Error("SQLite state row missing");
    }

    const state = JSON.parse(row.json);
    if (!this.isValidState(state)) {
      throw new Error("Invalid sqlite db shape");
    }
    return { state, serialized: row.json, updatedAt: String(row.updated_at ?? "") };
  }

  async readReadonly() {
    const DatabaseSync = await this.loadDatabaseSync();
    const readonlyDb = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      readonlyDb.exec("PRAGMA busy_timeout = 5000;");
      const row = readonlyDb.prepare("SELECT json, updated_at FROM app_state WHERE id = 1").get();
      if (!row || typeof row.json !== "string") {
        throw new Error("SQLite state row missing");
      }

      const state = JSON.parse(row.json);
      if (!this.isValidState(state)) {
        throw new Error("Invalid sqlite db shape");
      }
      return { state, serialized: row.json, updatedAt: String(row.updated_at ?? "") };
    } finally {
      this.closeDb(readonlyDb);
    }
  }

  async checkHealth() {
    const DatabaseSync = await this.loadDatabaseSync();
    const readonlyDb = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      readonlyDb.exec("PRAGMA busy_timeout = 5000;");
      const row = readonlyDb.prepare("SELECT updated_at FROM app_state WHERE id = 1").get();
      if (!row) {
        throw new Error("SQLite state row missing");
      }
      return {
        ok: true,
        mode: "sqlite",
        updatedAt: String(row.updated_at ?? ""),
      };
    } finally {
      this.closeDb(readonlyDb);
    }
  }

  async write(state) {
    await this.ensure();
    const serialized = JSON.stringify(state);
    const updatedAt = String(state?.meta?.lastWriteAt ?? this.nowIso());
    this.runImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          `
            INSERT INTO app_state (id, json, updated_at)
            VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              json = excluded.json,
              updated_at = excluded.updated_at
          `
        )
        .run(serialized, updatedAt);
    });
    return { serialized, updatedAt };
  }

  closeDb(db) {
    try {
      db?.close();
    } catch {
      // noop
    }
  }

  close() {
    this.closeDb(this.db);
    this.db = null;
  }
}
