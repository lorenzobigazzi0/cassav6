#!/usr/bin/env node
/**
 * REV2 2026-08-31 — Riconciliazione legacy -> PostgreSQL.
 *
 * Questo e il controllo che mancava nella REV1: confronta conteggi, somme e
 * hash fra la sorgente legacy (MariaDB app-state + SQLite relational) e
 * PostgreSQL. reconciliation_checks.sql verifica solo lo stato interno di PG e
 * non puo sostituire questo file.
 *
 * Uso:
 *   node scripts/reconcile_legacy_vs_pg.mjs --config reconcile.config.json
 *   node scripts/reconcile_legacy_vs_pg.mjs --config reconcile.config.json --json > report.json
 *
 * Exit code:
 *   0  nessun mismatch critico
 *   1  almeno un mismatch critico  (il cutover NON procede)
 *   2  errore di configurazione o di connessione
 *
 * SCHELETRO INTENZIONALE: le query legacy vanno completate con la mappatura
 * reale dei domini, che dipende da decisioni prese in P12 (regola di merge per
 * dominio, doc 07). Non e completabile a tavolino senza quelle decisioni.
 * Ogni check con `legacyQuery: null` fallisce esplicitamente invece di passare.
 */

import { readFile } from "node:fs/promises";
import process from "node:process";

/* -------------------------------------------------------------------------- */
/* Definizione dei check                                                       */
/* -------------------------------------------------------------------------- */

/**
 * kind:
 *   'count'  -> confronto di conteggi
 *   'sum'    -> confronto di somme monetarie (in centesimi interi)
 *   'hash'   -> confronto di un hash ordinato di chiavi naturali
 *
 * severity:
 *   'critical' -> un mismatch blocca il cutover
 *   'warning'  -> un mismatch va spiegato ma non blocca
 *
 * tolerance: ammessa SOLO dove esiste una ragione documentata (es. record
 * orfani noti che l'importer scarta di proposito). Default 0.
 */
const CHECKS = [
  {
    id: "users.count",
    kind: "count",
    severity: "critical",
    legacySource: "mariadb",
    legacyQuery: null, // TODO P12: conteggio utenti in app_state
    pgQuery: "SELECT count(*)::bigint AS value FROM identity.users",
    tolerance: 0,
    note: "Un utente perso significa un operatore che non entra in cassa.",
  },
  {
    id: "products.count",
    kind: "count",
    severity: "critical",
    legacySource: "mariadb",
    legacyQuery: null, // TODO P12: menuItems + commercial_products dopo unificazione (COM-01)
    pgQuery: "SELECT count(*)::bigint AS value FROM catalog.products",
    tolerance: 0,
    note: "Dipende da COM-01: definire cosa conta come prodotto canonico prima di eseguire.",
  },
  {
    id: "product_ingredient_labels.count",
    kind: "count",
    severity: "critical",
    legacySource: "mariadb",
    legacyQuery: null, // TODO P12: somma delle lunghezze di menuItem.ingredients[]
    pgQuery: "SELECT count(*)::bigint AS value FROM catalog.product_ingredient_labels",
    tolerance: 0,
    note: "Gate 'nessuna perdita di ingredient labels'. Deve essere esatto.",
  },
  {
    id: "orders.count",
    kind: "count",
    severity: "critical",
    legacySource: "sqlite",
    legacyQuery: "SELECT count(*) AS value FROM orders",
    pgQuery: "SELECT count(*)::bigint AS value FROM sales.orders",
    tolerance: 0,
  },
  {
    id: "order_lines.count",
    kind: "count",
    severity: "critical",
    legacySource: "sqlite",
    legacyQuery: "SELECT count(*) AS value FROM order_lines",
    pgQuery: "SELECT count(*)::bigint AS value FROM sales.order_lines",
    tolerance: 0,
  },
  {
    id: "payments.count",
    kind: "count",
    severity: "critical",
    legacySource: "sqlite",
    legacyQuery: "SELECT count(*) AS value FROM payment_containers",
    pgQuery: "SELECT count(*)::bigint AS value FROM payments.payments",
    tolerance: 0,
  },
  {
    id: "payments.gross_settled",
    kind: "sum",
    severity: "critical",
    legacySource: "sqlite",
    legacyQuery: null, // TODO P12: somma in centesimi, attenzione alla conversione da float legacy
    pgQuery: "SELECT COALESCE(sum(amount_cents),0)::bigint AS value FROM payments.payments WHERE status = 'SETTLED'",
    tolerance: 0,
    note: "Zero tolleranza. Una differenza di un centesimo va spiegata, non arrotondata.",
  },
  {
    id: "fiscal_documents.count",
    kind: "count",
    severity: "critical",
    legacySource: "sqlite",
    legacyQuery: "SELECT count(*) AS value FROM fiscal_receipts",
    pgQuery: "SELECT count(*)::bigint AS value FROM fiscal.documents",
    tolerance: 0,
    note: "Un documento fiscale mancante e un problema legale, non tecnico.",
  },
  {
    id: "benefit_redemptions.sum",
    kind: "sum",
    severity: "critical",
    legacySource: "mariadb",
    legacyQuery: null, // TODO P12: somma redemption in app_state
    pgQuery: "SELECT COALESCE(sum(amount_cents),0)::bigint AS value FROM commerce.benefit_redemptions",
    tolerance: 0,
  },
  {
    id: "reservations.count",
    kind: "count",
    severity: "critical",
    legacySource: "sqlite",
    legacyQuery: "SELECT count(*) AS value FROM reservations",
    pgQuery: "SELECT count(*)::bigint AS value FROM reservations.reservations",
    tolerance: 0,
  },
  {
    id: "orders.id_hash",
    kind: "hash",
    severity: "critical",
    legacySource: "sqlite",
    legacyQuery: "SELECT group_concat(id) AS value FROM (SELECT id FROM orders ORDER BY id)",
    pgQuery: "SELECT string_agg(id, ',' ORDER BY id) AS value FROM sales.orders",
    tolerance: 0,
    note: "Conteggi uguali non implicano insiemi uguali. L'hash lo verifica.",
  },
  {
    id: "audit_events.count",
    kind: "count",
    severity: "warning",
    legacySource: "sqlite",
    legacyQuery: "SELECT count(*) AS value FROM audit_events",
    pgQuery: "SELECT count(*)::bigint AS value FROM audit.events",
    tolerance: 0,
    note: "Warning: l'audit storico puo essere importato parzialmente per scelta (doc 07).",
  },
];

/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = { config: null, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--config") args.config = argv[++i];
    else if (argv[i] === "--json") args.json = true;
  }
  return args;
}

async function loadConfig(path) {
  if (!path) {
    throw new Error("--config obbligatorio. Vedi config/reconcile.config.example.json");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * I driver sono iniettati, non importati staticamente: questo script deve poter
 * girare in tools/legacy-import/ senza trascinare mysql2 o node:sqlite nel
 * dependency graph del server (vedi 10_LEGACY_DECOMMISSION.md).
 */
async function createRunners(config) {
  const runners = {};

  if (config.postgres) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool(config.postgres);
    runners.postgres = async (sql) => {
      const res = await pool.query(sql);
      return res.rows[0]?.value ?? null;
    };
    runners._closePg = () => pool.end();
  }

  if (config.mariadb) {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection(config.mariadb);
    runners.mariadb = async (sql) => {
      const [rows] = await conn.query(sql);
      return rows[0]?.value ?? null;
    };
    runners._closeMy = () => conn.end();
  }

  if (config.sqlite) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(config.sqlite.path, { readOnly: true });
    runners.sqlite = async (sql) => db.prepare(sql).get()?.value ?? null;
    runners._closeSqlite = () => db.close();
  }

  return runners;
}

function normalise(kind, value) {
  if (value === null || value === undefined) return null;
  if (kind === "hash") {
    // hash stabile della lista ordinata di chiavi
    let h = 0n;
    const s = String(value);
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31n + BigInt(s.charCodeAt(i))) % 0xffffffffffffn;
    }
    return h.toString(16);
  }
  return BigInt(value).toString();
}

async function main() {
  const args = parseArgs(process.argv);
  let config;
  try {
    config = await loadConfig(args.config);
  } catch (err) {
    console.error(`[config] ${err.message}`);
    process.exit(2);
  }

  let runners;
  try {
    runners = await createRunners(config);
  } catch (err) {
    console.error(`[connect] ${err.message}`);
    process.exit(2);
  }

  const results = [];
  let criticalMismatches = 0;
  let incomplete = 0;

  for (const check of CHECKS) {
    const row = { id: check.id, kind: check.kind, severity: check.severity, note: check.note ?? null };

    if (!check.legacyQuery) {
      row.status = "INCOMPLETO";
      row.detail = "legacyQuery non definita: mappatura di dominio da chiudere in P12";
      incomplete += 1;
      if (check.severity === "critical") criticalMismatches += 1;
      results.push(row);
      continue;
    }

    try {
      const legacyRunner = runners[check.legacySource === "mariadb" ? "mariadb" : "sqlite"];
      if (!legacyRunner) throw new Error(`sorgente ${check.legacySource} non configurata`);

      const legacyRaw = await legacyRunner(check.legacyQuery);
      const pgRaw = await runners.postgres(check.pgQuery);

      row.legacy = normalise(check.kind, legacyRaw);
      row.postgres = normalise(check.kind, pgRaw);

      if (check.kind === "hash") {
        row.status = row.legacy === row.postgres ? "OK" : "MISMATCH";
      } else {
        const diff = BigInt(row.postgres ?? 0) - BigInt(row.legacy ?? 0);
        row.diff = diff.toString();
        row.status = (diff < 0n ? -diff : diff) <= BigInt(check.tolerance ?? 0) ? "OK" : "MISMATCH";
      }

      if (row.status === "MISMATCH" && check.severity === "critical") criticalMismatches += 1;
    } catch (err) {
      row.status = "ERRORE";
      row.detail = err.message;
      if (check.severity === "critical") criticalMismatches += 1;
    }

    results.push(row);
  }

  for (const close of ["_closePg", "_closeMy", "_closeSqlite"]) {
    if (runners[close]) await runners[close]();
  }

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results, criticalMismatches, incomplete }, null, 2));
  } else {
    const pad = (s, n) => String(s ?? "").padEnd(n);
    console.log(pad("CHECK", 34) + pad("STATO", 12) + pad("LEGACY", 20) + pad("POSTGRES", 20) + "DIFF");
    console.log("-".repeat(100));
    for (const r of results) {
      console.log(pad(r.id, 34) + pad(r.status, 12) + pad(r.legacy, 20) + pad(r.postgres, 20) + (r.diff ?? r.detail ?? ""));
    }
    console.log("-".repeat(100));
    console.log(`Mismatch critici: ${criticalMismatches}   Check incompleti: ${incomplete}`);
    if (incomplete > 0) {
      console.log("\nI check INCOMPLETO non sono neutri: contano come mismatch critici.");
      console.log("Un report con check incompleti NON e evidenza sufficiente per il GO di cutover.");
    }
  }

  process.exit(criticalMismatches === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
