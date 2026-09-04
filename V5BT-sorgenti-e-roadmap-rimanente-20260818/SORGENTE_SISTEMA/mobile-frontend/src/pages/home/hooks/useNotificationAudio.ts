import { useCallback, useEffect, useRef } from "react";
import { subscribeMobileSessionEnding } from "../../../app/session/sessionLifecycle";
import { cancelHapticPulse, triggerHapticPulse } from "../../../utils/haptics";

type WaveType = OscillatorType;

type NotificationAudioOptions = {
  enabled: boolean;
  waiterCount: number;
  bellCount: number;
};

export function useNotificationAudio({
  enabled,
  waiterCount,
  bellCount,
}: NotificationAudioOptions) {
  const enabledRef = useRef(enabled);
  const contextRef = useRef<AudioContext | null>(null);
  const queueAtRef = useRef(0);
  const repeatTimerRef = useRef<number | null>(null);
  const ringTimerRef = useRef<number | null>(null);
  enabledRef.current = enabled;

  const stop = useCallback(() => {
    enabledRef.current = false;
    cancelHapticPulse();
    if (repeatTimerRef.current !== null) {
      window.clearInterval(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (ringTimerRef.current !== null) {
      window.clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    queueAtRef.current = 0;
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== "closed") {
      const closing = context.close();
      void closing?.catch(() => undefined);
    }
  }, []);

  const getContext = useCallback(() => {
    if (!enabledRef.current) return null;
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    const context = contextRef.current || new AudioContextClass();
    contextRef.current = context;
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }
    return context;
  }, []);

  const enqueue = useCallback(
    (pattern: Array<{ freq: number; dur: number }>, wave: WaveType, gainPeak: number) => {
      if (!enabledRef.current) return;
      const context = getContext();
      if (!context) return;
      const now = context.currentTime;
      const startAt = Math.max(queueAtRef.current, now);
      let cursor = startAt;
      pattern.forEach(({ freq, dur }) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = wave;
        oscillator.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, cursor);
        gain.gain.exponentialRampToValueAtTime(gainPeak, cursor + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, cursor + dur);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(cursor);
        oscillator.stop(cursor + dur + 0.02);
        cursor += dur + 0.06;
      });
      queueAtRef.current = cursor + 0.04;
    },
    [getContext]
  );

  const playWaiterTone = useCallback(
    () =>
      enqueue(
        [
          { freq: 1568, dur: 0.11 },
          { freq: 2093, dur: 0.13 },
          { freq: 1760, dur: 0.16 },
        ],
        "triangle",
        0.56
      ),
    [enqueue]
  );

  const playBellTone = useCallback(
    () =>
      enqueue(
        [
          { freq: 1318, dur: 0.1 },
          { freq: 1760, dur: 0.11 },
          { freq: 2349, dur: 0.13 },
          { freq: 1760, dur: 0.13 },
        ],
        "triangle",
        0.62
      ),
    [enqueue]
  );

  const playGeneralTone = useCallback(
    () =>
      enqueue(
        [
          { freq: 1760, dur: 0.08 },
          { freq: 2637, dur: 0.11 },
        ],
        "sine",
        0.48
      ),
    [enqueue]
  );

  const playHandheldRingTone = useCallback(() => {
    if (!enabledRef.current) return;
    enqueue(
      [
        { freq: 988, dur: 0.1 },
        { freq: 1976, dur: 0.12 },
        { freq: 988, dur: 0.1 },
        { freq: 1976, dur: 0.12 },
        { freq: 1318, dur: 0.16 },
      ],
      "square",
      0.72
    );
    if (ringTimerRef.current !== null) window.clearTimeout(ringTimerRef.current);
    ringTimerRef.current = window.setTimeout(() => {
      ringTimerRef.current = null;
      if (!enabledRef.current) return;
      enqueue(
        [
          { freq: 1175, dur: 0.1 },
          { freq: 2349, dur: 0.12 },
          { freq: 1175, dur: 0.1 },
          { freq: 2349, dur: 0.12 },
          { freq: 1568, dur: 0.16 },
        ],
        "square",
        0.72
      );
    }, 850);
    triggerHapticPulse([220, 120, 220, 120, 360]);
  }, [enqueue]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) stop();
  }, [enabled, stop]);

  useEffect(() => {
    if (!enabled || (waiterCount === 0 && bellCount === 0)) return undefined;
    repeatTimerRef.current = window.setInterval(() => {
      if (!enabledRef.current) return;
      if (waiterCount > 0) playWaiterTone();
      if (bellCount > 0) playBellTone();
    }, 5000);
    return () => {
      if (repeatTimerRef.current !== null) {
        window.clearInterval(repeatTimerRef.current);
        repeatTimerRef.current = null;
      }
    };
  }, [bellCount, enabled, playBellTone, playWaiterTone, waiterCount]);

  useEffect(() => {
    const unsubscribe = subscribeMobileSessionEnding(stop);
    return () => {
      unsubscribe();
      stop();
    };
  }, [stop]);

  return { playWaiterTone, playBellTone, playGeneralTone, playHandheldRingTone, stop };
}
