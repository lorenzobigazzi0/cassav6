import { describe, expect, it } from "vitest";
import { parseBackendHealthPayload } from "../src/api/systemStatus";

describe("backend health parsing", () => {
  it("requires backend and database health to be ok", () => {
    expect(parseBackendHealthPayload({ ok: true, database: { ok: true } })).toEqual({ ok: true });
    expect(parseBackendHealthPayload({ ok: true, database: { ok: false } })).toEqual({ ok: false });
    expect(parseBackendHealthPayload({ ok: true })).toEqual({ ok: false });
    expect(parseBackendHealthPayload({ ok: false, database: { ok: true } })).toEqual({ ok: false });
  });

  it("ignores fiscal failures for the avatar connection ring", () => {
    expect(
      parseBackendHealthPayload({
        ok: true,
        database: { ok: true },
        fiscal: { ok: false },
      })
    ).toEqual({ ok: true });
  });
});
