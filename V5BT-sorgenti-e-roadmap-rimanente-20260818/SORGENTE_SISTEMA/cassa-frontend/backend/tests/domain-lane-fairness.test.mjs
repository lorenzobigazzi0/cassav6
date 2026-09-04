import assert from "node:assert/strict";
import test from "node:test";

import {
  canContinueLaneBurst,
  domainLanePairConflicts,
  getLanePeerQueuePressureDepth,
  isDomainLaneSchedulerDrained,
  selectHybridSchedulableLane,
  selectIdlePeerLaneIds,
  selectOldestSchedulableLane,
} from "../modules/queue/domain-lane-fairness.js";

test("il fair scheduler seleziona la lane schedulabile in attesa da piu tempo", () => {
  const selected = selectOldestSchedulableLane([
    {
      id: "prima-in-lista",
      canSchedule: true,
      fairSequence: 200,
      priority: 0,
    },
    {
      id: "piu-vecchia",
      canSchedule: true,
      fairSequence: 100,
      priority: 99,
    },
  ]);

  assert.equal(selected?.id, "piu-vecchia");
  assert.equal(selected?.fairSequence, 100);
});

test("il fair scheduler esclude lane non schedulabili o con sequenza invalida", () => {
  const selected = selectOldestSchedulableLane([
    {
      id: "non-schedulabile",
      canSchedule: false,
      fairSequence: 1,
      priority: 0,
    },
    {
      id: "sequenza-mancante",
      canSchedule: true,
      priority: 0,
    },
    {
      id: "sequenza-negativa",
      canSchedule: true,
      fairSequence: -1,
      priority: 0,
    },
    {
      id: "sequenza-nan",
      canSchedule: true,
      fairSequence: Number.NaN,
      priority: 0,
    },
    {
      id: "valida",
      canSchedule: true,
      fairSequence: 50,
      priority: 3,
    },
  ]);

  assert.equal(selected?.id, "valida");
  assert.equal(
    selectOldestSchedulableLane([
      { canSchedule: false, fairSequence: 1 },
      { canSchedule: true, fairSequence: Number.POSITIVE_INFINITY },
    ]),
    null,
  );
});

test("a parita di sequenza il fair scheduler usa priorita e ordine stabile", () => {
  const byPriority = selectOldestSchedulableLane([
    {
      id: "priorita-sette",
      canSchedule: true,
      fairSequence: 100,
      priority: 7,
    },
    {
      id: "priorita-quattro",
      canSchedule: true,
      fairSequence: 100,
      priority: 4,
    },
  ]);
  assert.equal(byPriority?.id, "priorita-quattro");

  const stable = selectOldestSchedulableLane([
    {
      id: "primo",
      canSchedule: true,
      fairSequence: 100,
      priority: 4,
    },
    {
      id: "secondo",
      canSchedule: true,
      fairSequence: 100,
      priority: 4,
    },
  ]);
  assert.equal(stable?.id, "primo");
});

test("la sequenza monotona prevale su timestamp di parete regressivi", () => {
  const selected = selectOldestSchedulableLane([
    {
      id: "gia-in-coda",
      canSchedule: true,
      fairSequence: 10,
      enqueuedAt: 2_000,
    },
    {
      id: "nuova-dopo-regressione-clock",
      canSchedule: true,
      fairSequence: 11,
      enqueuedAt: 1_000,
    },
  ]);
  assert.equal(selected?.id, "gia-in-coda");
});

test("lo scheduler ibrido usa la priorita di pressione nel percorso normale", () => {
  const selected = selectHybridSchedulableLane(
    [
      {
        id: "ordine-piu-vecchio",
        canSchedule: true,
        fairSequence: 10,
        enqueuedMonotonicAt: 500,
        normalPriority: 8,
      },
      {
        id: "pagamento-in-pressione",
        canSchedule: true,
        fairSequence: 11,
        enqueuedMonotonicAt: 600,
        normalPriority: 0,
      },
    ],
    { nowMonotonicMs: 1_000, starvationWaitMs: 5_000 },
  );

  assert.equal(selected?.id, "pagamento-in-pressione");
  assert.equal(selected?.promoted, false);
  assert.equal(selected?.selectionReason, "normal");
});

test("lo scheduler ibrido promuove una sola lane realmente in aging", () => {
  const candidates = [
    {
      id: "normale",
      canSchedule: true,
      fairSequence: 20,
      enqueuedMonotonicAt: 9_500,
      normalPriority: 0,
    },
    {
      id: "in-aging",
      canSchedule: true,
      fairSequence: 10,
      enqueuedMonotonicAt: 2_000,
      normalPriority: 9,
    },
  ];
  const promoted = selectHybridSchedulableLane(candidates, {
    nowMonotonicMs: 10_000,
    starvationWaitMs: 5_000,
  });
  const cooldown = selectHybridSchedulableLane(candidates, {
    nowMonotonicMs: 10_000,
    starvationWaitMs: 5_000,
    allowAgedPromotion: false,
  });

  assert.equal(promoted?.id, "in-aging");
  assert.equal(promoted?.promoted, true);
  assert.equal(promoted?.waitMs, 8_000);
  assert.equal(cooldown?.id, "normale");
  assert.equal(cooldown?.promoted, false);
});

test("la regressione del clock monotono non crea una falsa promozione", () => {
  const selected = selectHybridSchedulableLane(
    [
      {
        id: "clock-regredito",
        canSchedule: true,
        fairSequence: 1,
        enqueuedMonotonicAt: 2_000,
        normalPriority: 9,
      },
      {
        id: "normale",
        canSchedule: true,
        fairSequence: 2,
        enqueuedMonotonicAt: 900,
        normalPriority: 0,
      },
    ],
    { nowMonotonicMs: 1_000, starvationWaitMs: 5_000 },
  );

  assert.equal(selected?.id, "normale");
  assert.equal(selected?.promoted, false);
});

test("il cooldown aging si resetta soltanto a scheduler domain drenato", () => {
  assert.equal(
    isDomainLaneSchedulerDrained({ queueDepth: 0, runningCount: 0 }),
    true,
  );
  assert.equal(
    isDomainLaneSchedulerDrained({ queueDepth: 1, runningCount: 0 }),
    false,
  );
  assert.equal(
    isDomainLaneSchedulerDrained({ queueDepth: 0, runningCount: 1 }),
    false,
  );
});

test("il reset burst esclude target e peer ancora attivi", () => {
  assert.deepEqual(
    selectIdlePeerLaneIds("waiterPause", [
      { id: "order", runningCount: 1 },
      { id: "waiterPause", runningCount: 0 },
      { id: "payment", runningCount: 0 },
      { id: "room", runningCount: 2 },
      { id: "notification", runningCount: 0 },
    ]),
    ["payment", "notification"],
  );
});

test("il reset burst segue il grafo delle esclusioni e non le lane compatibili", () => {
  const enabledFlags = {
    orders: true,
    tables: true,
    payments: true,
    presence: true,
  };
  assert.equal(
    domainLanePairConflicts("order", "waiterPause", enabledFlags),
    false,
  );
  assert.equal(
    domainLanePairConflicts("order", "payment", enabledFlags),
    true,
  );
  assert.deepEqual(
    selectIdlePeerLaneIds(
      "order",
      [
        { id: "waiterPause", runningCount: 0 },
        { id: "payment", runningCount: 0 },
        { id: "notification", runningCount: 0 },
        { id: "stationState", runningCount: 0 },
      ],
      enabledFlags,
    ),
    ["payment", "notification", "stationState"],
  );
  assert.deepEqual(
    selectIdlePeerLaneIds(
      "order",
      [{ id: "payment", runningCount: 0 }],
      { ...enabledFlags, payments: false },
    ),
    [],
  );
});

test("una lane senza pressione puo continuare oltre il limite burst", () => {
  assert.equal(
    canContinueLaneBurst({ burstCount: 12, burstLimit: 4 }),
    true,
  );
});

test("la pressione DB o peer applica il limite burst e rispetta i task bloccanti", () => {
  assert.equal(
    canContinueLaneBurst({
      burstCount: 3,
      burstLimit: 4,
      dbQueueDepth: 1,
    }),
    true,
  );
  assert.equal(
    canContinueLaneBurst({
      burstCount: 4,
      burstLimit: 4,
      peerQueueDepth: 1,
    }),
    false,
  );
  assert.equal(
    canContinueLaneBurst({
      burstCount: 0,
      burstLimit: 4,
      hasBlockingDbMutation: true,
    }),
    false,
  );
});

test("la matrice di pressione include esattamente le lane concorrenti", () => {
  const depths = {
    order: 1,
    payment: 2,
    room: 4,
    reservation: 8,
    notification: 16,
    waiterPause: 32,
    stationState: 64,
  };
  const enabled = {
    orders: true,
    tables: true,
    payments: true,
    presence: true,
  };

  assert.equal(getLanePeerQueuePressureDepth("order", depths, enabled), 94);
  assert.equal(getLanePeerQueuePressureDepth("payment", depths, enabled), 125);
  assert.equal(getLanePeerQueuePressureDepth("room", depths, enabled), 123);
  assert.equal(
    getLanePeerQueuePressureDepth("reservation", depths, enabled),
    119,
  );
  assert.equal(
    getLanePeerQueuePressureDepth("notification", depths, enabled),
    111,
  );
  assert.equal(
    getLanePeerQueuePressureDepth("waiterPause", depths, enabled),
    30,
  );
  assert.equal(
    getLanePeerQueuePressureDepth("stationState", depths, enabled),
    31,
  );
  assert.equal(getLanePeerQueuePressureDepth("print", depths, enabled), 0);
});

test("i flag disattivati eliminano solo le esclusioni opzionali", () => {
  const depths = {
    order: 1,
    payment: 2,
    room: 4,
    reservation: 8,
    notification: 16,
    waiterPause: 32,
    stationState: 64,
  };
  const disabled = {
    orders: false,
    tables: false,
    payments: false,
    presence: false,
  };

  assert.equal(getLanePeerQueuePressureDepth("order", depths, disabled), 0);
  assert.equal(getLanePeerQueuePressureDepth("payment", depths, disabled), 0);
  assert.equal(getLanePeerQueuePressureDepth("room", depths, disabled), 0);
  assert.equal(
    getLanePeerQueuePressureDepth("reservation", depths, disabled),
    0,
  );
  assert.equal(
    getLanePeerQueuePressureDepth("notification", depths, disabled),
    0,
  );
  assert.equal(
    getLanePeerQueuePressureDepth("waiterPause", depths, disabled),
    0,
  );
  assert.equal(
    getLanePeerQueuePressureDepth("stationState", depths, disabled),
    0,
  );
});

test("il canary tables rimuove anche la pressione notification-room", () => {
  const depths = {
    order: 1,
    payment: 2,
    room: 4,
    reservation: 8,
    notification: 16,
    waiterPause: 0,
    stationState: 0,
  };
  const flags = {
    orders: true,
    tables: false,
    payments: true,
    presence: true,
  };

  assert.equal(getLanePeerQueuePressureDepth("room", depths, flags), 3);
  assert.equal(getLanePeerQueuePressureDepth("reservation", depths, flags), 3);
  assert.equal(getLanePeerQueuePressureDepth("notification", depths, flags), 3);
});
