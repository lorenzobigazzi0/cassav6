export const MOBILE_SESSION_ENDING_EVENT = "mobile:session-ending";

export function dispatchMobileSessionEnding() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MOBILE_SESSION_ENDING_EVENT));
}

export function subscribeMobileSessionEnding(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(MOBILE_SESSION_ENDING_EVENT, listener);
  return () => window.removeEventListener(MOBILE_SESSION_ENDING_EVENT, listener);
}
