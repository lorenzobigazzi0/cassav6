import test from "node:test";
import assert from "node:assert/strict";
import { chooseBestStationForOrder } from "../integration/load-balancer.service.js";

function activeStation(station, updatedAtMs = Date.now(), overrides = {}) {
  return {
    station,
    active: true,
    realStation: true,
    operatorUserId: `user_${station.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    operatorUsername: station.toLowerCase(),
    operatorName: station,
    operatorRole: "operator",
    deviceUuid: `device_${station}`,
    updatedAtMs,
    ...overrides,
  };
}

test("load balancer ignora postazioni non eleggibili per la comanda", () => {
  const now = Date.now();
  const state = {
    integration: {
      stationStates: [
        activeStation("BAR-1", now - 1000),
        activeStation("BAR-2", now - 2000),
      ],
      orders: [],
    },
  };
  const order = {
    id: "001",
    items: [{ id: "line_1", productId: "prod_caffe", category: "Caffetteria", qty: 1 }],
  };
  const choice = chooseBestStationForOrder(state, order, {
    nowMs: now,
    isStationEligible: (station) => station.station !== "BAR-1",
  });

  assert.equal(choice.stationId, "BAR-2");
  assert.equal(choice.reason, "least_estimated_workload");
});

test("load balancer segnala assenza di postazioni eleggibili se il filtro esclude tutte", () => {
  const now = Date.now();
  const state = {
    integration: {
      stationStates: [
        activeStation("BAR-1", now - 1000),
        activeStation("BAR-2", now - 2000),
      ],
      orders: [],
    },
  };
  const choice = chooseBestStationForOrder(state, { id: "002", items: [] }, {
    nowMs: now,
    isStationEligible: () => false,
  });

  assert.equal(choice.stationId, null);
  assert.equal(choice.reason, "no_eligible_active_station");
});

test("load balancer distribuisce in modo deterministico a parita di carico anche con storico sbilanciato", () => {
  const now = Date.now();
  const history = [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `slow_bar_1_${index}`,
      stationId: "BAR-1",
      operatorUserId: "u_chiara",
      durationSeconds: 2000,
      itemsCount: 1,
      includedInOperationalAverage: true,
      completedAt: new Date(now - (200 - index) * 1000).toISOString(),
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `fast_roberto_${index}`,
      stationId: "BAR-2",
      operatorUserId: "user_bar_2",
      durationSeconds: 60,
      itemsCount: 1,
      includedInOperationalAverage: true,
      completedAt: new Date(now - (100 - index) * 1000).toISOString(),
    })),
  ];
  const state = {
    integration: {
      stationStates: [
        activeStation("BAR-1", now),
        activeStation("BAR-2", now),
      ],
      orders: [],
      orderFulfillmentHistory: history,
    },
  };

  const oddChoice = chooseBestStationForOrder(state, { id: "001", items: [{ qty: 1 }] }, { nowMs: now });
  const evenChoice = chooseBestStationForOrder(state, { id: "002", items: [{ qty: 1 }] }, { nowMs: now });

  assert.equal(oddChoice.stationId, "BAR-2");
  assert.equal(evenChoice.stationId, "BAR-1");
  const evenCandidates = Object.fromEntries(evenChoice.candidates.map((entry) => [entry.stationId, entry]));
  assert.ok(evenCandidates["BAR-1"].orderSeconds > evenCandidates["BAR-2"].orderSeconds);
});

test("load balancer preferisce la postazione senza carico aperto prima della rotazione", () => {
  const now = Date.now();
  const state = {
    integration: {
      stationStates: [
        activeStation("BAR-1", now),
        activeStation("BAR-2", now),
      ],
      orders: [
        {
          id: "open_on_bar_1",
          assignedStationId: "BAR-1",
          assignedStationOperatorUserId: "user_bar_1",
          workflowStatus: "waiting",
          paymentStatus: "unpaid",
          dueAmount: 10,
          items: [{ qty: 3 }],
        },
      ],
      orderFulfillmentHistory: [],
    },
  };

  const choice = chooseBestStationForOrder(state, { id: "002", items: [{ qty: 1 }] }, { nowMs: now });

  assert.equal(choice.stationId, "BAR-2");
});

test("load balancer considera una sola postazione attiva per lo stesso device", () => {
  const now = Date.now();
  const state = {
    integration: {
      stationStates: [
        activeStation("BAR-1", now - 1000, { deviceUuid: "shared-device" }),
        activeStation("BAR-2", now, { deviceUuid: "shared-device" }),
      ],
      orders: [],
      orderFulfillmentHistory: [],
    },
  };

  const choice = chooseBestStationForOrder(state, { id: "same-device", items: [{ qty: 1 }] }, { nowMs: now });

  assert.equal(choice.stationId, "BAR-2");
  assert.deepEqual(choice.candidates.map((entry) => entry.stationId), ["BAR-2"]);
});

test("load balancer conta il carico della postazione anche se cambia identita operatore", () => {
  const now = Date.now();
  const state = {
    integration: {
      stationStates: [
        activeStation("BAR-1", now, { operatorUserId: "user_bar_1" }),
        activeStation("BAR-2", now, { operatorUserId: "user_bar_2" }),
      ],
      orders: [
        {
          id: "open_on_bar_2_without_operator_identity",
          assignedStationId: "BAR-2",
          workflowStatus: "waiting",
          paymentStatus: "unpaid",
          dueAmount: 10,
          items: [{ qty: 2 }],
        },
      ],
      orderFulfillmentHistory: [],
    },
  };

  const choice = chooseBestStationForOrder(state, { id: "next", items: [{ qty: 1 }] }, { nowMs: now });

  assert.equal(choice.stationId, "BAR-1");
});

test("load balancer non favorisce sempre la postazione storicamente piu veloce se ha piu coda", () => {
  const now = Date.now();
  const history = [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `slow_bar_1_${index}`,
      stationId: "BAR-1",
      operatorUserId: "user_bar_1",
      durationSeconds: 2000,
      itemsCount: 1,
      includedInOperationalAverage: true,
      completedAt: new Date(now - (200 - index) * 1000).toISOString(),
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `fast_bar_2_${index}`,
      stationId: "BAR-2",
      operatorUserId: "user_bar_2",
      durationSeconds: 60,
      itemsCount: 1,
      includedInOperationalAverage: true,
      completedAt: new Date(now - (100 - index) * 1000).toISOString(),
    })),
  ];
  const state = {
    integration: {
      stationStates: [
        activeStation("BAR-1", now, { operatorUserId: "user_bar_1" }),
        activeStation("BAR-2", now, { operatorUserId: "user_bar_2" }),
      ],
      orders: [
        {
          id: "open_on_bar_1",
          assignedStationId: "BAR-1",
          assignedStationOperatorUserId: "user_bar_1",
          workflowStatus: "waiting",
          paymentStatus: "unpaid",
          dueAmount: 10,
          items: [{ qty: 4 }],
        },
        {
          id: "open_on_bar_2_a",
          assignedStationId: "BAR-2",
          assignedStationOperatorUserId: "user_bar_2",
          workflowStatus: "waiting",
          paymentStatus: "unpaid",
          dueAmount: 10,
          items: [{ qty: 3 }],
        },
        {
          id: "open_on_bar_2_b",
          assignedStationId: "BAR-2",
          assignedStationOperatorUserId: "user_bar_2",
          workflowStatus: "waiting",
          paymentStatus: "unpaid",
          dueAmount: 10,
          items: [{ qty: 4 }],
        },
      ],
      orderFulfillmentHistory: history,
    },
  };

  const choice = chooseBestStationForOrder(state, { id: "next", items: [{ qty: 1 }] }, { nowMs: now });

  assert.equal(choice.stationId, "BAR-1");
});
