import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CallNotification } from "../types";
import { formatRelativeTime } from "../utils/time";

interface CallHistoryMenuProps {
  title: string;
  emptyText: string;
  history: CallNotification[];
  onDelete: (id: string) => void;
  onClear: () => void;
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

export function CallHistoryMenu({
  title,
  emptyText,
  history,
  onDelete,
  onClear,
}: CallHistoryMenuProps) {
  const [swipeX, setSwipeX] = useState<Record<string, number>>({});
  const [activeSwipeId, setActiveSwipeId] = useState<string | null>(null);
  const [reflow, setReflow] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedHeights, setExpandedHeights] = useState<Record<string, number>>({});
  const swipeRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    swiping: boolean;
  } | null>(null);
  const prevCountRef = useRef(history.length);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

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
      history.forEach((n) => {
        next[n.id] = prev[n.id] ?? 0;
      });
      return next;
    });
    if (activeSwipeId && !history.some((n) => n.id === activeSwipeId)) {
      setActiveSwipeId(null);
    }
    if (expandedId && !history.some((n) => n.id === expandedId)) {
      setExpandedId(null);
    }
    setExpandedHeights((prev) => {
      const next: Record<string, number> = {};
      history.forEach((n) => {
        if (prev[n.id]) next[n.id] = prev[n.id];
      });
      return next;
    });
  }, [history, activeSwipeId, expandedId]);

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
  }, [expandedId, history]);

  useEffect(() => {
    if (history.length < prevCountRef.current) {
      setReflow(true);
      const id = window.setTimeout(() => setReflow(false), 260);
      return () => window.clearTimeout(id);
    }
    prevCountRef.current = history.length;
  }, [history.length]);

  const handleSwipeStart = (id: string) => (e: ReactPointerEvent) => {
    if (isActionHitTarget(e.target)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    closeOtherSwipes(id);
    swipeRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      swiping: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleSwipeMove = (id: string) => (e: ReactPointerEvent) => {
    const current = swipeRef.current;
    if (!current || current.id !== id) return;
    const dx = e.clientX - current.startX;
    const dy = e.clientY - current.startY;
    if (!current.swiping) {
      if (dx < -6 && Math.abs(dx) > Math.abs(dy)) {
        current.swiping = true;
        setActiveSwipeId(id);
      } else {
        return;
      }
    }
    if (current.swiping) {
      e.preventDefault();
      const nextX = clamp(dx, -SWIPE_MAX, 0);
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

  const handleSwipeEnd = (id: string) => (e: ReactPointerEvent) => {
    const current = swipeRef.current;
    if (!current || current.id !== id) return;
    const dx = e.clientX - current.startX;
    const finalX = clamp(dx, -SWIPE_MAX, 0);
    if (current.swiping && finalX <= -SWIPE_TRIGGER) {
      onDelete(id);
      setSwipeX((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } else if (current.swiping && finalX <= -SWIPE_MIN) {
      const snap = -SWIPE_OPEN;
      setSwipeX((prev) => ({ ...prev, [id]: snap }));
    } else {
      setSwipeX((prev) => ({ ...prev, [id]: 0 }));
    }
    swipeRef.current = null;
    setActiveSwipeId(null);
  };

  return (
    <div className="notif-panel call-history-menu" role="menu" aria-label={title}>
      <div className="notif-head">
        <div className="notif-head-title">{title}</div>
        <div className="call-history-head-actions">
          <button
            className="notif-clear-btn"
            type="button"
            disabled={history.length === 0}
            onClick={onClear}
          >
            Cancella
          </button>
        </div>
      </div>

      {history.length === 0 ? (
        <div className="notif-empty">{emptyText}</div>
      ) : (
        <div className="notif-list">
          {history.map((item) => {
            const swipe = swipeX[item.id] ?? 0;
            const dir = swipe < -6 ? "left" : "none";
            const isExpanded = expandedId === item.id;
            const expandedHeight = expandedHeights[item.id];
            return (
              <div
                key={item.id}
                className={`notif-row ${reflow ? "is-reflow" : ""} ${isExpanded ? "is-expanded" : ""}`}
                data-swipe={dir}
                data-read={item.confirmed ? "true" : "false"}
                style={{
                  height: isExpanded
                    ? `${Math.max(
                        COLLAPSED_HEIGHT,
                        (expandedHeight ?? COLLAPSED_HEIGHT) + EXPAND_BUFFER
                      )}px`
                    : "var(--notif-item-h)",
                }}
                onPointerDown={handleSwipeStart(item.id)}
                onPointerMove={handleSwipeMove(item.id)}
                onPointerUp={handleSwipeEnd(item.id)}
                onPointerCancel={handleSwipeEnd(item.id)}
                onClick={(e) => {
                  if (Math.abs(swipe) > 6) return;
                  const rowEl = e.currentTarget;
                  setExpandedId((prev) => {
                    const next = prev === item.id ? null : item.id;
                    if (next === item.id) {
                      window.setTimeout(() => {
                        rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
                      }, 140);
                    }
                    return next;
                  });
                }}
              >
                <div className="notif-action notif-action-left" aria-hidden="true">
                  <button
                    className="notif-action-hit"
                    type="button"
                    aria-label="Elimina elemento storico"
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onPointerCancel={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(item.id);
                    }}
                  />
                  <svg className="notif-action-icon" viewBox="0 0 24 24">
                    <path d="M4 7h16" />
                    <path d="M9 7V5h6v2" />
                    <rect x="7" y="7" width="10" height="12" rx="2" />
                  </svg>
                </div>
                <div
                  className={`notif-item type-${item.type} ${item.confirmed ? "is-read" : ""} ${
                    activeSwipeId === item.id ? "is-swiping" : ""
                  }`}
                  ref={(el) => {
                    itemRefs.current[item.id] = el;
                  }}
                  style={{ transform: `translateX(${swipeX[item.id] ?? 0}px)` }}
                >
                  <div className="notif-info">
                    <div className="notif-meta">
                      <div className="notif-title">
                        {item.type === "waiter" ? "Cameriere" : "Comanda"} - {item.title}
                      </div>
                      <div className="notif-time">{formatRelativeTime(item.createdAt)}</div>
                    </div>
                    {item.description ? <div className="notif-desc">{item.description}</div> : null}
                  </div>
                  {item.confirmed && (
                    <span className="notif-check" aria-label="Confermata">
                      <svg className="notif-check-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 12l4 4 10-10" />
                      </svg>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
