import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCounterCashDefaultSource,
  setCounterCashDefaultSource,
  subscribeCounterCashDefaultSource,
} from "../src/utils/automaticCashPaymentPreferences";

describe("automatic cash payment preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("preserves the legacy fallback while isolating each user preference", () => {
    window.localStorage.setItem("mobile_counter_cash_default_source", "automatic");

    expect(getCounterCashDefaultSource("USER A")).toBe("automatic");
    setCounterCashDefaultSource("wallet", "USER A");

    expect(getCounterCashDefaultSource("USER A")).toBe("wallet");
    expect(getCounterCashDefaultSource("USER B")).toBe("automatic");
    expect(window.localStorage.getItem("mobile_counter_cash_default_source:user_a")).toBe("wallet");
  });

  it("publishes one scoped change and removes the listener during cleanup", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCounterCashDefaultSource(listener);

    setCounterCashDefaultSource("automatic", "operator");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setCounterCashDefaultSource("wallet", "operator");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
