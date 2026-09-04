#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONF_PATH = path.resolve("configs", "mosquitto.conf.example");
const DEFAULT_ACL_PATH = path.resolve("configs", "mosquitto.acl.example");

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeAccess(value) {
  const access = normalizeText(value, "readwrite").toLowerCase();
  if (["read", "write", "readwrite", "deny"].includes(access)) return access;
  return "readwrite";
}

function stripMosquittoComment(rawLine) {
  const line = String(rawLine ?? "");
  if (line.trimStart().startsWith("#")) return "";
  return line.replace(/\s+#.*$/, "");
}

export function parseMqttAclCheckArgs(argv = [], env = process.env) {
  const parsed = {
    confPath: normalizeText(env.MQTT_ACL_CHECK_CONF, DEFAULT_CONF_PATH),
    aclPath: normalizeText(env.MQTT_ACL_CHECK_ACL, DEFAULT_ACL_PATH),
    outDir: normalizeText(env.MQTT_ACL_CHECK_OUT_DIR, "reports"),
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
    else if (arg === "--acl") parsed.aclPath = readNext();
    else if (arg.startsWith("--acl=")) parsed.aclPath = arg.slice("--acl=".length);
    else if (arg === "--out-dir") parsed.outDir = readNext();
    else if (arg.startsWith("--out-dir=")) parsed.outDir = arg.slice("--out-dir=".length);
  }
  parsed.confPath = path.resolve(parsed.confPath);
  parsed.aclPath = path.resolve(parsed.aclPath);
  parsed.outDir = path.resolve(parsed.outDir || "reports");
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/mqtt-acl-policy-check.mjs [opzioni]

Valida la policy Mosquitto Step 14E:
  --conf PATH     mosquitto.conf, default ${DEFAULT_CONF_PATH}
  --acl PATH      mosquitto acl, default ${DEFAULT_ACL_PATH}
  --out-dir DIR   directory report, default reports
  --json          stampa JSON
`);
}

export function parseMosquittoConfig(text = "") {
  const entries = [];
  const values = new Map();
  String(text)
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const line = stripMosquittoComment(rawLine).trim();
      if (!line) return;
      const [key, ...rest] = line.split(/\s+/);
      const value = rest.join(" ").trim();
      entries.push({ lineNumber: index + 1, key, value, raw: rawLine });
      if (!values.has(key)) values.set(key, []);
      values.get(key).push(value);
    });
  return { entries, values };
}

export function parseMosquittoAcl(text = "") {
  const users = new Map();
  let currentUser = null;
  const ensureUser = (name) => {
    const user = normalizeText(name, "global");
    if (!users.has(user)) users.set(user, []);
    return user;
  };
  String(text)
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const line = stripMosquittoComment(rawLine).trim();
      if (!line) return;
      const [kind, ...rest] = line.split(/\s+/);
      if (kind === "user") {
        currentUser = ensureUser(rest[0]);
        return;
      }
      if (kind !== "topic") return;
      const first = normalizeText(rest[0], "");
      const access = ["read", "write", "readwrite", "deny"].includes(first)
        ? normalizeAccess(first)
        : "readwrite";
      const pattern = access === "readwrite" && first && !["read", "write", "readwrite", "deny"].includes(first)
        ? rest.join(" ")
        : rest.slice(1).join(" ");
      const user = ensureUser(currentUser);
      users.get(user).push({
        lineNumber: index + 1,
        access,
        pattern: normalizeText(pattern, ""),
        raw: rawLine,
      });
    });
  return { users };
}

function expandUserPattern(pattern, username) {
  return String(pattern ?? "").replaceAll("%u", username);
}

function mqttTopicMatches(pattern, topic) {
  const patternParts = String(pattern ?? "").split("/");
  const topicParts = String(topic ?? "").split("/");
  for (let index = 0; index < patternParts.length; index += 1) {
    const part = patternParts[index];
    if (part === "#") return index === patternParts.length - 1;
    if (topicParts[index] === undefined) return false;
    if (part !== "+" && part !== topicParts[index]) return false;
  }
  return patternParts.length === topicParts.length;
}

function accessAllows(ruleAccess, operation) {
  if (ruleAccess === "deny") return false;
  if (ruleAccess === "readwrite") return true;
  return ruleAccess === operation;
}

export function evaluateAclAccess(acl, username, operation, topic) {
  const rules = [
    ...(acl.users.get("global") ?? []),
    ...(acl.users.get(username) ?? []),
  ];
  const matchingRules = rules.filter((rule) =>
    mqttTopicMatches(expandUserPattern(rule.pattern, username), topic),
  );
  if (matchingRules.some((rule) => rule.access === "deny")) {
    return { allowed: false, reason: "deny", matchingRules };
  }
  const allowed = matchingRules.some((rule) => accessAllows(rule.access, operation));
  return {
    allowed,
    reason: allowed ? "allow" : "default_deny",
    matchingRules,
  };
}

function hasConfigValue(config, key, expected) {
  return (config.values.get(key) ?? []).some((value) => value === expected);
}

function checkAccess(acl, { name, username, operation, topic, expected }) {
  const result = evaluateAclAccess(acl, username, operation, topic);
  return {
    name,
    ok: result.allowed === expected,
    detail: `${username} ${operation} ${topic} => ${result.allowed ? "allow" : "deny"} (${result.reason})`,
    matchingRules: result.matchingRules.map((rule) => ({
      lineNumber: rule.lineNumber,
      access: rule.access,
      pattern: rule.pattern,
    })),
  };
}

export function buildMqttAclPolicySummary({ confText, aclText, confPath = DEFAULT_CONF_PATH, aclPath = DEFAULT_ACL_PATH } = {}) {
  const config = parseMosquittoConfig(confText);
  const acl = parseMosquittoAcl(aclText);
  const users = [...acl.users.keys()].filter((user) => user !== "global");
  const checks = [
    {
      name: "allow_anonymous false",
      ok: hasConfigValue(config, "allow_anonymous", "false"),
      detail: "anonymous MQTT clients must be disabled",
    },
    {
      name: "password_file configured",
      ok: (config.values.get("password_file") ?? []).length > 0,
      detail: (config.values.get("password_file") ?? ["-"])[0],
    },
    {
      name: "acl_file configured",
      ok: (config.values.get("acl_file") ?? []).length > 0,
      detail: (config.values.get("acl_file") ?? ["-"])[0],
    },
    {
      name: "backend user exists",
      ok: acl.users.has("backend"),
      detail: users.join(", "),
    },
    checkAccess(acl, {
      name: "backend writes events",
      username: "backend",
      operation: "write",
      topic: "pos/store-1/events/orders/order-1",
      expected: true,
    }),
    checkAccess(acl, {
      name: "device reads events",
      username: "palmare-template",
      operation: "read",
      topic: "pos/store-1/events/orders/order-1",
      expected: true,
    }),
    checkAccess(acl, {
      name: "device cannot write events",
      username: "palmare-template",
      operation: "write",
      topic: "pos/store-1/events/orders/order-1",
      expected: false,
    }),
    checkAccess(acl, {
      name: "device cannot write payment events",
      username: "palmare-template",
      operation: "write",
      topic: "pos/store-1/events/payments/pay-1",
      expected: false,
    }),
    checkAccess(acl, {
      name: "device cannot write fiscal events",
      username: "palmare-template",
      operation: "write",
      topic: "pos/store-1/events/fiscal/doc-1",
      expected: false,
    }),
    checkAccess(acl, {
      name: "device writes own presence",
      username: "palmare-template",
      operation: "write",
      topic: "pos/store-1/devices/palmare-template/presence",
      expected: true,
    }),
    checkAccess(acl, {
      name: "device cannot write other presence",
      username: "palmare-template",
      operation: "write",
      topic: "pos/store-1/devices/other-device/presence",
      expected: false,
    }),
    checkAccess(acl, {
      name: "printer gateway reads print events",
      username: "printer-gateway-template",
      operation: "read",
      topic: "pos/store-1/events/prints/job-1",
      expected: true,
    }),
    checkAccess(acl, {
      name: "printer gateway cannot write events",
      username: "printer-gateway-template",
      operation: "write",
      topic: "pos/store-1/events/prints/job-1",
      expected: false,
    }),
  ];
  const nonBackendWritesEvents = users
    .filter((user) => user !== "backend")
    .flatMap((user) =>
      (acl.users.get(user) ?? [])
        .filter((rule) =>
          ["write", "readwrite"].includes(rule.access) &&
          mqttTopicMatches(expandUserPattern(rule.pattern, user), "pos/store-1/events/orders/order-1"),
        )
        .map((rule) => ({ user, lineNumber: rule.lineNumber, pattern: rule.pattern, access: rule.access })),
    );
  checks.push({
    name: "no non-backend event writers",
    ok: nonBackendWritesEvents.length === 0,
    detail: nonBackendWritesEvents.length === 0 ? "none" : JSON.stringify(nonBackendWritesEvents),
  });
  return {
    ok: checks.every((check) => check.ok),
    generatedAt: new Date().toISOString(),
    files: {
      confPath,
      aclPath,
    },
    users,
    checks,
  };
}

export function formatMqttAclPolicyMarkdown(summary) {
  const lines = ["# MQTT ACL policy check", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Conf: ${summary.files.confPath}`);
  lines.push(`ACL: ${summary.files.aclPath}`);
  lines.push(`Users: ${summary.users.join(", ") || "-"}`);
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
  lines.push("- Backend is the only writer for `pos/+/events/#`.");
  lines.push("- Devices can read events and write only their own presence/acks.");
  lines.push("- MQTT commands remain disabled by runtime flags.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeMqttAclPolicyReport(summary, outDir) {
  const targetDir = path.resolve(String(outDir || "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const jsonPath = path.join(targetDir, "mqtt-acl-policy-check.json");
  const mdPath = path.join(targetDir, "mqtt-acl-policy-check.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatMqttAclPolicyMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

export function runMqttAclPolicyCheck(options = {}) {
  const confPath = path.resolve(options.confPath || DEFAULT_CONF_PATH);
  const aclPath = path.resolve(options.aclPath || DEFAULT_ACL_PATH);
  return buildMqttAclPolicySummary({
    confPath,
    aclPath,
    confText: readFileSync(confPath, "utf8"),
    aclText: readFileSync(aclPath, "utf8"),
  });
}

async function main() {
  const options = parseMqttAclCheckArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = runMqttAclPolicyCheck(options);
  const output = writeMqttAclPolicyReport(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMqttAclPolicyMarkdown(summary));
    process.stdout.write(`[mqtt-acl-policy-check] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[mqtt-acl-policy-check] Markdown: ${output.mdPath}\n`);
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
