import { buildBackendProcessTopologyReport } from "../backend/core/process-topology.js";
import { buildRouteRegistry } from "../backend/routes/index.js";

function formatMarkdown(report) {
  const lines = [];
  lines.push("# Backend process topology report");
  lines.push("");
  lines.push(`- role: ${report.role}`);
  lines.push(`- read workers enabled: ${report.readWorkersEnabled ? "yes" : "no"}`);
  lines.push(`- order workers enabled: ${report.orderWorkersEnabled ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Order worker prerequisites");
  lines.push("");
  for (const entry of report.orderWorkerPrerequisites ?? []) {
    lines.push(`- ${entry.ok ? "OK" : "MISSING"} ${entry.name}`);
  }
  lines.push("");
  lines.push("Order worker route allowlist:");
  if (report.orderWorkerRouteAllowlist?.length) {
    for (const entry of report.orderWorkerRouteAllowlist) lines.push(`- ${entry}`);
  } else {
    lines.push("- empty");
  }
  lines.push("");
  lines.push("## Route scopes");
  lines.push("");
  for (const [scope, count] of Object.entries(report.counts)) {
    lines.push(`- ${scope}: ${count}`);
  }
  lines.push("");
  lines.push("## Blocked for generic workers");
  lines.push("");
  for (const entry of report.blockedForWorkers) {
    const flags = entry.requiredFlags.length > 0 ? `; requires ${entry.requiredFlags.join(", ")}` : "";
    lines.push(`- ${entry.key}: ${entry.scope}${flags}`);
  }
  if (report.blockedForWorkers.length === 0) lines.push("- None.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const report = buildBackendProcessTopologyReport(buildRouteRegistry(), process.env);
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(formatMarkdown(report));
}
