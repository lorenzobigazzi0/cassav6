#!/usr/bin/env node
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyBackendRouteForProcess } from "../backend/core/process-topology.js";
import { buildRouteRegistry } from "../backend/routes/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(cassaRoot, "..");

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function routeKey(route) {
  return `${String(route?.method ?? "").toUpperCase()} ${String(route?.path ?? "")}`;
}

function routePathFromKey(key) {
  const text = String(key ?? "").trim();
  const separatorIndex = text.indexOf(" ");
  return separatorIndex >= 0 ? text.slice(separatorIndex + 1).trim() : text;
}

function splitRouteAllowlist(value) {
  return String(value ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function fileEntry(relativePath, label) {
  const absolutePath = path.join(projectRoot, relativePath);
  return {
    label,
    path: relativePath,
    ok: existsSync(absolutePath),
  };
}

const ORDER_ROUTE_AUDIT = {
  "POST /api/integration/orders/create": {
    domain: "create",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: ["BACKEND_ORDERS_CREATE_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-create-write-primary.e2e.test.mjs", "create write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-async-ack.e2e.test.mjs", "create async ACK"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-crash-reconcile.e2e.test.mjs", "crash reconcile"),
      fileEntry("cassa-frontend/backend/tests/order-create-assignment-plan.test.mjs", "create station assignment plan"),
      fileEntry("cassa-frontend/backend/tests/order-table-financial-plan.test.mjs", "create table financial plan"),
      fileEntry("cassa-frontend/backend/tests/order-financial-sync-source.test.mjs", "create financial sync source"),
      fileEntry("cassa-frontend/backend/tests/order-financial-table-write-guard.test.mjs", "create financial table write guard"),
      fileEntry("cassa-frontend/backend/tests/realtime-event-outbox.e2e.test.mjs", "create order.created outbox"),
    ],
    externalized: [
      "ordine relazionale write-primary",
      "mirror app-state async con riconciliazione",
      "piano assegnazione postazione calcolabile fuori dal server owner",
      "piano table-state finanziario calcolabile su snapshot tavolo/live stats",
      "financial sync di orders/create puo usare snapshot ordini relazionale dopo write-primary",
      "financial sync di orders/create scrive table_state relazionale con guard anti-stale su revision",
      "order_created passa da event_outbox obbligatorio quando create write-primary gira con EVENT_OUTBOX_ENABLED",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/sync": {
    domain: "sync",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: ["BACKEND_ORDERS_SYNC_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-sync-write-primary.e2e.test.mjs", "sync write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-async-ack.e2e.test.mjs", "sync async ACK"),
      fileEntry("cassa-frontend/backend/tests/orders-flow.e2e.test.mjs", "sync workflow/idempotenza"),
      fileEntry("cassa-frontend/backend/tests/order-preparation-queue.test.mjs", "coda preparazione snapshot adapter"),
    ],
    externalized: [
      "ordine relazionale write-primary",
      "mirror app-state async con riconciliazione",
      "duplicate terminali ready/delivered letti dal relazionale prima della order lane",
      "eventi SSE order_ready/order_state_changed instradati da event_outbox obbligatorio",
      "stato operativo tavolo coperto da tableStates externalized con fuse runtime",
      "record notifica bell/order_ready coperto da integration.notifications split con fuse runtime",
      "conteggio e promozione coda preparazione possono lavorare su snapshot ordini esterno",
      "retrocessione prep vuote per cambio selezione produce piano puro su snapshot ordini esterno",
      "ingresso in preparazione usa piano unico snapshot-ready per demotion e limite coda",
      "riconciliazione e promozione automatica coda usano piano applicativo snapshot-ready",
      "orders/sync usa sorgente snapshot esplicita per preparare il cambio a read model condiviso",
      "lookup e applicazione ordine corrente di orders/sync passano da target/apply plan snapshot-ready",
      "orders/sync puo usare snapshot workflow relazionale quando il write-primary sync e' attivo",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/cancel": {
    domain: "cancel",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: ["BACKEND_ORDERS_CANCEL_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-cancel-write-primary.e2e.test.mjs", "cancel write-primary"),
    ],
    externalized: [
      "ordine relazionale write-primary",
      "lookup iniziale puo reidratare dal relazionale quando il mirror app-state non contiene la comanda",
      "order_cancelled passa da event_outbox obbligatorio quando cancel write-primary gira con EVENT_OUTBOX_ENABLED",
      "financial sync di orders/cancel puo usare snapshot ordini relazionale dopo write-primary",
      "financial sync di orders/cancel scrive table_state relazionale con guard anti-stale su revision",
      "mirror app-state async con riconciliazione",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/correct": {
    domain: "correct",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: ["BACKEND_ORDERS_CORRECT_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-correct-write-primary.e2e.test.mjs", "correct write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-async-ack.e2e.test.mjs", "correct async ACK"),
      fileEntry("cassa-frontend/backend/tests/order-correction-read-model.test.mjs", "correct read-model adapter"),
      fileEntry("cassa-frontend/backend/tests/scoped-orders-read.test.mjs", "correct scoped read-model lookup"),
    ],
    externalized: [
      "ordine relazionale write-primary",
      "orders/correct financial sync da snapshot ordini relazionale",
      "orders/correct table_state relazionale con guard revisione",
      "order_correction_applied passa da event_outbox obbligatorio quando correct write-primary gira con EVENT_OUTBOX_ENABLED",
      "visualizzazione righe corrette/barrate ricostruibile da read-model relazionale senza dbCache owner",
      "mirror app-state async con orderCorrections",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/comp": {
    domain: "comp",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: ["BACKEND_ORDERS_COMP_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-comp-write-primary.e2e.test.mjs", "comp write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-async-ack.e2e.test.mjs", "comp async ACK"),
    ],
    externalized: [
      "ordine relazionale write-primary",
      "orders/comp financial sync da snapshot ordini relazionale",
      "orders/comp table_state relazionale con guard revisione",
      "mirror app-state async per orderComps",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/line/split": {
    domain: "line-split",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-line-split-write-primary.e2e.test.mjs", "line split write-primary"),
      fileEntry("cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs", "line split cross-process canary"),
    ],
    externalized: [
      "ordine relazionale write-primary con CAS su revisione",
      "read-model relazionale letto prima di app-state e preferito quando il mirror locale non e aggiornato",
      "table-state finanziario dichiarato neutro e verificato immutato nello split",
      "test e2e line-split con conflitto revisione e mirror app-state non scritto su 409",
      "canary e2e cross-process su api-worker per line/split",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/line/price-override": {
    domain: "price-override",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-price-override-write-primary.e2e.test.mjs", "price override write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-price-override-audit-financial.e2e.test.mjs", "price override audit relazionale idempotente e financial-sync da snapshot"),
    ],
    externalized: [
      "ordine relazionale write-primary con CAS su revisione",
      "override prezzo riga persistito nel primary prima del mirror app-state e financial-sync",
      "test e2e price-override con conflitto revisione e mirror app-state non scritto su 409",
      "audit override persistito come order_event relazionale deterministico nella stessa transazione CAS; audit app-state conservato per i report",
      "financial sync calcolato da snapshot ordini relazionale post-write-primary e table_state persistito con guard anti-stale su revision",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/correct/resolve": {
    domain: "correct-resolve",
    disabledForOrderWorker: true,
    disabledReason: "route legacy hard-disabled: il handler risponde 410 ORDER_CORRECTION_APPROVAL_DISABLED prima di leggere il body",
    writePrimaryFlags: [],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/route-policy-architecture.test.mjs", "correct/resolve hard-disabled"),
    ],
    externalized: [
      "flusso approvazione correzioni legacy disabilitato con 410 prima di qualunque mutazione",
      "route esclusa dal backlog order-worker finche non viene riattivata esplicitamente",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/storno": {
    domain: "storno",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-storno-write-primary.e2e.test.mjs", "storno write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-storno-payment-effects.e2e.test.mjs", "storno payment effects idempotenti"),
      fileEntry("cassa-frontend/backend/tests/route-policy-architecture.test.mjs", "storno financial sync relazionale"),
      fileEntry("cassa-frontend/backend/tests/route-policy-architecture.test.mjs", "storno fiscal-payment intent condivisi"),
    ],
    externalized: [
      "ordine relazionale write-primary con CAS dedicato alla route storno",
      "storno persistito nel primary prima del mirror app-state",
      "test e2e storno con conflitto revisione e mirror app-state non scritto su 409",
      "orders/storno financial sync da snapshot ordini relazionale",
      "orders/storno table_state relazionale con guard revisione",
      "effetti pagamento storno idempotenti coperti da test cash/POS/stale",
      "orders/storno fiscal-payment intent persistiti su domini payments/fiscal/printSpool prima del mirror app-state",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/orders/replacement/bar-charge": {
    domain: "bar-charge-legacy",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: ["BACKEND_ORDERS_BAR_REPLACEMENT_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-bar-replacement-write-primary.e2e.test.mjs", "bar replacement write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-async-ack.e2e.test.mjs", "bar replacement async ACK"),
    ],
    externalized: [
      "alias legacy usa lo stesso handler write-primary della route integration",
      "ordine relazionale write-primary con CAS su revisione",
      "financial sync di bar-charge puo usare snapshot ordini relazionale",
      "bar-charge scrive table_state relazionale con guard anti-stale su revision",
      "mirror app-state async con barChargeReplacements",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/replacement/bar-charge": {
    domain: "bar-charge",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: ["BACKEND_ORDERS_BAR_REPLACEMENT_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-bar-replacement-write-primary.e2e.test.mjs", "bar replacement write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-async-ack.e2e.test.mjs", "bar replacement async ACK"),
    ],
    externalized: [
      "ordine relazionale write-primary con CAS su revisione",
      "financial sync di bar-charge puo usare snapshot ordini relazionale",
      "bar-charge scrive table_state relazionale con guard anti-stale su revision",
      "mirror app-state async con barChargeReplacements",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/transfer/request": {
    domain: "transfer-request",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-transfer-request-write-primary.e2e.test.mjs", "transfer request write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-transfer-request-handoff.e2e.test.mjs", "transfer request handoff cross-process e CAS concorrente"),
    ],
    externalized: [
      "ordine relazionale write-primary con CAS su revisione",
      "richiesta trasferimento persistita nel primary prima del mirror app-state e notifica",
      "notifica transfer_request pubblicata via event_outbox quando transfer/request write-primary gira con EVENT_OUTBOX_ENABLED",
      "test e2e transfer/request con conflitto revisione e mirror app-state non scritto su 409",
      "handoff pendingAuthRequest persistito nel raw_json relazionale e serializzato dal CAS, senza dipendenze da lock o stato owner",
      "concorrenza cross-process provata: due request parallele producono un 200 e un 409 senza doppia pending",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/transfer/resolve": {
    domain: "transfer-resolve",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-transfer-resolve-write-primary.e2e.test.mjs", "transfer resolve write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-transfer-resolve-audit-events.e2e.test.mjs", "transfer resolve audit relazionale idempotente"),
    ],
    externalized: [
      "ordine relazionale write-primary con CAS su revisione",
      "risoluzione trasferimento persistita nel primary prima del mirror app-state e notifica",
      "notifiche transfer_approved/transfer_denied pubblicate via event_outbox quando transfer/resolve write-primary gira con EVENT_OUTBOX_ENABLED",
      "test e2e transfer/resolve con conflitto revisione e mirror app-state non scritto su 409",
      "audit approvazione/negazione persistito come order_event relazionale deterministico nella stessa transazione CAS",
      "permessi approve_room_change deterministici cross-process su sessioni/utenti esternalizzati",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/integration/orders/transfer/force": {
    domain: "transfer-force",
    writePrimaryFlags: ["BACKEND_RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/relational-orders-transfer-force-write-primary.e2e.test.mjs", "transfer force write-primary"),
      fileEntry("cassa-frontend/backend/tests/relational-orders-transfer-force-audit-outbox.e2e.test.mjs", "transfer force audit relazionale e outbox"),
    ],
    externalized: [
      "ordine relazionale write-primary con CAS su revisione",
      "forzatura trasferimento persistita nel primary prima del mirror app-state",
      "test e2e transfer/force con conflitto revisione e mirror app-state non scritto su 409",
      "audit forzatura trasferimento persistito come order_event relazionale deterministico nella stessa transazione CAS",
      "notifica transfer_forced pubblicata via event_outbox quando transfer/force write-primary gira con EVENT_OUTBOX_ENABLED",
      "handler transfer/force verificato senza dipendenze da lock/station owner-bound",
      "permesso approve_room_change deterministico cross-process su sessioni/utenti esternalizzati",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/tables/lock/acquire": {
    domain: "table-lock-acquire",
    writePrimaryFlags: ["BACKEND_MYSQL_TABLE_LOCKS", "BACKEND_RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/concurrency-cas-regression.e2e.test.mjs", "lock tavolo CAS concorrente"),
      fileEntry("cassa-frontend/backend/tests/process-topology.test.mjs", "routing worker lock ristretto"),
    ],
    externalized: [
      "lock tavolo persistito in MySQL condiviso con named lock e SELECT FOR UPDATE",
      "sessioni autenticate lette dallo store MySQL condiviso",
      "routing dedicato verificato con contesa cross-processo",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/tables/lock/heartbeat": {
    domain: "table-lock-heartbeat",
    writePrimaryFlags: ["BACKEND_MYSQL_TABLE_LOCKS", "BACKEND_RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/tables-locks.e2e.test.mjs", "heartbeat e owner lock"),
      fileEntry("cassa-frontend/backend/tests/process-topology.test.mjs", "routing worker lock ristretto"),
    ],
    externalized: [
      "heartbeat aggiorna atomicamente il record lock condiviso",
      "owner verificato tramite user, sessione e device esternalizzati",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/tables/lock/release": {
    domain: "table-lock-release",
    writePrimaryFlags: ["BACKEND_MYSQL_TABLE_LOCKS", "BACKEND_RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/tables-locks.e2e.test.mjs", "release vincolato allo stesso owner"),
      fileEntry("cassa-frontend/backend/tests/process-topology.test.mjs", "routing worker lock ristretto"),
    ],
    externalized: [
      "release elimina atomicamente il record lock condiviso",
      "owner verificato tramite user, sessione e device esternalizzati",
    ],
    blockers: [],
    blockerDimensions: [],
  },
  "POST /api/tables/lock/force-release": {
    domain: "table-lock-force-release",
    writePrimaryFlags: ["BACKEND_MYSQL_TABLE_LOCKS", "BACKEND_RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY"],
    asyncAckFlags: [],
    tests: [
      fileEntry("cassa-frontend/backend/tests/tables-locks.e2e.test.mjs", "force release vincolato ai permessi"),
      fileEntry("cassa-frontend/backend/tests/process-topology.test.mjs", "routing worker lock ristretto"),
    ],
    externalized: [
      "force release elimina atomicamente il record lock condiviso",
      "permesso approve_room_change verificato su utente e sessione condivisi",
    ],
    blockers: [],
    blockerDimensions: [],
  },
};

function summarizeBlockerDimensions(entries) {
  const byDimension = new Map();
  for (const entry of entries) {
    for (const dimension of entry.blockerDimensions ?? []) {
      const current = byDimension.get(dimension) ?? { dimension, count: 0, routes: [] };
      current.count += 1;
      current.routes.push(entry.key);
      byDimension.set(dimension, current);
    }
  }
  return [...byDimension.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return left.dimension.localeCompare(right.dimension);
  });
}

const BLOCKER_DIMENSION_WEIGHTS = {
  "app-state-mirror": 4,
  "audit-permissions": 4,
  "concurrency-tests": 6,
  dbcache: 6,
  "financial-sync": 8,
  "fiscal-payments": 10,
  idempotency: 6,
  "locks-handoff": 4,
  "notification-record": 5,
  notifications: 5,
  "read-model": 3,
  "station-assignment": 6,
  "table-state": 5,
  "write-primary": 10,
};

function nextActionForOrderCandidate(entry) {
  const dimensions = new Set(entry.blockerDimensions ?? []);
  if (entry.disabledForOrderWorker) return "nessuna azione: route disabilitata/ritirata dal backlog order-worker";
  if (entry.readyForOrderWorker) return "abilitare in allowlist singola e misurare canary";
  const hasWritePrimary = entry.writePrimaryCovered === true || (entry.writePrimaryFlags ?? []).length > 0;
  if (!hasWritePrimary) return "aggiungere write-primary relazionale dedicato e test e2e";
  if (dimensions.has("financial-sync") && dimensions.has("table-state")) {
    return "isolare financial-sync e stato tavolo dal dbCache owner";
  }
  if (dimensions.has("financial-sync")) return "isolare financial-sync dal processo owner";
  if (dimensions.has("fiscal-payments")) return "modellare pagamenti/fiscale storno su intent persistenti condivisi";
  if (dimensions.has("table-state")) return "isolare stato tavolo dal dbCache owner";
  if (dimensions.has("notification-record")) return "spostare record notifica su store condiviso";
  if (dimensions.has("notifications")) return "spostare notifiche ordine su outbox/read model condiviso";
  if (dimensions.has("read-model")) return "portare il read model correzioni fuori dal dbCache owner";
  if (dimensions.has("dbcache")) return "ridurre dipendenza da dbCache locale nel workflow ordine";
  if (dimensions.has("app-state-mirror")) return "portare mirror app-state fuori dal percorso risposta";
  if (dimensions.has("audit-permissions")) return "rendere audit e permessi idempotenti cross-process";
  if (dimensions.has("concurrency-tests")) return "aggiungere canary e2e di concorrenza cross-process";
  return "chiudere i blocchi residui e ripetere canary con allowlist singola";
}

function scoreOrderWorkerCandidate(entry) {
  const rationale = [];
  if (entry.disabledForOrderWorker) {
    return { score: -999, rationale: [entry.disabledReason || "route disabilitata"] };
  }
  let score = 0;
  if (entry.readyForOrderWorker) {
    score += 100;
    rationale.push("route gia pronta per allowlist");
  }
  if (entry.writePrimaryFlags.length) {
    score += 45;
    rationale.push("write-primary presente");
  } else {
    score -= 35;
    rationale.push("write-primary mancante");
  }
  if (entry.asyncAckFlags.length) {
    score += 15;
    rationale.push("ACK/mirror async presente");
  }
  if (entry.tests.length > 0 && entry.missingTests.length === 0) {
    score += Math.min(15, entry.tests.length * 5);
    rationale.push(`test presenti: ${entry.tests.length}`);
  } else if (entry.tests.length === 0) {
    score -= 10;
    rationale.push("test e2e mancanti");
  } else {
    score -= entry.missingTests.length * 5;
    rationale.push(`test mancanti: ${entry.missingTests.length}`);
  }
  for (const dimension of entry.blockerDimensions ?? []) {
    score -= 4;
    score -= BLOCKER_DIMENSION_WEIGHTS[dimension] ?? 4;
  }
  if (entry.blockerDimensions.length) {
    rationale.push(`blocchi: ${entry.blockerDimensions.join(", ")}`);
  }
  return { score, rationale };
}

function buildOrderWorkerCandidateRanking(entries) {
  return entries
    .map((entry) => {
      const { score, rationale } = scoreOrderWorkerCandidate(entry);
      return {
        key: entry.key,
        domain: entry.domain,
        score,
        readyForOrderWorker: entry.readyForOrderWorker,
        writePrimaryCovered: entry.writePrimaryFlags.length > 0,
        asyncMirrorCovered: entry.asyncAckFlags.length > 0,
        blockerCount: entry.blockerDimensions.length,
        blockerDimensions: entry.blockerDimensions,
        nextAction: nextActionForOrderCandidate(entry),
        rationale,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.blockerCount !== right.blockerCount) return left.blockerCount - right.blockerCount;
      return left.key.localeCompare(right.key);
    })
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}

function buildRecommendedOrderWorkerBatches(candidateRanking) {
  const activeRanking = candidateRanking.filter((entry) => !entry.disabledForOrderWorker);
  const writePrimaryCovered = activeRanking.filter((entry) => entry.writePrimaryCovered);
  const missingWritePrimary = activeRanking.filter((entry) => !entry.writePrimaryCovered);
  const highRiskDimensions = new Set(["audit-permissions", "fiscal-payments", "locks-handoff", "notifications"]);
  const lowRiskWritePrimaryGaps = missingWritePrimary.filter(
    (entry) => !entry.blockerDimensions.some((dimension) => highRiskDimensions.has(dimension)),
  );
  const highRiskGaps = missingWritePrimary.filter(
    (entry) => !lowRiskWritePrimaryGaps.some((candidate) => candidate.key === entry.key),
  );
  return [
    {
      id: "batch-1-primary-covered-side-effects",
      title: "Route con write-primary gia presente",
      goal: "estrarre i side effect owner-bound e poi usare allowlist singola per canary",
      routeKeys: writePrimaryCovered.map((entry) => entry.key),
    },
    {
      id: "batch-2-add-write-primary-low-risk",
      title: "Route senza write-primary e senza blocchi fiscal/approval/lock",
      goal: "aggiungere write-primary dedicato, test concorrenza e mirror sicuro",
      routeKeys: lowRiskWritePrimaryGaps.map((entry) => entry.key),
    },
    {
      id: "batch-3-admin-fiscal-transfer",
      title: "Route admin, fiscale, transfer e notifiche sensibili",
      goal: "affrontare dopo outbox/read model condiviso e audit cross-process",
      routeKeys: highRiskGaps.map((entry) => entry.key),
    },
  ];
}

export function buildOrderWorkerAllowlistAudit(
  entries = [],
  { allowlist = process.env.BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST ?? "", wildcardAllowed = false } = {},
) {
  const values = splitRouteAllowlist(allowlist);
  const wildcardRequested = values.includes("*");
  const selectedEntries =
    wildcardRequested && wildcardAllowed
      ? entries
      : entries.filter((entry) => {
          const pathValue = routePathFromKey(entry.key);
          return values.includes(entry.key) || values.includes(pathValue);
        });
  const selectedKeys = new Set(selectedEntries.map((entry) => entry.key));
  const missingAllowlistValues = values.filter((value) => {
    if (value === "*") return false;
    return !entries.some((entry) => entry.key === value || routePathFromKey(entry.key) === value);
  });
  const blockedRoutes = selectedEntries
    .filter((entry) => !entry.readyForOrderWorker || entry.disabledForOrderWorker)
    .map((entry) => ({
      key: entry.key,
      domain: entry.domain,
      blockerDimensions: entry.blockerDimensions,
      blockers: entry.blockers,
      disabledForOrderWorker: entry.disabledForOrderWorker,
      disabledReason: entry.disabledReason,
      nextAction: nextActionForOrderCandidate(entry),
    }));
  const readyRouteKeys = selectedEntries
    .filter((entry) => entry.readyForOrderWorker && !entry.disabledForOrderWorker)
    .map((entry) => entry.key);
  const requested = values.length > 0;
  const goNoGo =
    requested &&
    (!wildcardRequested || wildcardAllowed) &&
    selectedKeys.size > 0 &&
    missingAllowlistValues.length === 0 &&
    blockedRoutes.length === 0
      ? "go"
      : requested
        ? "no-go"
        : "not-requested";
  return {
    requested,
    values,
    wildcardRequested,
    wildcardAllowed: wildcardRequested ? Boolean(wildcardAllowed) : false,
    goNoGo,
    selectedRouteKeys: [...selectedKeys],
    readyRouteKeys,
    blockedRoutes,
    missingAllowlistValues,
  };
}

function buildOrderRouteAudit(route) {
  const key = routeKey(route);
  const metadata = ORDER_ROUTE_AUDIT[key] ?? {
    domain: "unknown",
    writePrimaryFlags: [],
    asyncAckFlags: [],
    tests: [],
    externalized: [],
    blockers: ["route order-workflow senza metadata MP-3"],
    blockerDimensions: ["metadata"],
  };
  const missingTests = metadata.tests.filter((entry) => !entry.ok);
  const hasWritePrimary = metadata.writePrimaryFlags.length > 0;
  const hasAsyncMirror = metadata.asyncAckFlags.length > 0;
  const readyForOrderWorker =
    metadata.disabledForOrderWorker !== true &&
    hasWritePrimary &&
    metadata.blockers.length === 0 &&
    missingTests.length === 0 &&
    (metadata.domain !== "create" || hasAsyncMirror) &&
    (metadata.domain !== "sync" || hasAsyncMirror);
  return {
    key,
    handlerKey: route.handlerKey,
    domain: metadata.domain,
    writePrimaryFlags: metadata.writePrimaryFlags,
    asyncAckFlags: metadata.asyncAckFlags,
    tests: metadata.tests,
    missingTests,
    externalized: metadata.externalized,
    blockers: metadata.blockers,
    blockerDimensions: metadata.blockerDimensions ?? [],
    disabledForOrderWorker: metadata.disabledForOrderWorker === true,
    disabledReason: metadata.disabledReason ?? "",
    readyForOrderWorker,
  };
}

export function buildOrderWorkflowExternalizationAudit({
  routes = buildRouteRegistry(),
  now = new Date(),
  orderWorkerRouteAllowlist = process.env.BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST ?? "",
  orderWorkerAllowWildcard = process.env.BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD === "1",
} = {}) {
  const orderRoutes = routes.filter((route) => classifyBackendRouteForProcess(route).scope === "order-workflow");
  const entries = orderRoutes.map(buildOrderRouteAudit).sort((left, right) => left.key.localeCompare(right.key));
  const missingMetadata = entries.filter((entry) => entry.domain === "unknown");
  const disabled = entries.filter((entry) => entry.disabledForOrderWorker);
  const activeEntries = entries.filter((entry) => !entry.disabledForOrderWorker);
  const ready = activeEntries.filter((entry) => entry.readyForOrderWorker);
  const blocked = activeEntries.filter((entry) => !entry.readyForOrderWorker);
  const writePrimaryCovered = activeEntries.filter((entry) => entry.writePrimaryFlags.length > 0);
  const blockerDimensionSummary = summarizeBlockerDimensions(activeEntries);
  const orderWorkerCandidateRanking = buildOrderWorkerCandidateRanking(activeEntries);
  const recommendedOrderWorkerBatches = buildRecommendedOrderWorkerBatches(orderWorkerCandidateRanking);
  const orderWorkerAllowlistAudit = buildOrderWorkerAllowlistAudit(entries, {
    allowlist: orderWorkerRouteAllowlist,
    wildcardAllowed: orderWorkerAllowWildcard,
  });
  return {
    ok: missingMetadata.length === 0,
    generatedAt: now.toISOString(),
    totalOrderWorkflowRoutes: entries.length,
    activeOrderWorkflowRoutes: activeEntries.length,
    disabledForOrderWorker: disabled.length,
    disabledRouteKeys: disabled.map((entry) => entry.key),
    readyForOrderWorker: ready.length,
    blockedForOrderWorker: blocked.length,
    writePrimaryCovered: writePrimaryCovered.length,
    blockerDimensionSummary,
    nextExternalizationFocus: blockerDimensionSummary.slice(0, 5),
    topOrderWorkerCandidates: orderWorkerCandidateRanking.slice(0, 5),
    orderWorkerCandidateRanking,
    recommendedOrderWorkerBatches,
    orderWorkerAllowlistAudit,
    missingMetadata: missingMetadata.map((entry) => entry.key),
    orderWorkersGoNoGo: ready.length === activeEntries.length ? "go" : "no-go",
    entries,
  };
}

function renderMarkdown(audit) {
  const candidateRows = audit.orderWorkerCandidateRanking
    .map((entry) => {
      const dimensions = entry.blockerDimensions.length ? entry.blockerDimensions.join("<br>") : "nessuna";
      return `| ${entry.rank} | ${entry.score} | \`${entry.key}\` | ${entry.domain} | ${dimensions} | ${entry.nextAction} |`;
    })
    .join("\n");
  const batchRows = audit.recommendedOrderWorkerBatches
    .map((batch) => {
      const routeKeys = batch.routeKeys.length ? batch.routeKeys.map((route) => `\`${route}\``).join("<br>") : "nessuna";
      return `| ${batch.id} | ${batch.title} | ${batch.goal} | ${routeKeys} |`;
    })
    .join("\n");
  const allowlist = audit.orderWorkerAllowlistAudit;
  const allowlistBlockedRows = allowlist.blockedRoutes.length
    ? allowlist.blockedRoutes
        .map(
          (entry) =>
            `| \`${entry.key}\` | ${entry.domain} | ${entry.blockerDimensions.join("<br>") || "nessuna"} | ${entry.nextAction} |`,
        )
        .join("\n")
    : "| nessuna | - | - | - |";
  const rows = audit.entries
    .map((entry) => {
      const tests = entry.tests.length
        ? entry.tests.map((test) => `${test.ok ? "OK" : "MISSING"} ${test.path}`).join("<br>")
        : "MISSING";
      const blockers = entry.disabledForOrderWorker ? entry.disabledReason || "route disabilitata" : entry.blockers.length ? entry.blockers.join("<br>") : "nessuno";
      const flags = entry.writePrimaryFlags.length ? entry.writePrimaryFlags.join("<br>") : "MISSING";
      const dimensions = entry.blockerDimensions.length ? entry.blockerDimensions.join("<br>") : "nessuna";
      const status = entry.disabledForOrderWorker ? "DISABLED" : entry.readyForOrderWorker ? "GO" : "NO-GO";
      return `| ${status} | \`${entry.key}\` | ${entry.domain} | ${dimensions} | ${flags} | ${tests} | ${blockers} |`;
    })
    .join("\n");
  return `# MP-3 order workflow externalization audit

Generato: ${audit.generatedAt}

Esito metadata: ${audit.ok ? "OK" : "FAIL"}

Go/no-go order workers: ${audit.orderWorkersGoNoGo.toUpperCase()}

## Sintesi

- route order-workflow: ${audit.totalOrderWorkflowRoutes}
- route attive per order-worker: ${audit.activeOrderWorkflowRoutes}
- route disabilitate/ritirate: ${audit.disabledForOrderWorker}
- pronte per order worker: ${audit.readyForOrderWorker}
- bloccate: ${audit.blockedForOrderWorker}
- coperte da write-primary relazionale: ${audit.writePrimaryCovered}
- metadata mancanti: ${audit.missingMetadata.length}

## Dimensioni bloccanti

${audit.blockerDimensionSummary.map((entry) => `- ${entry.dimension}: ${entry.count} route`).join("\n")}

## Ranking candidati order worker

| Rank | Score | Route | Dominio | Dimensioni | Prossima azione |
|---:|---:|---|---|---|---|
${candidateRows}

## Batch consigliati

| Batch | Titolo | Obiettivo | Route |
|---|---|---|---|
${batchRows}

## Audit allowlist order worker

- richiesto: ${allowlist.requested ? "si" : "no"}
- go/no-go allowlist: ${allowlist.goNoGo.toUpperCase()}
- wildcard richiesta: ${allowlist.wildcardRequested ? "si" : "no"}
- wildcard consentita: ${allowlist.wildcardAllowed ? "si" : "no"}
- valori: ${allowlist.values.length ? allowlist.values.map((value) => `\`${value}\``).join(", ") : "nessuno"}
- route selezionate: ${allowlist.selectedRouteKeys.length ? allowlist.selectedRouteKeys.map((value) => `\`${value}\``).join(", ") : "nessuna"}
- valori non trovati: ${allowlist.missingAllowlistValues.length ? allowlist.missingAllowlistValues.map((value) => `\`${value}\``).join(", ") : "nessuno"}

| Route bloccata | Dominio | Dimensioni | Prossima azione |
|---|---|---|---|
${allowlistBlockedRows}

## Route

| Esito | Route | Dominio | Dimensioni | Flag write-primary | Test | Bloccanti |
|---|---|---|---|---|---|---|
${rows}
`;
}

export async function writeOrderWorkflowExternalizationAudit({
  outputDir = "",
  now = new Date(),
  orderWorkerRouteAllowlist = process.env.BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST ?? "",
  orderWorkerAllowWildcard = process.env.BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD === "1",
} = {}) {
  const audit = buildOrderWorkflowExternalizationAudit({
    now,
    orderWorkerRouteAllowlist,
    orderWorkerAllowWildcard,
  });
  const targetDir = outputDir || path.join(cassaRoot, "logs", `order-workflow-externalization-audit-${timestampId(now)}`);
  await fs.mkdir(targetDir, { recursive: true });
  const reportJsonPath = path.join(targetDir, "report.json");
  const reportMdPath = path.join(targetDir, "REPORT.md");
  await fs.writeFile(reportJsonPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await fs.writeFile(reportMdPath, renderMarkdown(audit), "utf8");
  return { ...audit, reportJsonPath, reportMdPath };
}

async function main() {
  const outputArgIndex = process.argv.findIndex((arg) => arg === "--output-dir");
  const outputDir = outputArgIndex >= 0 ? String(process.argv[outputArgIndex + 1] ?? "").trim() : "";
  const allowlistArgIndex = process.argv.findIndex((arg) => arg === "--route-allowlist");
  const orderWorkerRouteAllowlist =
    allowlistArgIndex >= 0
      ? String(process.argv[allowlistArgIndex + 1] ?? "").trim()
      : process.env.BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST ?? "";
  const orderWorkerAllowWildcard =
    process.argv.includes("--allow-wildcard") ||
    process.env.BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD === "1";
  const jsonOnly = process.argv.includes("--json-only");
  const noWrite = process.argv.includes("--no-write") || process.argv.includes("--check-only");
  const result = noWrite
    ? buildOrderWorkflowExternalizationAudit({ orderWorkerRouteAllowlist, orderWorkerAllowWildcard })
    : await writeOrderWorkflowExternalizationAudit({ outputDir, orderWorkerRouteAllowlist, orderWorkerAllowWildcard });
  const payload = {
    ok: result.ok,
    orderWorkersGoNoGo: result.orderWorkersGoNoGo,
    totalOrderWorkflowRoutes: result.totalOrderWorkflowRoutes,
    activeOrderWorkflowRoutes: result.activeOrderWorkflowRoutes,
    disabledForOrderWorker: result.disabledForOrderWorker,
    disabledRouteKeys: result.disabledRouteKeys,
    readyForOrderWorker: result.readyForOrderWorker,
    blockedForOrderWorker: result.blockedForOrderWorker,
    writePrimaryCovered: result.writePrimaryCovered,
    blockerDimensionSummary: result.blockerDimensionSummary,
    nextExternalizationFocus: result.nextExternalizationFocus,
    topOrderWorkerCandidates: result.topOrderWorkerCandidates,
    recommendedOrderWorkerBatches: result.recommendedOrderWorkerBatches,
    orderWorkerAllowlistAudit: result.orderWorkerAllowlistAudit,
    missingMetadata: result.missingMetadata,
    ...(result.reportJsonPath ? { reportJsonPath: result.reportJsonPath } : {}),
    ...(result.reportMdPath ? { reportMdPath: result.reportMdPath } : {}),
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!jsonOnly && result.reportMdPath) console.log(`REPORT=${result.reportMdPath}`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
