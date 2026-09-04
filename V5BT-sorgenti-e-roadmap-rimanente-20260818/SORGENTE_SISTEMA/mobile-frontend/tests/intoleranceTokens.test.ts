import { describe, expect, it } from "vitest";
import {
  collectIntoleranceTokens,
  composeIntoleranceTokens,
  parseIntoleranceTokens,
} from "../src/utils/intoleranceTokens";

describe("intolerance token helpers", () => {
  it("normalizza allergie e intolleranze da testo libero", () => {
    expect(parseIntoleranceTokens("Glutine, lattosio\nGlutine; Solfiti")).toEqual([
      "Glutine",
      "lattosio",
      "Solfiti",
    ]);
  });

  it("compone e raccoglie fonti diverse senza duplicati", () => {
    expect(composeIntoleranceTokens(["Glutine", " Glutine ", "Solfiti"])).toBe("Glutine, Solfiti");
    expect(collectIntoleranceTokens(["Glutine"], "Solfiti; Glutine")).toEqual([
      "Glutine",
      "Solfiti",
    ]);
  });
});
