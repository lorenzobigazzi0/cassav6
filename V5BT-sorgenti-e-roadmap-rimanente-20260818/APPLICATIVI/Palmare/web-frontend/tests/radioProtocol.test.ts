import { describe, expect, it } from "vitest";
import {
  decodeRadioFrame,
  encodeRadioFrame,
  formatPttElapsed,
  formatRadioSpeakerName,
  normalizeRadioSlots,
  resolveActiveRadioSlots,
} from "../src/radio/radioProtocol";
import type { RadioChannel } from "../src/radio/radioTypes";

const CHANNELS: RadioChannel[] = [
  {
    id: "sala",
    name: "Sala",
    enabled: true,
    color: "#2f80ed",
    sortOrder: 1,
  },
  {
    id: "bar",
    name: "Bar",
    enabled: true,
    color: "#27ae60",
    sortOrder: 2,
  },
  {
    id: "disabled",
    name: "Disabilitato",
    enabled: false,
    color: "#eb5757",
    sortOrder: 3,
  },
];

describe("radio protocol helpers", () => {
  it("encodes and decodes a binary radio frame", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeRadioFrame({
      streamId: 42,
      seq: 7,
      timestampMs: 123456,
      payload,
    });

    const decoded = decodeRadioFrame(frame);

    expect(decoded).toEqual({
      streamId: 42,
      seq: 7,
      timestampMs: 123456,
      payload,
    });
  });

  it("rejects malformed radio frames", () => {
    expect(decodeRadioFrame(new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });

  it("normalizes slots to exactly three entries", () => {
    expect(normalizeRadioSlots(["sala", "", "bar", "extra"])).toEqual(["sala", null, "bar"]);
  });

  it("resolves only enabled unique active channels", () => {
    expect(resolveActiveRadioSlots(CHANNELS, ["sala", "disabled", "sala"]).map((channel) => channel.id)).toEqual([
      "sala",
    ]);
  });

  it("formats speaker names and elapsed PTT time", () => {
    expect(formatRadioSpeakerName("Lorenzo Bigazzi")).toBe("Lorenzo B.");
    expect(formatRadioSpeakerName("Lorenzo")).toBe("Lorenzo");
    expect(formatPttElapsed(0)).toBe("00:00");
    expect(formatPttElapsed(61_000)).toBe("01:01");
  });
});
