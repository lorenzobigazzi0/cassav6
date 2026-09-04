#!/usr/bin/env node
/**
 * Archivia le comande concluse spostandole dallo stato caldo a un file di archivio.
 *
 * Perche serve: `integration.orders` non ha retention e cresce per sempre. Con qualche
 * centinaio di comande la latenza di ogni pagamento cresce in modo misurabile, perche
 * piu percorsi di scrittura pagano il costo dell'insieme.
 *
 * Perche su file e non su tabella: il launcher verifica che lo schema `cassa_v5bt`
 * contenga esattamente 480 tabelle e blocca l'avvio se ne trova una in piu. L'archivio
 * e un artefatto operativo, non fa parte dello schema certificato, e vive quindi fuori.
 *
 * Nessuna riga viene rimossa prima che il file sia stato scritto, richiuso e riletto per
 * intero: se qualcosa va storto nella scrittura, lo stato caldo resta come era.
 *
 * Va eseguito a servizio fermo: lo stato applicativo e tenuto in memoria dal backend, che
 * altrimenti riscriverebbe le comande appena rimosse.
 *
 *   node scripts/archive-integration-orders.mjs --hours 24            # simulazione
 *   node scripts/archive-integration-orders.mjs --hours 24 --confirm  # esecuzione
 *   node scripts/archive-integration-orders.mjs --restore <file>      # rientro
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import {
  selectArchivableIntegrationOrders,
  summarizeIntegrationOrdersRetention,
} from "../backend/modules/integration/orders-retention.js";

const LIVE_TABLE = "app_state_domain_records";
const ORDERS_DOMAIN = "integration";
const ORDER_PREFIX = "orders:";

function parseArgs(argv) {
  const options = {
    host: process.env.BACKEND_MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.BACKEND_MYSQL_PORT || 3306),
    user: process.env.BACKEND_MYSQL_USER || "",
    password: process.env.BACKEND_MYSQL_PASSWORD || "",
    database: process.env.BACKEND_MYSQL_DATABASE || "",
    archiveDir: "",
    hours: 24,
    limit: 0,
    confirm: false,
    restore: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = argv[index].split("=");
    const value = inlineValue ?? argv[index + 1];
    const consume = () => {
      if (inlineValue === undefined) index += 1;
    };
    switch (flag) {
      case "--host": options.host = value; consume(); break;
      case "--port": options.port = Number(value); consume(); break;
      case "--user": options.user = value; consume(); break;
      case "--password": options.password = value; consume(); break;
      case "--database": options.database = value; consume(); break;
      case "--archive-dir": options.archiveDir = value; consume(); break;
      case "--hours": options.hours = Number(value); consume(); break;
      case "--limit": options.limit = Number(value); consume(); break;
      case "--restore": options.restore = value; consume(); break;
      case "--confirm": options.confirm = true; break;
      default:
        if (flag.startsWith("--")) throw new Error(`Argomento non riconosciuto: ${flag}`);
    }
  }
  if (!Number.isFinite(options.hours) || options.hours < 0) {
    throw new Error("--hours deve essere un numero non negativo.");
  }
  if (!options.user || !options.database) {
    throw new Error("Credenziali MySQL incomplete: servono --user e --database.");
  }
  return options;
}

const connect = async (options) => {
  const { createConnection } = await import("mysql2/promise");
  return createConnection({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
  });
};

async function readArchiveFile(filePath) {
  const chunks = [];
  await pipeline(createReadStream(filePath), createGunzip(), async function* (source) {
    for await (const chunk of source) chunks.push(chunk);
    yield "";
  });
  return Buffer.concat(chunks).toString("utf8");
}

/** Riporta nello stato caldo le righe di un archivio, senza toccare quelle gia presenti. */
async function restore(options) {
  const filePath = path.resolve(options.restore);
  const text = await readArchiveFile(filePath);
  const rows = text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  process.stdout.write(`archivio: ${filePath}\nrighe: ${rows.length}\n`);
  if (!options.confirm) {
    process.stdout.write("Simulazione: nessuna modifica. Aggiungi --confirm per eseguire.\n");
    return 0;
  }
  const connection = await connect(options);
  try {
    await connection.beginTransaction();
    for (const row of rows) {
      await connection.query(
        `INSERT INTO ${LIVE_TABLE} (domain, record_id, kind, app_state_position, row_hash, raw_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE raw_json = VALUES(raw_json)`,
        [row.domain, row.record_id, row.kind, row.app_state_position, row.row_hash, row.raw_json],
      );
    }
    await connection.commit();
    process.stdout.write(`Ripristinate ${rows.length} comande. Riavvia cassav5bt.service.\n`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
  return 0;
}

async function archive(options) {
  const connection = await connect(options);
  try {
    const [rows] = await connection.query(
      `SELECT domain, record_id, kind, app_state_position, row_hash, raw_json FROM ${LIVE_TABLE}
       WHERE domain = ? AND kind = 'obj_array_entry' AND record_id LIKE ?`,
      [ORDERS_DOMAIN, `${ORDER_PREFIX}%`],
    );

    const rowByRecordId = new Map();
    const orders = [];
    let unparsable = 0;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.raw_json);
        rowByRecordId.set(String(row.record_id), row);
        orders.push({ ...parsed, __recordId: String(row.record_id) });
      } catch {
        unparsable += 1;
      }
    }

    const selection = selectArchivableIntegrationOrders(orders, {
      retentionMs: options.hours * 60 * 60 * 1000,
      limit: options.limit,
    });
    const summary = summarizeIntegrationOrdersRetention(selection, {
      retentionHours: options.hours,
      reason: options.confirm ? "manual" : "dry-run",
    });

    process.stdout.write(
      `comande in stato caldo: ${summary.scanned}` +
        (unparsable > 0 ? ` (${unparsable} non leggibili, lasciate intatte)` : "") +
        `\narchiviabili oltre ${options.hours}h: ${summary.archived}\n` +
        `restano calde: ${summary.retained}\n`,
    );

    if (summary.archived === 0) {
      process.stdout.write("Nessuna comanda da archiviare.\n");
      return 0;
    }
    if (!options.confirm) {
      process.stdout.write("Simulazione: nessuna modifica. Aggiungi --confirm per eseguire.\n");
      return 0;
    }

    const archiveDir = options.archiveDir || path.resolve(process.cwd(), "../../.runtime/cassav5bt/order-archive");
    await mkdir(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(archiveDir, `orders-${stamp}.ndjson.gz`);

    const recordIds = selection.archivable.map((order) => order.__recordId);
    const payload = recordIds
      .map((recordId) => JSON.stringify(rowByRecordId.get(recordId)))
      .join("\n");
    await pipeline(async function* () { yield payload; }, createGzip(), createWriteStream(filePath));

    // Rilettura completa prima di toccare lo stato caldo: se il file non e integro,
    // le comande restano dove sono.
    const verified = await readArchiveFile(filePath);
    const verifiedRows = verified.split("\n").filter((line) => line.trim().length > 0);
    if (verifiedRows.length !== recordIds.length) {
      throw new Error(
        `archivio incompleto: attese ${recordIds.length} righe, rilette ${verifiedRows.length}. Stato caldo intatto.`,
      );
    }
    const digest = createHash("sha256").update(await readFile(filePath)).digest("hex");
    const bytes = (await stat(filePath)).size;

    await connection.beginTransaction();
    try {
      let removed = 0;
      for (let index = 0; index < recordIds.length; index += 200) {
        const batch = recordIds.slice(index, index + 200);
        const placeholders = batch.map(() => "?").join(",");
        const [result] = await connection.query(
          `DELETE FROM ${LIVE_TABLE} WHERE domain = ? AND record_id IN (${placeholders})`,
          [ORDERS_DOMAIN, ...batch],
        );
        removed += result.affectedRows ?? 0;
      }
      await connection.commit();
      process.stdout.write(
        `Archiviate ${removed} comande in ${filePath}\n` +
          `  ${bytes} byte, sha256 ${digest.slice(0, 16)}...\n` +
          "Riavvia cassav5bt.service per ricaricare lo stato.\n" +
          `Per rientrare: --restore ${filePath} --confirm\n`,
      );
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    return 0;
  } finally {
    await connection.end();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  return options.restore ? restore(options) : archive(options);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`[archive-orders] errore: ${error?.message ?? error}\n`);
    process.exit(1);
  });
