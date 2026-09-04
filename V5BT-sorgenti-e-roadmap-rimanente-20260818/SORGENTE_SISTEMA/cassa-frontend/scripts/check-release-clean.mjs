#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_IGNORES = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", ".cache"]);
const SECRET_NAME_PATTERN = /(PASSWORD|PASS|SECRET|TOKEN|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)/i;
const CREDENTIAL_LINE_PATTERN = /(MYSQL|DB|DATABASE|REDIS|MQTT|AUTOMATIC_CASH).*?(PASSWORD|PASS|SECRET|TOKEN)\s*=\s*['\"]?[^'\"\s%$]+/i;

function parseArgs(argv) {
  const result = { root: ".", warnOnly: false, jsonReport: "reports/release-hygiene.json", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--warn-only") result.warnOnly = true;
    else if (arg === "--json-report") result.jsonReport = argv[++index] ?? result.jsonReport;
    else if (arg.startsWith("--json-report=")) result.jsonReport = arg.slice("--json-report=".length);
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (!arg.startsWith("--")) result.root = arg;
  }
  result.root = path.resolve(result.root);
  if (result.jsonReport) result.jsonReport = path.resolve(result.root, result.jsonReport);
  return result;
}

function printHelp() {
  console.log(`Usage: node scripts/check-release-clean.mjs [--warn-only] [--json-report reports/release-hygiene.json] [root]\n\nVerifica che il pacchetto non contenga runtime data, log, spool, DB locali, backup o credenziali hardcoded.`);
}

function safeStat(filePath) {
  try { return statSync(filePath); } catch { return null; }
}

function addIssue(issues, severity, filePath, message) {
  issues.push({ severity, path: filePath, message });
}

function isRuntimeSqlite(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (!normalized.endsWith(".sqlite") && !normalized.endsWith(".sqlite3") && !normalized.endsWith(".db")) return false;
  if (/fixtures|test|tests|sample|schema/.test(normalized)) return false;
  return true;
}

function scanFileContent(root, relativePath, issues) {
  const normalized = relativePath.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  if (!/\.(cmd|ps1|sh|env|example|mjs|js|ts|json|md|yml|yaml)$/i.test(lower)) return;
  if (/\.env\.example$/.test(lower) || lower.endsWith("env.example")) return;
  const absolute = path.join(root, relativePath);
  const stat = safeStat(absolute);
  if (!stat || stat.size > 512 * 1024) return;
  let content = "";
  try { content = readFileSync(absolute, "utf8"); } catch { return; }
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (CREDENTIAL_LINE_PATTERN.test(line) && !/%[A-Z0-9_]+%|\$\{?[A-Z0-9_]+\}?|example|changeme|placeholder|unset/i.test(line)) {
      addIssue(issues, "error", `${relativePath}:${index + 1}`, "Possibile credenziale hardcoded in file/script.");
    }
  });
}

function walk(root, current, issues) {
  const entries = readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute) || entry.name;
    const normalized = relative.replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORES.has(entry.name)) continue;
      if (entry.name === ".print-spool") {
        const files = readdirSync(absolute).filter((name) => name !== ".gitkeep");
        if (files.length > 0) addIssue(issues, "error", normalized, "Directory .print-spool non vuota.");
      }
      if (entry.name.toLowerCase() === "logs") {
        const files = readdirSync(absolute).filter((name) => name !== ".gitkeep");
        if (files.length > 0) addIssue(issues, "error", normalized, "Directory logs non vuota.");
      }
      walk(root, absolute, issues);
      continue;
    }
    if (!entry.isFile()) continue;
    const lower = normalized.toLowerCase();
    const stat = safeStat(absolute);
    if (/app-state\.before-.*\.json$/i.test(entry.name)) addIssue(issues, "error", normalized, "Backup app-state.before-*.json incluso.");
    if (isRuntimeSqlite(normalized)) addIssue(issues, "error", normalized, "Database runtime locale non ammesso nel pacchetto release.");
    if (/(^|\/)\.env($|\.)/i.test(normalized) && !/\.example$/i.test(normalized)) addIssue(issues, "error", normalized, ".env reale incluso.");
    if (/debug.*\.apk$|app-debug.*\.apk$/i.test(entry.name)) addIssue(issues, "error", normalized, "APK debug incluso.");
    if (/\.(dump|bak|backup|tmp)$/i.test(entry.name)) addIssue(issues, "warning", normalized, "File temporaneo/backup da verificare.");
    if (stat && stat.size > 50 * 1024 * 1024 && !/\.zip$/i.test(entry.name)) addIssue(issues, "warning", normalized, `File grande (${Math.round(stat.size / 1024 / 1024)} MB) da verificare.`);
    if (SECRET_NAME_PATTERN.test(entry.name) && !/example|template/i.test(entry.name)) addIssue(issues, "warning", normalized, "Nome file potenzialmente sensibile.");
    scanFileContent(root, normalized, issues);
  }
}

function scanReleaseClean(rootArg = ".", options = {}) {
  const root = path.resolve(rootArg);
  if (!existsSync(root)) {
    return {
      ok: false,
      warnOnly: options.warnOnly === true,
      root,
      generatedAt: new Date().toISOString(),
      counts: { errors: 1, warnings: 0, total: 1 },
      issues: [{ severity: "error", path: root, message: "Root non trovato." }],
    };
  }
  const issues = [];
  walk(root, root, issues);
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity !== "error");
  return {
    ok: errors.length === 0,
    warnOnly: options.warnOnly === true,
    root,
    generatedAt: new Date().toISOString(),
    counts: { errors: errors.length, warnings: warnings.length, total: issues.length },
    issues,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return 0; }
  const report = scanReleaseClean(args.root, { warnOnly: args.warnOnly });
  console.log(`Release hygiene: ${report.ok ? "OK" : "ISSUES"} (${report.counts.errors} errori, ${report.counts.warnings} warning)`);
  for (const issue of report.issues.slice(0, 100)) {
    const prefix = issue.severity === "error" ? "ERROR" : "WARN";
    console.log(`${prefix} ${issue.path} — ${issue.message}`);
  }
  if (report.issues.length > 100) console.log(`... altri ${report.issues.length - 100} problemi omessi dalla console; vedere JSON report.`);
  if (args.jsonReport) {
    mkdirSync(path.dirname(args.jsonReport), { recursive: true });
    writeFileSync(args.jsonReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Report JSON: ${args.jsonReport}`);
  }
  if (args.warnOnly) return 0;
  return report.ok ? 0 : 1;
}

export { parseArgs, scanReleaseClean };

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
