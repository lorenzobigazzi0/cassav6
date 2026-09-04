import { describe, expect, it } from "vitest";
import { resampleLinear } from "../src/radio/resample";

describe("radio resampling", () => {
  it("returns a copy when sample rates match", () => {
    const input = new Float32Array([0, 0.5, 1]);
    const output = resampleLinear(input, 16000, 16000);

    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it("produces the expected output length when downsampling", () => {
    const input = new Float32Array(480);
    const output = resampleLinear(input, 48000, 16000);

    expect(output).toHaveLength(160);
  });

  it("does not produce NaN values on simple interpolation", () => {
    const output = resampleLinear(new Float32Array([0, 1]), 2, 4);

    expect(output).toHaveLength(4);
    for (const sample of output) {
      expect(Number.isNaN(sample)).toBe(false);
    }
  });
});
