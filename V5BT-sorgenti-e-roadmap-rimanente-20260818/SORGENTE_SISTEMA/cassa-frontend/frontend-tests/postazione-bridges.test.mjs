import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatDurationHHMMSS,
  isStationOccupiedByOther,
  normalizeActiveStationsPayload,
  sortOrdersOperationalFirst,
  tableLabelForOrder,
} from "../../postazione/src/stationRuntime.js";
import {
  isCurrentPostazioneSession,
  performPostazioneLogout,
} from "../../postazione/src/logoutSession.js";

const frontendTestsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(frontendTestsDir, "..", "..");
const postazioneRoot = path.join(projectRoot, "postazione");

const [appSource, indexSource, mainSource] = await Promise.all([
  readFile(path.join(postazioneRoot, "src/App.jsx"), "utf8"),
  readFile(path.join(postazioneRoot, "index.html"), "utf8"),
  readFile(path.join(postazioneRoot, "src/main.jsx"), "utf8"),
]);

function sourceSection(start, end) {
  const startIndex = appSource.indexOf(start);
  assert.notEqual(startIndex, -1, `sezione React non trovata: ${start}`);
  const endIndex = appSource.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `fine sezione React non trovata: ${end}`);
  return appSource.slice(startIndex, endIndex);
}

test("[FE][P1] Postazione avvia un solo proprietario React senza script di compatibilita", async () => {
  const scriptSources = [...indexSource.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const allowedSupportScripts = new Set([
    "/postazione/assets/postazione-disable-context-menu.js",
    "/postazione/assets/postazione-order-sound.js",
    "/postazione/assets/postazione-apericena-summary.js",
  ]);

  assert.ok(scriptSources.includes("/src/main.jsx"));
  for (const source of scriptSources) {
    const pathname = source.split("?")[0];
    if (pathname === "/src/main.jsx") continue;
    assert.ok(allowedSupportScripts.has(pathname), `script Postazione non previsto: ${source}`);
  }
  assert.doesNotMatch(indexSource, /postazione-[^"']*bridge\.js/i);
  assert.doesNotMatch(indexSource, /data-[^=\s]*-owner=/i);
  assert.match(mainSource, /createRoot\(document\.getElementById\("root"\)\)\.render/);
  assert.match(mainSource, /<App\s*\/>/);

  const [publicAssets, distAssets] = await Promise.all([
    readdir(path.join(postazioneRoot, "public/assets")),
    readdir(path.join(postazioneRoot, "dist/assets")),
  ]);
  assert.equal(
    [...publicAssets, ...distAssets].some((name) => /^postazione-.*bridge\.js$/i.test(name)),
    false,
  );
});

test("[FE][P1] richieste API e autenticazione appartengono a React senza fallback HTTP", () => {
  const apiSection = sourceSection(
    "const apiFetchJson = useCallback",
    "const persistActionQueue = useCallback",
  );

  assert.match(apiSection, /const res = await fetch\(`\$\{base\}\$\{path\}`/);
  assert.match(apiSection, /"X-Client-App": "postazione"/);
  assert.match(apiSection, /Authorization: `Bearer \$\{String\(authLocal\.token\)\.trim\(\)\}`/);
  assert.match(apiSection, /"X-User-Id": String\(authLocal\.userId\)\.trim\(\)/);
  assert.match(apiSection, /"X-Device-Uuid": String\(authLocal\.deviceUuid\)\.trim\(\)/);
  assert.match(apiSection, /const bases = \[apiRef\.current\]\.filter\(Boolean\)/);
  assert.doesNotMatch(apiSection, /apiFallbackRef/);
  assert.match(apiSection, /activeApiControllersRef\.current\.add\(ctrl\)/);
  assert.match(apiSection, /activeApiControllersRef\.current\.delete\(ctrl\)/);
  assert.doesNotMatch(appSource, /window\.fetch\s*=/);
});

test("[FE][P1] la selezione login usa allowlist server e associazione atomica", () => {
  const payload = normalizeActiveStationsPayload({
    configuredStations: ["BAR-1", "BAR-2", "PIZZA IN RIVA"],
    stations: [
      {
        station: "BAR-1",
        active: true,
        stale: false,
        realStation: true,
        operatorUserId: "current-user",
        deviceUuid: "current-device",
      },
      {
        station: "BAR-2",
        active: true,
        stale: false,
        realStation: true,
        operatorUserId: "other-user",
        deviceUuid: "other-device",
      },
      {
        station: "PIZZA IN RIVA",
        active: true,
        stale: false,
        realStation: false,
        configuredStation: true,
      },
    ],
  });
  const currentIdentity = { userId: "current-user", deviceUuid: "current-device" };

  assert.deepEqual(payload.activeStations, ["BAR-1", "BAR-2"]);
  assert.equal(isStationOccupiedByOther(payload.sessions, "BAR-1", currentIdentity), false);
  assert.equal(isStationOccupiedByOther(payload.sessions, "BAR-2", currentIdentity), true);
  assert.match(appSource, /apiFetchJson\("\/api\/integration\/stations\/active"/);
  assert.match(appSource, /setActiveStationSessions\(normalized\.activeSessions\)/);
  assert.match(appSource, /normalizeAvailableWorkstations\(payload\)/);
  assert.match(appSource, /\/api\/auth\/workstation\/select/);
  assert.match(appSource, /station-selector station-selector-static/);
  assert.doesNotMatch(appSource, /modal\.station/);
});

test("[FE][P1] heartbeat e pausa inviano al backend l'intero stato React", () => {
  const heartbeatSection = sourceSection(
    "const pushStationHeartbeat = useCallback",
    "const syncOrders = useCallback",
  );
  const pauseSection = sourceSection(
    "const completeStationPause = useCallback",
    "const handleStationActiveChange = useCallback",
  );
  const pauseChoiceSection = sourceSection(
    "const handleStationActiveChange = useCallback",
    "const queuePauseNotification = useCallback",
  );

  assert.match(heartbeatSection, /isAuthenticatedPostazioneSession\(authLocal\)/);
  assert.match(heartbeatSection, /apiFetchJson\("\/api\/integration\/stations\/state"/);
  assert.match(heartbeatSection, /operatorUserId: String\(authLocal\.userId/);
  assert.match(heartbeatSection, /deviceUuid: String\(authLocal\.deviceUuid/);
  assert.match(pauseSection, /pauseTransferMode: transferMode/);
  assert.match(pauseSection, /transferOrders: transferMode === "transfer"/);
  assert.doesNotMatch(pauseSection, /orders\/transfer\/force/);
  assert.match(pauseChoiceSection, /activeStationSessions[\s\S]*?\.filter\(isRealActiveStation\)/);
  assert.match(pauseChoiceSection, /if \(!hasTransferableQueue \|\| candidates\.length === 0\)/);
  assert.match(pauseChoiceSection, /await completeStationPause\("suspend"\)/);
});

test("[FE][P1] workflow, checkbox e selezione sono handler React", () => {
  const selectionSection = sourceSection(
    "const selectOrder = useCallback",
    "const callWaiter = useCallback",
  );
  const readySection = sourceSection(
    "const markReady = useCallback",
    "const toggleGroup = useCallback",
  );
  const checkboxSection = sourceSection(
    "const toggleGroup = useCallback",
    "const checkBackendStatus = useCallback",
  );

  assert.match(selectionSection, /setSelectedId\(orderId\)/);
  assert.match(selectionSection, /workflowStatus: "prep"/);
  assert.match(selectionSection, /workflowStatus: "waiting"/);
  assert.match(readySection, /workflowStatus: "ready"/);
  assert.match(readySection, /await syncOrderReliably\(updated\)/);
  assert.match(checkboxSection, /if \(total > 0 && done === total\) next\.workflowStatus = "ready"/);
  assert.match(checkboxSection, /else if \(done > 0\) next\.workflowStatus = "prep"/);
  assert.match(checkboxSection, /else next\.workflowStatus = "waiting"/);
  assert.match(appSource, /checked=\{allDone\}/);
  assert.match(appSource, /onChange=\{\(e\) => toggleGroup\(g\.key, e\.target\.checked\)\}/);
  assert.match(appSource, /onClick=\{\(\) => selectOrder\(o\.id\)\}/);
});

test("[FE][P1] avanzamento automatico sceglie la comanda operativa piu recente", () => {
  const autoSelectionSection = sourceSection(
    "if (!stationActive) return;",
    "const queuePauseNotification = useCallback",
  );

  assert.match(autoSelectionSection, /if \(wf\(order\.workflowStatus\) !== "prep"\) return false/);
  assert.match(autoSelectionSection, /return wf\(order\.workflowStatus\) === "waiting"/);
  assert.match(
    autoSelectionSection,
    /sort\(\s*\(left, right\) => \(right\.receivedAtMs \|\| 0\) - \(left\.receivedAtMs \|\| 0\),\s*\)\[0\]/,
  );
  assert.match(autoSelectionSection, /workflowStatus: "prep"/);
  assert.match(autoSelectionSection, /void syncOrder\(updated\)/);
});

test("[FE][P1] tavoli, timer e storico usano il dominio React", () => {
  assert.equal(tableLabelForOrder({ tableLabel: "Tavolo 12/A", tableNumber: 12 }), "12/A");
  assert.equal(tableLabelForOrder({ logicalTableLabel: "7/B", tableNumber: 7 }), "7/B");
  assert.equal(formatDurationHHMMSS(3_661_999), "01:01:01");

  const orders = [
    { id: "history-new", workflowStatus: "delivered", receivedAtMs: 400 },
    { id: "active-old", workflowStatus: "waiting", receivedAtMs: 100 },
    { id: "active-new", workflowStatus: "prep", receivedAtMs: 300 },
    { id: "history-old", paymentStatus: "paid", receivedAtMs: 200 },
  ];
  assert.deepEqual(
    sortOrdersOperationalFirst(orders).map((order) => order.id),
    ["active-new", "active-old", "history-new", "history-old"],
  );
  assert.match(appSource, /const fmtMMSS = \(ms\) => \{[\s\S]*?formatDurationHHMMSS\(ms\)/);
  assert.match(appSource, /showHistory\s*\?\s*sortOrdersOperationalFirst\(filtered\)/);
  assert.match(appSource, /selectedHistorical \? " history-readonly-mode" : ""/);
});

test("[FE][P1] logout invalida subito sessione, richieste e notifiche", async () => {
  const calls = [];
  let releaseRemote;
  const remotePending = new Promise((resolve) => {
    releaseRemote = resolve;
  });
  const pending = performPostazioneLogout({
    authSnapshot: { token: "token-1", userId: "user-1", deviceUuid: "device-1" },
    station: "BAR-1",
    reason: "",
    sessionInvalid: false,
    completeLocalLogout: () => calls.push("local"),
    requestBackendLogout: async () => {
      calls.push("remote");
      await remotePending;
      return { ok: true };
    },
    requestStationOffline: async () => calls.push("offline"),
  });

  assert.deepEqual(calls, ["local", "remote"]);
  assert.equal(
    isCurrentPostazioneSession(4, 5, {
      loggedIn: false,
      token: "",
      userId: "",
      deviceUuid: "device-1",
    }),
    false,
  );
  releaseRemote();
  await pending;

  const logoutSection = sourceSection(
    "const completeLocalLogout = useCallback",
    "const requestBackendLogout = useCallback",
  );
  assert.match(logoutSection, /notificationSessionGenerationRef\.current \+= 1/);
  assert.match(logoutSection, /activeApiControllersRef\.current\.forEach\(\(controller\) => controller\.abort\(\)\)/);
  assert.match(logoutSection, /clearNativeNotificationSession\(\)/);
  assert.match(logoutSection, /setOrders\(\[\]\)/);
  assert.match(logoutSection, /setWaiters\(\[\]\)/);
  assert.match(logoutSection, /setToast\(\{ show: false, text: "" \}\)/);
});

test("[FE][P1] camerieri, supporto, stampa e settings sono gestiti da React", () => {
  const waiterSection = sourceSection(
    "const syncWaiters = useCallback",
    "const syncStationStates = useCallback",
  );
  const settingsSection = sourceSection(
    "const applySettingsVersion = async",
    "useEffect(() => {\n    if (!auth.loggedIn || typeof window.EventSource",
  );
  const printSection = sourceSection(
    "const printSelected = useCallback",
    "if (!auth.loggedIn)",
  );

  assert.match(waiterSection, /activeMs=\$\{WAITER_ACTIVE_MS\}/);
  assert.match(waiterSection, /entry\.clientApp === "mobile-frontend"/);
  assert.match(waiterSection, /entry\.online && entry\.activeNow/);
  assert.match(appSource, /eventType: "station_support_request"/);
  assert.match(appSource, /const \[waiterCallStates, setWaiterCallStates\] = useState\(\{\}\)/);
  assert.match(appSource, /HA RISPOSTO - STA ARRIVANDO/);
  assert.match(settingsSection, /writeJson\(LS\.settingsVersion, version\)/);
  assert.match(settingsSection, /await runSync\(\)/);
  assert.match(settingsSection, /window\.setInterval\(pollSettingsVersion, 3000\)/);
  assert.match(printSection, /apiFetchJson\("\/api\/integration\/print"/);
  assert.match(printSection, /isCurrentPostazioneSession/);
});
