#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseMosquittoConfig } from "./mqtt-acl-policy-check.mjs";

const DEFAULT_CONF_PATH = path.resolve("configs", "mosquitto-tls.conf.example");

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export function parseMqttTlsPolicyCheckArgs(argv = [], env = process.env) {
  const parsed = {
    confPath: normalizeText(env.MQTT_TLS_CHECK_CONF, DEFAULT_CONF_PATH),
    outDir: normalizeText(env.MQTT_TLS_CHECK_OUT_DIR, "reports"),
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--conf") parsed.confPath = readNext();
    else if (arg.startsWith("--conf=")) parsed.confPath = arg.slice("--conf=".length);
    else if (arg === "--out-dir") parsed.outDir = readNext();
    else if (arg.startsWith("--out-dir=")) parsed.outDir = arg.slice("--out-dir=".length);
  }
  parsed.confPath = path.resolve(parsed.confPath);
  parsed.outDir = path.resolve(parsed.outDir || "reports");
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/mqtt-tls-policy-check.mjs [opzioni]

Valida la policy Mosquitto TLS Step 14I:
  --conf PATH     mosquitto TLS conf, default ${DEFAULT_CONF_PATH}
  --out-dir DIR   directory report, default reports
  --json          stampa JSON
`);
}

function valuesFor(config, key) {
  return config.values.get(key) ?? [];
}

function hasConfigValue(config, key, expected) {
  return valuesFor(config, key).some((value) => value === expected);
}

function hasAny(config, key) {
  return valuesFor(config, key).some((value) => normalizeText(value, "") !== "");
}

function firstValue(config, key, fallback = "-") {
  return valuesFor(config, key).find((value) => normalizeText(value, "") !== "") ?? fallback;
}

function listenerPorts(config) {
  return valuesFor(config, "listener")
    .map((value) => String(value).trim().split(/\s+/)[0])
    .filter(Boolean);
}

function pathLooksExternal(value) {
  const normalized = normalizeText(value, "");
  if (!normalized) return false;
  if (path.isAbsolute(normalized)) return true;
  return normalized.startsWith("/etc/") || normalized.startsWith("/var/");
}

export function buildMqttTlsPolicySummary({ confText = "", confPath = DEFAULT_CONF_PATH } = {}) {
  const config = parseMosquittoConfig(confText);
  const ports = listenerPorts(config);
  const checks = [
    {
      name: "tls listener configured",
      ok: ports.includes("8883"),
      detail: ports.join(", ") || "-",
    },
    {
      name: "anonymous disabled",
      ok: hasConfigValue(config, "allow_anonymous", "false"),
      detail: "allow_anonymous false",
    },
    {
      name: "password file configured",
      ok: hasAny(config, "password_file"),
      detail: firstValue(config, "password_file"),
    },
    {
      name: "acl file configured",
      ok: hasAny(config, "acl_file"),
      detail: firstValue(config, "acl_file"),
    },
    {
      name: "ca file configured",
      ok: hasAny(config, "cafile"),
      detail: firstValue(config, "cafile"),
    },
    {
      name: "server certificate configured",
      ok: hasAny(config, "certfile"),
      detail: firstValue(config, "certfile"),
    },
    {
      name: "server private key configured",
      ok: hasAny(config, "keyfile"),
      detail: firstValue(config, "keyfile"),
    },
    {
      name: "tls version pinned",
      ok: ["tlsv1.2", "tlsv1.3"].includes(firstValue(config, "tls_version", "").toLowerCase()),
      detail: firstValue(config, "tls_version"),
    },
    {
      name: "certificate paths external",
      ok: ["cafile", "certfile", "keyfile"].every((key) => pathLooksExternal(firstValue(config, key, ""))),
      detail: ["cafile", "certfile", "keyfile"].map((key) => `${key}=${firstValue(config, key)}`).join(", "),
    },
  ];
  return {
    ok: checks.every((check) => check.ok),
    generatedAt: new Date().toISOString(),
    files: { confPath },
    listeners: ports,
    checks,
  };
}

export function formatMqttTlsPolicyMarkdown(summary) {
  const lines = ["# MQTT TLS policy check", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Conf: ${summary.files.confPath}`);
  lines.push(`Listeners: ${summary.listeners.join(", ") || "-"}`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push(summary.ok ? "RESULT: OK" : "RESULT: FAIL");
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  for (const check of summary.checks) {
    lines.push(`- [${check.ok ? "OK" : "FAIL"}] ${check.name}: ${check.detail}`);
  }
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- TLS listener runs on 8883.");
  lines.push("- Anonymous access remains disabled.");
  lines.push("- Cert/key paths point outside the repository.");
  lines.push("- Runtime secrets stay in environment/service configuration.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeMqttTlsPolicyReport(summary, outDir) {
  const targetDir = path.resolve(String(outDir || "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const jsonPath = path.join(targetDir, "mqtt-tls-policy-check.json");
  const mdPath = path.join(targetDir, "mqtt-tls-policy-check.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatMqttTlsPolicyMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

export function runMqttTlsPolicyCheck(options = {}) {
  const confPath = path.resolve(options.confPath || DEFAULT_CONF_PATH);
  return buildMqttTlsPolicySummary({
    confPath,
    confText: readFileSync(confPath, "utf8"),
  });
}

async function main() {
  const options = parseMqttTlsPolicyCheckArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = runMqttTlsPolicyCheck(options);
  const output = writeMqttTlsPolicyReport(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMqttTlsPolicyMarkdown(summary));
    process.stdout.write(`[mqtt-tls-policy-check] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[mqtt-tls-policy-check] Markdown: ${output.mdPath}\n`);
  }
  return summary.ok ? 0 : 2;
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exit(1);
    },
  );
}
