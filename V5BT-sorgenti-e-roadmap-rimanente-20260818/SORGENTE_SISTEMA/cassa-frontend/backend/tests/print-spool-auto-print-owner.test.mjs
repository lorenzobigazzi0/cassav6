import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_PRINT_OWNER_MAX_PLANS,
  AUTO_PRINT_OWNER_MAX_JSON_BYTES,
  AUTO_PRINT_OWNER_MAX_PAYLOADS_PER_PLAN,
  AUTO_PRINT_OWNER_MAX_TEXT_BYTES,
  buildAutoPrintOwnerBatchId,
  buildAutoPrintOwnerJobId,
  createAutoPrintOwnerForwarder,
  normalizeAutoPrintOwnerPlans,
  persistAutoPrintOwnerPlanWorkflow,
} from "../modules/print-spool/auto-print-owner.js";

function createMetrics() {
  const counters = {};
  const operations = [];
  return {
    counters,
    operations,
    incrementCounter(name, amount = 1) {
      counters[name] = (counters[name] ?? 0) + amount;
    },
    recordOperation(kind, label, ms) {
      operations.push({ kind, label, ms });
    },
  };
}

function plan(index = 1, overrides = {}) {
  return {
    kind: "order",
    orderId: `order-${index}`,
    station: "CUCINA",
    text: `Comanda ${index}\n`,
    printPreferences: { order: { copies: 1 } },
    clientApp: "postazione-auto-print",
    ...overrides,
  };
}

test("costruisce ID batch e job deterministici", () => {
  const batchId = buildAutoPrintOwnerBatchId("00421");
  assert.equal(batchId, buildAutoPrintOwnerBatchId("00421"));
  assert.notEqual(batchId, buildAutoPrintOwnerBatchId("00422"));
  assert.match(batchId, /^auto_print_batch_[a-f0-9]{40}$/);
  assert.equal(buildAutoPrintOwnerJobId(batchId, 0), buildAutoPrintOwnerJobId(batchId, 0));
  assert.notEqual(buildAutoPrintOwnerJobId(batchId, 0), buildAutoPrintOwnerJobId(batchId, 1));
  assert.match(buildAutoPrintOwnerJobId(batchId, 0), /^print_[a-f0-9]{40}$/);
});

test("normalizza, deduplica e limita piani e payload", () => {
  const batchId = buildAutoPrintOwnerBatchId("00421");
  const source = [
    {
      batchId,
      payloads: [
        plan(1, { ignored: "non esportare" }),
        plan(1, { ignored: "cambia ma resta duplicato" }),
        ...Array.from(
          { length: AUTO_PRINT_OWNER_MAX_PAYLOADS_PER_PLAN + 4 },
          (_, index) => plan(index + 2),
        ),
      ],
    },
    { batchId, payloads: [plan(99)] },
    ...Array.from({ length: AUTO_PRINT_OWNER_MAX_PLANS + 4 }, (_, index) => ({
      batchId: buildAutoPrintOwnerBatchId(`extra-${index}`),
      payloads: [plan(index + 100)],
    })),
  ];

  const first = normalizeAutoPrintOwnerPlans(source);
  const second = normalizeAutoPrintOwnerPlans(source);

  assert.equal(first.length, AUTO_PRINT_OWNER_MAX_PLANS);
  assert.deepEqual(first, second);
  assert.equal(first[0].payloads.length, AUTO_PRINT_OWNER_MAX_PAYLOADS_PER_PLAN);
  assert.equal(first[0].payloads[0].ignored, undefined);
  assert.match(first[0].payloads[0].jobId, /^print_[a-f0-9]{40}$/);
  assert.equal(new Set(first.map((entry) => entry.batchId)).size, first.length);
});

test("il workflow di persistenza owner espone fasi stabili e cardinalita", async () => {
  const metrics = createMetrics();
  const batchId = buildAutoPrintOwnerBatchId("workflow-1");
  const db = { marker: "db" };
  const settings = { marker: "settings" };
  let enqueueOptions;
  const result = await persistAutoPrintOwnerPlanWorkflow({
    plans: [{ batchId, payloads: [plan(1), plan(2)] }],
    db,
    settings,
    runtimeMetrics: metrics,
    readDb: () => assert.fail("readDb inatteso"),
    sanitizeSettings: () => assert.fail("sanitizeSettings inatteso"),
    enqueueJobs: async (effectiveDb, payloads, options) => {
      assert.equal(effectiveDb, db);
      assert.equal(options.settings, settings);
      assert.equal(payloads.length, 2);
      options.onSkippedExisting(1);
      enqueueOptions = options;
      return [{ id: options.jobIds[0] }];
    },
  });

  assert.equal(enqueueOptions.jobIds.length, 2);
  assert.deepEqual(result, { accepted: 1, duplicates: 1, skipped: 0 });
  assert.deepEqual(
    metrics.operations.map(({ kind, label }) => [kind, label]),
    [
      ["printSpoolOwner", "normalizePlans"],
      ["printSpoolOwner", "resolveDb"],
      ["printSpoolOwner", "resolveSettings"],
      ["printSpoolOwner", "enqueueBatch"],
      ["printSpoolOwner", "total"],
    ],
  );
});

test("il workflow owner attesta errore e totale anche su persistenza fallita", async () => {
  const metrics = createMetrics();
  const batchId = buildAutoPrintOwnerBatchId("workflow-error");
  await assert.rejects(
    persistAutoPrintOwnerPlanWorkflow({
      plans: [{ batchId, payloads: [plan()] }],
      db: {},
      settings: {},
      runtimeMetrics: metrics,
      enqueueJobs: async () => { throw new Error("storage offline"); },
    }),
    /storage offline/,
  );
  assert.deepEqual(
    metrics.operations.slice(-3).map(({ label }) => label),
    ["enqueueBatch", "error", "total"],
  );
});

test("rifiuta batchId, piani e contenuti oltre i limiti", () => {
  assert.throws(
    () => normalizeAutoPrintOwnerPlans([{ batchId: "../non-valido", payloads: [plan()] }]),
    { code: "AUTO_PRINT_OWNER_PAYLOAD_INVALID" },
  );
  const largeText = "x".repeat(Math.floor(AUTO_PRINT_OWNER_MAX_JSON_BYTES / 2));
  assert.throws(
    () => normalizeAutoPrintOwnerPlans([
      { batchId: "batch-large-1", payloads: [plan(1, { text: largeText })] },
      { batchId: "batch-large-2", payloads: [plan(2, { text: largeText })] },
    ]),
    { code: "AUTO_PRINT_OWNER_PAYLOAD_INVALID" },
  );
  assert.throws(
    () => normalizeAutoPrintOwnerPlans([{ batchId: "batch-1", payloads: [] }]),
    { code: "AUTO_PRINT_OWNER_PAYLOAD_INVALID" },
  );
  assert.throws(
    () => normalizeAutoPrintOwnerPlans([{
      batchId: "batch-1",
      payloads: [plan(1, { text: "x".repeat(AUTO_PRINT_OWNER_MAX_TEXT_BYTES + 1) })],
    }]),
    { code: "AUTO_PRINT_OWNER_PAYLOAD_INVALID" },
  );
});

test("inoltra dall'api-worker con service token e payload validato", async () => {
  const metrics = createMetrics();
  const requests = [];
  const forwarder = createAutoPrintOwnerForwarder({
    enabled: true,
    getRole: () => "api-worker",
    ownerUrl: "http://127.0.0.1:5281/",
    serviceToken: "service-token",
    timeoutMs: 2_000,
    runtimeMetrics: metrics,
    fetchWithTimeout: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 202,
        json: async () => ({ ok: true, accepted: 2, duplicates: 0, skipped: 0 }),
      };
    },
  });

  const batchId = buildAutoPrintOwnerBatchId("00421");
  assert.equal(await forwarder.forward([{
    batchId,
    payloads: [plan(1), plan(1), plan(2)],
  }]), true);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:5281/api/internal/print-spool/auto-print");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.timeoutMs, 2_000);
  assert.equal(requests[0].options.headers["X-Service-Token"], "service-token");
  assert.equal(requests[0].options.headers["X-V5BT-Internal"], "print-spool-auto-print");
  assert.equal(requests[0].options.headers["X-Cassav4-Internal"], undefined);
  const payload = JSON.parse(requests[0].options.body);
  assert.deepEqual(Object.keys(payload), ["plans"]);
  assert.equal(payload.plans.length, 1);
  assert.equal(payload.plans[0].payloads.length, 2);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerForwarded, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerAccepted, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerForwardedPlans, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerForwardedJobs, 2);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerConfirmedPlans, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerConfirmedJobs, 2);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerAcceptedJobs, 2);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerDuplicateJobs ?? 0, 0);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerErrors ?? 0, 0);
  assert.equal(metrics.operations[0].label, "printSpoolAutoPrint.remoteOwner");
});

test("non inoltra fuori dal ruolo api-worker", async () => {
  let fetchCalls = 0;
  const forwarder = createAutoPrintOwnerForwarder({
    enabled: true,
    getRole: () => "api-owner",
    ownerUrl: "http://127.0.0.1:5281",
    serviceToken: "service-token",
    fetchWithTimeout: async () => {
      fetchCalls += 1;
    },
  });

  assert.equal(await forwarder.forward([{ batchId: "batch-1", payloads: [plan()] }]), false);
  assert.equal(fetchCalls, 0);
});

test("su errore owner ritorna false, registra metriche e non dichiara fallback locale", async () => {
  const metrics = createMetrics();
  const warnings = [];
  const forwarder = createAutoPrintOwnerForwarder({
    enabled: true,
    getRole: () => "api-worker",
    ownerUrl: "http://127.0.0.1:5281",
    serviceToken: "service-token",
    runtimeMetrics: metrics,
    logger: { warn: (message) => warnings.push(message) },
    fetchWithTimeout: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(await forwarder.forward([{ batchId: "batch-1", payloads: [plan()] }]), false);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerForwarded, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerAccepted ?? 0, 0);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerErrors, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerTimeouts ?? 0, 0);
  assert.equal(metrics.operations[0].label, "printSpoolAutoPrint.remoteOwnerError");
  assert.match(warnings[0], /owner remoto non disponibile/);
  assert.doesNotMatch(warnings[0], /fallback locale/i);
});

test("un payload non valido non effettua richieste e viene attestato", async () => {
  const metrics = createMetrics();
  let fetchCalls = 0;
  const forwarder = createAutoPrintOwnerForwarder({
    enabled: true,
    getRole: () => "api-worker",
    ownerUrl: "http://127.0.0.1:5281",
    serviceToken: "service-token",
    runtimeMetrics: metrics,
    logger: { warn() {} },
    fetchWithTimeout: async () => {
      fetchCalls += 1;
    },
  });

  assert.equal(await forwarder.forward([{ batchId: "", payloads: [plan()] }]), false);
  assert.equal(fetchCalls, 0);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerInvalidPayloads, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerErrors, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerForwarded ?? 0, 0);
});

test("distingue un timeout remoto da un errore non ritentabile", async () => {
  const metrics = createMetrics();
  const timeout = new Error("request timed out");
  timeout.code = "ETIMEDOUT";
  const forwarder = createAutoPrintOwnerForwarder({
    enabled: true,
    getRole: () => "api-worker",
    ownerUrl: "http://127.0.0.1:5281",
    serviceToken: "service-token",
    runtimeMetrics: metrics,
    logger: { warn() {} },
    fetchWithTimeout: async () => {
      throw timeout;
    },
  });

  assert.equal(await forwarder.forward([{ batchId: "batch-1", payloads: [plan()] }]), false);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerErrors, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerTimeouts, 1);
});

test("rifiuta una risposta owner con cardinalita non attestabile", async () => {
  const metrics = createMetrics();
  const forwarder = createAutoPrintOwnerForwarder({
    enabled: true,
    getRole: () => "api-worker",
    ownerUrl: "http://127.0.0.1:5281",
    serviceToken: "service-token",
    runtimeMetrics: metrics,
    logger: { warn() {} },
    fetchWithTimeout: async () => ({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, accepted: 0, duplicates: 0, skipped: 0 }),
    }),
  });

  assert.equal(await forwarder.forward([{ batchId: "batch-1", payloads: [plan()] }]), false);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerResultMismatches, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerErrors, 1);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerAccepted ?? 0, 0);
  assert.equal(metrics.counters.printSpoolAutoPrintRemoteOwnerConfirmedJobs ?? 0, 0);
});
