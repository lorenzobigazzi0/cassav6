import { describe, expect, it } from "vitest";

import { parseIntegrationLayoutTable } from "./integrationParsers";

describe("parseIntegrationLayoutTable", () => {
  it("usa totalDue come fallback di amountDue per non perdere il residuo pagabile", () => {
    const table = parseIntegrationLayoutTable({
      id: "room_pedana_t01",
      number: 1,
      roomId: "room_pedana",
      roomName: "Pedana",
      occupancyState: "seated",
      totalDue: 29.3,
    });

    expect(table?.amountDue).toBe(29.3);
  });

  it("usa dueAmount come fallback se amountDue e totalDue non sono presenti", () => {
    const table = parseIntegrationLayoutTable({
      id: "room_pedana_t02",
      number: 2,
      roomId: "room_pedana",
      roomName: "Pedana",
      occupancyState: "seated",
      dueAmount: 43.3,
    });

    expect(table?.amountDue).toBe(43.3);
  });

  it("non espone piu di 100 coperti per un singolo tavolo", () => {
    const table = parseIntegrationLayoutTable({
      id: "room_pedana_t03",
      number: 3,
      roomId: "room_pedana",
      roomName: "Pedana",
      occupancyState: "seated",
      covers: 101,
    });

    expect(table?.covers).toBe(100);
  });
});
