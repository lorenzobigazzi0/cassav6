#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const inputArg = process.argv[2] || "";

function usage() {
  console.error("Uso: node cassa-frontend/scripts/endurance-report-pdf.mjs <report.json|cartella-log>");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value ?? "-");
  return new Intl.DateTimeFormat("it-IT", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function seconds(ms) {
  return `${Math.round((Number(ms) || 0) / 1000)} s`;
}

function value(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "-";
  return `${escapeHtml(value)}${suffix}`;
}

function moneyCents(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format(value / 100);
}

function statusClass(ok) {
  return ok ? "ok" : "fail";
}

function table(headers, rows) {
  if (!rows.length) return `<p class="muted">Nessun dato.</p>`;
  return `
    <table>
      <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  `;
}

function httpRows(items) {
  return items.map(
    (entry) => `
      <tr>
        <td>${escapeHtml(entry.name)}</td>
        <td class="num">${value(entry.count)}</td>
        <td class="num ${entry.fail ? "bad" : "good"}">${value(entry.fail)}</td>
        <td class="num">${value(entry.p50Ms, " ms")}</td>
        <td class="num">${value(entry.p95Ms, " ms")}</td>
        <td class="num">${value(entry.p99Ms, " ms")}</td>
        <td class="num">${value(entry.maxMs, " ms")}</td>
        <td class="num">${value(entry.earlyP95Ms, " ms")}</td>
        <td class="num">${value(entry.lateP95Ms, " ms")}</td>
        <td class="num">${value(entry.lateVsEarlyP95)}</td>
      </tr>
    `,
  );
}

function actionRows(items) {
  return items.map(
    (entry) => `
      <tr>
        <td>${escapeHtml(entry.name)}</td>
        <td class="num">${value(entry.count)}</td>
        <td class="num ${entry.fail ? "bad" : "good"}">${value(entry.fail)}</td>
        <td class="num">${value(entry.p50Ms, " ms")}</td>
        <td class="num">${value(entry.p95Ms, " ms")}</td>
        <td class="num">${value(entry.p99Ms, " ms")}</td>
        <td class="num">${value(entry.maxMs, " ms")}</td>
      </tr>
    `,
  );
}

function driftRows(items) {
  return items.map(
    (entry) => `
      <tr>
        <td>${escapeHtml(entry.name)}</td>
        <td class="num">${value(entry.earlyP95Ms, " ms")}</td>
        <td class="num">${value(entry.middleP95Ms, " ms")}</td>
        <td class="num">${value(entry.lateP95Ms, " ms")}</td>
        <td class="num">${value(entry.lateVsEarlyP95)}</td>
      </tr>
    `,
  );
}

function list(items) {
  if (!items.length) return `<p class="muted">Nessuno.</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function sumCount(items) {
  return items.reduce((sum, entry) => sum + (Number(entry?.count) || 0), 0);
}

function reconnectRows(items) {
  return items.map((entry) => {
    const errored = entry.snapshots?.filter((snapshot) => snapshot.reconnectError) ?? [];
    const critical = entry.critical ?? {};
    return `
      <tr>
        <td>${escapeHtml(formatDate(entry.at))}</td>
        <td class="num">${value(entry.elapsedMs, " ms")}</td>
        <td class="num">${value(critical.criticalWaitMs, " ms")}</td>
        <td class="num">${value(critical.backgroundInFlightAtStart)}</td>
        <td class="num">${value(critical.backgroundInFlightAfterWait)}</td>
        <td class="num">${value(entry.usersChecked)}</td>
        <td class="num">${value(entry.stationsChecked)}</td>
        <td class="${entry.allRadioStable ? "good" : "bad"}">${entry.allRadioStable ? "OK" : "FAIL"}</td>
        <td class="${entry.allCashStatusOk ? "good" : "bad"}">${entry.allCashStatusOk ? "OK" : "FAIL"}</td>
        <td>${errored.length ? escapeHtml(errored.map((item) => `${item.username}: ${item.reconnectError}`).join("; ")) : "-"}</td>
      </tr>
    `;
  });
}

function compactJson(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function renderHtml(report) {
  const http = report.recorder?.http ?? [];
  const actions = report.recorder?.actions ?? [];
  const drift = http
    .filter((entry) => entry.count >= 20 && entry.lateVsEarlyP95 !== null)
    .sort((left, right) => (right.lateVsEarlyP95 ?? 0) - (left.lateVsEarlyP95 ?? 0));
  const topFailures = report.recorder?.failures?.slice(0, 40) ?? [];
  const validation = report.validation ?? {};
  const monitor = report.monitor ?? {};
  const radio = report.recorder?.radio ?? {};
  const options = report.options ?? {};
  const actionCount = sumCount(actions);
  const httpCount = sumCount(http);
  const actionConcurrency = Number.isFinite(Number(options.actionConcurrency))
    ? Number(options.actionConcurrency)
    : Math.max(1, (Number(options.maxConcurrency) || 0) - (Number(options.criticalHeadroom) || 0));

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>Endurance Report ${escapeHtml(report.runId)}</title>
  <style>
    @page { margin: 14mm 12mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #172033;
      font: 12px/1.45 "Segoe UI", Arial, sans-serif;
      background: #fff;
    }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 26px; }
    h2 { font-size: 16px; margin: 22px 0 8px; padding-top: 4px; border-top: 1px solid #d8e0ec; }
    h3 { font-size: 13px; margin: 14px 0 6px; }
    .cover {
      padding: 22px;
      border: 1px solid #d9e2ef;
      border-radius: 10px;
      background: linear-gradient(135deg, #f7fbff, #eef5ff);
      margin-bottom: 18px;
    }
    .subtitle { color: #526071; margin-top: 6px; }
    .badge {
      display: inline-block;
      margin-top: 12px;
      padding: 5px 10px;
      border-radius: 999px;
      font-weight: 800;
      color: #fff;
    }
    .badge.ok { background: #1f7a4d; }
    .badge.fail { background: #b42318; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0 4px; }
    .card {
      border: 1px solid #dce4ef;
      border-radius: 8px;
      padding: 10px;
      background: #fff;
      min-height: 58px;
    }
    .card span { display: block; color: #667487; font-size: 10px; text-transform: uppercase; font-weight: 800; }
    .card strong { display: block; margin-top: 3px; font-size: 15px; }
    table { width: 100%; border-collapse: collapse; margin: 7px 0 12px; page-break-inside: auto; }
    th, td { border: 1px solid #dde5f0; padding: 5px 6px; vertical-align: top; }
    th { background: #edf4fb; color: #26364d; font-size: 10px; text-transform: uppercase; text-align: left; }
    tr { page-break-inside: avoid; }
    .num { text-align: right; white-space: nowrap; }
    .good { color: #1f7a4d; font-weight: 800; }
    .bad { color: #b42318; font-weight: 800; }
    .muted { color: #667487; }
    ul { margin: 6px 0 12px 18px; padding: 0; }
    li { margin: 3px 0; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid #dde5f0;
      border-radius: 8px;
      background: #f8fafc;
      padding: 8px;
      font-size: 10px;
    }
    .page-break { break-before: page; }
  </style>
</head>
<body>
  <section class="cover">
    <h1>Report Simulazione Endurance</h1>
    <div class="subtitle">Run ${escapeHtml(report.runId)} - ${escapeHtml(formatDate(report.recorder?.startedAt))} / ${escapeHtml(formatDate(report.recorder?.finishedAt))}</div>
    <span class="badge ${statusClass(report.ok)}">${report.ok ? "ESITO OK" : "ESITO FAIL"}</span>
    <div class="grid">
	      <div class="card"><span>Durata</span><strong>${escapeHtml(seconds(report.recorder?.durationMs))}</strong></div>
	      <div class="card"><span>Azioni</span><strong>${value(actionCount)} / ${value(options.actions)}</strong></div>
	      <div class="card"><span>HTTP</span><strong>${value(httpCount)}</strong></div>
	      <div class="card"><span>Mobile</span><strong>${value(options.mobileDevices)}</strong></div>
	      <div class="card"><span>Postazioni</span><strong>${value(options.stations)}</strong></div>
	      <div class="card"><span>Radio WS</span><strong>${value(radio.clientsOpened)} / ${value(options.radioClients)}</strong></div>
	      <div class="card"><span>Concorrenza</span><strong>${value(actionConcurrency)} + ${value(options.criticalHeadroom ?? 0)}</strong></div>
	      <div class="card"><span>Finding</span><strong>${value(validation.findings?.length ?? 0)}</strong></div>
	      <div class="card"><span>Warning</span><strong>${value(validation.warnings?.length ?? 0)}</strong></div>
	      <div class="card"><span>Load max</span><strong>${value(monitor.load1Max)}</strong></div>
    </div>
  </section>

  <h2>Sintesi Stato</h2>
  <div class="grid">
    <div class="card"><span>Ordini</span><strong>${value(validation.counts?.orders)}</strong></div>
    <div class="card"><span>Pagamenti</span><strong>${value(validation.counts?.paymentTransactions)}</strong></div>
    <div class="card"><span>Code stampa</span><strong>${value(validation.counts?.printSpoolJobs)}</strong></div>
    <div class="card"><span>Scontrini fiscali</span><strong>${value(validation.counts?.fiscalReceipts)}</strong></div>
    <div class="card"><span>RSS backend</span><strong>${value(monitor.backendRssStartMb)} -> ${value(monitor.backendRssEndMb)} MB</strong></div>
    <div class="card"><span>RSS max</span><strong>${value(monitor.backendRssMaxMb, " MB")}</strong></div>
    <div class="card"><span>DB JSON</span><strong>${value(monitor.dbSizeStartMb)} -> ${value(monitor.dbSizeEndMb)} MB</strong></div>
    <div class="card"><span>DB max</span><strong>${value(monitor.dbSizeMaxMb, " MB")}</strong></div>
  </div>

  <h2>Finding</h2>
  ${list(validation.findings ?? [])}

  <h2>Warning</h2>
  ${list(validation.warnings ?? [])}

  <h2>Radio</h2>
  <div class="grid">
    <div class="card"><span>Frame TX</span><strong>${value(radio.framesSent)}</strong></div>
    <div class="card"><span>Frame RX</span><strong>${value(radio.binaryFramesReceived)}</strong></div>
    <div class="card"><span>Start RX</span><strong>${value(radio.incomingStarts)}</strong></div>
    <div class="card"><span>Stop RX</span><strong>${value(radio.incomingStops)}</strong></div>
    <div class="card"><span>Busy</span><strong>${value(radio.busyResponses)}</strong></div>
    <div class="card"><span>Restart TX</span><strong>${value(radio.restarts)}</strong></div>
    <div class="card"><span>Errori</span><strong>${value(radio.errors?.length ?? 0)}</strong></div>
  </div>
  ${radio.errors?.length ? `<pre>${compactJson(radio.errors.slice(0, 40))}</pre>` : `<p class="muted">Nessun errore radio campionato.</p>`}

	  <h2>Riconnessioni</h2>
	  ${table(
	    ["Ora", "Durata", "Wait critico", "BG start", "BG dopo", "Utenti", "Postazioni", "Radio stabile", "Cash OK", "Errori"],
	    reconnectRows(report.recorder?.reconnections ?? []),
	  )}

  <h2>HTTP Principali</h2>
  ${table(
    ["Endpoint", "Count", "Fail", "P50", "P95", "P99", "Max", "Early P95", "Late P95", "Late/Early"],
    httpRows(http.slice(0, 28)),
  )}

  <h2>Drift Latenza Early/Late</h2>
  ${table(
    ["Endpoint", "Early P95", "Middle P95", "Late P95", "Ratio"],
    driftRows(drift.slice(0, 24)),
  )}

  <h2>Azioni High-Level</h2>
  ${table(
    ["Azione", "Count", "Fail", "P50", "P95", "P99", "Max"],
    actionRows(actions.slice(0, 28)),
  )}

  <h2>Automatic Cash</h2>
  ${table(
    ["Ora", "Step", "Status", "ID", "Totale"],
    (report.recorder?.automaticCash ?? []).slice(-40).map((entry) => `
      <tr>
        <td>${escapeHtml(formatDate(entry.at))}</td>
        <td>${escapeHtml(entry.step ?? "-")}</td>
        <td class="num">${value(entry.status)}</td>
        <td>${escapeHtml(entry.exchangeId ?? entry.body?.cashFloatId ?? entry.body?.exchangeId ?? "-")}</td>
        <td class="num">${entry.body?.totalCents != null ? moneyCents(entry.body.totalCents) : "-"}</td>
      </tr>
    `),
  )}

  <h2>Failure Campionati</h2>
  ${topFailures.length ? `<pre>${compactJson(topFailures)}</pre>` : `<p class="muted">Nessun failure campionato.</p>`}

  <h2>File</h2>
  <ul>
    <li>DB isolato: ${escapeHtml(report.backend?.dbPath)}</li>
    <li>Report JSON: ${escapeHtml(report.__reportJsonPath ?? "")}</li>
  </ul>
</body>
</html>`;
}

async function resolveReportPath(input) {
  if (!input) throw new Error("Percorso report mancante.");
  const resolved = path.resolve(input);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) return path.join(resolved, "report.json");
  return resolved;
}

async function main() {
  if (!inputArg) {
    usage();
    process.exit(2);
  }
  const reportJsonPath = await resolveReportPath(inputArg);
  const report = JSON.parse(await fs.readFile(reportJsonPath, "utf8"));
  report.__reportJsonPath = reportJsonPath;
  const outputPath = path.join(path.dirname(reportJsonPath), "REPORT.pdf");
  const htmlPath = path.join(path.dirname(reportJsonPath), "REPORT.html");
  await fs.writeFile(htmlPath, renderHtml(report), "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(pathToFileURL(htmlPath).toString(), { waitUntil: "load" });
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
