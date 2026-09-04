import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  EDGE_SWIPE_START_PX,
  isEdgeSwipeBlockedTarget,
  resolveEdgeSwipeIntent,
  shouldCompleteEdgeSwipe,
} from "../../../hooks/edgeSwipeBackPolicy";

type GestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  locked: boolean;
};

export function useMenuEdgeBack(enabled: boolean, onBack: () => void) {
  const gestureRef = useRef<GestureState | null>(null);

  const reset = () => {
    gestureRef.current = null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled) return;
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
    if (!enabled || !gesture || gesture.pointerId !== e.pointerId) return;

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
      const target = e.currentTarget as HTMLElement;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(e.pointerId);
      }
    }
    e.preventDefault();
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!enabled || !gesture || gesture.pointerId !== e.pointerId) return;

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
    if (!enabled || !gesture || gesture.pointerId !== e.pointerId) return;
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

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel,
  };
}
