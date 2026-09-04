import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimedPricingRefresh } from "../src/pages/home/menu/hooks/useTimedPricingRefresh";

describe("useTimedPricingRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules one refresh shortly after the next price change", () => {
    const onRefresh = vi.fn();
    renderHook(() =>
      useTimedPricingRefresh({
        products: [{ price: 8, nextPriceChangeAt: "2026-05-22T18:00:01.000Z" }],
        onRefresh,
      })
    );

    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(onRefresh).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("cleans the scheduled timer on unmount", () => {
    const onRefresh = vi.fn();
    const { unmount } = renderHook(() =>
      useTimedPricingRefresh({
        products: [{ price: 8, nextPriceChangeAt: "2026-05-22T18:00:01.000Z" }],
        onRefresh,
      })
    );

    unmount();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not create a timer when nextPriceChangeAt is absent", () => {
    const onRefresh = vi.fn();
    renderHook(() =>
      useTimedPricingRefresh({
        products: [{ price: 8 }],
        onRefresh,
      })
    );

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
