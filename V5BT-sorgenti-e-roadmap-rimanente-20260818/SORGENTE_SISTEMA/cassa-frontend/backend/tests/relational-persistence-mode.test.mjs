import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createDomainStore,
  createRelationalRuntime,
  openRelationalConnection,
  withRelationalTransaction,
} from "../db/relational/index.js";
import { closeRelationalConnection, normalizeRelationalConfig } from "../db/relational/connection.js";
import {
  assertPrimaryRelationalAvailable,
  getRelationalMode,
  isDomainReadPrimary,
  isDomainWritePrimary,
  isRelationalEnabled,
  normalizePersistenceMode,
} from "../db/persistence-mode.js";
import {
  apiPost,
  authPayload,
  createTempRunDir,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

function relationalConfig(dbPath) {
  return {
    enabled: true,
    mode: "shadow",
    dbPath,
  };
}

test("persistence-mode abilita read-primary solo per domini configurati", () => {
  const env = {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "primary",
    BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users,sale-sessions",
  };

  assert.equal(isRelationalEnabled({ env }), true);
  assert.equal(getRelationalMode({ env }), "primary");
  assert.equal(isDomainReadPrimary("users", { env }), true);
  assert.equal(isDomainReadPrimary("saleSessions", { env }), true);
  assert.equal(isDomainReadPrimary("sessions", { env }), false);
  assert.equal(isDomainReadPrimary("payments", { env }), false);
});

test("isDomainWritePrimary riconosce env futura ma non attiva scritture", () => {
  const env = {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "primary",
    BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
    BACKEND_RELATIONAL_WRITE_PRIMARY_DOMAINS: "users,payments",
  };
  const mode = normalizePersistenceMode({ env });

  assert.equal(mode.requestedWritePrimaryDomains.has("users"), true);
  assert.equal(mode.requestedWritePrimaryDomains.has("payments"), true);
  assert.equal(isDomainWritePrimary("users", { env }), false);
  assert.equal(isDomainWritePrimary("payments", { env }), false);
});

test("write-primary richiesto fallisce chiaramente nel runtime relazionale", () => {
  const env = {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "primary",
    BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
    BACKEND_RELATIONAL_WRITE_PRIMARY_DOMAINS: "users",
  };

  assert.throws(
    () => normalizeRelationalConfig({ env }),
    /BACKEND_RELATIONAL_WRITE_PRIMARY_DOMAINS non e' ancora supportato/i
  );
  assert.throws(
    () => assertPrimaryRelationalAvailable("users", { env, access: "write" }),
    /write-primary relazionale per users non e' ancora supportato/i
  );
});

test("domain-store sceglie repository relazionale solo per read-primary", () => {
  const env = {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "primary",
    BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
  };
  const appStateRepository = { source: "app-state" };
  const relationalRepository = { source: "relational" };
  const store = createDomainStore({
    domain: "users",
    env,
    relationalDb: { exec() {}, prepare() {} },
    appStateRepository,
    relationalRepository,
  });

  assert.equal(store.isReadPrimary(), true);
  assert.equal(store.isWritePrimary(), false);
  assert.equal(store.getReadRepository({}), relationalRepository);
  assert.equal(store.getWriteRepository({}), appStateRepository);
});

test("withRelationalTransaction committa", async () => {
  const runDir = await createTempRunDir("rel-tx-commit");
  const db = await openRelationalConnection(relationalConfig(path.join(runDir, "rel.sqlite")));
  try {
    db.exec("CREATE TABLE tx_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const steps = [];
    const result = withRelationalTransaction(db, (tx) => {
      tx.prepare("INSERT INTO tx_test (id, value) VALUES (?, ?)").run("a", "committed");
      return "ok";
    }, { onStep: (label, durationMs) => steps.push({ label, durationMs }) });

    assert.equal(result, "ok");
    assert.equal(db.prepare("SELECT value FROM tx_test WHERE id = ?").get("a")?.value, "committed");
    assert.deepEqual(steps.map((entry) => entry.label), ["beginImmediate", "body", "commit"]);
    assert.equal(steps.every((entry) => entry.durationMs >= 0), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("withRelationalTransaction rollbacka su errore", async () => {
  const runDir = await createTempRunDir("rel-tx-rollback");
  const db = await openRelationalConnection(relationalConfig(path.join(runDir, "rel.sqlite")));
  try {
    db.exec("CREATE TABLE tx_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const steps = [];

    assert.throws(
      () =>
        withRelationalTransaction(db, (tx) => {
          tx.prepare("INSERT INTO tx_test (id, value) VALUES (?, ?)").run("a", "rolled-back");
          throw new Error("boom");
        }, { onStep: (label) => steps.push(label) }),
      /boom/
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tx_test").get().count, 0);
    assert.deepEqual(steps, ["beginImmediate", "rollback"]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("withRelationalTransaction libera il guard se BEGIN IMMEDIATE fallisce", () => {
  let failBegin = true;
  const statements = [];
  const db = {
    exec(statement) {
      statements.push(statement);
      if (statement === "BEGIN IMMEDIATE" && failBegin) {
        failBegin = false;
        throw new Error("database is busy");
      }
    },
    prepare() {
      return {};
    },
  };

  assert.throws(() => withRelationalTransaction(db, () => "first"), /database is busy/);
  assert.equal(withRelationalTransaction(db, () => "second"), "second");
  assert.deepEqual(statements, ["BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "COMMIT"]);
});

test("withRelationalTransaction rifiuta transazioni annidate", async () => {
  const runDir = await createTempRunDir("rel-tx-nested");
  const db = await openRelationalConnection(relationalConfig(path.join(runDir, "rel.sqlite")));
  try {
    db.exec("CREATE TABLE tx_test (id TEXT PRIMARY KEY)");

    assert.throws(
      () =>
        withRelationalTransaction(db, () => {
          withRelationalTransaction(db, () => {});
        }),
      /Transazione relazionale annidata non supportata/
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tx_test").get().count, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("nessun endpoint cambia comportamento con write-primary disattivato", async (t) => {
  const { baseUrl } = await startBackend(t);
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);

  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "persistence-mode-device",
    clientApp: "cassa-frontend",
  });
  assert.equal(session.ok, true);
  assert.equal(session.user.id, "u_cashier");

  const status = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(session, "persistence-mode-device", { clientApp: "cassa-frontend" })
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.valid, true);
  assert.equal(status.body.userId, "u_cashier");
});

test("runtime relazionale espone write-primary sempre inattivo", () => {
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
    },
    logger: { warn() {} },
  });

  assert.equal(runtime.isPrimaryDomain("users"), true);
  assert.equal(runtime.isWritePrimaryDomain("users"), false);
});

test("runtime relazionale puo aprire outbox senza shadow sync app-state", async () => {
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED: "0",
    },
    logger: { warn() {} },
  });

  assert.equal(runtime.shadowSyncEnabled, false);
  assert.equal(await runtime.syncAfterAppStateWrite({}), null);
});
