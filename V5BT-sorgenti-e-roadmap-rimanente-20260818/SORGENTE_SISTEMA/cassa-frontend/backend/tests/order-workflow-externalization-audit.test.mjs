import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { classifyBackendRouteForProcess } from "../core/process-topology.js";
import { buildRouteRegistry } from "../routes/index.js";
import {
  buildOrderWorkflowExternalizationAudit,
  buildOrderWorkerAllowlistAudit,
} from "../../scripts/order-workflow-externalization-audit.mjs";

test("MP-3 audit copre tutte le route order-workflow registrate", () => {
  const routes = buildRouteRegistry();
  const expected = routes
    .filter((route) => classifyBackendRouteForProcess(route).scope === "order-workflow")
    .map((route) => `${route.method} ${route.path}`)
    .sort();
  const audit = buildOrderWorkflowExternalizationAudit({
    routes,
    now: new Date("2026-07-04T16:50:00.000Z"),
  });

  assert.equal(audit.ok, true);
  assert.deepEqual(
    audit.entries.map((entry) => entry.key).sort(),
    expected,
  );
  assert.equal(audit.totalOrderWorkflowRoutes, expected.length);
  assert.equal(audit.missingMetadata.length, 0);
});

test("MP-3 audit considera pronte tutte le route order-worker attive", () => {
  const audit = buildOrderWorkflowExternalizationAudit({
    routes: buildRouteRegistry(),
    now: new Date("2026-07-04T16:50:00.000Z"),
  });

  assert.equal(audit.orderWorkersGoNoGo, "go");
  assert.equal(audit.totalOrderWorkflowRoutes, 18);
  assert.equal(audit.activeOrderWorkflowRoutes, 17);
  assert.equal(audit.disabledForOrderWorker, 1);
  assert.deepEqual(audit.disabledRouteKeys, ["POST /api/integration/orders/correct/resolve"]);
  assert.equal(audit.readyForOrderWorker, 17);
  assert.equal(audit.writePrimaryCovered, 17);
  assert.equal(audit.blockedForOrderWorker, 0);
  assert.ok(
    ["POST /api/integration/orders/create", "POST /api/integration/orders/sync", "POST /api/integration/orders/cancel", "POST /api/integration/orders/comp", "POST /api/tables/lock/acquire"].every((key) =>
      audit.entries.some((entry) => entry.key === key && entry.readyForOrderWorker === true),
    ),
  );
  assert.ok(
    audit.entries.some(
      (entry) =>
        entry.key === "POST /api/integration/orders/line/split" &&
        entry.writePrimaryFlags.includes("BACKEND_RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY") &&
        entry.externalized.some((item) => /write-primary.*CAS/i.test(item)) &&
        entry.externalized.some((item) => /read-model relazionale/i.test(item)) &&
        entry.externalized.some((item) => /table-state finanziario.*neutro/i.test(item)) &&
        entry.externalized.some((item) => /canary e2e cross-process/i.test(item)) &&
        entry.readyForOrderWorker === true &&
        !entry.blockerDimensions.includes("dbcache") &&
        !entry.blockerDimensions.includes("table-state") &&
        !entry.blockerDimensions.includes("concurrency-tests") &&
        !entry.blockers.some((blocker) => /manca write-primary/i.test(blocker)),
    ),
  );
  assert.ok(
    audit.entries.some(
      (entry) =>
        entry.key === "POST /api/integration/orders/line/price-override" &&
        entry.writePrimaryFlags.includes("BACKEND_RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY") &&
        entry.externalized.some((item) => /write-primary.*CAS/i.test(item)) &&
        entry.externalized.some((item) => /persistito nel primary prima del mirror app-state/i.test(item)) &&
        entry.externalized.some((item) => /order_event relazionale deterministico.*CAS/i.test(item)) &&
        entry.externalized.some((item) => /table_state persistito con guard/i.test(item)) &&
        entry.readyForOrderWorker === true &&
        entry.blockerDimensions.length === 0 &&
        entry.blockers.length === 0,
    ),
  );
  assert.ok(
    audit.entries.some(
      (entry) =>
        entry.key === "POST /api/integration/orders/transfer/force" &&
        entry.writePrimaryFlags.includes("BACKEND_RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY") &&
        entry.externalized.some((item) => /write-primary.*CAS/i.test(item)) &&
        entry.externalized.some((item) => /persistita nel primary prima del mirror app-state/i.test(item)) &&
        entry.externalized.some((item) => /conflitto revisione/i.test(item)) &&
        entry.externalized.some((item) => /order_event relazionale deterministico.*CAS/i.test(item)) &&
        entry.externalized.some((item) => /transfer_forced.*event_outbox/i.test(item)) &&
        entry.externalized.some((item) => /senza dipendenze da lock/i.test(item)) &&
        entry.readyForOrderWorker === true &&
        entry.blockerDimensions.length === 0 &&
        entry.blockers.length === 0 &&
        !entry.blockers.some((blocker) => /manca write-primary/i.test(blocker)),
    ),
  );
  assert.ok(
    audit.entries.some(
      (entry) =>
        entry.key === "POST /api/integration/orders/storno" &&
        entry.writePrimaryFlags.includes("BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY") &&
        entry.externalized.some((item) => /CAS dedicato.*storno/i.test(item)) &&
        entry.externalized.some((item) => /persistito nel primary prima del mirror app-state/i.test(item)) &&
        entry.externalized.some((item) => /conflitto revisione/i.test(item)) &&
        entry.externalized.some((item) => /orders\/storno.*snapshot ordini relazionale/i.test(item)) &&
        entry.externalized.some((item) => /orders\/storno.*table_state relazionale.*guard/i.test(item)) &&
        entry.externalized.some((item) => /fiscal-payment intent.*payments\/fiscal\/printSpool/i.test(item)) &&
        entry.readyForOrderWorker === true &&
        entry.blockerDimensions.length === 0 &&
        !entry.blockerDimensions.includes("financial-sync") &&
        !entry.blockerDimensions.includes("fiscal-payments") &&
        !entry.blockers.some((blocker) => /manca write-primary/i.test(blocker)),
    ),
  );
  const disabledResolve = audit.entries.find((entry) => entry.key === "POST /api/integration/orders/correct/resolve");
  assert.equal(disabledResolve?.disabledForOrderWorker, true);
  assert.match(disabledResolve?.disabledReason ?? "", /ORDER_CORRECTION_APPROVAL_DISABLED/);
  assert.equal(disabledResolve?.readyForOrderWorker, false);
  assert.deepEqual(disabledResolve?.blockerDimensions, []);
});

test("MP-3 audit produce matrice bloccanti per dimensione", () => {
  const audit = buildOrderWorkflowExternalizationAudit({
    routes: buildRouteRegistry(),
    now: new Date("2026-07-04T16:50:00.000Z"),
  });
  const dimensions = new Map(audit.blockerDimensionSummary.map((entry) => [entry.dimension, entry]));

  assert.equal(dimensions.has("fiscal-payments"), false);
  assert.equal(dimensions.has("financial-sync"), false);
  assert.equal(dimensions.has("notifications"), false);
  assert.equal(dimensions.has("audit-permissions"), false);
  assert.equal(dimensions.has("locks-handoff"), false);
  assert.equal(dimensions.has("write-primary"), false);
  assert.equal(dimensions.has("app-state-mirror"), false);
  assert.equal(dimensions.has("notification-record"), false);
  assert.equal(dimensions.has("table-state"), false);
  assert.deepEqual(
    audit.nextExternalizationFocus.map((entry) => entry.dimension).slice(0, 2),
    [],
  );
  assert.ok(
    audit.entries.some(
      (entry) =>
        entry.key === "POST /api/integration/orders/create" &&
        entry.blockerDimensions.length === 0 &&
        !entry.blockerDimensions.includes("table-state") &&
        !entry.blockerDimensions.includes("station-assignment") &&
        entry.externalized.some((item) => /assegnazione postazione/i.test(item)) &&
        entry.externalized.some((item) => /table-state finanziario/i.test(item)) &&
        entry.externalized.some((item) => /snapshot ordini relazionale/i.test(item)),
    ),
  );
});

test("MP-4 audit ordina i candidati order worker e propone batch di rollout", () => {
  const audit = buildOrderWorkflowExternalizationAudit({
    routes: buildRouteRegistry(),
    now: new Date("2026-07-04T16:50:00.000Z"),
  });

  assert.deepEqual(
    audit.topOrderWorkerCandidates.map((entry) => entry.key),
    [
      "POST /api/integration/orders/correct",
      "POST /api/integration/orders/create",
      "POST /api/integration/orders/sync",
      "POST /api/integration/orders/comp",
      "POST /api/integration/orders/replacement/bar-charge",
    ],
  );
  assert.equal(audit.topOrderWorkerCandidates[0].rank, 1);
  assert.equal(audit.topOrderWorkerCandidates[0].writePrimaryCovered, true);
  assert.equal(audit.topOrderWorkerCandidates[0].readyForOrderWorker, true);
  assert.equal(audit.topOrderWorkerCandidates[0].nextAction, "abilitare in allowlist singola e misurare canary");
  assert.ok(
    audit.orderWorkerCandidateRanking.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/line/split" &&
        entry.writePrimaryCovered === true &&
        entry.readyForOrderWorker === true &&
        entry.nextAction === "abilitare in allowlist singola e misurare canary",
    ),
  );
  assert.ok(
    audit.entries.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/transfer/request" &&
        entry.externalized.some((item) => /transfer_request.*event_outbox/i.test(item)),
    ),
  );
  assert.ok(
    audit.entries.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/transfer/resolve" &&
        entry.externalized.some((item) => /transfer_approved\/transfer_denied.*event_outbox/i.test(item)),
    ),
  );
  assert.ok(
    audit.orderWorkerCandidateRanking.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/transfer/request" &&
        entry.writePrimaryCovered === true &&
        entry.readyForOrderWorker === true &&
        entry.blockerCount === 0 &&
        entry.blockerDimensions.length === 0 &&
        entry.nextAction === "abilitare in allowlist singola e misurare canary",
    ),
  );
  assert.ok(
    audit.entries.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/transfer/request" &&
        entry.externalized.some((item) => /pendingAuthRequest.*raw_json relazionale.*CAS/i.test(item)) &&
        entry.externalized.some((item) => /due request parallele.*200.*409/i.test(item)),
    ),
  );
  assert.ok(
    audit.orderWorkerCandidateRanking.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/transfer/resolve" &&
        entry.writePrimaryCovered === true &&
        entry.readyForOrderWorker === true &&
        entry.blockerCount === 0 &&
        entry.blockerDimensions.length === 0 &&
        entry.nextAction === "abilitare in allowlist singola e misurare canary",
    ),
  );
  assert.ok(
    audit.entries.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/transfer/resolve" &&
        entry.externalized.some((item) => /order_event relazionale deterministico.*CAS/i.test(item)) &&
        entry.externalized.some((item) => /approve_room_change.*cross-process/i.test(item)),
    ),
  );
  assert.ok(
    audit.orderWorkerCandidateRanking.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/line/price-override" &&
        entry.writePrimaryCovered === true &&
        entry.readyForOrderWorker === true &&
        entry.blockerCount === 0 &&
        entry.blockerDimensions.length === 0 &&
        entry.nextAction === "abilitare in allowlist singola e misurare canary",
    ),
  );
  assert.ok(
    audit.orderWorkerCandidateRanking.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/transfer/force" &&
        entry.writePrimaryCovered === true &&
        entry.readyForOrderWorker === true &&
        entry.blockerCount === 0 &&
        entry.blockerDimensions.length === 0 &&
        entry.nextAction === "abilitare in allowlist singola e misurare canary",
    ),
  );
  assert.ok(
    audit.orderWorkerCandidateRanking.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/storno" &&
        entry.writePrimaryCovered === true &&
        entry.readyForOrderWorker === true &&
        entry.blockerCount === 0 &&
        entry.blockerDimensions.length === 0 &&
        !entry.blockerDimensions.includes("financial-sync") &&
        !entry.blockerDimensions.includes("fiscal-payments") &&
        entry.nextAction === "abilitare in allowlist singola e misurare canary",
    ),
  );
  assert.equal(
    audit.orderWorkerCandidateRanking.some((entry) => entry.key === "POST /api/integration/orders/correct/resolve"),
    false,
  );

  const batches = new Map(audit.recommendedOrderWorkerBatches.map((batch) => [batch.id, batch]));
  assert.deepEqual(batches.get("batch-1-primary-covered-side-effects")?.routeKeys, [
    "POST /api/integration/orders/correct",
    "POST /api/integration/orders/create",
    "POST /api/integration/orders/sync",
    "POST /api/integration/orders/comp",
    "POST /api/integration/orders/replacement/bar-charge",
    "POST /api/orders/replacement/bar-charge",
    "POST /api/integration/orders/cancel",
    "POST /api/integration/orders/storno",
    "POST /api/integration/orders/line/price-override",
    "POST /api/integration/orders/line/split",
    "POST /api/integration/orders/transfer/force",
    "POST /api/integration/orders/transfer/request",
    "POST /api/integration/orders/transfer/resolve",
    "POST /api/tables/lock/acquire",
    "POST /api/tables/lock/force-release",
    "POST /api/tables/lock/heartbeat",
    "POST /api/tables/lock/release",
  ]);
  assert.deepEqual(batches.get("batch-2-add-write-primary-low-risk")?.routeKeys, []);
  assert.equal(
    batches.get("batch-3-admin-fiscal-transfer")?.routeKeys.includes("POST /api/integration/orders/correct/resolve"),
    false,
  );
  assert.ok(
    audit.orderWorkerCandidateRanking.find(
      (entry) =>
        entry.key === "POST /api/integration/orders/replacement/bar-charge" &&
        entry.writePrimaryCovered === true &&
        entry.readyForOrderWorker === true &&
        entry.nextAction === "abilitare in allowlist singola e misurare canary",
    ),
  );
  assert.deepEqual(batches.get("batch-3-admin-fiscal-transfer")?.routeKeys, []);
  const cancelEntry = audit.entries.find((entry) => entry.key === "POST /api/integration/orders/cancel");
  assert.ok(cancelEntry?.externalized.some((item) => /order_cancelled.*event_outbox/i.test(item)));
  assert.ok(cancelEntry?.externalized.some((item) => /orders\/cancel.*snapshot ordini relazionale/i.test(item)));
  assert.ok(cancelEntry?.externalized.some((item) => /orders\/cancel.*table_state relazionale.*guard/i.test(item)));
  assert.ok(cancelEntry?.externalized.some((item) => /mirror app-state async/i.test(item)));
  assert.deepEqual(cancelEntry?.asyncAckFlags, ["BACKEND_ORDERS_CANCEL_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"]);
  assert.deepEqual(cancelEntry?.blockerDimensions, []);
  const compEntry = audit.entries.find((entry) => entry.key === "POST /api/integration/orders/comp");
  assert.ok(compEntry?.externalized.some((item) => /orders\/comp.*snapshot ordini relazionale/i.test(item)));
  assert.ok(compEntry?.externalized.some((item) => /orders\/comp.*table_state relazionale.*guard/i.test(item)));
  assert.ok(compEntry?.externalized.some((item) => /mirror app-state async.*orderComps/i.test(item)));
  assert.deepEqual(compEntry?.asyncAckFlags, ["BACKEND_ORDERS_COMP_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"]);
  assert.deepEqual(compEntry?.blockerDimensions, []);
  const correctEntry = audit.entries.find((entry) => entry.key === "POST /api/integration/orders/correct");
  assert.ok(correctEntry?.externalized.some((item) => /orders\/correct.*snapshot ordini relazionale/i.test(item)));
  assert.ok(correctEntry?.externalized.some((item) => /orders\/correct.*table_state relazionale.*guard/i.test(item)));
  assert.ok(correctEntry?.externalized.some((item) => /order_correction_applied.*event_outbox/i.test(item)));
  assert.ok(correctEntry?.externalized.some((item) => /righe corrette\/barrate.*read-model relazionale/i.test(item)));
  assert.ok(correctEntry?.externalized.some((item) => /mirror app-state async.*orderCorrections/i.test(item)));
  assert.deepEqual(correctEntry?.asyncAckFlags, ["BACKEND_ORDERS_CORRECT_ASYNC_ACK", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH"]);
  assert.deepEqual(correctEntry?.blockerDimensions, []);
  assert.equal(audit.topOrderWorkerCandidates.find((entry) => entry.key === "POST /api/integration/orders/correct")?.nextAction, "abilitare in allowlist singola e misurare canary");
  assert.equal(audit.topOrderWorkerCandidates.find((entry) => entry.key === "POST /api/integration/orders/comp")?.nextAction, "abilitare in allowlist singola e misurare canary");
});

test("MP-4 audit allowlist valuta il GO per singola route, non solo globalmente", () => {
  const readyEntry = {
    key: "POST /api/integration/orders/sync",
    domain: "sync",
    readyForOrderWorker: true,
    blockers: [],
    blockerDimensions: [],
  };
  const blockedEntry = {
    key: "POST /api/integration/orders/create",
    domain: "create",
    readyForOrderWorker: false,
    blockers: ["side effect owner-bound"],
    blockerDimensions: ["financial-sync"],
  };

  const readyAllowlist = buildOrderWorkerAllowlistAudit([readyEntry, blockedEntry], {
    allowlist: "POST /api/integration/orders/sync",
  });
  assert.equal(readyAllowlist.goNoGo, "go");
  assert.deepEqual(readyAllowlist.selectedRouteKeys, ["POST /api/integration/orders/sync"]);

  const blockedAllowlist = buildOrderWorkerAllowlistAudit([readyEntry, blockedEntry], {
    allowlist: "/api/integration/orders/create",
  });
  assert.equal(blockedAllowlist.goNoGo, "no-go");
  assert.equal(blockedAllowlist.blockedRoutes[0].key, "POST /api/integration/orders/create");

  const wildcardWithoutConsent = buildOrderWorkerAllowlistAudit([readyEntry], {
    allowlist: "*",
  });
  assert.equal(wildcardWithoutConsent.goNoGo, "no-go");
  assert.equal(wildcardWithoutConsent.wildcardRequested, true);
  assert.equal(wildcardWithoutConsent.wildcardAllowed, false);
});

test("MP-4 audit allowlist reale abilita orders/sync dopo chiusura blocco dbcache", () => {
  const audit = buildOrderWorkflowExternalizationAudit({
    routes: buildRouteRegistry(),
    now: new Date("2026-07-04T16:50:00.000Z"),
    orderWorkerRouteAllowlist: "POST /api/integration/orders/sync",
  });

  assert.equal(audit.orderWorkersGoNoGo, "go");
  assert.equal(audit.orderWorkerAllowlistAudit.goNoGo, "go");
  assert.deepEqual(audit.orderWorkerAllowlistAudit.selectedRouteKeys, [
    "POST /api/integration/orders/sync",
  ]);
  assert.deepEqual(audit.orderWorkerAllowlistAudit.readyRouteKeys, [
    "POST /api/integration/orders/sync",
  ]);
  assert.deepEqual(audit.orderWorkerAllowlistAudit.blockedRoutes, []);
  const syncEntry = audit.entries.find((entry) => entry.key === "POST /api/integration/orders/sync");
  assert.equal(syncEntry?.readyForOrderWorker, true);
  assert.deepEqual(syncEntry?.blockerDimensions, []);
});

test("MP-3 audit CLI --no-write emette solo JSON senza creare path report", () => {
  const child = spawnSync(
    process.execPath,
    ["cassa-frontend/scripts/order-workflow-externalization-audit.mjs", "--json-only", "--no-write"],
    {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.orderWorkersGoNoGo, "go");
  assert.deepEqual(payload.blockerDimensionSummary, []);
  assert.equal(payload.orderWorkerAllowlistAudit.goNoGo, "not-requested");
  assert.equal(Object.hasOwn(payload, "reportJsonPath"), false);
  assert.equal(Object.hasOwn(payload, "reportMdPath"), false);
});
