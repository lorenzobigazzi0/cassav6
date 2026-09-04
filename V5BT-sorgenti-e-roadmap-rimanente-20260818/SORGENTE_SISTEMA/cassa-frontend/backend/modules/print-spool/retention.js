import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const PRINT_SPOOL_RETENTION_TERMINAL_STATUSES = new Set([
  "printed",
  "failed",
  "failed_configuration",
  "failed_permanent",
  "disabled",
  "cancelled",
]);

function safeFileName(value = "") {
  const name = path.basename(String(value ?? "").trim());
  return name && name.endsWith(".txt") ? name : "";
}

function parseTimestampMs(value, fallback = 0) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRetentionMs(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeJob(job) {
  if (!job || typeof job !== "object") return null;
  const fileName = safeFileName(job.fileName);
  if (!fileName) return null;
  const status = String(job.status ?? "").trim().toLowerCase();
  const completedAtMs = Math.max(
    parseTimestampMs(job.processedAt),
    parseTimestampMs(job.lastAttemptAt),
    parseTimestampMs(job.updatedAt),
    parseTimestampMs(job.requestedAt),
  );
  return {
    id: String(job.id ?? "").trim(),
    fileName,
    status,
    terminal: PRINT_SPOOL_RETENTION_TERMINAL_STATUSES.has(status),
    completedAtMs,
  };
}

export async function collectPrintSpoolFiles(spoolDir) {
  let entries = [];
  try {
    entries = await readdir(spoolDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fileName = safeFileName(entry.name);
    if (!fileName) continue;
    const filePath = path.join(spoolDir, fileName);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile?.()) continue;
    files.push({
      fileName,
      path: filePath,
      mtimeMs: Math.trunc(Number(fileStat.mtimeMs) || 0),
      size: Math.max(Math.trunc(Number(fileStat.size) || 0), 0),
    });
  }
  return files;
}

export function buildPrintSpoolRetentionPlan({
  jobs = [],
  files = [],
  nowMs = Date.now(),
  terminalRetentionMs = 24 * 60 * 60 * 1000,
  orphanRetentionMs = 24 * 60 * 60 * 1000,
} = {}) {
  const safeNowMs = Math.max(Math.trunc(Number(nowMs) || Date.now()), 0);
  const terminalMs = normalizeRetentionMs(
    terminalRetentionMs,
    24 * 60 * 60 * 1000,
  );
  const orphanMs = normalizeRetentionMs(orphanRetentionMs, 24 * 60 * 60 * 1000);
  const normalizedJobs = (Array.isArray(jobs) ? jobs : [])
    .map(normalizeJob)
    .filter(Boolean);
  const activeFileNames = new Set(
    normalizedJobs
      .filter((job) => !job.terminal)
      .map((job) => job.fileName),
  );
  const jobsByFileName = new Map();
  for (const job of normalizedJobs) {
    const current = jobsByFileName.get(job.fileName) ?? [];
    current.push(job);
    jobsByFileName.set(job.fileName, current);
  }

  const safeFiles = (Array.isArray(files) ? files : [])
    .map((file) => ({
      ...file,
      fileName: safeFileName(file?.fileName ?? file?.name),
      mtimeMs: Math.trunc(Number(file?.mtimeMs) || 0),
      size: Math.max(Math.trunc(Number(file?.size) || 0), 0),
    }))
    .filter((file) => file.fileName);

  const terminalFiles = [];
  const orphanFiles = [];
  const deleteFiles = [];

  for (const file of safeFiles) {
    if (activeFileNames.has(file.fileName)) continue;
    const fileJobs = jobsByFileName.get(file.fileName) ?? [];
    if (fileJobs.length === 0) {
      const ageMs = safeNowMs - file.mtimeMs;
      const orphan = {
        ...file,
        reason: "orphan",
        ageMs,
      };
      orphanFiles.push(orphan);
      if (ageMs >= orphanMs) deleteFiles.push(orphan);
      continue;
    }

    const terminalJobs = fileJobs.filter((job) => job.terminal);
    if (terminalJobs.length === fileJobs.length) {
      const completedAtMs = Math.max(
        ...terminalJobs.map((job) => job.completedAtMs || file.mtimeMs),
      );
      const ageMs = safeNowMs - completedAtMs;
      const terminal = {
        ...file,
        reason: "terminal",
        ageMs,
        jobIds: terminalJobs.map((job) => job.id).filter(Boolean),
        status: terminalJobs[terminalJobs.length - 1]?.status ?? "",
      };
      terminalFiles.push(terminal);
      if (ageMs >= terminalMs) deleteFiles.push(terminal);
    }
  }

  return {
    files: safeFiles.length,
    referencedFiles: jobsByFileName.size,
    terminalFiles: terminalFiles.length,
    orphanFiles: orphanFiles.length,
    deleteFiles,
    deleteCount: deleteFiles.length,
    keepCount: safeFiles.length - deleteFiles.length,
  };
}

export async function cleanupPrintSpoolRetention({
  spoolDir,
  jobs = [],
  nowMs = Date.now(),
  terminalRetentionMs,
  orphanRetentionMs,
} = {}) {
  const files = await collectPrintSpoolFiles(spoolDir);
  const plan = buildPrintSpoolRetentionPlan({
    jobs,
    files,
    nowMs,
    terminalRetentionMs,
    orphanRetentionMs,
  });
  const deletedFiles = [];
  const errors = [];

  for (const file of plan.deleteFiles) {
    const filePath = path.join(spoolDir, file.fileName);
    try {
      await unlink(filePath);
      deletedFiles.push(file.fileName);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        errors.push({
          fileName: file.fileName,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    ...plan,
    deletedFiles,
    deletedCount: deletedFiles.length,
    errorCount: errors.length,
    errors,
  };
}
