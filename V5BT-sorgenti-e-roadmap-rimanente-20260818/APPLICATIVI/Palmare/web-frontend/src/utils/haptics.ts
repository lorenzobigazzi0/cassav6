type NativeHapticsBridge = {
  pulse?: (durationMs: number) => boolean;
  pattern?: (patternCsv: string) => boolean;
};

const DEFAULT_HAPTIC_MS = 36;
const LONG_PRESS_HAPTIC_MS = 72;

declare global {
  interface Window {
    AmaliaNativeHaptics?: NativeHapticsBridge;
  }
}

export function triggerHapticPulse(pattern: number | number[] = DEFAULT_HAPTIC_MS) {
  try {
    const nativeHaptics = typeof window === "undefined" ? undefined : window.AmaliaNativeHaptics;
    if (nativeHaptics) {
      const nativeResult = Array.isArray(pattern)
        ? nativeHaptics.pattern?.(pattern.join(","))
        : nativeHaptics.pulse?.(pattern);
      if (nativeResult) return;
    }
    if (typeof navigator === "undefined") return;
    navigator.vibrate?.(pattern);
  } catch {
    // Some WebViews expose vibrate but reject calls outside supported contexts.
  }
}

export function cancelHapticPulse() {
  try {
    if (typeof navigator === "undefined") return;
    navigator.vibrate?.(0);
  } catch {
    // Best-effort cancellation for browsers without vibration support.
  }
}

export function triggerLongPressHaptic() {
  triggerHapticPulse(LONG_PRESS_HAPTIC_MS);
}
