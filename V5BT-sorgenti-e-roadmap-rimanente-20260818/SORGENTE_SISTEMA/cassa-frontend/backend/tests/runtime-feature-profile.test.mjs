import assert from "node:assert/strict";
import test from "node:test";

import {
  buildP43RuntimeFeatureProfile,
  formatRuntimeFeature,
} from "../modules/runtime-feature-profile.js";

test("runtime feature profile espone requested, effective, source e fallback", () => {
  const profile = buildP43RuntimeFeatureProfile({
    env: {
      INVOCATION_ID: "systemd-invocation",
      BACKEND_DB_MODE: "mysql",
      BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR: "1",
      BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY: "0",
      BACKEND_WAITER_PAUSE_SESSION_AUDIT_FASTPATH: "1",
      BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
      BACKEND_MYSQL_SPLIT_SESSIONS: "1",
      BACKEND_MYSQL_SPLIT_AUDIT_EVENTS: "0",
      BACKEND_NOTIFICATION_PUNCTUAL_WRITER: "1",
      BACKEND_COUNTER_COLLECTION_ATOMIC_FASTPATH: "1",
      BACKEND_REALTIME_SCOPED_DELIVERY: "1",
      DB_MUTATION_STARVATION_WAIT_MS: "4200",
    },
  });

  assert.equal(profile.features.durablePaymentMirror.requested, true);
  assert.equal(profile.features.durablePaymentMirror.effective, false);
  assert.equal(profile.features.durablePaymentMirror.source, "systemd");
  assert.equal(profile.features.durablePaymentMirror.fallback.active, true);
  assert.deepEqual(
    profile.features.durablePaymentMirror.unmetPrerequisites,
    ["relationalPaymentsFreeSplitWritePrimary"],
  );
  assert.equal(profile.features.waiterPauseFastWriter.requested, true);
  assert.equal(profile.features.waiterPauseFastWriter.effective, false);
  assert.deepEqual(
    profile.features.waiterPauseFastWriter.unmetPrerequisites,
    ["mysqlSplitAuditEvents"],
  );
  assert.equal(profile.features.scopedRealtimeDelivery.requested, true);
  assert.equal(profile.features.scopedRealtimeDelivery.effective, true);
  assert.equal(profile.features.scopedRealtimeDelivery.source, "systemd");
  assert.equal(profile.features.notificationPunctualWriter.requested, true);
  assert.equal(profile.features.notificationPunctualWriter.effective, true);
  assert.deepEqual(
    profile.features.notificationPunctualWriter.unmetPrerequisites,
    [],
  );
  assert.equal(profile.features.counterCollectionAtomicWriter.requested, true);
  assert.equal(profile.features.counterCollectionAtomicWriter.effective, false);
  assert.deepEqual(
    profile.features.counterCollectionAtomicWriter.unmetPrerequisites,
    ["mysqlSplitAuditEvents"],
  );
  assert.deepEqual(profile.dbMutationScheduler, {
    starvationWaitMs: 4200,
    source: "systemd",
  });
});

test("runtime feature profile usa i valori effettivi forniti dal bootstrap", () => {
  const profile = buildP43RuntimeFeatureProfile({
    env: {
      BACKEND_DB_MODE: "mysql",
      BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR: "1",
      BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY: "1",
      BACKEND_PAYMENT_MIRROR_COMPLETED_RETENTION_DAYS: "14",
    },
    effective: {
      durablePaymentMirror: false,
    },
    paymentMirrorRetention: {
      completedDays: 21,
      failedDays: 120,
      batchSize: 100,
      intervalMs: 45_000,
    },
    paymentMirrorScheduling: {
      intervalMs: 125,
      batchSize: 4,
      foregroundIdleGraceMs: 3_000,
      foregroundDeferralMaxAgeMs: 20_000,
    },
  });

  assert.equal(profile.features.durablePaymentMirror.requested, true);
  assert.equal(profile.features.durablePaymentMirror.effective, false);
  assert.equal(profile.features.durablePaymentMirror.fallback.mode, "synchronous_app_state_mirror");
  assert.deepEqual(profile.paymentMirrorRetention, {
    intervalMs: 45_000,
    completedDays: 21,
    failedDays: 120,
    batchSize: 100,
  });
  assert.deepEqual(profile.paymentMirrorScheduling, {
    intervalMs: 125,
    batchSize: 4,
    foregroundIdleGraceMs: 3_000,
    foregroundDeferralMaxAgeMs: 20_000,
  });
  assert.match(
    formatRuntimeFeature("durablePaymentMirror", profile.features.durablePaymentMirror),
    /requested=ON effective=OFF source=env fallback=synchronous_app_state_mirror/,
  );
});
