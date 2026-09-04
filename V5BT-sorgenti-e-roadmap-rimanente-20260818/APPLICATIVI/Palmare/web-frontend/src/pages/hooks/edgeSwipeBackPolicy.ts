export const EDGE_SWIPE_START_PX = 24;
export const EDGE_SWIPE_TRIGGER_PX = 112;

const ACTIVATE_HORIZONTAL_PX = 30;
const CANCEL_VERTICAL_PX = 14;
const ACTIVATE_HORIZONTAL_RATIO = 1.75;
const COMPLETE_HORIZONTAL_RATIO = 1.35;
const BLOCKED_TARGET_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[contenteditable='true']",
  "[data-edge-swipe-back='ignore']",
].join(",");

export type EdgeSwipeIntent = "pending" | "activate" | "cancel";

export function resolveEdgeSwipeIntent(dx: number, dy: number): EdgeSwipeIntent {
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (dx <= 0) return absDy >= CANCEL_VERTICAL_PX ? "cancel" : "pending";
  if (absDx < ACTIVATE_HORIZONTAL_PX) {
    return absDy >= CANCEL_VERTICAL_PX ? "cancel" : "pending";
  }
  return absDx >= absDy * ACTIVATE_HORIZONTAL_RATIO ? "activate" : "cancel";
}

export function shouldCompleteEdgeSwipe(dx: number, dy: number) {
  return dx >= EDGE_SWIPE_TRIGGER_PX && Math.abs(dx) >= Math.abs(dy) * COMPLETE_HORIZONTAL_RATIO;
}

function hasOpenModal(root: Document) {
  const elements = root.body?.getElementsByTagName("*");
  if (!elements) return false;
  for (const element of elements) {
    if (
      element.getAttribute("aria-modal") === "true" ||
      (element.tagName === "DIALOG" && element.hasAttribute("open"))
    ) {
      return true;
    }
  }
  return false;
}

export function isEdgeSwipeBlockedTarget(target: EventTarget | null) {
  if (typeof document !== "undefined" && hasOpenModal(document)) {
    return true;
  }
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest(BLOCKED_TARGET_SELECTOR) !== null;
}
