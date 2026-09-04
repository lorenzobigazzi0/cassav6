import { useCallback, useEffect, useRef, type PointerEvent, type TouchEvent } from "react";
import { triggerLongPressHaptic } from "../../../../utils/haptics";

export function useSubmitLongPressAction<TPayload>({
  enabled,
  busy,
  hasPayload,
  delayMs,
  buildPayload,
  onLongPress,
}: {
  enabled: boolean;
  busy: boolean;
  hasPayload: boolean;
  delayMs: number;
  buildPayload: () => TPayload | null;
  onLongPress?: (payload: TPayload) => Promise<void> | void;
}) {
  const timerRef = useRef<number | null>(null);
  const triggeredRef = useRef(false);

  const startTimer = useCallback(() => {
    if (!enabled || busy || !hasPayload || !onLongPress) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    triggeredRef.current = false;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      triggeredRef.current = true;
      triggerLongPressHaptic();
      const payload = buildPayload();
      if (payload) void onLongPress(payload);
    }, delayMs);
  }, [buildPayload, busy, delayMs, enabled, hasPayload, onLongPress]);

  const clearTimer = useCallback((event?: PointerEvent<HTMLElement>) => {
    if (event?.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!enabled || busy || !hasPayload || !onLongPress) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      startTimer();
    },
    [busy, enabled, hasPayload, onLongPress, startTimer]
  );

  const onPointerEnd = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      clearTimer(event);
    },
    [clearTimer]
  );

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      if (event.touches.length !== 1) return;
      startTimer();
    },
    [startTimer]
  );

  const onTouchEnd = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  const onTouchCancel = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      event.preventDefault();
      clearTimer();
    },
    [clearTimer]
  );

  const consumeTriggered = useCallback(() => {
    const triggered = triggeredRef.current;
    if (triggered) triggeredRef.current = false;
    return triggered;
  }, []);

  return {
    onPointerDown,
    onPointerEnd,
    onTouchStart,
    onTouchEnd,
    onTouchCancel,
    consumeTriggered,
  };
}
