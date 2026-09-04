function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeIdentifier(value, fallback) {
  const identifier = String(value ?? fallback ?? "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(
      `Identificatore MySQL non valido: ${identifier || "(vuoto)"}`,
    );
  }
  return identifier;
}

function quoteIdentifier(identifier) {
  return `\`${identifier}\``;
}

function firstRow(rows) {
  return Array.isArray(rows) ? rows[0] : null;
}

function classifySql(sql) {
  const match = String(sql ?? "").trim().match(/^([a-z]+)/i);
  const verb = String(match?.[1] ?? "unknown").toLowerCase();
  return ["select", "insert", "update", "delete", "create"].includes(verb)
    ? verb
    : "other";
}

export class AppStateMysqlRepository {
  constructor(options = {}) {
    this.connectionUri =
      options.connectionUri ??
      process.env.BACKEND_MYSQL_URL ??
      process.env.MYSQL_URL ??
      process.env.DATABASE_URL ??
      "";
    this.host =
      options.host ??
      process.env.BACKEND_MYSQL_HOST ??
      process.env.MYSQL_HOST ??
      "127.0.0.1";
    this.port = parsePort(
      options.port ?? process.env.BACKEND_MYSQL_PORT ?? process.env.MYSQL_PORT,
      3306,
    );
    this.user =
      options.user ??
      process.env.BACKEND_MYSQL_USER ??
      process.env.MYSQL_USER ??
      "root";
    this.password =
      options.password ??
      process.env.BACKEND_MYSQL_PASSWORD ??
      process.env.MYSQL_PASSWORD ??
      "";
    this.database =
      options.database ??
      process.env.BACKEND_MYSQL_DATABASE ??
      process.env.MYSQL_DATABASE ??
      "cassa";
    this.tableName = normalizeIdentifier(
      options.tableName ?? process.env.BACKEND_MYSQL_APP_STATE_TABLE,
      "app_state",
    );
    this.importJsonPath = options.importJsonPath ?? "";
    this.buildInitialState = options.buildInitialState;
    this.isValidState = options.isValidState;
    this.loadSeedState = options.loadSeedState;
    this.nowIso = options.nowIso;
    this.canInitializeMissingDb = options.canInitializeMissingDb;
    this.canInitializeExistingEmptyDb = options.canInitializeExistingEmptyDb;
    this.buildEmptyDbInitDeniedMessage = options.buildEmptyDbInitDeniedMessage;
    this.mysql = options.mysql ?? null;
    this.pool = options.pool ?? null;
    this.poolMetricsEnabled =
      options.poolMetricsEnabled === true ||
      process.env.BACKEND_MYSQL_POOL_METRICS === "1";
    this.runtimeMetrics =
      this.poolMetricsEnabled &&
      options.runtimeMetrics &&
      typeof options.runtimeMetrics.recordOperation === "function"
        ? options.runtimeMetrics
        : null;
    this.poolMetrics = {
      activeConnections: 0,
      pendingAcquires: 0,
    };
    this.connectionLimit = parsePort(
      options.connectionLimit ?? process.env.BACKEND_MYSQL_CONNECTION_LIMIT,
      8,
    );
  }

  get tableSql() {
    return quoteIdentifier(this.tableName);
  }

  get targetDescription() {
    if (this.connectionUri) return "BACKEND_MYSQL_URL";
    return `${this.host}:${this.port}/${this.database}`;
  }

  async loadMysql() {
    if (this.mysql) return this.mysql;
    try {
      const mysqlModule = await import("mysql2/promise");
      this.mysql = mysqlModule.default ?? mysqlModule;
      return this.mysql;
    } catch (error) {
      const wrapped = new Error(
        "BACKEND_DB_MODE=mysql richiede la dipendenza 'mysql2'. Installa il pacchetto e riavvia il backend.",
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async getPool() {
    if (this.pool) {
      this.attachPoolMetrics(this.pool);
      return this.pool;
    }
    const mysql = await this.loadMysql();
    const poolStartedAt = Date.now();
    const baseOptions = {
      waitForConnections: true,
      connectionLimit: this.connectionLimit,
      timezone: "Z",
      supportBigNumbers: true,
    };
    this.pool = this.connectionUri
      ? mysql.createPool(this.connectionUri)
      : mysql.createPool({
          host: this.host,
          port: this.port,
          user: this.user,
          password: this.password,
          database: this.database,
          ...baseOptions,
        });
    this.recordMetric("pool.create", poolStartedAt);
    this.attachPoolMetrics(this.pool);
    return this.pool;
  }

  recordMetric(label, startedAt) {
    this.runtimeMetrics?.recordOperation?.(
      "appStateMysql",
      label,
      Math.max(0, Date.now() - startedAt),
    );
  }

  updatePoolGauges() {
    this.runtimeMetrics?.setGauge?.(
      "mysqlPoolActiveConnections",
      this.poolMetrics.activeConnections,
    );
    this.runtimeMetrics?.setGauge?.(
      "mysqlPoolPendingAcquires",
      this.poolMetrics.pendingAcquires,
    );
  }

  attachPoolMetrics(pool) {
    if (!pool || !this.runtimeMetrics || pool.__cassaMetricsWrapped === true) return;
    Object.defineProperty(pool, "__cassaMetricsWrapped", {
      configurable: true,
      enumerable: false,
      value: true,
    });
    const originalGetConnection = pool.getConnection.bind(pool);
    pool.getConnection = async (...args) => {
      const acquireStartedAt = Date.now();
      this.poolMetrics.pendingAcquires += 1;
      this.updatePoolGauges();
      try {
        const connection = await originalGetConnection(...args);
        this.recordMetric("connection.acquire", acquireStartedAt);
        this.poolMetrics.pendingAcquires = Math.max(
          0,
          this.poolMetrics.pendingAcquires - 1,
        );
        this.poolMetrics.activeConnections += 1;
        this.updatePoolGauges();
        this.attachConnectionMetrics(connection);
        return connection;
      } catch (error) {
        this.recordMetric("connection.acquire.error", acquireStartedAt);
        this.poolMetrics.pendingAcquires = Math.max(
          0,
          this.poolMetrics.pendingAcquires - 1,
        );
        this.updatePoolGauges();
        throw error;
      }
    };

    const originalQuery = pool.query.bind(pool);
    pool.query = async (...args) => {
      const queryStartedAt = Date.now();
      const label = `query.${classifySql(args?.[0])}`;
      try {
        const result = await originalQuery(...args);
        this.recordMetric(label, queryStartedAt);
        return result;
      } catch (error) {
        this.recordMetric(`${label}.error`, queryStartedAt);
        throw error;
      }
    };
  }

  attachConnectionMetrics(connection) {
    if (!connection || connection.__cassaMetricsWrapped === true) return;
    Object.defineProperty(connection, "__cassaMetricsWrapped", {
      configurable: true,
      enumerable: false,
      value: true,
    });
    const holdStartedAt = Date.now();
    const originalRelease = connection.release.bind(connection);
    let released = false;
    connection.release = (...args) => {
      if (!released) {
        released = true;
        this.poolMetrics.activeConnections = Math.max(
          0,
          this.poolMetrics.activeConnections - 1,
        );
        this.updatePoolGauges();
        this.recordMetric("connection.hold", holdStartedAt);
      }
      return originalRelease(...args);
    };
  }

  async query(sql, params = []) {
    const pool = await this.getPool();
    const [rows] = await pool.query(sql, params);
    return rows;
  }

  async tableExists() {
    const rows = await this.query(
      `
        SELECT COUNT(*) AS count
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = ?
      `,
      [this.tableName],
    );
    return Number(firstRow(rows)?.count ?? 0) > 0;
  }

  async createTable() {
    await this.query(`
      CREATE TABLE ${this.tableSql} (
        id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        json LONGTEXT NOT NULL,
        updated_at VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async resolveSeedState() {
    const imported = this.importJsonPath
      ? await this.loadSeedState?.(this.importJsonPath)
      : null;
    return imported ?? this.buildInitialState();
  }

  async ensure() {
    const existedBeforeOpen = await this.tableExists();
    const mayCreateAppState =
      (!existedBeforeOpen && this.canInitializeMissingDb()) ||
      (existedBeforeOpen && this.canInitializeExistingEmptyDb());

    if (!existedBeforeOpen) {
      if (!mayCreateAppState) {
        throw new Error(
          this.buildEmptyDbInitDeniedMessage(
            "Database MySQL",
            this.targetDescription,
          ),
        );
      }
      await this.createTable();
    }

    const rows = await this.query(
      `SELECT json, updated_at FROM ${this.tableSql} WHERE id = 1 LIMIT 1`,
    );
    const existingRow = firstRow(rows);
    if (!existingRow) {
      if (!mayCreateAppState) {
        throw new Error(
          this.buildEmptyDbInitDeniedMessage(
            "Database MySQL",
            this.targetDescription,
          ),
        );
      }
      const seededState = await this.resolveSeedState();
      const serialized = JSON.stringify(seededState);
      const updatedAt = String(seededState.meta?.lastWriteAt ?? this.nowIso());
      await this.writeRow(serialized, updatedAt);
      return { seededState, serialized, updatedAt };
    }

    const parsed = JSON.parse(String(existingRow.json ?? ""));
    if (!this.isValidState(parsed)) {
      throw new Error("Invalid mysql db shape");
    }

    return { seededState: null, serialized: "", updatedAt: "" };
  }

  async read() {
    await this.ensure();
    const rows = await this.query(
      `SELECT json, updated_at FROM ${this.tableSql} WHERE id = 1 LIMIT 1`,
    );
    const row = firstRow(rows);
    if (!row || typeof row.json !== "string") {
      throw new Error("MySQL state row missing");
    }

    const state = JSON.parse(row.json);
    if (!this.isValidState(state)) {
      throw new Error("Invalid mysql db shape");
    }
    return {
      state,
      serialized: row.json,
      updatedAt: String(row.updated_at ?? ""),
    };
  }

  async readReadonly() {
    return this.read();
  }

  async checkHealth() {
    const rows = await this.query(
      `SELECT updated_at FROM ${this.tableSql} WHERE id = 1 LIMIT 1`,
    );
    const row = firstRow(rows);
    if (!row) {
      throw new Error("MySQL state row missing");
    }
    return {
      ok: true,
      mode: "mysql",
      updatedAt: String(row.updated_at ?? ""),
    };
  }

  async writeRow(serialized, updatedAt) {
    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        `
          INSERT INTO ${this.tableSql} (id, json, updated_at)
          VALUES (1, ?, ?)
          ON DUPLICATE KEY UPDATE
            json = VALUES(json),
            updated_at = VALUES(updated_at)
        `,
        [serialized, updatedAt],
      );
      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // noop
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async write(state) {
    await this.ensure();
    const serialized = JSON.stringify(state);
    const updatedAt = String(state?.meta?.lastWriteAt ?? this.nowIso());
    await this.writeRow(serialized, updatedAt);
    return { serialized, updatedAt };
  }

  close() {
    const pool = this.pool;
    this.pool = null;
    return pool?.end?.();
  }
}
