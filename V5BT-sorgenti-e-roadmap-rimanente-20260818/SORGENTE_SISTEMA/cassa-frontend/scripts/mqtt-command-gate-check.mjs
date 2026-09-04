#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeMqttCommandGateConfig } from "../backend/modules/realtime-backbone/mqtt-bridge.js";

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export function parseMqttCommandGateCheckArgs(argv = [], env = process.env) {
  const parsed = {
    outDir: normalizeText(env.MQTT_COMMAND_GATE_CHECK_OUT_DIR, "reports"),
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--out-dir") parsed.outDir = readNext();
    else if (arg.startsWith("--out-dir=")) parsed.outDir = arg.slice("--out-dir=".length);
  }
  parsed.outDir = path.resolve(parsed.outDir || "reports");
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/mqtt-command-gate-check.mjs [opzioni]

Valida il gate Step 15 per impedire comandi MQTT senza command-inbox/ACK:
  --out-dir DIR   directory report, default reports
  --json          stampa JSON
`);
}

function scenario(name, env, expected) {
  const gate = normalizeMqttCommandGateConfig(env);
  const ok = Object.entries(expected).every(([key, value]) => {
    if (key === "reasons") return JSON.stringify(gate.reasons) === JSON.stringify(value);
    return gate[key] === value;
  });
  return {
    name,
    ok,
    expected,
    gate,
    detail: `requested=${gate.requested ? 1 : 0}, enabled=${gate.enabled ? 1 : 0}, mode=${gate.commandInboxMode}, reasons=${gate.reasons.join(",") || "-"}`,
  };
}

export function buildMqttCommandGateSummary(env = process.env) {
  const currentGate = normalizeMqttCommandGateConfig(env);
  const checks = [
    scenario("default off", {}, {
      requested: false,
      enabled: false,
      reasons: ["mqtt_commands_disabled"],
    }),
    scenario("commands requested without command inbox", {
      MQTT_COMMANDS_ENABLED: "1",
    }, {
      requested: true,
      enabled: false,
      reasons: ["command_inbox_disabled"],
    }),
    scenario("command inbox shadow does not allow mqtt commands", {
      MQTT_COMMANDS_ENABLED: "1",
      COMMAND_INBOX_ENABLED: "1",
      COMMAND_INBOX_MODE: "shadow",
    }, {
      requested: true,
      enabled: false,
      reasons: ["command_inbox_not_enforcing:shadow"],
    }),
    scenario("command inbox enforce still requires ack gate", {
      MQTT_COMMANDS_ENABLED: "1",
      COMMAND_INBOX_ENABLED: "1",
      COMMAND_INBOX_MODE: "enforce_pilot",
    }, {
      requested: true,
      enabled: false,
      reasons: ["mqtt_command_ack_disabled"],
    }),
    scenario("full command gate allows mqtt commands", {
      MQTT_COMMANDS_ENABLED: "1",
      COMMAND_INBOX_ENABLED: "1",
      COMMAND_INBOX_MODE: "enforce_pilot",
      MQTT_COMMAND_ACK_ENABLED: "1",
    }, {
      requested: true,
      enabled: true,
      reasons: [],
    }),
  ];
  const currentCheck = {
    name: "current environment commands disabled or safely gated",
    ok: currentGate.requested !== true || currentGate.enabled === true,
    gate: currentGate,
    detail: currentGate.requested
      ? `MQTT_COMMANDS_ENABLED=1, enabled=${currentGate.enabled ? 1 : 0}, reasons=${currentGate.reasons.join(",") || "-"}`
      : "MQTT_COMMANDS_ENABLED=0",
  };
  return {
    ok: checks.every((check) => check.ok) && currentCheck.ok,
    generatedAt: new Date().toISOString(),
    checks,
    currentCheck,
    currentGate,
  };
}

export function formatMqttCommandGateMarkdown(summary) {
  const lines = ["# MQTT command gate check", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
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
  lines.push(`- [${summary.currentCheck.ok ? "OK" : "FAIL"}] ${summary.currentCheck.name}: ${summary.currentCheck.detail}`);
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- MQTT commands are still disabled by default.");
  lines.push("- `MQTT_COMMANDS_ENABLED=1` is treated as a request, not as sufficient authorization.");
  lines.push("- Effective enablement requires command-inbox in write/enforce/enforce_pilot mode and `MQTT_COMMAND_ACK_ENABLED=1`.");
  lines.push("- MQTT remains transport only: command durability and replay must pass through `command_inbox`.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeMqttCommandGateReport(summary, outDir) {
  const targetDir = path.resolve(String(outDir || "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const jsonPath = path.join(targetDir, "mqtt-command-gate-check.json");
  const mdPath = path.join(targetDir, "mqtt-command-gate-check.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatMqttCommandGateMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseMqttCommandGateCheckArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = buildMqttCommandGateSummary(process.env);
  const output = writeMqttCommandGateReport(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMqttCommandGateMarkdown(summary));
    process.stdout.write(`[mqtt-command-gate-check] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[mqtt-command-gate-check] Markdown: ${output.mdPath}\n`);
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
