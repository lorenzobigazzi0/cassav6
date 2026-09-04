#!/usr/bin/env node
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const input = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !existsSync(input)) {
  throw new Error("Uso: node scripts/p5-endurance-report-pdf.mjs <report.json>");
}

async function loadChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    try {
      return (await import("playwright-core")).chromium;
    } catch {
      const fallback = path.resolve(path.dirname(input), "../../mobile-frontend/node_modules/playwright/index.mjs");
      return (await import(pathToFileURL(fallback).href)).chromium;
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "-")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function duration(ms) {
  const totalSeconds = Math.round((Number(ms) || 0) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function latencyCells(item = {}) {
  return ["p50ms", "p95ms", "p98ms", "p99ms", "p999ms", "maxMs"]
    .map((key) => `<td class="num">${escapeHtml(item[key] ?? 0)}</td>`)
    .join("");
}

function render(report) {
  const p5 = report.p5Profile || {};
  const recorder = report.recorder || {};
  const config = report.config || {};
  const rateOk = p5.rate?.ok === true;
  const quotaOk = p5.totalStarted === p5.totalActions && p5.totalCompleted === p5.totalActions;
  const drainOk = report.relationalAudit?.drained === true;
  const failures = recorder.failures || [];
  const ok = rateOk && quotaOk && drainOk && failures.length === 0;
  const topOperations = Object.entries(recorder.ops || {})
    .filter(([name]) => !name.startsWith("business:"))
    .sort((left, right) => (right[1]?.count || 0) - (left[1]?.count || 0))
    .slice(0, 25);
  const drift = p5.actionLatencyDrift || {};
  const steadyDrift = p5.steadyActionLatencyDrift || {};
  const httpDrift = recorder.latencyDrift || {};
  const printers = report.mockIoMetrics?.printers?.body?.printers || [];

  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>P5 ${escapeHtml(report.runId)}</title>
<style>
@page { size: A4; margin: 13mm 11mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #172033; font: 10.5px/1.4 Arial, sans-serif; }
h1,h2 { letter-spacing: 0; margin: 0; }
h1 { font-size: 24px; } h2 { font-size: 15px; margin: 18px 0 7px; border-top: 1px solid #ccd6e3; padding-top: 6px; }
.cover { padding: 18px; background: #edf5fb; border: 1px solid #cbd8e7; border-radius: 6px; }
.sub { color: #526071; margin: 5px 0 10px; }
.badge { display:inline-block; padding:5px 9px; color:#fff; background:${ok ? "#197548" : "#b42318"}; font-weight:700; border-radius:4px; }
.grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-top:10px; }
.card { border:1px solid #d9e2ed; padding:7px; background:#fff; min-height:50px; }
.card span { display:block; color:#657386; font-size:8.5px; text-transform:uppercase; font-weight:700; }
.card strong { display:block; margin-top:3px; font-size:13px; }
table { width:100%; border-collapse:collapse; margin:5px 0 10px; }
th,td { border:1px solid #dce4ee; padding:4px 5px; vertical-align:top; }
th { background:#edf3f8; font-size:8.5px; text-transform:uppercase; text-align:left; }
.num { text-align:right; white-space:nowrap; }
.ok { color:#197548; font-weight:700; } .fail { color:#b42318; font-weight:700; }
tr { break-inside:avoid; } .break { break-before:page; }
ul { margin:5px 0 8px 16px; padding:0; } li { margin:2px 0; }
</style></head><body>
<section class="cover">
  <h1>Report P5 Endurance 20x5</h1>
  <div class="sub">Run ${escapeHtml(report.runId)} - ${escapeHtml(recorder.startedAt)} / ${escapeHtml(recorder.endedAt)}</div>
  <span class="badge">${ok ? "GATE VERDE" : "GATE ROSSO"}</span>
  <div class="grid">
    <div class="card"><span>Durata</span><strong>${duration(p5.durationMs)}</strong></div>
    <div class="card"><span>Azioni</span><strong>${escapeHtml(p5.totalCompleted)} / ${escapeHtml(p5.totalActions)}</strong></div>
    <div class="card"><span>Rate massimo</span><strong>${escapeHtml(p5.actionsPerSecond)} azioni/s</strong></div>
    <div class="card"><span>HTTP</span><strong>${escapeHtml(recorder.httpRequests)}</strong></div>
    <div class="card"><span>Palmari</span><strong>${escapeHtml(config.handHeldCount)}</strong></div>
    <div class="card"><span>Postazioni</span><strong>${escapeHtml(config.stationCount)}</strong></div>
    <div class="card"><span>GUI reali</span><strong>${escapeHtml(p5.guiMobileCount)} + ${escapeHtml(p5.guiStationCount)}</strong></div>
    <div class="card"><span>Anomalie</span><strong>${escapeHtml(failures.length)}</strong></div>
  </div>
</section>

<h2>Gate e sicurezza</h2>
<table><tbody>
  <tr><th>Quota 1.000 per device</th><td class="${quotaOk ? "ok" : "fail"}">${quotaOk ? "OK" : "FAIL"}</td><th>Rate globale</th><td class="${rateOk ? "ok" : "fail"}">${rateOk ? "OK" : "FAIL"}</td></tr>
  <tr><th>Drain relazionale</th><td class="${drainOk ? "ok" : "fail"}">${drainOk ? "OK" : "FAIL"}</td><th>I/O reale</th><td class="${config.allowNonLoopbackIo ? "fail" : "ok"}">${config.allowNonLoopbackIo ? "CONSENTITO" : "BLOCCATO"}</td></tr>
  <tr><th>Stampanti</th><td>${printers.length} mock TCP</td><th>Fiscale</th><td>${escapeHtml(config.rtBaseUrl)}</td></tr>
  <tr><th>Cassa automatica</th><td>${escapeHtml(config.automaticCashBaseUrl)}</td><th>Browser</th><td>${escapeHtml(config.chromiumExecutablePath)}</td></tr>
</tbody></table>

<h2>Percentili</h2>
<table><thead><tr><th>Ambito</th><th>P50</th><th>P95</th><th>P98</th><th>P99</th><th>P99.9</th><th>Max</th></tr></thead><tbody>
  <tr><td>Azioni applicative</td>${latencyCells(p5.actionLatencyMs)}</tr>
  <tr><td>Azioni steady (${escapeHtml(p5.disruptiveActionCount || 0)} disruptive escluse)</td>${latencyCells(p5.steadyActionLatencyMs)}</tr>
  <tr><td>Richieste HTTP</td>${latencyCells(recorder.latencyMs)}</tr>
  <tr><td>Realtime delivery</td>${latencyCells(report.realtime?.deliveryLagMs)}</tr>
</tbody></table>

<h2>Drift primo/ultimo 10%</h2>
<table><thead><tr><th>Ambito</th><th>Fase</th><th>P50</th><th>P95</th><th>P98</th><th>P99</th><th>P99.9</th><th>Max</th></tr></thead><tbody>
  <tr><td rowspan="2">Azioni</td><td>Primo 10%</td>${latencyCells(drift.first)}</tr>
  <tr><td>Ultimo 10%</td>${latencyCells(drift.last)}</tr>
  <tr><td rowspan="2">Azioni steady</td><td>Primo 10%</td>${latencyCells(steadyDrift.first)}</tr>
  <tr><td>Ultimo 10%</td>${latencyCells(steadyDrift.last)}</tr>
  <tr><td rowspan="2">HTTP</td><td>Primo 10%</td>${latencyCells(httpDrift.first)}</tr>
  <tr><td>Ultimo 10%</td>${latencyCells(httpDrift.last)}</tr>
</tbody></table>
<p>Drift P95 azioni: ${escapeHtml(drift.drift?.p95ms?.deltaMs)} ms (${escapeHtml(drift.drift?.p95ms?.percent)}%). Drift P95 HTTP: ${escapeHtml(httpDrift.drift?.p95ms?.deltaMs)} ms (${escapeHtml(httpDrift.drift?.p95ms?.percent)}%).</p>

<h2>Finestre temporali</h2>
<table><thead><tr><th>Decile</th><th>Sequenze</th><th>Count</th><th>P50</th><th>P95</th><th>P98</th><th>P99</th><th>P99.9</th><th>Max</th></tr></thead><tbody>
${(p5.actionTimeWindows || []).map((window) => `<tr><td>${window.index}</td><td>${window.firstSequence}-${window.lastSequence}</td><td class="num">${window.count}</td>${latencyCells(window.latencyMs)}</tr>`).join("")}
</tbody></table>

<h2 class="break">Operazioni principali</h2>
<table><thead><tr><th>Operazione</th><th>Count</th><th>OK</th><th>Fail</th><th>P50</th><th>P95</th><th>P98</th><th>P99</th><th>P99.9</th><th>Max</th></tr></thead><tbody>
${topOperations.map(([name, item]) => `<tr><td>${escapeHtml(name)}</td><td class="num">${item.count}</td><td class="num">${item.ok}</td><td class="num ${item.fail ? "fail" : "ok"}">${item.fail}</td>${latencyCells(item)}</tr>`).join("")}
</tbody></table>

<h2>GUI Chrome reali</h2>
<table><thead><tr><th>GUI</th><th>Interazioni</th><th>Touch</th><th>Pressioni lunghe</th><th>Reload</th><th>Disconnect</th><th>4xx</th><th>5xx</th><th>Console</th></tr></thead><tbody>
${(recorder.gui || []).map((gui) => `<tr><td>${escapeHtml(gui.kind)} ${Number(gui.index || 0) + 1}</td><td class="num">${gui.interactions}</td><td class="num">${gui.touchTaps}</td><td class="num">${gui.longPresses}</td><td class="num">${gui.reloads}</td><td class="num">${gui.disconnects}</td><td class="num">${gui.responses4xx}</td><td class="num ${gui.responses5xx ? "fail" : "ok"}">${gui.responses5xx}</td><td class="num">${gui.consoleErrors}</td></tr>`).join("")}
</tbody></table>

<h2>Risorse e code</h2>
<ul>
  <li>Outbox realtime non pubblicata: ${escapeHtml(report.relationalAudit?.eventOutboxUnpublished)}</li>
  <li>Stampa pending/fallita: ${escapeHtml(report.relationalAudit?.printSpoolPending)} / ${escapeHtml(report.relationalAudit?.printSpoolFailedFinal)}</li>
  <li>Fiscale pending/problem: ${escapeHtml(report.relationalAudit?.fiscalOutboxPending)} / ${escapeHtml(report.relationalAudit?.fiscalOutboxProblem)}</li>
  <li>Payment mirror pending/fallito: ${escapeHtml(report.relationalAudit?.paymentMirrorPending)} / ${escapeHtml(report.relationalAudit?.paymentMirrorFailed)}</li>
  <li>Dimensione MySQL finale: ${escapeHtml(Math.round((report.monitor?.tableBytesEnd || 0) / 1024 / 1024))} MB</li>
</ul>

<h2>Anomalie</h2>
${failures.length ? `<ul>${failures.slice(-80).map((failure) => `<li><strong>${escapeHtml(failure.type)}</strong>: ${escapeHtml(JSON.stringify(failure.detail || {}))}</li>`).join("")}</ul>` : "<p>Nessuna anomalia registrata.</p>"}
</body></html>`;
}

const report = JSON.parse(await fs.readFile(input, "utf8"));
if (!report.p5Profile) throw new Error("Il report non contiene p5Profile.");
const output = path.join(path.dirname(input), "P5_ENDURANCE_REPORT.pdf");
const chromium = await loadChromium();
const executablePath = String(process.env.LOADTEST_CHROMIUM_EXECUTABLE_PATH || report.config?.chromiumExecutablePath || "").trim();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  ...(String(process.env.LOADTEST_CHROMIUM_NO_SANDBOX || "0") === "1" ? { args: ["--no-sandbox"] } : {}),
});
try {
  const page = await browser.newPage();
  await page.setContent(render(report), { waitUntil: "load" });
  await page.pdf({ path: output, format: "A4", printBackground: true });
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ok: true, input, output }, null, 2));
