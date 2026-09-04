import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");

function usage() {
  return `Uso: node scripts/cpu-profile-summary.mjs <file|dir> [altro file|dir...] [--top N] [--json out.json] [--md out.md]

Legge profili V8 .cpuprofile e produce:
- top frame per self time;
- top frame applicativi dentro cassa-frontend;
- top file per self time.
`;
}

function parseArgs(argv) {
  const inputs = [];
  const options = {
    top: 25,
    jsonPath: "",
    mdPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--top") {
      options.top = Math.max(1, Number.parseInt(argv[++index] ?? "", 10) || options.top);
    } else if (arg === "--json") {
      options.jsonPath = argv[++index] ?? "";
    } else if (arg === "--md") {
      options.mdPath = argv[++index] ?? "";
    } else {
      inputs.push(arg);
    }
  }
  return { inputs, options };
}

async function collectProfiles(entry) {
  const absolute = path.resolve(entry);
  const stat = await fs.stat(absolute);
  if (stat.isFile()) return absolute.endsWith(".cpuprofile") ? [absolute] : [];
  if (!stat.isDirectory()) return [];
  const children = await fs.readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    children.map((child) => collectProfiles(path.join(absolute, child.name)).catch(() => [])),
  );
  return nested.flat();
}

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function normalizeUrl(rawUrl) {
  const url = String(rawUrl ?? "").trim();
  if (!url) return "(native)";
  if (url.startsWith("file://")) {
    try {
      return fileURLToPath(url);
    } catch {
      return url;
    }
  }
  return url;
}

function displayPath(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (normalized === "(native)") return normalized;
  const cassaIndex = normalized.lastIndexOf("/cassa-frontend/");
  if (cassaIndex >= 0) return normalized.slice(cassaIndex + 1);
  if (normalized.startsWith(cassaRoot)) return path.relative(cassaRoot, normalized);
  return normalized.replace(/^node:/, "node:");
}

function isApplicationUrl(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  return normalized.includes("/cassa-frontend/") && !normalized.includes("/node_modules/");
}

function frameLabel(node) {
  const callFrame = node?.callFrame ?? {};
  const fn = String(callFrame.functionName ?? "").trim() || "(anonymous)";
  const url = displayPath(callFrame.url);
  const line = Number.isFinite(callFrame.lineNumber) ? Number(callFrame.lineNumber) + 1 : "";
  return `${url}:${line} ${fn}`;
}

function addMetric(map, key, delta) {
  const current = map.get(key) ?? { key, selfUs: 0, samples: 0 };
  current.selfUs += Number(delta?.selfUs ?? 0) || 0;
  current.samples += Number(delta?.samples ?? 0) || 0;
  map.set(key, current);
}

function profileSampleWeights(profile) {
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  const weights = new Map();
  if (samples.length > 0) {
    const fallbackUs =
      Number(profile.endTime) > Number(profile.startTime)
        ? Math.max(1, Math.round((Number(profile.endTime) - Number(profile.startTime)) / samples.length))
        : 1000;
    samples.forEach((nodeId, index) => {
      const entry = weights.get(nodeId) ?? { selfUs: 0, samples: 0 };
      entry.selfUs += Number(deltas[index]) > 0 ? Number(deltas[index]) : fallbackUs;
      entry.samples += 1;
      weights.set(nodeId, entry);
    });
    return weights;
  }

  const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
  const totalHits = nodes.reduce((sum, node) => sum + (Number(node.hitCount) || 0), 0);
  const fallbackUs =
    totalHits > 0 && Number(profile.endTime) > Number(profile.startTime)
      ? Math.max(1, Math.round((Number(profile.endTime) - Number(profile.startTime)) / totalHits))
      : 1000;
  nodes.forEach((node) => {
    const hits = Number(node.hitCount) || 0;
    if (hits <= 0) return;
    weights.set(node.id, { selfUs: hits * fallbackUs, samples: hits });
  });
  return weights;
}

function summarizeProfile(filePath, profile) {
  const nodeById = new Map((Array.isArray(profile.nodes) ? profile.nodes : []).map((node) => [node.id, node]));
  const weights = profileSampleWeights(profile);
  const frames = new Map();
  const applicationFrames = new Map();
  const files = new Map();
  const applicationFiles = new Map();
  let totalUs = 0;
  let totalSamples = 0;

  for (const [nodeId, weight] of weights.entries()) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    totalUs += weight.selfUs;
    totalSamples += weight.samples;
    const label = frameLabel(node);
    const file = displayPath(node.callFrame?.url);
    addMetric(frames, label, weight);
    addMetric(files, file, weight);
    if (isApplicationUrl(node.callFrame?.url)) {
      addMetric(applicationFrames, label, weight);
      addMetric(applicationFiles, file, weight);
    }
  }

  return {
    file: filePath,
    profileStartTime: profile.startTime ?? null,
    profileEndTime: profile.endTime ?? null,
    totalMs: round(totalUs / 1000),
    totalSamples,
    frames,
    applicationFrames,
    files,
    applicationFiles,
  };
}

function sortedRows(map, totalUs, limit) {
  return [...map.values()]
    .sort((left, right) => right.selfUs - left.selfUs || left.key.localeCompare(right.key))
    .slice(0, limit)
    .map((row) => ({
      key: row.key,
      selfMs: round(row.selfUs / 1000),
      samples: row.samples,
      pct: round(totalUs > 0 ? (row.selfUs / totalUs) * 100 : 0, 2),
    }));
}

function mergeSummaries(summaries) {
  const frames = new Map();
  const applicationFrames = new Map();
  const files = new Map();
  const applicationFiles = new Map();
  let totalUs = 0;
  let totalSamples = 0;
  for (const summary of summaries) {
    totalUs += Number(summary.totalMs) * 1000 || 0;
    totalSamples += Number(summary.totalSamples) || 0;
    for (const [key, value] of summary.frames.entries()) addMetric(frames, key, value);
    for (const [key, value] of summary.applicationFrames.entries()) addMetric(applicationFrames, key, value);
    for (const [key, value] of summary.files.entries()) addMetric(files, key, value);
    for (const [key, value] of summary.applicationFiles.entries()) addMetric(applicationFiles, key, value);
  }
  return { frames, applicationFrames, files, applicationFiles, totalUs, totalSamples };
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.title).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(column.value(row) ?? "")).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function toMarkdown(result) {
  const columns = [
    { title: "Frame/File", value: (row) => row.key },
    { title: "Self ms", value: (row) => row.selfMs },
    { title: "Samples", value: (row) => row.samples },
    { title: "%", value: (row) => row.pct },
  ];
  return [
    "# CPU Profile Summary",
    "",
    `Profiles: ${result.profileCount}`,
    `Total sampled CPU: ${result.totalMs} ms`,
    `Total samples: ${result.totalSamples}`,
    "",
    "## Top Application Frames",
    "",
    markdownTable(result.topApplicationFrames, columns),
    "",
    "## Top Application Files",
    "",
    markdownTable(result.topApplicationFiles, columns),
    "",
    "## Top All Frames",
    "",
    markdownTable(result.topFrames, columns),
    "",
    "## Top All Files",
    "",
    markdownTable(result.topFiles, columns),
    "",
  ].join("\n");
}

async function main() {
  const { inputs, options } = parseArgs(process.argv.slice(2));
  if (options.help || inputs.length === 0) {
    console.log(usage());
    return;
  }

  const files = [...new Set((await Promise.all(inputs.map(collectProfiles))).flat())].sort();
  if (files.length === 0) throw new Error("nessun file .cpuprofile trovato");

  const summaries = [];
  for (const filePath of files) {
    const profile = JSON.parse(await fs.readFile(filePath, "utf8"));
    summaries.push(summarizeProfile(filePath, profile));
  }
  const merged = mergeSummaries(summaries);
  const result = {
    generatedAt: new Date().toISOString(),
    profileCount: files.length,
    profiles: summaries.map((summary) => ({
      file: summary.file,
      totalMs: summary.totalMs,
      totalSamples: summary.totalSamples,
    })),
    totalMs: round(merged.totalUs / 1000),
    totalSamples: merged.totalSamples,
    topApplicationFrames: sortedRows(merged.applicationFrames, merged.totalUs, options.top),
    topApplicationFiles: sortedRows(merged.applicationFiles, merged.totalUs, options.top),
    topFrames: sortedRows(merged.frames, merged.totalUs, options.top),
    topFiles: sortedRows(merged.files, merged.totalUs, options.top),
  };

  if (options.jsonPath) {
    await fs.mkdir(path.dirname(path.resolve(options.jsonPath)), { recursive: true });
    await fs.writeFile(options.jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  const markdown = toMarkdown(result);
  if (options.mdPath) {
    await fs.mkdir(path.dirname(path.resolve(options.mdPath)), { recursive: true });
    await fs.writeFile(options.mdPath, `${markdown}\n`);
  }
  console.log(markdown);
}

main().catch((error) => {
  console.error("[cpu-profile-summary] errore", error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
