import { describe, expect, it } from "vitest";
import { getRadioChannelColor, resolveRadioZone } from "../src/radio/radioUi";
import type { RadioChannel } from "../src/radio/radioTypes";

const channel = (id: string, color = "#123456"): RadioChannel => ({
  id,
  name: id,
  enabled: true,
  color,
  sortOrder: 0,
});

describe("radio bottom bar UI helpers", () => {
  it("uses the full bar when only one channel is active", () => {
    expect(resolveRadioZone(10, { left: 0, width: 300 }, [channel("cucina")])?.index).toBe(0);
    expect(resolveRadioZone(299, { left: 0, width: 300 }, [channel("cucina")])?.index).toBe(0);
  });

  it("splits two or three active channels into equal zones", () => {
    const two = [channel("cucina"), channel("bar")];
    expect(resolveRadioZone(40, { left: 0, width: 300 }, two)?.channel.id).toBe("cucina");
    expect(resolveRadioZone(220, { left: 0, width: 300 }, two)?.channel.id).toBe("bar");

    const three = [channel("cucina"), channel("bar"), channel("cassa")];
    expect(resolveRadioZone(20, { left: 0, width: 300 }, three)?.channel.id).toBe("cucina");
    expect(resolveRadioZone(150, { left: 0, width: 300 }, three)?.channel.id).toBe("bar");
    expect(resolveRadioZone(299, { left: 0, width: 300 }, three)?.channel.id).toBe("cassa");
  });

  it("clamps pointer positions and falls back to slot colors", () => {
    const slots = [channel("a", "bad"), channel("b", "#abcdef")];
    expect(resolveRadioZone(-100, { left: 0, width: 300 }, slots)?.channel.id).toBe("a");
    expect(resolveRadioZone(999, { left: 0, width: 300 }, slots)?.channel.id).toBe("b");
    expect(getRadioChannelColor(slots[0], 0)).toBe("#ff9f43");
    expect(getRadioChannelColor(slots[1], 1)).toBe("#abcdef");
  });
});
