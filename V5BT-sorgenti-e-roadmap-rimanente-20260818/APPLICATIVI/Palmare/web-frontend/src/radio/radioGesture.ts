type WindowWithWebkitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

export const RADIO_PRESTART_MS = 200;
export const RADIO_START_MS = 1700;
export const RADIO_BUSY_TOTAL_MS = 666 * 3;
export const RADIO_ERROR_TOTAL_MS = 3_000;

type RadioToneKind = "bot" | "eot";

const activeToneCleanups = new Set<() => void>();
let radioTonesEnabled = true;

export function stopAllRadioTones() {
  Array.from(activeToneCleanups).forEach((cleanup) => cleanup());
}

export function setRadioTonesEnabled(enabled: boolean) {
  radioTonesEnabled = enabled;
  if (!enabled) stopAllRadioTones();
}

function playRadioLocalTone(kind: RadioToneKind) {
  if (!radioTonesEnabled) return;
  try {
    const AudioContextClass =
      window.AudioContext || (window as WindowWithWebkitAudioContext).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass({ latencyHint: "interactive" });
    const startAt = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const isBot = kind === "bot";
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(isBot ? 820 : 1480, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(isBot ? 1320 : 720, startAt + 0.075);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.28, startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + (isBot ? 0.105 : 0.13));
    let closed = false;
    let cleanupTimer: number | null = null;
    const closeToneContext = () => {
      if (closed) return;
      closed = true;
      activeToneCleanups.delete(closeToneContext);
      if (cleanupTimer !== null) {
        window.clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }
      try {
        oscillator.disconnect();
        gain.disconnect();
      } catch {
        // Ignore cleanup failures on older WebViews.
      }
      void context.close().catch(() => undefined);
    };
    activeToneCleanups.add(closeToneContext);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = closeToneContext;
    oscillator.start(startAt);
    oscillator.stop(startAt + (isBot ? 0.12 : 0.145));
    cleanupTimer = window.setTimeout(() => {
      closeToneContext();
    }, 260);
  } catch {
    // Local radio tones are an enhancement. Gesture flow must not fail if browser blocks them.
  }
}

export function playRadioBotTone() {
  playRadioLocalTone("bot");
}

export function playRadioEotTone() {
  playRadioLocalTone("eot");
}
