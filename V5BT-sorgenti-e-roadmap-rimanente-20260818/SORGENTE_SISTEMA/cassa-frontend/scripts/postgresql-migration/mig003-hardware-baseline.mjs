import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, "../..");
const WORKSPACE_ROOT = path.resolve(APP_ROOT, "../..");
const DEFAULT_DATA_DIR = process.env.BACKEND_DATA_DIR
  ?? process.env.V5BT_DATA_DIR
  ?? path.join(WORKSPACE_ROOT, ".runtime", "cassav5bt", "data");

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseMeminfo(text) {
  const values = {};
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const match = line.match(/^([^:]+):\s+(\d+)\s*(kB)?$/u);
    if (!match) continue;
    values[match[1]] = Number(match[2]) * (match[3] ? 1024 : 1);
  }
  return {
    totalBytes: values.MemTotal ?? 0,
    availableBytes: values.MemAvailable ?? 0,
    freeBytes: values.MemFree ?? 0,
    swapTotalBytes: values.SwapTotal ?? 0,
    swapFreeBytes: values.SwapFree ?? 0,
  };
}

export function parseProcessTable(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, observedCommand, executable, rssKiB, vszKiB, cpuPercent] = line.split(/\s+/u);
      const executableName = path.basename(String(executable ?? "")).toLowerCase();
      const command = executableName && executableName !== "-"
        ? executableName
        : String(observedCommand ?? "").toLowerCase();
      return {
        pid: finiteNumber(pid),
        command,
        rssBytes: finiteNumber(rssKiB) * 1024,
        virtualBytes: finiteNumber(vszKiB) * 1024,
        cpuPercent: finiteNumber(cpuPercent),
      };
    })
    .filter((entry) => entry.pid > 0 && entry.command);
}

function matchesProcess(entry, names) {
  return names.some((name) => entry.command === name || entry.command.startsWith(`${name}-`));
}

export function summarizeProcesses(processes) {
  const groups = {
    node: ["node"],
    mariaDb: ["mariadbd", "mysqld"],
    postgresql: ["postgres", "postmaster"],
    sqliteCli: ["sqlite3"],
  };
  return Object.fromEntries(Object.entries(groups).map(([group, names]) => {
    const matching = processes.filter((entry) => matchesProcess(entry, names));
    return [group, {
      processCount: matching.length,
      rssBytes: matching.reduce((sum, entry) => sum + entry.rssBytes, 0),
      virtualBytes: matching.reduce((sum, entry) => sum + entry.virtualBytes, 0),
      cpuPercent: matching.reduce((sum, entry) => sum + entry.cpuPercent, 0),
    }];
  }));
}

export function parseTemperature(rawVcgencmd, rawThermalZone) {
  const vcMatch = String(rawVcgencmd ?? "").match(/(-?\d+(?:\.\d+)?)\s*'?C/u);
  if (vcMatch) return Number(vcMatch[1]);
  const thermalText = String(rawThermalZone ?? "").trim();
  if (!thermalText) return null;
  const thermalValue = Number(thermalText);
  if (!Number.isFinite(thermalValue)) return null;
  return thermalValue > 1_000 ? thermalValue / 1_000 : thermalValue;
}

function safeCommand(command, args = []) {
  try {
    return {
      available: true,
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      }).trim(),
    };
  } catch (error) {
    return {
      available: error?.code !== "ENOENT",
      ok: false,
      exitCode: Number.isInteger(error?.status) ? error.status : null,
      stdout: "",
    };
  }
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function listSqliteFiles(dataDir) {
  if (!(await pathExists(dataDir))) return { dataDir, available: false, files: [] };
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && /\.sqlite(?:-(?:wal|shm))?$/u.test(entry.name)) {
        const metadata = await stat(absolutePath);
        files.push({
          relativePath: path.relative(dataDir, absolutePath).replaceAll("\\", "/"),
          sizeBytes: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        });
      }
    }
  };
  await visit(dataDir);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { dataDir, available: true, files };
}

async function collectResourceSample(commandRunner = safeCommand) {
  const meminfoRaw = await readOptional("/proc/meminfo");
  const processResult = commandRunner("ps", [
    "-eo", "pid=,comm=,exe=,rss=,vsz=,pcpu=", "--sort=-rss",
  ]);
  const temperatureResult = commandRunner("vcgencmd", ["measure_temp"]);
  const throttlingResult = commandRunner("vcgencmd", ["get_throttled"]);
  const thermalZoneRaw = await readOptional("/sys/class/thermal/thermal_zone0/temp");
  const processes = parseProcessTable(processResult.stdout);
  return {
    capturedAt: new Date().toISOString(),
    memory: meminfoRaw ? parseMeminfo(meminfoRaw) : {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem(),
      freeBytes: os.freemem(),
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    },
    processInventoryAvailable: processResult.ok,
    processes: summarizeProcesses(processes),
    temperatureCelsius: parseTemperature(temperatureResult.stdout, thermalZoneRaw),
    throttling: throttlingResult.ok ? throttlingResult.stdout : null,
    loadAverage: os.loadavg(),
  };
}

function maximum(samples, selector) {
  return samples.reduce((value, sample) => Math.max(value, finiteNumber(selector(sample))), 0);
}

export function summarizeSamples(samples) {
  return {
    sampleCount: samples.length,
    nodeMaxRssBytes: maximum(samples, (sample) => sample.processes.node.rssBytes),
    mariaDbMaxRssBytes: maximum(samples, (sample) => sample.processes.mariaDb.rssBytes),
    postgresqlMaxRssBytes: maximum(samples, (sample) => sample.processes.postgresql.rssBytes),
    maximumTemperatureCelsius: samples.reduce((maximumValue, sample) => {
      if (sample.temperatureCelsius === null) return maximumValue;
      return maximumValue === null
        ? sample.temperatureCelsius
        : Math.max(maximumValue, sample.temperatureCelsius);
    }, null),
    minimumAvailableMemoryBytes: samples.reduce((minimumValue, sample) => {
      const value = finiteNumber(sample.memory.availableBytes);
      return minimumValue === null ? value : Math.min(minimumValue, value);
    }, null),
  };
}

export function evaluateMig003Evidence(evidence) {
  const checks = {
    linux: evidence.host.platform === "linux",
    arm64: evidence.host.architecture === "arm64",
    raspberryModel: /raspberry pi/iu.test(evidence.host.model ?? ""),
    memoryCaptured: evidence.samples.every((sample) => sample.memory.totalBytes > 0),
    processInventoryCaptured: evidence.samples.every((sample) => sample.processInventoryAvailable),
    nodeRunning: evidence.summary.nodeMaxRssBytes > 0,
    mariaDbRunning: evidence.summary.mariaDbMaxRssBytes > 0,
    sqliteFilesCaptured: evidence.sqlite.available && evidence.sqlite.files.length >= 2,
    storageInventoryCaptured: evidence.storage.lsblk !== null && evidence.storage.findmnt !== null,
    temperatureCaptured: evidence.summary.maximumTemperatureCelsius !== null,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    checks,
    failedChecks,
    validForMig003: failedChecks.length === 0,
    nextGate: "MIG-010/HW-01",
    nextGateStatus: "BLOCKED",
    nextGateReason: "MIG-010 additionally requires pg_test_fsync, fio and a written SD-vs-SSD decision on the real Raspberry.",
  };
}

export async function collectMig003Evidence({
  durationSeconds = 60,
  intervalSeconds = 5,
  dataDir = DEFAULT_DATA_DIR,
  commandRunner = safeCommand,
} = {}) {
  const modelRaw = await readOptional("/proc/device-tree/model");
  const lsblkResult = commandRunner("lsblk", [
    "-J", "-b", "-o", "NAME,KNAME,TYPE,SIZE,MODEL,TRAN,ROTA,MOUNTPOINTS,FSTYPE",
  ]);
  const findmntResult = commandRunner("findmnt", ["-J", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"]);
  const serviceStates = Object.fromEntries(["mariadb", "postgresql"].map((service) => {
    const result = commandRunner("systemctl", ["is-active", service]);
    return [service, result.ok ? result.stdout : "unavailable-or-inactive"];
  }));
  const parseJson = (result) => {
    if (!result.ok) return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  };
  const samples = [];
  const startedAt = Date.now();
  do {
    samples.push(await collectResourceSample(commandRunner));
    if (Date.now() - startedAt >= durationSeconds * 1_000) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, intervalSeconds) * 1_000));
  } while (true);

  const evidence = {
    schemaVersion: 1,
    task: "MIG-003",
    generatedAt: new Date().toISOString(),
    capture: { durationSeconds, intervalSeconds },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      model: modelRaw?.replaceAll("\0", "").trim() ?? null,
      nodeVersion: process.version,
    },
    services: serviceStates,
    storage: {
      lsblk: parseJson(lsblkResult),
      findmnt: parseJson(findmntResult),
    },
    sqlite: await listSqliteFiles(dataDir),
    samples,
    summary: summarizeSamples(samples),
  };
  evidence.gate = evaluateMig003Evidence(evidence);
  return evidence;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--duration-seconds") options.durationSeconds = finiteNumber(value, 60);
    else if (name === "--interval-seconds") options.intervalSeconds = finiteNumber(value, 5);
    else if (name === "--data-dir") options.dataDir = path.resolve(value);
    else if (name === "--output") options.output = path.resolve(value);
    else throw new Error(`Unknown argument: ${name}`);
    index += 1;
  }
  return options;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  const evidence = await collectMig003Evidence(options);
  const timestamp = evidence.generatedAt.replaceAll(/[:.]/gu, "-");
  const output = options.output ?? path.join(
    APP_ROOT,
    "reports",
    "postgresql-migration",
    "mig003",
    `hardware-baseline-${timestamp}.json`,
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, gate: evidence.gate }, null, 2));
  if (!evidence.gate.validForMig003) process.exitCode = 2;
}
