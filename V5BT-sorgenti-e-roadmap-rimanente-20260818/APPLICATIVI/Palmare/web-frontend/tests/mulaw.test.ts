import { describe, expect, it } from "vitest";
import { calculatePcmLevel, decodeMuLaw, encodeMuLaw } from "../src/radio/mulaw";

describe("radio mu-law codec", () => {
  it("encodes and decodes finite samples within PCM range", () => {
    const pcm = new Float32Array([-1, -0.5, 0, 0.5, 1, Number.NaN]);
    const encoded = encodeMuLaw(pcm);
    const decoded = decodeMuLaw(encoded);

    expect(encoded).toHaveLength(pcm.length);
    for (const sample of decoded) {
      expect(Number.isNaN(sample)).toBe(false);
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });

  it("keeps silence close to zero and calculates stable levels", () => {
    const decodedSilence = decodeMuLaw(encodeMuLaw(new Float32Array([0, 0, 0, 0])));
    expect(Math.abs(decodedSilence[0])).toBeLessThan(0.01);
    expect(calculatePcmLevel(new Float32Array([0, 0, 0, 0]))).toBe(0);
    expect(calculatePcmLevel(new Float32Array([1, -1, 1, -1]))).toBe(1);
  });
});
