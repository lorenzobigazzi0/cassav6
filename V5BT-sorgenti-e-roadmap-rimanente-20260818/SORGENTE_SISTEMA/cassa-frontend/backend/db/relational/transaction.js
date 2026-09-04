const activeRelationalTransactions = new WeakSet();

function recordTransactionStep(options, label, startedAt) {
  try {
    options?.onStep?.(label, Date.now() - startedAt);
  } catch {
    // La telemetria non deve modificare l'esito della transazione.
  }
}

function ensureDatabase(db) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
    throw new Error("withRelationalTransaction richiede una connessione SQLite relazionale valida.");
  }
}

export function withRelationalTransaction(db, fn, options = {}) {
  ensureDatabase(db);
  if (typeof fn !== "function") {
    throw new Error("withRelationalTransaction richiede una callback.");
  }
  if (activeRelationalTransactions.has(db)) {
    throw new Error("Transazione relazionale annidata non supportata.");
  }

  activeRelationalTransactions.add(db);
  let transactionStarted = false;
  try {
    let stepStartedAt = Date.now();
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    recordTransactionStep(options, "beginImmediate", stepStartedAt);
    const tx = {
      db,
      exec(sql) {
        return db.exec(sql);
      },
      prepare(sql) {
        return db.prepare(sql);
      },
    };
    stepStartedAt = Date.now();
    const result = fn(tx);
    recordTransactionStep(options, "body", stepStartedAt);
    if (result && typeof result.then === "function") {
      throw new Error("withRelationalTransaction supporta solo callback sincrone.");
    }
    stepStartedAt = Date.now();
    db.exec("COMMIT");
    transactionStarted = false;
    recordTransactionStep(options, "commit", stepStartedAt);
    return result;
  } catch (error) {
    if (transactionStarted) {
      const rollbackStartedAt = Date.now();
      try {
        db.exec("ROLLBACK");
      } catch {
        // noop
      }
      recordTransactionStep(options, "rollback", rollbackStartedAt);
    }
    throw error;
  } finally {
    activeRelationalTransactions.delete(db);
  }
}
