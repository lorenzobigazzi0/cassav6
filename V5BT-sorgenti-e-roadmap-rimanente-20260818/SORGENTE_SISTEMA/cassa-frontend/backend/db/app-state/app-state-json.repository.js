import { promises as fs } from "node:fs";
import path from "node:path";

export async function ensureJsonStateFile({
  dbPath,
  legacyDbPath = "",
  buildInitialState,
  allowEmptyInit = true,
}) {
  try {
    await fs.access(dbPath);
    return;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }

    if (legacyDbPath) {
      try {
        await fs.copyFile(legacyDbPath, dbPath);
        return;
      } catch (legacyError) {
        if (!legacyError || typeof legacyError !== "object" || legacyError.code !== "ENOENT") {
          throw legacyError;
        }
      }
    }

    if (!allowEmptyInit) {
      throw new Error(`Database JSON mancante: inizializzazione vuota non consentita (${dbPath}).`);
    }

    const initial = buildInitialState();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, `${JSON.stringify(initial, null, 2)}\n`, "utf-8");
  }
}

export async function readJsonStateFile(dbPath) {
  const raw = await fs.readFile(dbPath, "utf-8");
  return JSON.parse(raw);
}

export async function writeJsonStateFile(dbPath, tmpPath, state) {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(tmpPath, serialized, "utf-8");
  await fs.rename(tmpPath, dbPath);
  return serialized;
}
