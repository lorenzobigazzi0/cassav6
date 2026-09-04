import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildPhasePValidationPlan } from "../../scripts/phase-p-validation-preflight.mjs";

test("Fase P preflight genera profili progressivi e simulatori virtuali", () => {
  const plan = buildPhasePValidationPlan({
    now: new Date("2026-07-03T10:00:00.000Z"),
    nodeBin: process.execPath,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.profiles.loadProfiles.map((profile) => profile.name),
    ["load-10", "load-25", "load-50", "load-100"],
  );
  assert.match(plan.profiles.loadProfiles[3].command, /LOADTEST_HANDHELDS=100/);
  assert.match(plan.profiles.loadProfiles[3].command, /LOADTEST_STATIONS=10/);
  assert.match(plan.profiles.loadProfiles[3].command, /LOADTEST_GUI=5/);
  assert.match(plan.profiles.loadProfiles[3].command, /LOADTEST_MULTIPROCESS=1/);
  assert.match(plan.profiles.loadProfiles[3].command, /LOADTEST_API_WORKERS=2/);
  assert.match(plan.profiles.loadProfiles[3].command, /APP_STATE_DIRTY_TRACKING=write/);
  assert.match(plan.profiles.loadProfiles[3].command, /LOADTEST_PRINTING_ENABLED=1/);
  assert.match(plan.profiles.loadProfiles[3].command, /LOADTEST_PRINTER_HOST=127\.0\.0\.1/);
  assert.match(plan.profiles.loadProfiles[3].command, /LOADTEST_ALLOW_NON_LOOPBACK_IO=0/);
  assert.match(plan.profiles.endurance.command, /ENDURANCE_DURATION_MS=5400000/);
  assert.match(plan.profiles.endurance.command, /ENDURANCE_ACTIONS=50000/);
  assert.match(plan.profiles.endurance.command, /ENDURANCE_STATIONS=50/);
  assert.match(plan.profiles.endurance.command, /ENDURANCE_RADIO_CLIENTS=100/);
  assert.match(plan.profiles.endurance.command, /ENDURANCE_PRINTING_ENABLED=1/);
  assert.match(plan.profiles.endurance.command, /ENDURANCE_FISCAL_BASE_URL=http:\/\/127\.0\.0\.1:9290/);
  assert.match(plan.profiles.support.map((entry) => entry.command).join("\n"), /mock-fiscal-server\.mjs/);
  assert.match(plan.profiles.support.map((entry) => entry.command).join("\n"), /mock-tcp-printer\.mjs/);
  assert.equal(
    plan.requiredFiles.find((entry) => entry.label === "Raspberry load-100 guarded runner")?.ok,
    true,
  );
  assert.equal(plan.thresholds.fiscalDuplicateReceipts, 0);
  assert.equal(plan.thresholds.paymentDuplicates, 0);
});

test("Fase P preflight include i canary multi-processo con gate misto", () => {
  const plan = buildPhasePValidationPlan({
    now: new Date("2026-07-04T16:45:00.000Z"),
    nodeBin: process.execPath,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.multiProcess.canaries.map((profile) => profile.name),
    [
      "api-worker-reads-30s",
      "realtime-gateway-8x8",
      "mixed-30s",
      "order-worker-fuse",
      "order-worker-create-allowlist",
      "order-worker-sync-allowlist",
      "order-worker-cancel-allowlist",
      "order-worker-comp-allowlist",
      "order-worker-correct-allowlist",
      "order-worker-bar-replacement-allowlist",
      "order-worker-bar-replacement-legacy-allowlist",
      "order-worker-line-split-allowlist",
      "order-worker-transfer-resolve-allowlist",
      "order-worker-create-sync-e2e",
      "order-worker-create-sync-cancel-e2e",
      "order-worker-create-correct-sync-comp-e2e",
      "order-worker-create-bar-replacement-correct-sync-comp-e2e",
      "order-worker-create-line-split-sync-e2e",
      "order-worker-create-transfer-resolve-sync-e2e",
      "order-worker-transfer-request-allowlist",
      "order-worker-price-override-allowlist",
      "order-worker-transfer-force-allowlist",
      "order-worker-storno-allowlist",
      "order-worker-create-price-override-sync-e2e",
      "order-worker-create-transfer-force-sync-e2e",
      "order-worker-create-transfer-force-storno-sync-e2e",
    ],
  );
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_PROCESS_ROLE=api-owner/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /EVENT_OUTBOX_ENABLED=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_APP_STATE_SPLIT_TABLE_STATES=externalized/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_READ_WORKERS=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY=1/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /POST \/api\/integration\/orders\/create/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /POST \/api\/integration\/orders\/sync/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /POST \/api\/integration\/orders\/cancel/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /POST \/api\/integration\/orders\/comp/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /POST \/api\/integration\/orders\/correct/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /POST \/api\/integration\/orders\/replacement\/bar-charge/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /POST \/api\/orders\/replacement\/bar-charge/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /POST \/api\/integration\/orders\/line\/split/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /POST \/api\/integration\/orders\/storno/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /PRINTING_ENABLED=0/);
  assert.match(plan.multiProcess.requiredRuntime.join("\n"), /BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD/);
  assert.deepEqual(
    plan.multiProcess.restartPresets.map((profile) => profile.name),
    [
      "order-create-sync-worker-canary-dry-run",
      "order-create-sync-worker-canary-restart",
      "order-create-sync-cancel-worker-canary-dry-run",
      "order-create-sync-cancel-worker-canary-restart",
      "order-create-sync-cancel-comp-worker-canary-dry-run",
      "order-create-sync-cancel-comp-worker-canary-restart",
      "order-create-sync-cancel-comp-correct-worker-canary-dry-run",
      "order-create-sync-cancel-comp-correct-worker-canary-restart",
      "order-create-sync-cancel-comp-correct-bar-replacement-worker-canary-dry-run",
      "order-create-sync-cancel-comp-correct-bar-replacement-worker-canary-restart",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-worker-canary-dry-run",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-worker-canary-restart",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-worker-canary-dry-run",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-worker-canary-restart",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-worker-canary-dry-run",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-worker-canary-restart",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-worker-canary-dry-run",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-worker-canary-restart",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-worker-canary-dry-run",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-worker-canary-restart",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-storno-worker-canary-dry-run",
      "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-storno-worker-canary-restart",
    ],
  );
  assert.match(plan.multiProcess.restartPresets[0].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[0].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[0].command, /tools\/restart-v5bt-linux\.sh/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[1].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[2].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[2].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[3].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[4].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[4].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[5].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[6].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[6].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[7].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[8].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[8].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[9].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[10].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[10].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[11].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[12].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[12].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[13].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[14].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[14].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[15].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[16].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[16].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[17].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[18].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[18].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[19].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.restartPresets[20].command, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY=1/);
  assert.match(plan.multiProcess.restartPresets[20].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.doesNotMatch(plan.multiProcess.restartPresets[21].command, /BACKEND_RESTART_DRY_RUN=1/);
  assert.match(plan.multiProcess.canaries[0].command, /api-worker-read-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[1].command, /realtime-gateway-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[2].command, /multiprocess-mixed-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[2].command, /CANARY_READ_DURATION_MS=30000/);
  assert.match(plan.multiProcess.canaries[2].command, /CANARY_EVENTS=10/);
  assert.match(plan.multiProcess.canaries[3].command, /order-worker-fuse-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[4].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[4].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/create'/);
  assert.match(plan.multiProcess.canaries[4].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/correct\/resolve'/);
  assert.match(plan.multiProcess.canaries[5].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[5].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/sync'/);
  assert.match(plan.multiProcess.canaries[5].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/correct\/resolve'/);
  assert.match(plan.multiProcess.canaries[6].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[6].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/cancel'/);
  assert.match(plan.multiProcess.canaries[6].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/correct\/resolve'/);
  assert.match(plan.multiProcess.canaries[7].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[7].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/comp'/);
  assert.match(plan.multiProcess.canaries[7].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/correct\/resolve'/);
  assert.match(plan.multiProcess.canaries[8].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[8].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/correct'/);
  assert.match(plan.multiProcess.canaries[8].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/correct\/resolve'/);
  assert.match(plan.multiProcess.canaries[9].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[9].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/replacement\/bar-charge'/);
  assert.match(plan.multiProcess.canaries[9].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/correct\/resolve'/);
  assert.match(plan.multiProcess.canaries[10].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[10].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/orders\/replacement\/bar-charge'/);
  assert.match(plan.multiProcess.canaries[10].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/correct\/resolve'/);
  assert.match(plan.multiProcess.canaries[11].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[11].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/line\/split'/);
  assert.match(plan.multiProcess.canaries[11].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/correct\/resolve'/);
  assert.match(plan.multiProcess.canaries[12].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[12].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/transfer\/resolve'/);
  assert.match(plan.multiProcess.canaries[12].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/transfer\/force'/);
  assert.match(plan.multiProcess.canaries[13].command, /order-worker-sync-e2e-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[13].command, /PRINTING_ENABLED=0/);
  assert.match(plan.multiProcess.canaries[13].command, /CANARY_REQUIRE_PRINTING_DISABLED=1/);
  assert.match(plan.multiProcess.canaries[13].command, /CANARY_SKIP_CLEANUP=1/);
  assert.match(plan.multiProcess.canaries[13].command, /CANARY_REQUIRE_CLEANUP=0/);
  assert.match(plan.multiProcess.canaries[13].command, /CANARY_EXPECT_CREATE_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[13].command, /CANARY_USERNAME=lorenzo/);
  assert.match(plan.multiProcess.canaries[13].command, /CANARY_PIN=1234/);
  assert.match(plan.multiProcess.canaries[14].command, /order-worker-sync-e2e-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[14].command, /CANARY_REQUIRE_CLEANUP=1/);
  assert.match(plan.multiProcess.canaries[14].command, /CANARY_EXPECT_CLEANUP_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[15].command, /order-worker-sync-e2e-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[15].command, /CANARY_REQUIRE_CORRECT=1/);
  assert.match(plan.multiProcess.canaries[15].command, /CANARY_EXPECT_CORRECT_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[15].command, /CANARY_REQUIRE_COMP=1/);
  assert.match(plan.multiProcess.canaries[15].command, /CANARY_EXPECT_COMP_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[15].command, /CANARY_SYNC_WORKFLOW_STATUS=ready/);
  assert.match(plan.multiProcess.canaries[16].command, /order-worker-sync-e2e-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[16].command, /CANARY_REQUIRE_BAR_REPLACEMENT=1/);
  assert.match(plan.multiProcess.canaries[16].command, /CANARY_EXPECT_BAR_REPLACEMENT_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[16].command, /CANARY_REQUIRE_CORRECT=1/);
  assert.match(plan.multiProcess.canaries[16].command, /CANARY_REQUIRE_COMP=1/);
  assert.match(plan.multiProcess.canaries[17].command, /order-worker-sync-e2e-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[17].command, /CANARY_REQUIRE_LINE_SPLIT=1/);
  assert.match(plan.multiProcess.canaries[17].command, /CANARY_EXPECT_LINE_SPLIT_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[17].command, /CANARY_SYNC_WORKFLOW_STATUS=ready/);
  assert.match(plan.multiProcess.canaries[18].command, /order-worker-sync-e2e-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[18].command, /CANARY_REQUIRE_TRANSFER_RESOLVE=1/);
  assert.match(plan.multiProcess.canaries[18].command, /CANARY_EXPECT_TRANSFER_REQUEST_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[18].command, /CANARY_EXPECT_TRANSFER_RESOLVE_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[19].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[19].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/transfer\/request'/);
  assert.match(plan.multiProcess.canaries[19].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/transfer\/force'/);
  assert.match(plan.multiProcess.canaries[20].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[20].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/line\/price-override'/);
  assert.match(plan.multiProcess.canaries[20].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/transfer\/force'/);
  assert.match(plan.multiProcess.canaries[21].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[21].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/transfer\/force'/);
  assert.match(plan.multiProcess.canaries[21].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/integration\/orders\/storno'/);
  assert.match(plan.multiProcess.canaries[22].command, /order-worker-route-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[22].command, /CANARY_ORDER_WORKER_ROUTE_KEY='POST \/api\/integration\/orders\/storno'/);
  assert.match(plan.multiProcess.canaries[22].command, /CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY='POST \/api\/payments\/table'/);
  assert.match(plan.multiProcess.canaries[23].command, /order-worker-sync-e2e-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[23].command, /CANARY_REQUIRE_PRICE_OVERRIDE=1/);
  assert.match(plan.multiProcess.canaries[23].command, /CANARY_EXPECT_PRICE_OVERRIDE_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[23].command, /CANARY_SYNC_WORKFLOW_STATUS=ready/);
  assert.match(plan.multiProcess.canaries[24].command, /order-worker-sync-e2e-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[24].command, /CANARY_REQUIRE_TRANSFER_FORCE=1/);
  assert.match(plan.multiProcess.canaries[24].command, /CANARY_EXPECT_TRANSFER_FORCE_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[25].command, /order-worker-sync-e2e-canary\.mjs/);
  assert.match(plan.multiProcess.canaries[25].command, /CANARY_REQUIRE_STORNO=1/);
  assert.match(plan.multiProcess.canaries[25].command, /CANARY_EXPECT_STORNO_PROXY_ROLE=api-worker/);
  assert.match(plan.multiProcess.canaries[25].command, /CANARY_SYNC_WORKFLOW_STATUS=delivered/);
  assert.match(plan.multiProcess.canaries[18].command, /CANARY_SYNC_WORKFLOW_STATUS=ready/);
  assert.deepEqual(
    plan.multiProcess.audits.map((profile) => profile.name),
    [
      "order-workflow-externalization",
      "order-worker-create-sync-allowlist-audit",
      "order-worker-create-sync-cancel-allowlist-audit",
      "order-worker-create-sync-cancel-comp-allowlist-audit",
      "order-worker-create-sync-cancel-comp-correct-allowlist-audit",
      "order-worker-create-sync-cancel-comp-correct-bar-replacement-allowlist-audit",
      "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-allowlist-audit",
      "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-allowlist-audit",
      "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-allowlist-audit",
      "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-allowlist-audit",
      "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-allowlist-audit",
      "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-storno-allowlist-audit",
    ],
  );
  assert.match(plan.multiProcess.audits[0].command, /order-workflow-externalization-audit\.mjs/);
  assert.match(plan.multiProcess.audits[1].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync'/);
  assert.match(plan.multiProcess.audits[2].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel'/);
  assert.match(plan.multiProcess.audits[3].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp'/);
  assert.match(plan.multiProcess.audits[4].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct'/);
  assert.match(plan.multiProcess.audits[5].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge'/);
  assert.match(plan.multiProcess.audits[6].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge,POST \/api\/integration\/orders\/line\/split'/);
  assert.match(plan.multiProcess.audits[7].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge,POST \/api\/integration\/orders\/line\/split,POST \/api\/integration\/orders\/transfer\/resolve'/);
  assert.match(plan.multiProcess.audits[8].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge,POST \/api\/integration\/orders\/line\/split,POST \/api\/integration\/orders\/transfer\/resolve,POST \/api\/integration\/orders\/transfer\/request'/);
  assert.match(plan.multiProcess.audits[9].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge,POST \/api\/integration\/orders\/line\/split,POST \/api\/integration\/orders\/transfer\/resolve,POST \/api\/integration\/orders\/transfer\/request,POST \/api\/integration\/orders\/line\/price-override'/);
  assert.match(plan.multiProcess.audits[10].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge,POST \/api\/integration\/orders\/line\/split,POST \/api\/integration\/orders\/transfer\/resolve,POST \/api\/integration\/orders\/transfer\/request,POST \/api\/integration\/orders\/line\/price-override,POST \/api\/integration\/orders\/transfer\/force'/);
  assert.match(plan.multiProcess.audits[11].command, /--route-allowlist 'POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge,POST \/api\/integration\/orders\/line\/split,POST \/api\/integration\/orders\/transfer\/resolve,POST \/api\/integration\/orders\/transfer\/request,POST \/api\/integration\/orders\/line\/price-override,POST \/api\/integration\/orders\/transfer\/force,POST \/api\/integration\/orders\/storno'/);
  assert.equal(plan.thresholds.multiProcessOutboxUnpublished, 0);
  assert.equal(plan.thresholds.multiProcessDirectWorkerMutationBlocked, true);
});

test("Fase P loadtest usa il Node corrente se NODE_BIN non e' esplicito", () => {
  const loadtestSource = readFileSync(
    new URL("../../scripts/loadtest-full-capacity.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    loadtestSource,
    /const nodeBin = process\.env\.NODE_BIN \|\| process\.execPath;/,
    "loadtest-full-capacity non deve dipendere da un path Node storico su USB",
  );
  assert.doesNotMatch(
    loadtestSource,
    /cassav2-v3-patch7-complete-source/,
    "il runner P non deve avere un NODE_BIN hardcoded di un vecchio pacchetto",
  );
});

test("Fase P Raspberry runner blocca avvii con host non sicuro e persiste snapshot", () => {
  const runnerSource = readFileSync(
    new URL("../../scripts/run-p4-load100-raspberry.sh", import.meta.url),
    "utf8",
  );

  assert.match(runnerSource, /P4_MAX_START_TEMP_MILLIC="\$\{P4_MAX_START_TEMP_MILLIC:-80000\}"/);
  assert.match(runnerSource, /P4_MIN_AVAILABLE_MEMORY_KB="\$\{P4_MIN_AVAILABLE_MEMORY_KB:-524288\}"/);
  assert.match(runnerSource, /P4_MIN_FREE_DISK_KB="\$\{P4_MIN_FREE_DISK_KB:-2097152\}"/);
  assert.match(runnerSource, /vcgencmd get_throttled/);
  assert.match(runnerSource, /HOST_CURRENT_THROTTLE_MASK=\$\(\(throttle_value & 0x0f\)\)/);
  assert.match(runnerSource, /MemAvailable:/);
  assert.match(runnerSource, /df -Pk "\$CASSAV4_ROOT"/);
  assert.match(runnerSource, /capture_host_snapshot preflight/);
  assert.match(runnerSource, /capture_host_snapshot post_load/);
  assert.match(runnerSource, /capture_host_snapshot cleanup/);
  assert.match(runnerSource, /sync -d "\$CONTROL_LOG_DIR\/run\.env"/);
  assert.match(runnerSource, /P4_PREFLIGHT_ONLY="\$\{P4_PREFLIGHT_ONLY:-0\}"/);
  assert.match(runnerSource, /P4_PROGRESS_INTERVAL_SEC="\$\{P4_PROGRESS_INTERVAL_SEC:-10\}"/);
  assert.match(runnerSource, /SQLITE_BIN="\$\{SQLITE_BIN:-\/usr\/bin\/sqlite3\}"/);
  assert.match(runnerSource, /CASSAV4_RUN_USER="\$\{CASSAV4_RUN_USER:-cassav4\}"/);
  assert.match(runnerSource, /CASSAV4_RUN_GROUP="\$\{CASSAV4_RUN_GROUP:-cassav4\}"/);
  assert.match(runnerSource, /Preflight P4 completato senza fermare servizi o avviare il carico/);
  assert.match(runnerSource, /event=progress_monitor_started/);
  assert.match(runnerSource, /orders=.*devices=.*min_per_device=.*max_per_device=.*print_pending=.*outbox_unpublished=/);
  assert.match(runnerSource, /sync -d "\$PROGRESS_LOG"/);
  assert.match(runnerSource, /report_json_sha256=/);
  assert.match(runnerSource, /cassav4-table-lock-worker\.service/);
  assert.match(runnerSource, /5290 5291 5292 5293 5294 5295 5296 5297 9109 9290/);
  assert.match(runnerSource, /LOADTEST_TABLE_LOCK_WORKERS="\$\{LOADTEST_TABLE_LOCK_WORKERS:-1\}"/);
  assert.match(runnerSource, /LOADTEST_TABLE_LOCK_TOMBSTONES="\$\{LOADTEST_TABLE_LOCK_TOMBSTONES:-1\}"/);
  assert.match(runnerSource, /LOADTEST_API_WORKER_AUTH_FASTPATH="\$\{LOADTEST_API_WORKER_AUTH_FASTPATH:-1\}"/);
  assert.match(runnerSource, /LOADTEST_API_WORKER_REDIS_POOL_SIZE="\$\{LOADTEST_API_WORKER_REDIS_POOL_SIZE:-4\}"/);
  assert.match(runnerSource, /P4_API_WORKERS="\$\{LOADTEST_API_WORKERS:-2\}"/);
  assert.match(runnerSource, /P4_API_WORKERS < 1 \|\| P4_API_WORKERS > 4/);
  assert.match(runnerSource, /LOADTEST_API_WORKERS="\$P4_API_WORKERS"/);
  assert.match(runnerSource, /stop_mock_processes\(\) \{/);
  assert.match(runnerSource, /kill -KILL "\$pid"/);
  assert.match(runnerSource, /setpriv --reuid="\$CASSAV4_RUN_USER"[\s\S]+mock-fiscal-server\.mjs/);
  assert.match(runnerSource, /cassav4-fiscal-simulator\.service/);
  assert.match(runnerSource, /cassav4-automatic-cash-simulator\.service/);
  assert.ok(
    runnerSource.indexOf("\nenforce_host_preflight\n") < runnerSource.indexOf('systemctl stop "${ACTIVE_SERVICES[@]}"'),
    "il gate host deve scattare prima di fermare i servizi live",
  );
  assert.ok(
    runnerSource.indexOf('systemctl stop "${ACTIVE_SERVICES[@]}"') <
      runnerSource.indexOf("for port in 5290 5291 5292 5293 5294 5295 5296 5297 9109 9290"),
    "le porte di test devono essere verificate dopo lo stop tracciato dei simulatori live",
  );
  assert.match(runnerSource, /Porta P4 gia occupata dopo lo stop dei servizi isolati/);
});

test("Fase P loadtest isola lo stato e blocca I/O reali per default", () => {
  const loadtestSource = readFileSync(
    new URL("../../scripts/loadtest-full-capacity.mjs", import.meta.url),
    "utf8",
  );

  assert.match(loadtestSource, /const appStateSplitDbPath = path\.join\(outputDir, "app-state-split\.sqlite"\);/);
  assert.match(loadtestSource, /REDIS_KEY_PREFIX: redisKeyPrefix/);
  assert.match(loadtestSource, /MQTT_ENABLED: "0"/);
  assert.match(loadtestSource, /AUTOMATIC_CASH_GATEWAY_ENABLED: REALISTIC_LOAD_PROFILE \? "1" : "0"/);
  assert.match(loadtestSource, /AUTOMATIC_CASH_REAL_ENABLED: "0"/);
  assert.match(loadtestSource, /assertLoadtestIoSafety\(\);/);
  assert.match(loadtestSource, /isLoopbackHostname\(fiscalUrl\.hostname\)/);
  assert.match(loadtestSource, /isLoopbackHostname\(PRINTER_HOST\)/);
  assert.match(loadtestSource, /LOADTEST_CHROMIUM_EXECUTABLE_PATH/);
  assert.match(loadtestSource, /return await import\("playwright-core"\);/);
  assert.ok(
    loadtestSource.indexOf("assertLoadtestIoSafety();") < loadtestSource.indexOf("({ chromium } = await loadPlaywright());"),
    "il blocco I/O deve scattare prima del caricamento Playwright",
  );
  assert.match(loadtestSource, /const spawnedChildren = new Set\(\);/);
  assert.match(loadtestSource, /await cleanupResources\(\);/);
  assert.match(loadtestSource, /BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY: "1"/);
  assert.match(loadtestSource, /BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY: "1"/);
  assert.match(loadtestSource, /BACKEND_RELATIONAL_RESERVATIONS_UPDATE_WRITE_PRIMARY: "1"/);
  assert.match(loadtestSource, /BACKEND_MYSQL_TABLE_LOCK_TOMBSTONES: tableLockTombstonesEnabled \? "1" : "0"/);
  assert.match(loadtestSource, /BACKEND_API_WORKER_REQUEST_AUTH_FASTPATH:\s*apiWorkerAuthFastPathEnabled\s*\? "1"\s*:\s*"0"/);
  assert.match(loadtestSource, /BACKEND_API_WORKER_REDIS_SESSION_CACHE:\s*apiWorkerAuthFastPathEnabled\s*\? "1"\s*:\s*"0"/);
  assert.match(loadtestSource, /BACKEND_ORDER_CREATE_TARGETED_LOCK_REFRESH:\s*orderCreateTargetedLockRefreshEnabled\s*\? "1"\s*:\s*"0"/);
  assert.match(loadtestSource, /LOADTEST_ORDER_CREATE_TARGETED_LOCK_REFRESH \?\? "0"/);
  assert.match(loadtestSource, /orderCreateTargetedLockRefreshEnabled,/);
  assert.match(loadtestSource, /BACKEND_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH:\s*orderCreateParallelExternalRefreshEnabled\s*\? "1"\s*:\s*"0"/);
  assert.match(loadtestSource, /LOADTEST_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH \?\? "0"/);
  assert.match(loadtestSource, /orderCreateParallelExternalRefreshEnabled,/);
  assert.match(loadtestSource, /BACKEND_TABLE_SYNC_APP_STATE_FASTPATH:\s*tableSyncAppStateFastPathEnabled\s*\? "1"\s*:\s*"0"/);
  assert.match(loadtestSource, /LOADTEST_TABLE_SYNC_APP_STATE_FASTPATH \?\? "0"/);
  assert.match(loadtestSource, /tableSyncAppStateFastPathEnabled,/);
  assert.match(loadtestSource, /BACKEND_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH:\s*tableRoomMoveRequestAppStateFastPathEnabled\s*\? "1"\s*:\s*"0"/);
  assert.match(loadtestSource, /LOADTEST_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH \?\? "0"/);
  assert.match(loadtestSource, /tableRoomMoveRequestAppStateFastPathEnabled,/);
  assert.match(loadtestSource, /LOADTEST_ROOM_CHANGE_BRANCH_PROBES/);
  assert.match(loadtestSource, /LOADTEST_WAITER_PAUSE_PROBES/);
  assert.match(loadtestSource, /LOADTEST_PAYMENT_FREE_SPLIT_PROBES/);
  assert.match(loadtestSource, /LOADTEST_WAITER_PAUSE_SESSION_AUDIT_FASTPATH \?\? "0"/);
  assert.match(loadtestSource, /BACKEND_WAITER_PAUSE_SESSION_AUDIT_FASTPATH:\s*waiterPauseSessionAuditFastPathEnabled\s*\? "1"\s*:\s*"0"/);
  assert.match(loadtestSource, /waiterPauseSessionAuditFastPathEnabled,/);
  assert.match(loadtestSource, /runWaiterPauseProbes\(\s*waiterPauseProbeSession/);
  assert.match(loadtestSource, /runPaymentFreeSplitProbes\(\s*paymentFreeSplitProbeSession/);
  assert.match(loadtestSource, /payment\.free_split\.success_probe/);
  assert.match(loadtestSource, /order\?\.assignedStationId[\s\S]+order\?\.ownerStation/);
  assert.match(loadtestSource, /type:\s*["']payment\.free_split\.success_probe["']/);
  assert.match(loadtestSource, /waiter\.pause\.concurrent_idempotency_probe/);
  assert.match(loadtestSource, /statusActive: status\.body\?\.pause\?\.active \?\? null/);
  assert.match(loadtestSource, /status: status\.proxyRole \|\| null/);
  assert.match(loadtestSource, /deliveryLagMsByReason/);
  assert.match(loadtestSource, /eventReasonCounts\?\.\[reason\] \?\? 0/);
  assert.match(loadtestSource, /Realtime waiter pause delivery/);
  assert.match(loadtestSource, /LOADTEST_ROOM_LANE_CONCURRENCY/);
  assert.match(loadtestSource, /ROOM_LANE_CONCURRENCY: String\(ROOM_LANE_CONCURRENCY\)/);
  assert.match(loadtestSource, /roomLaneConcurrency: ROOM_LANE_CONCURRENCY/);
  assert.match(loadtestSource, /LOADTEST_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE \?\? "0"/);
  assert.match(loadtestSource, /BACKEND_POS_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE:\s*ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE\s*\? "1"\s*:\s*"0"/);
  assert.match(loadtestSource, /roomChangeApproveAsyncPinPreLane: ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE/);
  assert.match(loadtestSource, /room\.change\.request\.pending/);
  assert.match(loadtestSource, /room\.change\.request\.direct/);
  assert.match(loadtestSource, /Runtime Metrics - order\.create read breakdown/);
  assert.match(loadtestSource, /Runtime Metrics - order\.create internal breakdown/);
  assert.match(loadtestSource, /collectWorkerOperationHistograms\(\s*metrics,\s*"orderCreate"\s*,?\s*\)/);
  assert.match(loadtestSource, /Runtime Metrics - table\.sync write breakdown/);
  assert.match(loadtestSource, /collectWorkerOperationHistograms\(\s*metrics,\s*"tableSyncWrite:"\s*,?\s*\)/);
  assert.match(loadtestSource, /Runtime Metrics - table\.room-move request write breakdown/);
  assert.match(loadtestSource, /collectWorkerOperationHistograms\(\s*metrics,\s*"tableRoomMoveRequestWrite:"\s*,?\s*\)/);
  assert.match(loadtestSource, /Runtime Metrics - room-change request branch breakdown/);
  assert.match(loadtestSource, /collectWorkerOperationHistograms\(\s*metrics,\s*"posRoomChangeRequest:"\s*,?\s*\)/);
  assert.match(loadtestSource, /Runtime Metrics - room-change approve breakdown/);
  assert.match(loadtestSource, /collectWorkerOperationHistograms\(\s*metrics,\s*"posRoomChangeApprove:"\s*,?\s*\)/);
  assert.match(loadtestSource, /Runtime Metrics - room-change approve pre-lane breakdown/);
  assert.match(loadtestSource, /collectWorkerOperationHistograms\(\s*metrics,\s*"posRoomChangeApprovePreLane:"\s*,?\s*\)/);
  assert.match(loadtestSource, /Runtime Metrics - waiter pause workflow breakdown/);
  assert.match(loadtestSource, /collectWorkerOperationHistograms\(\s*metrics,\s*"waiterPauseWorkflow:"\s*,?\s*\)/);
  assert.match(loadtestSource, /Runtime Metrics - payment\.free_split workflow breakdown/);
  assert.match(loadtestSource, /collectWorkerOperationHistograms\(\s*metrics,\s*"paymentFreeSplitWorkflow:"\s*,?\s*\)/);
  assert.match(loadtestSource, /Runtime Metrics - payment\.free_split write breakdown/);
  assert.match(loadtestSource, /collectWorkerOperationHistograms\(\s*metrics,\s*"paymentWorkflowStep:payments\.freeSplit\."\s*,?\s*\)/);
  assert.match(loadtestSource, /paymentFreeSplitTransientMirrorDeferred/);
  assert.match(loadtestSource, /realisticNetworkOutageMs:\s*REALISTIC_LOAD_PROFILE\s*\? REALISTIC_NETWORK_OUTAGE_MS\s*:\s*null/);
  assert.match(loadtestSource, /realisticStationLogoutMs:\s*REALISTIC_LOAD_PROFILE\s*\? REALISTIC_STATION_LOGOUT_MS\s*:\s*null/);
  assert.match(loadtestSource, /gui\.station_login_response_fallback/);
  assert.match(loadtestSource, /verification\.status === 200\s*&&\s*verification\.body\?\.valid === true/);
  assert.match(loadtestSource, /process\.platform === "win32"\) return \[\]/);
  assert.match(loadtestSource, /proc\.once\("error", reject\)/);
  assert.match(loadtestSource, /BACKEND_MYSQL_CONNECTION_LIMIT:\s*String\(\s*tableLockMysqlConnectionLimit\s*,?\s*\)/);
  assert.match(loadtestSource, /REDIS_PERSISTENT_CLIENT: "1"/);
  assert.match(loadtestSource, /p999ms: percentile\(values, 0\.999\)/);
  assert.match(loadtestSource, /p98ms: percentile\(values, 0\.98\)/);
  assert.match(loadtestSource, /latencyMs: latencySummary\(this\.httpDurations\)/);
  assert.doesNotMatch(loadtestSource, /siblingBaseEnv\.PRINTING_ENABLED\s*=\s*"0"/);
  assert.match(loadtestSource, /id: `load_printer_simulated_\$\{index \+ 1\}`/);
  assert.match(loadtestSource, /LOADTEST_REALTIME_CLIENTS/);
  assert.match(loadtestSource, /startRealtimeClients\(handheldSessions\)/);
  assert.match(loadtestSource, /waitForRelationalDrain\(admin\)/);
  assert.match(loadtestSource, /readPrintRuntimeDrain\(session\)/);
  assert.match(loadtestSource, /printSpoolLegacyMirrorRunning/);
  assert.match(loadtestSource, /PRINTING_ENABLED && Number\(audit\?\.printSpoolFailedFinal\) > 0/);
  assert.match(loadtestSource, /runtimeQueues\.drained/);
  assert.match(loadtestSource, /precontoPrinterIds: VIRTUAL_PRINTERS\.map\(\(printer\) => printer\.id\)/);
  assert.match(loadtestSource, /MULTIPROCESS \? apiBaseUrl : undefined/);
  assert.match(loadtestSource, /POS_FISCAL_API_JOB_MAX_ATTEMPTS: "3"/);
  assert.match(loadtestSource, /POS_FISCAL_API_JOB_RETRY_DELAY_MS: "250"/);
  assert.match(loadtestSource, /POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "250"/);
  assert.match(loadtestSource, /return resolveRefreshedOrder\(order, result\);/);
  assert.match(
    loadtestSource,
    /process\.env\.LANE_CROSS_EXCLUSION_ORDERS \?\? "1"/,
  );
  assert.match(
    loadtestSource,
    /process\.env\.LANE_CROSS_EXCLUSION_TABLES \?\? "1"/,
  );
  assert.match(
    loadtestSource,
    /process\.env\.LANE_CROSS_EXCLUSION_PAYMENTS \?\? "1"/,
  );
  assert.match(
    loadtestSource,
    /process\.env\.LANE_CROSS_EXCLUSION_PRESENCE \?\? "1"/,
  );
  assert.match(loadtestSource, /laneCrossExclusionOrdersEnabled,/);
  assert.match(loadtestSource, /laneCrossExclusionTablesEnabled,/);
  assert.match(loadtestSource, /laneCrossExclusionPaymentsEnabled,/);
  assert.match(loadtestSource, /laneCrossExclusionPresenceEnabled,/);
  assert.match(loadtestSource, /PRINT_SPOOL_SQL_PRIMARY: "1"/);
  assert.match(loadtestSource, /LANE_PRINT: "1"/);
  assert.match(loadtestSource, /PRINT_LANE_ENABLED: "1"/);
  assert.match(loadtestSource, /PRINT_SPOOL_LEGACY_MIRROR_INTERVAL_MS: "1000"/);
  assert.match(loadtestSource, /PRINT_SPOOL_LEGACY_MIRROR_REMOTE_OWNER: "1"/);
  assert.match(loadtestSource, /PRINT_SPOOL_LEGACY_MIRROR_OWNER_URL: apiBaseUrl/);
  assert.match(loadtestSource, /PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER: "1"/);
  assert.match(loadtestSource, /PRINT_SPOOL_AUTO_PRINT_OWNER_URL: apiBaseUrl/);
  assert.match(loadtestSource, /PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_TIMEOUT_MS: "10000"/);
  assert.match(loadtestSource, /PRINT_SPOOL_INTERMEDIATE_STATUS_EVENTS: "0"/);
  assert.match(loadtestSource, /PRINT_SPOOL_INITIAL_STATUS_EVENTS: "0"/);
  assert.match(loadtestSource, /PRINT_SPOOL_PRE_SEND_PROBE: "0"/);
  assert.match(loadtestSource, /PRINT_SPOOL_LEGACY_MIRROR_ENABLED: "0"/);
  assert.match(loadtestSource, /PRINT_SPOOL_OWNER_POLL_INTERVAL_MS: "50"/);
  assert.match(loadtestSource, /PRINT_TCP_END_DELAY_MS: "0"/);
  assert.match(loadtestSource, /activityId: "activity_default"/);
  assert.match(loadtestSource, /const idempotencyKey = `load-create-/);
  assert.match(loadtestSource, /LOADTEST_PROFILE === "paced-orders"/);
  assert.match(loadtestSource, /PACED_ORDER_COUNT = Math\.max\(\s*20/);
  assert.match(loadtestSource, /PACED_OTHER_ACTION_COUNT = Math\.max\(\s*10/);
  assert.match(loadtestSource, /PACED_ACTION_INTERVAL_MS = Math\.max\(\s*10_000/);
  assert.match(loadtestSource, /PACED_START_GAP_TOLERANCE_MS = 5/);
  assert.match(loadtestSource, /gapMs < PACED_ACTION_INTERVAL_MS - PACED_START_GAP_TOLERANCE_MS/);
  assert.match(loadtestSource, /PACED_MAX_ACTIVE_MS = Math\.min\(\s*5 \* 60_000/);
  assert.match(loadtestSource, /async function pacedHandheldWorker/);
  assert.match(loadtestSource, /devicesMeetingPersistedOrderTarget/);
  assert.match(loadtestSource, /signal: options\.signal/);
});

test("Fase P preset restart orders/create+sync espone dry-run senza fermare processi", () => {
  const child = spawnSync("bash", ["tools/restart-v5bt-linux.sh"], {
    cwd: new URL("../../..", import.meta.url),
    env: {
      ...process.env,
      BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANARY: "1",
      BACKEND_RESTART_DRY_RUN: "1",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Dry run enabled: no process will be stopped or started\./);
  assert.match(child.stdout, /BACKEND_PROCESS_ROLE=api-owner/);
  assert.match(child.stdout, /BACKEND_REALTIME_GATEWAY_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_API_WORKER_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync/);
  assert.doesNotMatch(child.stdout, /Stopping pid/);
});

test("Fase P preset restart orders/create+sync+cancel espone dry-run senza fermare processi", () => {
  const child = spawnSync("bash", ["tools/restart-v5bt-linux.sh"], {
    cwd: new URL("../../..", import.meta.url),
    env: {
      ...process.env,
      BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_CANARY: "1",
      BACKEND_RESTART_DRY_RUN: "1",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Dry run enabled: no process will be stopped or started\./);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_CANARY=1/);
  assert.match(child.stdout, /BACKEND_PROCESS_ROLE=api-owner/);
  assert.match(child.stdout, /BACKEND_REALTIME_GATEWAY_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_API_WORKER_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel/);
  assert.doesNotMatch(child.stdout, /Stopping pid/);
});

test("Fase P preset restart orders/create+sync+cancel+comp espone dry-run senza fermare processi", () => {
  const child = spawnSync("bash", ["tools/restart-v5bt-linux.sh"], {
    cwd: new URL("../../..", import.meta.url),
    env: {
      ...process.env,
      BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CANARY: "1",
      BACKEND_RESTART_DRY_RUN: "1",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Dry run enabled: no process will be stopped or started\./);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CANARY=1/);
  assert.match(child.stdout, /BACKEND_PROCESS_ROLE=api-owner/);
  assert.match(child.stdout, /BACKEND_REALTIME_GATEWAY_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_API_WORKER_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp/);
  assert.doesNotMatch(child.stdout, /Stopping pid/);
});

test("Fase P preset restart orders/create+sync+cancel+comp+correct espone dry-run senza fermare processi", () => {
  const child = spawnSync("bash", ["tools/restart-v5bt-linux.sh"], {
    cwd: new URL("../../..", import.meta.url),
    env: {
      ...process.env,
      BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_CANARY: "1",
      BACKEND_RESTART_DRY_RUN: "1",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Dry run enabled: no process will be stopped or started\./);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_CANARY=1/);
  assert.match(child.stdout, /BACKEND_PROCESS_ROLE=api-owner/);
  assert.match(child.stdout, /BACKEND_REALTIME_GATEWAY_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_API_WORKER_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct/);
  assert.doesNotMatch(child.stdout, /Stopping pid/);
});

test("Fase P preset restart orders/create+sync+cancel+comp+correct+barReplacement espone dry-run senza fermare processi", () => {
  const child = spawnSync("bash", ["tools/restart-v5bt-linux.sh"], {
    cwd: new URL("../../..", import.meta.url),
    env: {
      ...process.env,
      BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_CANARY: "1",
      BACKEND_RESTART_DRY_RUN: "1",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Dry run enabled: no process will be stopped or started\./);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_CANARY=1/);
  assert.match(child.stdout, /BACKEND_PROCESS_ROLE=api-owner/);
  assert.match(child.stdout, /BACKEND_REALTIME_GATEWAY_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_API_WORKER_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge/);
  assert.doesNotMatch(child.stdout, /Stopping pid/);
});

test("Fase P preset restart orders/create+sync+cancel+comp+correct+barReplacement+lineSplit espone dry-run senza fermare processi", () => {
  const child = spawnSync("bash", ["tools/restart-v5bt-linux.sh"], {
    cwd: new URL("../../..", import.meta.url),
    env: {
      ...process.env,
      BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY: "1",
      BACKEND_RESTART_DRY_RUN: "1",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Dry run enabled: no process will be stopped or started\./);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY=1/);
  assert.match(child.stdout, /BACKEND_PROCESS_ROLE=api-owner/);
  assert.match(child.stdout, /BACKEND_REALTIME_GATEWAY_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_API_WORKER_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge,POST \/api\/integration\/orders\/line\/split/);
  assert.doesNotMatch(child.stdout, /Stopping pid/);
});

test("Fase P preset restart orders/create+sync+cancel+comp+correct+barReplacement+lineSplit+transferResolve+transferRequest+priceOverride+transferForce+storno espone dry-run senza fermare processi", () => {
  const child = spawnSync("bash", ["tools/restart-v5bt-linux.sh"], {
    cwd: new URL("../../..", import.meta.url),
    env: {
      ...process.env,
      BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY: "1",
      BACKEND_RESTART_DRY_RUN: "1",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Dry run enabled: no process will be stopped or started\./);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY=1/);
  assert.match(child.stdout, /BACKEND_PROCESS_ROLE=api-owner/);
  assert.match(child.stdout, /BACKEND_REALTIME_GATEWAY_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_API_WORKER_ENABLED=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1/);
  assert.match(child.stdout, /BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=POST \/api\/integration\/orders\/create,POST \/api\/integration\/orders\/sync,POST \/api\/integration\/orders\/cancel,POST \/api\/integration\/orders\/comp,POST \/api\/integration\/orders\/correct,POST \/api\/integration\/orders\/replacement\/bar-charge,POST \/api\/orders\/replacement\/bar-charge,POST \/api\/integration\/orders\/line\/split,POST \/api\/integration\/orders\/transfer\/resolve,POST \/api\/integration\/orders\/transfer\/request,POST \/api\/integration\/orders\/line\/price-override,POST \/api\/integration\/orders\/transfer\/force,POST \/api\/integration\/orders\/storno/);
  assert.doesNotMatch(child.stdout, /Stopping pid/);
});
