import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import notificationsIconSrc from "../../../assets/icons/notifications.png";
import { AppIcon } from "../../../components/AppIcon";
import { triggerLongPressHaptic } from "../../../utils/haptics";
import type { UiNotification } from "../types";
import { formatCount } from "../utils/format";
import { formatRelativeTime } from "../utils/time";
import { NotificationClearAllConfirmDialog } from "./NotificationClearAllConfirmDialog";

interface NotificationsMenuProps {
  open: boolean;
  unreadCount: number;
  readCount: number;
  notifications: UiNotification[];
  onToggle: () => void;
  onClearRead: () => void;
  onClearAll: () => void;
  onConfirm: (id: string) => void;
  onDelete: (id: string) => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isActionHitTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest(".notif-action-hit"));
const SWIPE_MAX = 120;
const SWIPE_TRIGGER = Math.round(SWIPE_MAX * 0.8);
const SWIPE_OPEN = 56;
const SWIPE_MIN = 20;
const COLLAPSED_HEIGHT = 76;
const EXPAND_BUFFER = 0;
const CLEAR_ALL_LONG_PRESS_MS = 650;

export function NotificationsMenu({
  open,
  unreadCount,
  readCount,
  notifications,
  onToggle,
  onClearRead,
  onClearAll,
  onConfirm,
  onDelete,
  containerRef,
}: NotificationsMenuProps) {
  const [swipeX, setSwipeX] = useState<Record<string, number>>({});
  const [activeSwipeId, setActiveSwipeId] = useState<string | null>(null);
  const [reflow, setReflow] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedHeights, setExpandedHeights] = useState<Record<string, number>>({});
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);
  const clearAllLongPressTimerRef = useRef<number | null>(null);
  const clearAllLongPressTriggeredRef = useRef(false);
  const swipeRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    swiping: boolean;
  } | null>(null);
  const prevCountRef = useRef(notifications.length);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const clearClearAllLongPress = () => {
    if (clearAllLongPressTimerRef.current === null) return;
    window.clearTimeout(clearAllLongPressTimerRef.current);
    clearAllLongPressTimerRef.current = null;
  };

  useEffect(() => clearClearAllLongPress, []);

  useEffect(() => {
    if (notifications.length === 0) setClearAllConfirmOpen(false);
  }, [notifications.length]);

  const startClearAllLongPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearClearAllLongPress();
    clearAllLongPressTriggeredRef.current = false;
    clearAllLongPressTimerRef.current = window.setTimeout(() => {
      clearAllLongPressTimerRef.current = null;
      clearAllLongPressTriggeredRef.current = true;
      triggerLongPressHaptic();
      setClearAllConfirmOpen(true);
    }, CLEAR_ALL_LONG_PRESS_MS);
  };

  const handleClearClick = () => {
    if (clearAllLongPressTriggeredRef.current) {
      clearAllLongPressTriggeredRef.current = false;
      return;
    }
    if (readCount > 0) onClearRead();
  };

  const confirmClearAll = () => {
    setClearAllConfirmOpen(false);
    onClearAll();
  };

  const closeOtherSwipes = (currentId: string, keepCurrent = true) => {
    setSwipeX((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      Object.entries(prev).forEach(([id, value]) => {
        if (id === currentId) {
          next[id] = keepCurrent ? value : 0;
          if (!keepCurrent && value !== 0) changed = true;
          return;
        }
        next[id] = 0;
        if (value !== 0) changed = true;
      });
      return changed ? next : prev;
    });
  };

  useEffect(() => {
    setSwipeX((prev) => {
      const next: Record<string, number> = {};
      notifications.forEach((n) => {
        const prevValue = prev[n.id] ?? 0;
        next[n.id] = n.read ? Math.min(0, prevValue) : Math.max(0, prevValue);
      });
      return next;
    });
    if (activeSwipeId && !notifications.some((n) => n.id === activeSwipeId)) {
      setActiveSwipeId(null);
    }
    if (expandedId && !notifications.some((n) => n.id === expandedId)) {
      setExpandedId(null);
    }
    setExpandedHeights((prev) => {
      const next: Record<string, number> = {};
      notifications.forEach((n) => {
        if (prev[n.id]) next[n.id] = prev[n.id];
      });
      return next;
    });
  }, [notifications, activeSwipeId, expandedId]);

  useLayoutEffect(() => {
    if (!expandedId) return;
    const item = itemRefs.current[expandedId];
    if (!item) return;
    const setMeasuredHeight = () => {
      const contentHeight = Math.ceil(item.scrollHeight);
      if (contentHeight <= 0) return;
      setExpandedHeights((prev) => {
        if (prev[expandedId] === contentHeight) return prev;
        return { ...prev, [expandedId]: contentHeight };
      });
    };
    setMeasuredHeight();
    const raf1 = window.requestAnimationFrame(setMeasuredHeight);
    const raf2 = window.requestAnimationFrame(setMeasuredHeight);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => setMeasuredHeight());
      ro.observe(item);
    }
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      if (ro) ro.disconnect();
    };
  }, [expandedId, notifications]);

  useEffect(() => {
    if (notifications.length < prevCountRef.current) {
      setReflow(true);
      const id = window.setTimeout(() => setReflow(false), 260);
      return () => window.clearTimeout(id);
    }
    prevCountRef.current = notifications.length;
  }, [notifications.length]);

  const handleSwipeStart = (id: string, read: boolean) => (e: ReactPointerEvent) => {
    if (isActionHitTarget(e.target)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    closeOtherSwipes(id, false);
    setSwipeX((prev) => ({
      ...prev,
      [id]: read ? Math.min(0, prev[id] ?? 0) : Math.max(0, prev[id] ?? 0),
    }));
    swipeRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      swiping: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleSwipeMove = (id: string, read: boolean) => (e: ReactPointerEvent) => {
    const current = swipeRef.current;
    if (!current || current.id !== id) return;
    const dx = e.clientX - current.startX;
    const dy = e.clientY - current.startY;
    if (!current.swiping) {
      const allowDirection = read ? dx < -6 : dx > 6;
      if (allowDirection && Math.abs(dx) > Math.abs(dy)) {
        current.swiping = true;
        setActiveSwipeId(id);
      } else {
        return;
      }
    }
    if (current.swiping) {
      e.preventDefault();
      const minX = read ? -SWIPE_MAX : 0;
      const maxX = read ? 0 : SWIPE_MAX;
      const nextX = clamp(dx, minX, maxX);
      setSwipeX((prev) => {
        const next: Record<string, number> = {};
        let changed = false;
        Object.entries(prev).forEach(([key, value]) => {
          if (key === id) {
            next[key] = nextX;
            if (value !== nextX) changed = true;
            return;
          }
          next[key] = 0;
          if (value !== 0) changed = true;
        });
        if (!(id in next)) {
          next[id] = nextX;
          changed = true;
        }
        return changed ? next : prev;
      });
    }
  };

  const handleSwipeEnd = (id: string, read: boolean) => (e: ReactPointerEvent) => {
    const current = swipeRef.current;
    if (!current || current.id !== id) return;
    const dx = e.clientX - current.startX;
    if (read) {
      const finalX = clamp(dx, -SWIPE_MAX, 0);
      if (current.swiping && finalX <= -SWIPE_TRIGGER) {
        onDelete(id);
        setSwipeX((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else if (current.swiping && finalX <= -SWIPE_MIN) {
        setSwipeX((prev) => ({ ...prev, [id]: -SWIPE_OPEN }));
      } else {
        setSwipeX((prev) => ({ ...prev, [id]: 0 }));
      }
    } else {
      const finalX = clamp(dx, 0, SWIPE_MAX);
      if (current.swiping && finalX >= SWIPE_TRIGGER) {
        onConfirm(id);
        setSwipeX((prev) => ({ ...prev, [id]: 0 }));
      } else if (current.swiping && finalX >= SWIPE_MIN) {
        setSwipeX((prev) => ({ ...prev, [id]: SWIPE_OPEN }));
      } else {
        setSwipeX((prev) => ({ ...prev, [id]: 0 }));
      }
    }
    swipeRef.current = null;
    setActiveSwipeId(null);
  };

  return (
    <div className="notif-wrap" ref={containerRef}>
      <button
        className="icon-btn"
        type="button"
        aria-label={`Notifiche${unreadCount ? ` (${unreadCount})` : ""}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <AppIcon
          src={notificationsIconSrc}
          className="icon"
          fallback={
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4a4 4 0 0 1 4 4v3l1.6 2H6.4L8 11V8a4 4 0 0 1 4-4z" />
              <path d="M10 17a2 2 0 0 0 4 0" />
            </svg>
          }
        />
        {unreadCount > 0 && (
          <span className="notif-count" aria-hidden="true">
            {formatCount(unreadCount)}
          </span>
        )}
      </button>
      {open && (
        <div className="notif-panel" role="menu" aria-label="Notifiche">
          <div className="notif-head">
            <div className="notif-head-title">Notifiche</div>
            <button
              className="notif-clear-btn"
              type="button"
              disabled={notifications.length === 0}
              aria-label="Cancella notifiche lette; tieni premuto per cancellarle tutte"
              title="Tocca per cancellare le lette. Tieni premuto per cancellarle tutte."
              onPointerDown={startClearAllLongPress}
              onPointerUp={clearClearAllLongPress}
              onPointerCancel={clearClearAllLongPress}
              onContextMenu={(event) => event.preventDefault()}
              onClick={handleClearClick}
            >
              Cancella
            </button>
          </div>
          {notifications.length === 0 ? (
            <div className="notif-empty">Nessuna notifica</div>
          ) : (
            <div className="notif-list">
              {notifications.map((n) => {
                const swipe = swipeX[n.id] ?? 0;
                const dir = n.read ? (swipe < -6 ? "left" : "none") : swipe > 6 ? "right" : "none";
                const isExpanded = expandedId === n.id;
                const expandedHeight = expandedHeights[n.id];
                return (
                  <div
                    key={n.id}
                    className={`notif-row ${reflow ? "is-reflow" : ""} ${isExpanded ? "is-expanded" : ""}`}
                    data-swipe={dir}
                    data-read={n.read ? "true" : "false"}
                    style={{
                      height: isExpanded
                        ? `${Math.max(
                            COLLAPSED_HEIGHT,
                            (expandedHeight ?? COLLAPSED_HEIGHT) + EXPAND_BUFFER
                          )}px`
                        : "var(--notif-item-h)",
                    }}
                    onPointerDown={handleSwipeStart(n.id, n.read)}
                    onPointerMove={handleSwipeMove(n.id, n.read)}
                    onPointerUp={handleSwipeEnd(n.id, n.read)}
                    onPointerCancel={handleSwipeEnd(n.id, n.read)}
                    onClick={(e) => {
                      if (Math.abs(swipe) > 6) return;
                      const rowEl = e.currentTarget;
                      setExpandedId((prev) => {
                        const next = prev === n.id ? null : n.id;
                        if (next === n.id) {
                          window.setTimeout(() => {
                            rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
                          }, 140);
                        }
                        return next;
                      });
                    }}
                  >
                    <div className="notif-action notif-action-left" aria-hidden="true">
                      {n.read && (
                        <button
                          className="notif-action-hit"
                          type="button"
                          aria-label="Elimina notifica"
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerUp={(e) => e.stopPropagation()}
                          onPointerCancel={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(n.id);
                          }}
                        />
                      )}
                      <svg className="notif-action-icon" viewBox="0 0 24 24">
                        <path d="M4 7h16" />
                        <path d="M9 7V5h6v2" />
                        <rect x="7" y="7" width="10" height="12" rx="2" />
                      </svg>
                    </div>
                    <div className="notif-action notif-action-right" aria-hidden="true">
                      {!n.read && (
                        <button
                          className="notif-action-hit"
                          type="button"
                          aria-label="Conferma notifica"
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerUp={(e) => e.stopPropagation()}
                          onPointerCancel={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onConfirm(n.id);
                          }}
                        />
                      )}
                      <svg className="notif-action-icon" viewBox="0 0 24 24">
                        <path d="M5 12l4 4 10-10" />
                      </svg>
                    </div>
                    <div
                      className={`notif-item type-${n.type || "general"} ${n.read ? "is-read" : ""} ${
                        activeSwipeId === n.id ? "is-swiping" : ""
                      }`}
                      ref={(el) => {
                        itemRefs.current[n.id] = el;
                      }}
                      style={{ transform: `translateX(${swipeX[n.id] ?? 0}px)` }}
                    >
                      <div className="notif-info">
                        <div className="notif-meta">
                          <div className="notif-title">{n.title}</div>
                          <div className="notif-time">{formatRelativeTime(n.createdAt)}</div>
                        </div>
                        <div className="notif-desc">{n.description}</div>
                      </div>
                      {n.read ? (
                        <span className="notif-check" aria-label="Confermata">
                          <svg className="notif-check-icon" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M5 12l4 4 10-10" />
                          </svg>
                        </span>
                      ) : (
                        <button
                          className="notif-ack-btn"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onConfirm(n.id);
                          }}
                        >
                          Conferma
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <NotificationClearAllConfirmDialog
        open={clearAllConfirmOpen}
        onCancel={() => setClearAllConfirmOpen(false)}
        onConfirm={confirmClearAll}
      />
    </div>
  );
}
