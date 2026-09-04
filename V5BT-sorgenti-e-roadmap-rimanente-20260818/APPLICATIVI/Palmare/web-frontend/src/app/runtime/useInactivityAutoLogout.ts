import { useEffect } from "react";
import { endCurrentSession } from "../session/endSession";
import { useAuthStore } from "../../store/authStore";
import { writeSessionPreference } from "../../shared/storage/preferenceStorage";

const MOBILE_INACTIVITY_LOGOUT_MS = 14_400_000;
const ACTIVITY_EVENTS = [
  "touchstart",
  "touchmove",
  "pointerdown",
  "pointermove",
  "click",
  "scroll",
  "keydown",
  "focusin",
  "input",
] as const;

function writeSessionMessage(message: string) {
  try {
    writeSessionPreference("pos_logout_message", message);
    writeSessionPreference("mobile_login_message", message);
  } catch {
    // ignore storage failures
  }
}

function showInlineMessage(message: string) {
  const node = document.createElement("div");
  node.textContent = message;
  node.style.position = "fixed";
  node.style.left = "50%";
  node.style.bottom = "24px";
  node.style.transform = "translateX(-50%)";
  node.style.zIndex = "2147483200";
  node.style.maxWidth = "calc(100vw - 32px)";
  node.style.padding = "12px 16px";
  node.style.borderRadius = "14px";
  node.style.background = "rgba(126, 24, 38, 0.96)";
  node.style.color = "#fff";
  node.style.font = "800 14px/1.3 system-ui, -apple-system, Segoe UI, sans-serif";
  node.style.textAlign = "center";
  document.body.appendChild(node);
}

/**
 * Logs the operator out after a long inactivity window. Ported from the retired
 * src/mobile/installMobileInactivityAutoLogout.ts into a hook tied to the auth
 * store: the timer is armed only while a session token exists and is reset on user
 * activity. On timeout it releases active table locks, notifies the backend, clears
 * the local session through the store, surfaces a message, and reloads.
 */
export function useInactivityAutoLogout() {
  const token = useAuthStore((state) => state.token);

  useEffect(() => {
    if (!token) return undefined;

    let timer: number | null = null;
    let loggingOut = false;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const handleTimeout = () => {
      if (loggingOut) return;
      loggingOut = true;
      clearTimer();

      const message = "Sessione terminata per inattività.";
      endCurrentSession();
      writeSessionMessage(message);
      showInlineMessage(message);
      window.dispatchEvent(
        new CustomEvent("mobile:session-expired", { detail: { reason: "inactivity" } })
      );
      window.setTimeout(() => {
        window.location.assign("/");
      }, 650);
    };

    const scheduleTimeout = () => {
      clearTimer();
      if (loggingOut) return;
      timer = window.setTimeout(handleTimeout, MOBILE_INACTIVITY_LOGOUT_MS);
    };

    const onUserActivity = () => {
      if (loggingOut) return;
      scheduleTimeout();
    };

    const listenerOptions: AddEventListenerOptions = { capture: true, passive: true };
    ACTIVITY_EVENTS.forEach((eventName) => {
      document.addEventListener(eventName, onUserActivity, listenerOptions);
    });
    scheduleTimeout();

    return () => {
      clearTimer();
      ACTIVITY_EVENTS.forEach((eventName) => {
        document.removeEventListener(eventName, onUserActivity, { capture: true });
      });
    };
  }, [token]);
}
