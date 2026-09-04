function isTruthyFlag(value) {
  return ["1", "true", "yes", "on", "enabled"].includes(
    String(value ?? "").trim().toLowerCase()
  );
}

export function normalizeRealtimeBackboneConfig(env = process.env) {
  return {
    idempotencyStoreEnabled: isTruthyFlag(env.IDEMPOTENCY_STORE_ENABLED),
    eventOutboxEnabled: isTruthyFlag(env.EVENT_OUTBOX_ENABLED),
    replayEnabled: isTruthyFlag(env.REALTIME_REPLAY_ENABLED),
  };
}
