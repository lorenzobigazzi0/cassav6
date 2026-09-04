const BRIDGE_NAME = "AmaliaNativeNotifications";

const defaultScope = () => {
  if (typeof window !== "undefined") return window;
  if (typeof globalThis !== "undefined") return globalThis;
  return null;
};

const bridgeFrom = (scope) => {
  try {
    return scope?.[BRIDGE_NAME] || null;
  } catch {
    return null;
  }
};

export const clearNativeNotificationSession = (scope = defaultScope()) => {
  const bridge = bridgeFrom(scope);
  if (typeof bridge?.clearSession !== "function") return false;
  try {
    return bridge.clearSession() === true;
  } catch {
    return false;
  }
};

export const updateNativeNotificationSession = (session, scope = defaultScope()) => {
  const bridge = bridgeFrom(scope);
  if (typeof bridge?.updateSession !== "function") return false;
  try {
    return bridge.updateSession(JSON.stringify(session || {})) === true;
  } catch {
    return false;
  }
};
