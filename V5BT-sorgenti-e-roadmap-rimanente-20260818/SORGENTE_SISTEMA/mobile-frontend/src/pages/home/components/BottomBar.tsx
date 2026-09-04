import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  RADIO_BUSY_TOTAL_MS,
  RADIO_ERROR_TOTAL_MS,
  RADIO_PRESTART_MS,
  RADIO_START_MS,
} from "../../../radio/radioGesture";
import { resolveRadioZone, type RadioZone } from "../../../radio/radioUi";
import { useRadio } from "../../../radio/useRadio";
import { triggerLongPressHaptic } from "../../../utils/haptics";

export type BottomTabKey = "home" | "menu" | "tavoli" | "prenotazioni" | "analytics";

export type BottomTabItem = {
  key: BottomTabKey;
  label: string;
  icon: React.ReactNode;
};

interface BottomBarProps {
  tabs: BottomTabItem[];
  activeTab: BottomTabKey;
  onChange: (tab: BottomTabKey) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const DRAG_SWITCH_DEBOUNCE_MS = 72;
const DRAG_START_THRESHOLD_PX = 14;
const RADIO_GESTURE_ARM_DELAY_MS = 320;
const RADIO_START_AFTER_ARM_MS = Math.max(0, RADIO_START_MS - RADIO_GESTURE_ARM_DELAY_MS);
const TOUCH_RADIO_POINTER_ID = -10_001;

type RadioGesturePhase = "idle" | "prestart" | "requesting" | "transmitting" | "busy" | "error";

type RadioGestureUiState = {
  phase: RadioGesturePhase;
  zone: RadioZone | null;
  startedAt: number | null;
  message: string | null;
  detail: string | null;
};

type RadioGestureRef = {
  pointerId: number;
  startX: number;
  startY: number;
  token: number;
  phase: "pending" | Exclude<RadioGesturePhase, "idle">;
  zone: RadioZone;
  consumedNavigation: boolean;
};

const EMPTY_RADIO_UI: RadioGestureUiState = {
  phase: "idle",
  zone: null,
  startedAt: null,
  message: null,
  detail: null,
};

export function BottomBar({ tabs, activeTab, onChange }: BottomBarProps) {
  const radio = useRadio();
  const [dragging, setDragging] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [stretch, setStretch] = useState(1);
  const [stretchOrigin, setStretchOrigin] = useState<"0%" | "50%" | "100%">("50%");
  const [radioUi, setRadioUi] = useState<RadioGestureUiState>(EMPTY_RADIO_UI);
  const barRef = useRef<HTMLDivElement | null>(null);
  const lastClientXRef = useRef<number | null>(null);
  const lastDragCommitAtRef = useRef(0);
  const queuedDragTabRef = useRef<BottomTabKey | null>(null);
  const interactionRef = useRef<"tap" | "drag">("tap");
  const pulseTimerRef = useRef<number | null>(null);
  const pulseRafRef = useRef<number | null>(null);
  const radioTimersRef = useRef<number[]>([]);
  const radioBeginTimerRef = useRef<number | null>(null);
  const radioResetTimerRef = useRef<number | null>(null);
  const radioGestureRef = useRef<RadioGestureRef | null>(null);
  const radioGestureTokenRef = useRef(0);
  const suppressNextClickRef = useRef(false);
  const gestureRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const radioPttAvailable = radio.activeSlots.length > 0;
  const activeIndex = useMemo(
    () =>
      Math.max(
        0,
        tabs.findIndex((item) => item.key === activeTab)
      ),
    [tabs, activeTab]
  );

  const triggerPulse = useCallback(() => {
    if (dragging) return;
    // Keep pulse centered on the selected tab hitbox.
    setStretch(1);
    setStretchOrigin("50%");
    setDragIndex(null);
    if (pulseTimerRef.current !== null) {
      window.clearTimeout(pulseTimerRef.current);
    }
    if (pulseRafRef.current !== null) {
      window.cancelAnimationFrame(pulseRafRef.current);
    }
    setPulse(false);
    pulseRafRef.current = window.requestAnimationFrame(() => {
      setPulse(true);
      pulseTimerRef.current = window.setTimeout(() => {
        setPulse(false);
        pulseTimerRef.current = null;
      }, 340);
      pulseRafRef.current = null;
    });
  }, [dragging]);

  const clearRadioTimers = useCallback(() => {
    radioTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    radioTimersRef.current = [];
  }, []);

  const clearRadioResetTimer = useCallback(() => {
    if (radioResetTimerRef.current !== null) {
      window.clearTimeout(radioResetTimerRef.current);
      radioResetTimerRef.current = null;
    }
  }, []);

  const clearPendingRadioBegin = useCallback(() => {
    if (radioBeginTimerRef.current !== null) {
      window.clearTimeout(radioBeginTimerRef.current);
      radioBeginTimerRef.current = null;
    }
  }, []);

  const setRadioGesturePhase = useCallback(
    (
      gesture: RadioGestureRef,
      phase: Exclude<RadioGesturePhase, "idle">,
      extra: Partial<RadioGestureUiState> = {}
    ) => {
      gesture.phase = phase;
      if (phase !== "prestart") {
        gesture.consumedNavigation = true;
      }
      setRadioUi({
        phase,
        zone: gesture.zone,
        startedAt: extra.startedAt ?? null,
        message: extra.message ?? null,
        detail: extra.detail ?? null,
      });
    },
    []
  );

  const resetRadioUi = useCallback(() => {
    clearRadioResetTimer();
    setRadioUi(EMPTY_RADIO_UI);
  }, [clearRadioResetTimer]);

  const scheduleRadioReset = useCallback(
    (delayMs: number) => {
      clearRadioResetTimer();
      radioResetTimerRef.current = window.setTimeout(() => {
        radioResetTimerRef.current = null;
        setRadioUi(EMPTY_RADIO_UI);
      }, delayMs);
    },
    [clearRadioResetTimer]
  );

  const finishRadioGesture = useCallback(
    (pointerId: number, reason: "release" | "cancel" | "screen-exit") => {
      const gesture = radioGestureRef.current;
      if (!gesture || gesture.pointerId !== pointerId) return false;
      clearRadioTimers();
      radioGestureRef.current = null;
      const shouldSuppressClick = gesture.consumedNavigation || reason === "screen-exit";
      if (
        gesture.phase === "pending" ||
        gesture.phase === "prestart" ||
        gesture.phase === "requesting" ||
        gesture.phase === "transmitting"
      ) {
        radio.stopPtt();
      }
      if (gesture.phase === "pending") {
        resetRadioUi();
      } else if (
        gesture.phase === "prestart" ||
        gesture.phase === "requesting" ||
        gesture.phase === "transmitting"
      ) {
        setRadioUi(EMPTY_RADIO_UI);
      }
      return shouldSuppressClick;
    },
    [clearRadioTimers, radio, resetRadioUi]
  );

  const showRadioBusy = useCallback(
    (
      gesture: RadioGestureRef,
      message = "CANALE OCCUPATO",
      detail = "ATTENDI FINE TRASMISSIONE"
    ) => {
      clearRadioTimers();
      setRadioGesturePhase(gesture, "busy", { message, detail });
      scheduleRadioReset(RADIO_BUSY_TOTAL_MS);
    },
    [clearRadioTimers, scheduleRadioReset, setRadioGesturePhase]
  );

  const showRadioError = useCallback(
    (gesture: RadioGestureRef, message: string) => {
      clearRadioTimers();
      setRadioGesturePhase(gesture, "error", {
        message: message.toUpperCase(),
        detail: "RIPROVA TRA POCO",
      });
      scheduleRadioReset(RADIO_ERROR_TOTAL_MS);
    },
    [clearRadioTimers, scheduleRadioReset, setRadioGesturePhase]
  );

  const beginRadioGestureAt = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      if (!radioPttAvailable || dragging || radioGestureRef.current) return;
      const bar = barRef.current;
      if (!bar) return;
      const zone = resolveRadioZone(clientX, bar.getBoundingClientRect(), radio.activeSlots);
      if (!zone) return;

      clearRadioTimers();
      clearRadioResetTimer();
      const token = radioGestureTokenRef.current + 1;
      radioGestureTokenRef.current = token;
      const gesture: RadioGestureRef = {
        pointerId,
        startX: clientX,
        startY: clientY,
        token,
        phase: "pending",
        zone,
        consumedNavigation: false,
      };
      radioGestureRef.current = gesture;

      if (radio.isChannelBusy(zone.channel.id)) {
        showRadioBusy(gesture);
        return;
      }

      void radio.preparePttAudio().catch(() => undefined);

      const prestartTimer = window.setTimeout(() => {
        if (radioGestureRef.current?.token !== token) return;
        setRadioGesturePhase(gesture, "prestart");
      }, RADIO_PRESTART_MS);
      const startTimer = window.setTimeout(() => {
        if (radioGestureRef.current?.token !== token) return;
        triggerLongPressHaptic();
        setRadioGesturePhase(gesture, "requesting", {
          message: "CONNESSIONE RADIO",
          detail: zone.channel.name,
        });
        void radio.startPtt(zone.channel.id, "bottom-bar").then((result) => {
          if (radioGestureRef.current?.token !== token) {
            if (result.ok) radio.stopPtt();
            return;
          }
          if (result.ok) {
            setRadioGesturePhase(gesture, "transmitting", { startedAt: result.startedAt });
            return;
          }
          if (result.reason === "busy") {
            showRadioBusy(gesture);
            return;
          }
          showRadioError(gesture, result.message || "Radio non disponibile");
        });
      }, RADIO_START_AFTER_ARM_MS);
      radioTimersRef.current = [prestartTimer, startTimer];
    },
    [
      clearRadioResetTimer,
      clearRadioTimers,
      dragging,
      radio,
      radioPttAvailable,
      setRadioGesturePhase,
      showRadioBusy,
      showRadioError,
    ]
  );

  const isPointerOutsideViewport = (e: ReactPointerEvent<HTMLDivElement>) => {
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    return e.clientX < 0 || e.clientY < 0 || e.clientX > width || e.clientY > height;
  };

  const isPointOutsideViewport = (clientX: number, clientY: number) => {
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    return clientX < 0 || clientY < 0 || clientX > width || clientY > height;
  };

  const trySetPointerCapture = (target: HTMLElement, pointerId: number) => {
    try {
      if (typeof target.setPointerCapture === "function") target.setPointerCapture(pointerId);
    } catch {
      // Some Android WebViews expose Pointer Events but fail pointer capture.
    }
  };

  const tryReleasePointerCapture = (target: HTMLElement | null, pointerId: number) => {
    try {
      if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    } catch {
      // Capture may already be gone after WebView pointercancel.
    }
  };

  useEffect(() => {
    if (interactionRef.current === "tap") {
      triggerPulse();
    }
  }, [activeTab, triggerPulse]);

  useEffect(() => {
    const onWindowPointerUp = (event: PointerEvent) => {
      const gesture = radioGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (finishRadioGesture(event.pointerId, "release")) {
        suppressNextClickRef.current = true;
      }
      tryReleasePointerCapture(barRef.current, event.pointerId);
      setDragging(false);
      setDragIndex(null);
      setStretch(1);
      setStretchOrigin("50%");
      queuedDragTabRef.current = null;
      gestureRef.current = null;
      lastClientXRef.current = null;
    };

    const onWindowTouchEnd = () => {
      const gesture = radioGestureRef.current;
      if (!gesture) return;
      if (gesture.pointerId !== TOUCH_RADIO_POINTER_ID) return;
      if (finishRadioGesture(gesture.pointerId, "release")) {
        suppressNextClickRef.current = true;
      }
      setDragging(false);
      setDragIndex(null);
      setStretch(1);
      setStretchOrigin("50%");
      queuedDragTabRef.current = null;
      gestureRef.current = null;
      lastClientXRef.current = null;
    };

    window.addEventListener("pointerup", onWindowPointerUp, true);
    window.addEventListener("touchend", onWindowTouchEnd, true);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp, true);
      window.removeEventListener("touchend", onWindowTouchEnd, true);
      if (pulseTimerRef.current !== null) {
        window.clearTimeout(pulseTimerRef.current);
      }
      if (pulseRafRef.current !== null) {
        window.cancelAnimationFrame(pulseRafRef.current);
      }
      clearPendingRadioBegin();
      clearRadioTimers();
      clearRadioResetTimer();
    };
  }, [clearPendingRadioBegin, clearRadioResetTimer, clearRadioTimers, finishRadioGesture]);

  const commitTabChange = (tab: BottomTabItem, source: "tap" | "drag") => {
    if (tab.key === activeTab) return;
    interactionRef.current = source;
    onChange(tab.key);
  };

  const commitDragSelection = (tab: BottomTabItem) => {
    const now = performance.now();
    if (now - lastDragCommitAtRef.current < DRAG_SWITCH_DEBOUNCE_MS) {
      queuedDragTabRef.current = tab.key;
      return;
    }
    lastDragCommitAtRef.current = now;
    queuedDragTabRef.current = null;
    commitTabChange(tab, "drag");
  };

  const handleTabClick = (tab: BottomTabItem) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    interactionRef.current = "tap";
    setStretch(1);
    setStretchOrigin("50%");
    setDragIndex(null);
    if (tab.key === activeTab) {
      triggerPulse();
      return;
    }
    onChange(tab.key);
  };

  const tabFromX = (clientX: number) => {
    const bar = barRef.current;
    if (!bar || tabs.length === 0) return null;
    const rect = bar.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const index = clamp(Math.floor(ratio * tabs.length), 0, tabs.length - 1);
    return tabs[index] ?? null;
  };

  const dragIndexFromX = (clientX: number) => {
    const bar = barRef.current;
    if (!bar || tabs.length === 0) return 0;
    const rect = bar.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return clamp(ratio * tabs.length - 0.5, 0, tabs.length - 1);
  };

  const maxStretchFor = (index: number, origin: "0%" | "50%" | "100%") => {
    if (tabs.length === 0) return 1;
    const edgePadding = 0.02;
    if (origin === "0%") {
      return Math.max(1, tabs.length - index - edgePadding);
    }
    if (origin === "100%") {
      return Math.max(1, index + 1 - edgePadding);
    }
    const leftReach = index + 0.5;
    const rightReach = tabs.length - index - 0.5;
    return Math.max(1, Math.min(leftReach, rightReach) * 2 - edgePadding);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (
      e.pointerType === "touch" &&
      typeof TouchEvent !== "undefined" &&
      (navigator.maxTouchPoints ?? 0) > 0
    ) {
      return;
    }
    if (radioGestureRef.current) return;
    resetRadioUi();
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
    };
    lastClientXRef.current = e.clientX;
    lastDragCommitAtRef.current = performance.now();
    queuedDragTabRef.current = null;
    setDragIndex(null);
    setStretch(1);
    setStretchOrigin("50%");
    if (radioPttAvailable) {
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      clearPendingRadioBegin();
      radioBeginTimerRef.current = window.setTimeout(() => {
        radioBeginTimerRef.current = null;
        if (gestureRef.current?.pointerId !== pointerId || dragging) return;
        const bar = barRef.current;
        if (bar) trySetPointerCapture(bar, pointerId);
        beginRadioGestureAt(pointerId, startX, startY);
      }, RADIO_GESTURE_ARM_DELAY_MS);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== e.pointerId) return;

    if (radioGestureRef.current?.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      if (isPointerOutsideViewport(e)) {
        if (finishRadioGesture(e.pointerId, "screen-exit")) {
          suppressNextClickRef.current = true;
        }
        tryReleasePointerCapture(e.currentTarget as HTMLElement, e.pointerId);
        gestureRef.current = null;
      }
      return;
    }

    if (!dragging) {
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDx < DRAG_START_THRESHOLD_PX || absDx <= absDy) {
        if (Math.max(absDx, absDy) >= DRAG_START_THRESHOLD_PX) {
          if (finishRadioGesture(e.pointerId, "cancel")) {
            suppressNextClickRef.current = true;
          }
        }
        return;
      }
      clearPendingRadioBegin();
      setDragging(true);
      trySetPointerCapture(e.currentTarget as HTMLElement, e.pointerId);
      const initialOrigin = dx > 0 ? "0%" : "100%";
      setDragIndex(dragIndexFromX(e.clientX));
      setStretch(1.08);
      setStretchOrigin(initialOrigin);
      const initialTab = tabFromX(e.clientX);
      if (initialTab) commitDragSelection(initialTab);
      return;
    }

    const nextDragIndex = dragIndexFromX(e.clientX);
    const previousX = lastClientXRef.current;
    const direction = previousX === null ? 0 : e.clientX - previousX;
    lastClientXRef.current = e.clientX;
    setDragIndex(nextDragIndex);
    const nextOrigin = direction > 0 ? "0%" : direction < 0 ? "100%" : "50%";
    setStretchOrigin(nextOrigin);
    const centerDistance = Math.abs(nextDragIndex - Math.round(nextDragIndex));
    const requestedStretch = 1.09 + Math.min(0.5, centerDistance) * 1.08;
    setStretch(Math.min(requestedStretch, maxStretchFor(nextDragIndex, nextOrigin)));
    const tab = tabFromX(e.clientX);
    if (tab) commitDragSelection(tab);
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    clearPendingRadioBegin();
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== e.pointerId) return;

    if (finishRadioGesture(e.pointerId, "release")) {
      suppressNextClickRef.current = true;
    }
    const queued = queuedDragTabRef.current;
    if (dragging && queued) {
      const tab = tabs.find((item) => item.key === queued);
      if (tab) commitTabChange(tab, "drag");
    }
    tryReleasePointerCapture(e.currentTarget as HTMLElement, e.pointerId);
    setDragging(false);
    setDragIndex(null);
    setStretch(1);
    setStretchOrigin("50%");
    queuedDragTabRef.current = null;
    gestureRef.current = null;
    lastClientXRef.current = null;
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    clearPendingRadioBegin();
    if (radioGestureRef.current?.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onPointerEnd(e);
  };

  const finishSyntheticTouchGesture = useCallback(
    (event: TouchEvent | null, reason: "release" | "screen-exit") => {
      const gesture = radioGestureRef.current;
      if (!gesture || gesture.pointerId !== TOUCH_RADIO_POINTER_ID) return;
      const shouldSuppressClick = finishRadioGesture(TOUCH_RADIO_POINTER_ID, reason);
      if (shouldSuppressClick) {
        event?.preventDefault();
        event?.stopPropagation();
        suppressNextClickRef.current = true;
      }
      setDragging(false);
      setDragIndex(null);
      setStretch(1);
      setStretchOrigin("50%");
      queuedDragTabRef.current = null;
      gestureRef.current = null;
      lastClientXRef.current = null;
    },
    [finishRadioGesture]
  );

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const touchOptions: AddEventListenerOptions = { capture: true, passive: false };

    const onNativeTouchStart = (event: TouchEvent) => {
      if (!radioPttAvailable || radioGestureRef.current) return;
      const touch = event.touches[0];
      if (!touch) return;
      resetRadioUi();
      clearPendingRadioBegin();
      gestureRef.current = {
        pointerId: TOUCH_RADIO_POINTER_ID,
        startX: touch.clientX,
        startY: touch.clientY,
      };
      lastClientXRef.current = touch.clientX;
      lastDragCommitAtRef.current = performance.now();
      queuedDragTabRef.current = null;
      setDragIndex(null);
      setStretch(1);
      setStretchOrigin("50%");
      const startX = touch.clientX;
      const startY = touch.clientY;
      radioBeginTimerRef.current = window.setTimeout(() => {
        radioBeginTimerRef.current = null;
        if (gestureRef.current?.pointerId !== TOUCH_RADIO_POINTER_ID || dragging) return;
        beginRadioGestureAt(TOUCH_RADIO_POINTER_ID, startX, startY);
      }, RADIO_GESTURE_ARM_DELAY_MS);
    };

    const onNativeTouchMove = (event: TouchEvent) => {
      const gesture = radioGestureRef.current;
      if (!gesture || gesture.pointerId !== TOUCH_RADIO_POINTER_ID) return;
      event.preventDefault();
      event.stopPropagation();
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) return;
      if (isPointOutsideViewport(touch.clientX, touch.clientY)) {
        finishSyntheticTouchGesture(event, "screen-exit");
      }
    };

    const onNativeTouchEnd = (event: TouchEvent) => {
      clearPendingRadioBegin();
      finishSyntheticTouchGesture(event, "release");
    };

    const onNativeTouchCancel = (event: TouchEvent) => {
      clearPendingRadioBegin();
      const gesture = radioGestureRef.current;
      if (!gesture || gesture.pointerId !== TOUCH_RADIO_POINTER_ID) return;
      event.preventDefault();
      event.stopPropagation();
      const touch = event.changedTouches[0];
      if (touch && isPointOutsideViewport(touch.clientX, touch.clientY)) {
        finishSyntheticTouchGesture(event, "screen-exit");
      }
    };

    bar.addEventListener("touchstart", onNativeTouchStart, touchOptions);
    bar.addEventListener("touchmove", onNativeTouchMove, touchOptions);
    bar.addEventListener("touchend", onNativeTouchEnd, touchOptions);
    bar.addEventListener("touchcancel", onNativeTouchCancel, touchOptions);
    return () => {
      bar.removeEventListener("touchstart", onNativeTouchStart, touchOptions);
      bar.removeEventListener("touchmove", onNativeTouchMove, touchOptions);
      bar.removeEventListener("touchend", onNativeTouchEnd, touchOptions);
      bar.removeEventListener("touchcancel", onNativeTouchCancel, touchOptions);
      clearPendingRadioBegin();
    };
  }, [
    beginRadioGestureAt,
    clearPendingRadioBegin,
    finishSyntheticTouchGesture,
    dragging,
    radioPttAvailable,
    resetRadioUi,
  ]);

  const indicatorIndex = dragIndex ?? activeIndex;
  const radioZone = radioUi.zone;
  const radioZoneCount = Math.max(1, radio.activeSlots.length || 1);
  const radioColor = radioZone?.color ?? "#00d2ff";
  const radioZoneCenter = radioZone
    ? `${((radioZone.index + 0.5) / radioZoneCount) * 100}%`
    : "50%";
  const radioPttActive =
    radioUi.phase === "prestart" ||
    radioUi.phase === "requesting" ||
    radioUi.phase === "transmitting" ||
    radioUi.phase === "busy" ||
    radioUi.phase === "error";
  return (
    <div
      className={`bottom-bar-wrap ${dragging ? "is-dragging" : ""} ${
        radioPttActive ? "is-radio-active" : ""
      } ${radioUi.phase !== "idle" ? `is-radio-${radioUi.phase}` : ""}`}
    >
      <div
        className="bottom-bar"
        ref={barRef}
        style={
          {
            "--bottom-index": indicatorIndex,
            "--bottom-count": tabs.length,
            "--bottom-stretch": stretch,
            "--bottom-stretch-origin": stretchOrigin,
            "--radio-zone-index": radioZone?.index ?? 0,
            "--radio-zone-count": radioZoneCount,
            "--radio-zone-center": radioZoneCenter,
            "--radio-zone-color": radioColor,
          } as CSSProperties
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerCancel}
      >
        {radioPttActive ? (
          <div className={`bottom-radio-ptt-panel is-${radioUi.phase}`} aria-live="polite">
            {radioUi.phase === "busy" || radioUi.phase === "error" ? (
              <>
                <strong>{radioUi.message}</strong>
                <span>{radioUi.detail}</span>
              </>
            ) : radioUi.phase === "transmitting" ? (
              <strong>RILASCIA PER TERMINARE</strong>
            ) : (
              <>
                <strong>{radioUi.message || radioZone?.channel.name || "RADIO"}</strong>
                <span>{radioUi.detail || "TIENI PREMUTO"}</span>
              </>
            )}
          </div>
        ) : null}
        <div className={`bottom-indicator ${pulse ? "is-pulse" : ""}`} aria-hidden="true" />
        {tabs.map((tab, index) => {
          const linearProximity =
            dragIndex === null ? 0 : clamp(1 - Math.abs(dragIndex - index), 0, 1);
          const proximity = linearProximity * linearProximity;
          return (
            <button
              key={tab.key}
              className={`bottom-btn ${activeTab === tab.key ? "is-active" : ""}`}
              type="button"
              style={{ "--drag-prox": proximity } as CSSProperties}
              onPointerUp={() => {
                const radioGesture = radioGestureRef.current;
                const radioHasConsumed =
                  radioGesture &&
                  radioGesture.phase !== "pending" &&
                  radioGesture.phase !== "prestart";
                if (dragging || radioHasConsumed) return;
                suppressNextClickRef.current = true;
                handleTabClick(tab);
              }}
              onClick={() => handleTabClick(tab)}
              aria-pressed={activeTab === tab.key}
              aria-label={tab.label}
              title={tab.label}
            >
              <span className="bottom-btn-icon" aria-hidden="true">
                {tab.icon}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
