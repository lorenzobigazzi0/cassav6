import path from "node:path";

export function resolvePrintSpoolDir(value, backendDir) {
  const safeBackendDir = String(backendDir ?? "").trim();
  if (
    !path.isAbsolute(safeBackendDir) ||
    path.resolve(safeBackendDir) !== safeBackendDir
  ) {
    throw new Error("Directory backend non valida per lo spool stampa.");
  }

  const defaultDir = path.join(safeBackendDir, ".print-spool");
  const raw = String(value ?? "").trim();
  if (!raw) return defaultDir;
  if (raw.includes("\0") || !path.isAbsolute(raw) || path.resolve(raw) !== raw) {
    throw new Error(
      "BACKEND_PRINT_SPOOL_DIR deve essere un path assoluto normalizzato.",
    );
  }

  const relativeBackend = path.relative(raw, safeBackendDir);
  const containsBackend =
    relativeBackend === "" ||
    (relativeBackend !== ".." &&
      !relativeBackend.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeBackend));
  if (raw === path.parse(raw).root || containsBackend) {
    throw new Error(
      "BACKEND_PRINT_SPOOL_DIR non puo essere root, backend o un suo antenato.",
    );
  }
  return raw;
}
