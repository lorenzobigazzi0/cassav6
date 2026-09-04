import { useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  EDGE_SWIPE_START_PX,
  isEdgeSwipeBlockedTarget,
  resolveEdgeSwipeIntent,
  shouldCompleteEdgeSwipe,
} from "./edgeSwipeBackPolicy";

const MAX_TRACK_PX = 420;
const REVEAL_TRACK_PX = 160;

type GestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  locked: boolean;
};

export function useEdgeSwipeBack(onBack: () => void) {
  const gestureRef = useRef<GestureState | null>(null);
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState(false);

  const reset = () => {
    gestureRef.current = null;
    setActive(false);
    setOffset(0);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.clientX > EDGE_SWIPE_START_PX || isEdgeSwipeBlockedTarget(e.target)) return;
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      locked: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== e.pointerId) return;

    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;

    if (!gesture.locked) {
      const intent = resolveEdgeSwipeIntent(dx, dy);
      if (intent === "pending") return;
      if (intent === "cancel") {
        reset();
        return;
      }
      gesture.locked = true;
      setActive(true);
      const target = e.currentTarget as HTMLElement;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(e.pointerId);
      }
    }

    e.preventDefault();
    setOffset(Math.min(MAX_TRACK_PX, Math.max(0, dx)));
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== e.pointerId) return;

    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;
    const shouldGoBack = gesture.locked && shouldCompleteEdgeSwipe(dx, dy);

    const target = e.currentTarget as HTMLElement;
    if (
      typeof target.hasPointerCapture === "function" &&
      target.hasPointerCapture(e.pointerId) &&
      typeof target.releasePointerCapture === "function"
    ) {
      target.releasePointerCapture(e.pointerId);
    }
    reset();
    if (shouldGoBack) onBack();
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    const target = e.currentTarget as HTMLElement;
    if (
      typeof target.hasPointerCapture === "function" &&
      target.hasPointerCapture(e.pointerId) &&
      typeof target.releasePointerCapture === "function"
    ) {
      target.releasePointerCapture(e.pointerId);
    }
    reset();
  };

  const style = useMemo<CSSProperties>(() => {
    if (!active && offset === 0) return {};
    const translateX = Math.min(MAX_TRACK_PX, offset);
    return {
      transform: `translateX(${translateX}px)`,
      transition: active ? "none" : "transform 180ms linear",
      willChange: "transform",
    };
  }, [active, offset]);

  const revealProgress = useMemo(() => {
    if (offset <= 0) return 0;
    return Math.min(1, offset / REVEAL_TRACK_PX);
  }, [offset]);

  return {
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel,
    },
    style,
    revealProgress,
  };
}
