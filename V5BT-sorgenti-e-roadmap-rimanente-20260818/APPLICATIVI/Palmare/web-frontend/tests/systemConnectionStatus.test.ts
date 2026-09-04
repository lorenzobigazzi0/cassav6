import { describe, expect, it } from "vitest";
import {
  getSystemConnectionLabel,
  getSystemConnectionRingColor,
} from "../src/app/runtime/systemConnectionStatus";

describe("system connection status UI", () => {
  it("maps backend connection states to the former status LED labels and colors", () => {
    expect(getSystemConnectionLabel("online")).toBe("Server connesso");
    expect(getSystemConnectionLabel("reconnecting")).toBe("Server in riconnessione");
    expect(getSystemConnectionLabel("offline")).toBe("Server offline");

    expect(getSystemConnectionRingColor("online")).toBe("#2fdc86");
    expect(getSystemConnectionRingColor("reconnecting")).toBe("#f2b84d");
    expect(getSystemConnectionRingColor("offline")).toBe("#ff6a6a");
  });
});
