import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { GlassCard } from "../components/GlassCard";
import {
  RADIO_BUSY_TOTAL_MS,
  RADIO_ERROR_TOTAL_MS,
  RADIO_PRESTART_MS,
  RADIO_START_MS,
} from "../radio/radioGesture";
import { formatPttElapsed } from "../radio/radioProtocol";
import { getRadioChannelColor } from "../radio/radioUi";
import type { RadioChannel, RadioSlots } from "../radio/radioTypes";
import { useRadio } from "../radio/useRadio";
import { triggerLongPressHaptic } from "../utils/haptics";
import { SystemRow } from "./home/components/SystemRow";
import { useSystemTime } from "./home/hooks/useSystemTime";
import { useEdgeSwipeBack } from "./hooks/useEdgeSwipeBack";
import { HomeBackButton } from "./shared/HomeBackButton";
import { SwipeBackHomePreview } from "./shared/SwipeBackHomePreview";

type RadioControlMode = "idle" | "prestart" | "requesting" | "transmitting" | "busy" | "error";

type RadioControlState = {
  targetId: string;
  mode: Exclude<RadioControlMode, "idle">;
  label: string;
  color: string;
  startedAt: number | null;
  message: string | null;
  detail: string | null;
};

type HoldTarget = {
  id: string;
  label: string;
  color: string;
  isBusy?: () => boolean;
  start: () => Promise<
    { ok: true; startedAt: number } | { ok: false; reason: string; message?: string }
  >;
  stop: () => void;
};

const RADIO_WAVEFORM_BAR_COUNT = 32;
const RADIO_WAVEFORM_FALLBACK_LEVELS = [
  0.12, 0.16, 0.2, 0.32, 0.54, 0.68, 0.78, 0.58, 0.34, 0.28, 0.32, 0.31, 0.27, 0.24, 0.2, 0.17,
  0.14, 0.15, 0.16, 0.22, 0.28, 0.18, 0.24, 0.34, 0.2, 0.15, 0.18, 0.24, 0.68, 0.92, 0.62, 0.2,
];

type HoldGesture = {
  pointerId: number;
  token: number;
  element: HTMLButtonElement;
  target: HoldTarget;
  mode: RadioControlMode;
  timers: number[];
};

const SLOT_LABELS = ["Canale 1", "Canale 2", "Canale 3"] as const;
const ECHO_TEST_COLOR = "#22c55e";

function normalizeSlotValue(value: string) {
  const normalized = value.trim();
  return normalized || null;
}

function statusText(status: ReturnType<typeof useRadio>["status"]) {
  if (status === "ready") return "Radio connessa";
  if (status === "connecting" || status === "reconnecting") return "Radio in connessione";
  if (status === "disabled") return "Radio non configurata";
  if (status === "error") return "Errore radio";
  return "Radio disconnessa";
}

function isCriticalPttMode(mode: ReturnType<typeof useRadio>["ptt"]["mode"]) {
  return mode === "requesting" || mode === "transmitting" || mode === "echo";
}

function isPointerOutsideViewport(clientX: number, clientY: number) {
  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  const height = window.innerHeight || document.documentElement.clientHeight || 0;
  return clientX < 0 || clientY < 0 || clientX > width || clientY > height;
}

function trySetPointerCapture(element: HTMLElement, pointerId: number) {
  try {
    if (typeof element.setPointerCapture === "function") element.setPointerCapture(pointerId);
  } catch {
    // Android WebView can expose Pointer Events while refusing capture during touch scroll arbitration.
  }
}

function tryReleasePointerCapture(element: HTMLElement | null, pointerId: number) {
  try {
    if (element?.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // Capture may already be gone after pointercancel/touchend.
  }
}

function RadioWaveform({ levels }: { levels: number[] }) {
  const resolvedLevels =
    levels.length > 0 ? levels.slice(0, RADIO_WAVEFORM_BAR_COUNT) : RADIO_WAVEFORM_FALLBACK_LEVELS;

  return (
    <div className="radio-page-waveform" aria-hidden="true">
      {resolvedLevels.map((level, index) => (
        <i
          key={`${index}-${resolvedLevels.length}`}
          style={
            {
              "--radio-wave-delay": `${index * -44}ms`,
              "--radio-wave-index": index,
              "--radio-wave-level": Math.max(0.035, Math.min(1, level)),
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

function RadioControlFeedback({
  state,
  levels,
  now,
}: {
  state: RadioControlState;
  levels: number[];
  now: number;
}) {
  if (state.mode === "transmitting" && state.startedAt !== null && state.targetId === "echo") {
    return (
      <div className="radio-page-control-feedback is-transmitting">
        <RadioWaveform levels={levels} />
        <strong>{formatPttElapsed(now - state.startedAt)}</strong>
        <span>RILASCIA PER TERMINARE</span>
      </div>
    );
  }

  if (state.mode === "transmitting") {
    return (
      <div className="radio-page-control-feedback is-transmitting">
        <strong>RILASCIA PER TERMINARE</strong>
      </div>
    );
  }

  return (
    <div className={`radio-page-control-feedback is-${state.mode}`}>
      <strong>{state.message || state.label}</strong>
      <span>{state.detail || "TIENI PREMUTO"}</span>
    </div>
  );
}

function RadioSlotDropdown({
  label,
  name,
  value,
  channels,
  slotIndex,
  disabled,
  onChange,
}: {
  label: string;
  name: string;
  value: string | null;
  channels: RadioChannel[];
  slotIndex: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedChannel = value ? (channels.find((channel) => channel.id === value) ?? null) : null;
  const selectedLabel = selectedChannel?.name ?? "Nessuno";
  const selectedColor = selectedChannel
    ? getRadioChannelColor(selectedChannel, slotIndex)
    : getRadioChannelColor(null, slotIndex);

  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const selectValue = (nextValue: string) => {
    setOpen(false);
    if (nextValue === (value ?? "")) return;
    onChange(nextValue);
  };

  return (
    <div className={`radio-slot-select-wrap ${slotIndex === 0 ? "is-primary-channel" : ""}`}>
      <span className="settings-ios-key">{label}</span>
      <input type="hidden" name={name} value={value ?? ""} readOnly />
      <div className="radio-slot-dropdown" ref={dropdownRef}>
        <button
          type="button"
          className={`radio-slot-trigger ${open ? "is-open" : ""}`}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          <span
            className="radio-slot-trigger-swatch"
            style={{ "--radio-slot-color": selectedColor } as CSSProperties}
            aria-hidden="true"
          />
          <span className="radio-slot-trigger-text">{selectedLabel}</span>
          <svg className="radio-slot-trigger-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {open && !disabled ? (
          <div className="radio-slot-menu" role="listbox" aria-label={`Opzioni ${label}`}>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              className={`radio-slot-option ${!value ? "is-selected" : ""}`}
              style={
                { "--radio-slot-color": getRadioChannelColor(null, slotIndex) } as CSSProperties
              }
              onClick={() => selectValue("")}
            >
              <span
                className="radio-slot-option-swatch is-empty"
                style={
                  { "--radio-slot-color": getRadioChannelColor(null, slotIndex) } as CSSProperties
                }
                aria-hidden="true"
              />
              <span>Nessuno</span>
              {!value ? (
                <svg className="radio-slot-option-check" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              ) : null}
            </button>
            {channels.map((channel, index) => {
              const isSelected = channel.id === value;
              const optionColor = getRadioChannelColor(channel, index);
              return (
                <button
                  key={channel.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`radio-slot-option ${isSelected ? "is-selected" : ""}`}
                  style={{ "--radio-slot-color": optionColor } as CSSProperties}
                  onClick={() => selectValue(channel.id)}
                >
                  <span
                    className="radio-slot-option-swatch"
                    style={{ "--radio-slot-color": optionColor } as CSSProperties}
                    aria-hidden="true"
                  />
                  <span>{channel.name}</span>
                  {isSelected ? (
                    <svg className="radio-slot-option-check" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function RadioPage() {
  const navigate = useNavigate();
  const timeLabel = useSystemTime();
  const edgeSwipe = useEdgeSwipeBack(() => navigate("/"));
  const radio = useRadio();
  const [draftSlots, setDraftSlots] = useState<RadioSlots>(radio.slots);
  const [savingSlot, setSavingSlot] = useState<number | null>(null);
  const [slotErrorMessage, setSlotErrorMessage] = useState<string | null>(null);
  const [controlState, setControlState] = useState<RadioControlState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const holdRef = useRef<HoldGesture | null>(null);
  const tokenRef = useRef(0);
  const resetTimerRef = useRef<number | null>(null);
  const stopPtt = radio.stopPtt;
  const stopEchoTest = radio.stopEchoTest;

  const channels = useMemo(
    () =>
      [...radio.channels]
        .filter((channel) => channel.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [radio.channels]
  );
  const channelById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels]
  );
  const canStartRadio = radio.status === "ready" && !isCriticalPttMode(radio.ptt.mode);
  const radioStatusLabel = statusText(radio.status);
  const permissionMessage =
    slotErrorMessage ??
    (radio.ptt.mode === "error"
      ? radio.ptt.message
      : "Microfono richiesto al primo PTT o Echo Test.");
  const refreshRadioConfig = radio.refreshConfig;

  useEffect(() => {
    setDraftSlots(radio.slots);
  }, [radio.slots]);

  useEffect(() => {
    let active = true;
    setSlotErrorMessage(null);
    void refreshRadioConfig().catch((error) => {
      if (!active) return;
      setSlotErrorMessage(
        error instanceof Error ? error.message : "Aggiornamento canali radio non riuscito."
      );
    });
    return () => {
      active = false;
    };
  }, [refreshRadioConfig]);

  useEffect(() => {
    if (controlState?.mode !== "transmitting") return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [controlState?.mode]);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const clearHoldTimers = useCallback((gesture: HoldGesture | null) => {
    gesture?.timers.forEach((timer) => window.clearTimeout(timer));
    if (gesture) gesture.timers = [];
  }, []);

  const scheduleReset = useCallback(
    (delayMs: number) => {
      clearResetTimer();
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        setControlState(null);
      }, delayMs);
    },
    [clearResetTimer]
  );

  useEffect(() => {
    return () => {
      clearHoldTimers(holdRef.current);
      holdRef.current = null;
      clearResetTimer();
      stopPtt();
      stopEchoTest();
    };
  }, [clearHoldTimers, clearResetTimer, stopEchoTest, stopPtt]);

  const updateControlState = useCallback(
    (
      gesture: HoldGesture,
      mode: Exclude<RadioControlMode, "idle">,
      extra: Partial<RadioControlState> = {}
    ) => {
      gesture.mode = mode;
      setControlState({
        targetId: gesture.target.id,
        mode,
        label: gesture.target.label,
        color: gesture.target.color,
        startedAt: extra.startedAt ?? null,
        message: extra.message ?? null,
        detail: extra.detail ?? null,
      });
    },
    []
  );

  const beginHold = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, target: HoldTarget) => {
      if (!canStartRadio) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      clearResetTimer();
      clearHoldTimers(holdRef.current);
      const token = tokenRef.current + 1;
      tokenRef.current = token;
      const gesture: HoldGesture = {
        pointerId: event.pointerId,
        token,
        element: event.currentTarget,
        target,
        mode: "idle",
        timers: [],
      };
      holdRef.current = gesture;
      trySetPointerCapture(event.currentTarget, event.pointerId);
      if (target.isBusy?.()) {
        updateControlState(gesture, "busy", {
          message: "CANALE OCCUPATO",
          detail: "ATTENDI FINE TRASMISSIONE",
        });
        scheduleReset(RADIO_BUSY_TOTAL_MS);
        return;
      }
      void radio.preparePttAudio().catch(() => undefined);

      const prestartTimer = window.setTimeout(() => {
        if (holdRef.current?.token !== token) return;
        updateControlState(gesture, "prestart", {
          message: target.label,
          detail: "TIENI PREMUTO",
        });
      }, RADIO_PRESTART_MS);
      const startTimer = window.setTimeout(() => {
        if (holdRef.current?.token !== token) return;
        triggerLongPressHaptic();
        updateControlState(gesture, "requesting", {
          message: "CONNESSIONE RADIO",
          detail: target.label,
        });
        void target.start().then((result) => {
          if (holdRef.current?.token !== token) {
            if (result.ok) target.stop();
            return;
          }
          if (result.ok) {
            updateControlState(gesture, "transmitting", { startedAt: result.startedAt });
            return;
          }
          if (result.reason === "busy") {
            updateControlState(gesture, "busy", {
              message: "CANALE OCCUPATO",
              detail: "ATTENDI FINE TRASMISSIONE",
            });
            scheduleReset(RADIO_BUSY_TOTAL_MS);
            return;
          }
          updateControlState(gesture, "error", {
            message: result.message || "Radio non disponibile",
            detail: "RIPROVA TRA POCO",
          });
          scheduleReset(RADIO_ERROR_TOTAL_MS);
        });
      }, RADIO_START_MS);
      gesture.timers = [prestartTimer, startTimer];
    },
    [canStartRadio, clearHoldTimers, clearResetTimer, radio, scheduleReset, updateControlState]
  );

  const finishHoldByPointer = useCallback(
    (pointerId: number) => {
      const gesture = holdRef.current;
      if (!gesture || gesture.pointerId !== pointerId) return;
      tryReleasePointerCapture(gesture.element, pointerId);
      clearHoldTimers(gesture);
      holdRef.current = null;
      if (
        gesture.mode === "idle" ||
        gesture.mode === "prestart" ||
        gesture.mode === "requesting" ||
        gesture.mode === "transmitting"
      ) {
        gesture.target.stop();
      }
      if (gesture.mode === "busy" || gesture.mode === "error") {
        return;
      }
      setControlState(null);
    },
    [clearHoldTimers]
  );

  const finishHold = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      finishHoldByPointer(event.pointerId);
    },
    [finishHoldByPointer]
  );

  const handleHoldPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const gesture = holdRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      if (isPointerOutsideViewport(event.clientX, event.clientY)) {
        finishHoldByPointer(event.pointerId);
      }
    },
    [finishHoldByPointer]
  );

  const ignoreHoldPointerCancel = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = holdRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const preventHoldTouchMove = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
    if (!holdRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    const onWindowPointerUp = (event: PointerEvent) => {
      finishHoldByPointer(event.pointerId);
    };

    const onWindowTouchEnd = () => {
      const gesture = holdRef.current;
      if (!gesture) return;
      finishHoldByPointer(gesture.pointerId);
    };

    window.addEventListener("pointerup", onWindowPointerUp, true);
    window.addEventListener("touchend", onWindowTouchEnd, true);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp, true);
      window.removeEventListener("touchend", onWindowTouchEnd, true);
    };
  }, [finishHoldByPointer]);

  const saveSlot = async (slotIndex: number, value: string) => {
    const nextSlots = [...draftSlots] as RadioSlots;
    nextSlots[slotIndex] = normalizeSlotValue(value);
    setDraftSlots(nextSlots);
    setSavingSlot(slotIndex);
    setSlotErrorMessage(null);
    try {
      await radio.saveSlots(nextSlots);
    } catch (error) {
      setDraftSlots(radio.slots);
      setSlotErrorMessage(
        error instanceof Error ? error.message : "Salvataggio radio non riuscito."
      );
    } finally {
      setSavingSlot(null);
    }
  };

  const buildSlotTarget = (slotIndex: number, channel: RadioChannel): HoldTarget => ({
    id: `slot-${slotIndex}`,
    label: channel.name,
    color: getRadioChannelColor(channel, slotIndex),
    isBusy: () => radio.isChannelBusy(channel.id),
    start: async () => {
      const result = await radio.startPtt(channel.id, "radio-page");
      if (result.ok) return { ok: true, startedAt: result.startedAt };
      return {
        ok: false,
        reason: result.reason,
        message: result.message,
      };
    },
    stop: radio.stopPtt,
  });

  const echoTarget: HoldTarget = {
    id: "echo",
    label: "Echo Test",
    color: ECHO_TEST_COLOR,
    start: async () => {
      const result = await radio.startEchoTest();
      if (result.ok) return { ok: true, startedAt: result.startedAt };
      return {
        ok: false,
        reason: result.reason,
        message: result.message,
      };
    },
    stop: radio.stopEchoTest,
  };

  return (
    <div className="page settings-page radio-page" {...edgeSwipe.bind}>
      <SwipeBackHomePreview timeLabel={timeLabel} revealProgress={edgeSwipe.revealProgress} />

      <div className="swipe-front-layer" style={edgeSwipe.style}>
        <div className="home-shell settings-shell radio-shell">
          <SystemRow timeLabel={timeLabel} />

          <div className="home-topbar settings-topbar settings-ios-header radio-topbar">
            <HomeBackButton onClick={() => navigate("/")} />
            <div className="settings-topbar-title">Radio</div>
            <div className="settings-header-spacer" aria-hidden="true" />
          </div>

          <GlassCard className="settings-card settings-card-ios radio-card">
            <div className="card-body settings-body radio-body">
              <div className="settings-scroll-area radio-scroll">
                <div className="radio-status-panel">
                  <div className={`radio-status-dot is-${radio.status}`} aria-hidden="true" />
                  <div>
                    <strong>{radioStatusLabel}</strong>
                    <span>{permissionMessage}</span>
                  </div>
                </div>

                <div className="settings-group radio-slots-group">
                  <div className="settings-group-title">Canali rapidi</div>
                  <div className="settings-ios-list radio-slot-list">
                    {SLOT_LABELS.map((label, index) => {
                      const channelId = draftSlots[index];
                      const channel = channelId ? (channelById.get(channelId) ?? null) : null;
                      const target = channel ? buildSlotTarget(index, channel) : null;
                      const active =
                        controlState?.targetId === `slot-${index}` ? controlState : null;
                      const disabled = !target || !canStartRadio || savingSlot !== null;

                      return (
                        <div
                          key={label}
                          className={`settings-ios-row radio-slot-row ${index === 0 ? "is-primary-channel" : ""} ${active ? `is-${active.mode}` : ""}`}
                          style={
                            {
                              "--radio-slot-color":
                                target?.color ?? getRadioChannelColor(null, index),
                            } as CSSProperties
                          }
                        >
                          <RadioSlotDropdown
                            label={label}
                            name={`radio_slot_${index + 1}`}
                            value={channelId}
                            channels={channels}
                            slotIndex={index}
                            disabled={savingSlot !== null}
                            onChange={(value) => {
                              void saveSlot(index, value);
                            }}
                          />
                          <button
                            type="button"
                            className="radio-page-ptt-btn"
                            disabled={disabled}
                            aria-label={target ? `PTT ${target.label}` : `${label} non assegnato`}
                            onPointerDown={(event) => target && beginHold(event, target)}
                            onPointerMove={handleHoldPointerMove}
                            onPointerUp={finishHold}
                            onPointerCancel={ignoreHoldPointerCancel}
                            onTouchMoveCapture={preventHoldTouchMove}
                          >
                            <span>PTT</span>
                          </button>
                          {active ? (
                            <RadioControlFeedback
                              state={active}
                              levels={radio.audioLevels}
                              now={now}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="settings-group radio-echo-group">
                  <div className="settings-group-title">Test microfono e ascolto</div>
                  <button
                    type="button"
                    className={`radio-echo-btn ${controlState?.targetId === "echo" ? `is-${controlState.mode}` : ""}`}
                    disabled={!canStartRadio}
                    aria-label="Echo Test radio"
                    style={{ "--radio-slot-color": echoTarget.color } as CSSProperties}
                    onPointerDown={(event) => beginHold(event, echoTarget)}
                    onPointerMove={handleHoldPointerMove}
                    onPointerUp={finishHold}
                    onPointerCancel={ignoreHoldPointerCancel}
                    onTouchMoveCapture={preventHoldTouchMove}
                  >
                    {controlState?.targetId === "echo" ? (
                      <RadioControlFeedback
                        state={controlState}
                        levels={radio.audioLevels}
                        now={now}
                      />
                    ) : (
                      <>
                        <strong>ECHO TEST</strong>
                        <span>Tieni premuto per provare microfono e ascolto</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
