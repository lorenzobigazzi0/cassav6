import net from "node:net";
import { test as base, expect } from "@playwright/test";
import {
  readJson,
  startBackend,
  startFrontendServer,
} from "../../backend/tests/helpers/test-server.mjs";

export { expect };

async function startFakeTcpPrinter(harness) {
  const chunks = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  harness.after(() => {
    server.close();
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    chunks,
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

function installGuiPrinterConfig(state, port) {
  const printer = {
    id: "printer_gui_tcp",
    name: "GUI TCP Printer",
    host: "127.0.0.1",
    port,
    purpose: "generic",
    active: true,
  };
  const roomIds = ["room_pedana", "room_sala", "sala_terrazza"];
  const workstations = [
    {
      id: "workstation_bar_principale",
      name: "BAR PRINCIPALE",
      stationName: "BAR PRINCIPALE",
      active: true,
      status: "active",
      roomIds,
      printerIds: [printer.id],
      precontoPrinterIds: [printer.id],
    },
    {
      id: "workstation_bar_secondario",
      name: "BAR SECONDARIO",
      stationName: "BAR SECONDARIO",
      active: true,
      status: "active",
      roomIds,
      printerIds: [printer.id],
      precontoPrinterIds: [printer.id],
    },
  ];
  state.posSettings.printers = [printer];
  state.posSettings.activities = [
    {
      id: "activity_gui",
      name: "GUI Test",
      status: "active",
      printerIds: [printer.id],
      precontoPrinterIds: [printer.id],
      workstationIds: workstations.map((workstation) => workstation.id),
    },
  ];
  state.posSettings.activityRoomBindings = roomIds.map((roomId) => ({
    id: `activity_gui_${roomId}`,
    activityId: "activity_gui",
    roomId,
    status: "active",
  }));
  state.posSettings.workstations = workstations;
  state.posSettings.areas = roomIds.map((id) => ({
    id,
    name: id === "sala_terrazza" ? "Terrazza" : id === "room_sala" ? "Sala" : "Pedana",
    printerIds: [printer.id],
    precontoPrinterIds: [printer.id],
    cashPoints: [
      {
        id: `${id}_cash`,
        name: `${id} cassa`,
        printerIds: [printer.id],
        fiscalPrinterId: null,
      },
    ],
    workstations: workstations.map((workstation) => ({
      ...workstation,
      id: `${id}_${workstation.id}`,
    })),
  }));
}

export const test = base.extend({
  app: async ({}, use) => {
    const cleanups = [];
    const harness = {
      after(fn) {
        cleanups.push(fn);
      },
    };
    const printer = await startFakeTcpPrinter(harness);
    const backend = await startBackend(harness, {
      env: {
        PRINTING_ENABLED: "1",
        PRINT_TCP_TIMEOUT_MS: "1500",
      },
      stateOverrides: (state) => installGuiPrinterConfig(state, printer.port),
    });
    const frontend = await startFrontendServer(harness, { backendOrigin: backend.baseUrl });

    try {
      await use({
        backendUrl: backend.baseUrl,
        frontendUrl: frontend.baseUrl,
        dbPath: backend.dbPath,
        printer,
        readState: () => readJson(backend.dbPath),
      });
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch {
          // best effort cleanup
        }
      }
    }
  },
});
