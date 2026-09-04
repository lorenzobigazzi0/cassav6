import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSubmitLongPressAction } from "../src/pages/home/tables/components/useSubmitLongPressAction";

vi.mock("../src/utils/haptics", () => ({
  triggerLongPressHaptic: vi.fn(),
}));

function SubmitLongPressProbe({
  onLongPress,
  onShortPress,
}: {
  onLongPress: (payload: { id: string }) => void;
  onShortPress: () => void;
}) {
  const submitLongPress = useSubmitLongPressAction({
    enabled: true,
    busy: false,
    hasPayload: true,
    delayMs: 1000,
    buildPayload: () => ({ id: "payload" }),
    onLongPress,
  });

  return (
    <button
      type="button"
      data-testid="submit"
      onPointerDown={submitLongPress.onPointerDown}
      onPointerUp={submitLongPress.onPointerEnd}
      onPointerCancel={submitLongPress.onPointerEnd}
      onTouchStart={submitLongPress.onTouchStart}
      onTouchEnd={submitLongPress.onTouchEnd}
      onTouchCancel={submitLongPress.onTouchCancel}
      onClick={() => {
        if (submitLongPress.consumeTriggered()) return;
        onShortPress();
      }}
    >
      RISCUOTI
    </button>
  );
}

describe("useSubmitLongPressAction", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("fires long press from touch events and consumes the following click", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const onShortPress = vi.fn();
    render(<SubmitLongPressProbe onLongPress={onLongPress} onShortPress={onShortPress} />);
    const submit = screen.getByTestId("submit");

    fireEvent.touchStart(submit, { touches: [{ identifier: 1, clientX: 0, clientY: 0 }] });
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.touchEnd(submit);
    fireEvent.click(submit);

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith({ id: "payload" });
    expect(onShortPress).not.toHaveBeenCalled();

    fireEvent.click(submit);
    expect(onShortPress).toHaveBeenCalledTimes(1);
  });

  it("keeps short touch as a normal click when hold time is not reached", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const onShortPress = vi.fn();
    render(<SubmitLongPressProbe onLongPress={onLongPress} onShortPress={onShortPress} />);
    const submit = screen.getByTestId("submit");

    fireEvent.touchStart(submit, { touches: [{ identifier: 1, clientX: 0, clientY: 0 }] });
    act(() => vi.advanceTimersByTime(999));
    fireEvent.touchEnd(submit);
    fireEvent.click(submit);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(onShortPress).toHaveBeenCalledTimes(1);
  });

  it("fires long press from touch pointer events when no touch event is emitted", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const onShortPress = vi.fn();
    render(<SubmitLongPressProbe onLongPress={onLongPress} onShortPress={onShortPress} />);
    const submit = screen.getByTestId("submit");

    fireEvent.pointerDown(submit, { pointerId: 9, pointerType: "touch" });
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.pointerUp(submit, { pointerId: 9, pointerType: "touch" });
    fireEvent.click(submit);

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith({ id: "payload" });
    expect(onShortPress).not.toHaveBeenCalled();
  });
});
