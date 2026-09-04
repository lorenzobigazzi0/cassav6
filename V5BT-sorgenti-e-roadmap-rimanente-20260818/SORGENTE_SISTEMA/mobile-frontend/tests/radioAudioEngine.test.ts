import { describe, expect, it } from "vitest";
import {
  buildMulawRadioFrames,
  createRadioCaptureFrameState,
} from "../src/radio/radioAudioEngine";
import { decodeRadioFrame, RADIO_FRAME_LIMITS } from "../src/radio/radioProtocol";

describe("radio audio frame builder", () => {
  it("builds 20ms 16kHz mu-law radio frames", () => {
    const state = createRadioCaptureFrameState();
    const input = new Float32Array(960);
    input.fill(0.5);

    const frames = buildMulawRadioFrames({
      streamId: 12,
      input,
      inputSampleRate: 48000,
      state,
      nowMs: 1000,
    });

    expect(frames).toHaveLength(1);
    const decoded = decodeRadioFrame(frames[0]);
    expect(decoded?.streamId).toBe(12);
    expect(decoded?.seq).toBe(0);
    expect(decoded?.timestampMs).toBe(1000);
    expect(decoded?.payload).toHaveLength(320);
    expect(state.nextTimestampMs).toBe(1000 + RADIO_FRAME_LIMITS.frameMs);
  });
});
