#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function parseArgs(argv) {
  const parsed = {
    url: process.env.RUNTIME_METRICS_URL || "http://127.0.0.1:3000/api/monitor/runtime-metrics",
    token: process.env.RUNTIME_METRICS_TOKEN || "",
    userId: process.env.RUNTIME_METRICS_USER_ID || "",
    deviceUuid: process.env.RUNTIME_METRICS_DEVICE_UUID || "",
    output: path.join(projectRoot, "reports", "runtime-metrics-snapshot.json"),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--url") { parsed.url = String(argv[index + 1] ?? parsed.url); index += 1; }
    else if (arg.startsWith("--url=")) parsed.url = arg.slice("--url=".length);
    else if (arg === "--token") { parsed.token = String(argv[index + 1] ?? parsed.token); index += 1; }
    else if (arg.startsWith("--token=")) parsed.token = arg.slice("--token=".length);
    else if (arg === "--user-id") { parsed.userId = String(argv[index + 1] ?? parsed.userId); index += 1; }
    else if (arg.startsWith("--user-id=")) parsed.userId = arg.slice("--user-id=".length);
    else if (arg === "--device-uuid") { parsed.deviceUuid = String(argv[index + 1] ?? parsed.deviceUuid); index += 1; }
    else if (arg.startsWith("--device-uuid=")) parsed.deviceUuid = arg.slice("--device-uuid=".length);
    else if (arg === "--output") { parsed.output = path.resolve(String(argv[index + 1] ?? parsed.output)); index += 1; }
    else if (arg.startsWith("--output=")) parsed.output = path.resolve(arg.slice("--output=".length));
  }
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/collect-runtime-metrics.mjs --url http://HOST:PORT/api/monitor/runtime-metrics --token TOKEN --output reports/runtime-metrics-snapshot.json
  node scripts/collect-runtime-metrics.mjs --url http://HOST:PORT/api/monitor/runtime-metrics --token TOKEN --user-id USER --device-uuid DEVICE --output reports/runtime-metrics-snapshot.json

Nota:
  l'endpoint e' admin/authenticated nel backend corrente. Usa token di servizio/admin solo in ambiente controllato.
`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) { printHelp(); process.exit(0); }
const headers = { accept: "application/json" };
if (options.token) headers.authorization = `Bearer ${options.token}`;
if (options.userId) headers["x-user-id"] = options.userId;
if (options.deviceUuid) headers["x-device-uuid"] = options.deviceUuid;
const response = await fetch(options.url, { headers });
const text = await response.text();
if (!response.ok) {
  console.error(`[collect-runtime-metrics] HTTP ${response.status}: ${text.slice(0, 500)}`);
  process.exit(1);
}
let body;
try { body = JSON.parse(text); }
catch (error) {
  console.error(`[collect-runtime-metrics] risposta non JSON: ${error.message}`);
  process.exit(1);
}
await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, `${JSON.stringify(body, null, 2)}\n`, "utf8");
console.log(`[collect-runtime-metrics] snapshot salvato in ${options.output}`);
