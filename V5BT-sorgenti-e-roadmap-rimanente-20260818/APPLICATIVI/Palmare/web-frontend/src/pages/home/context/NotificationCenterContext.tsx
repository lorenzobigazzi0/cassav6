import { createContext, useContext, type ReactNode } from "react";
import { useNotificationCenter } from "../hooks/useNotificationCenter";

type NotificationCenterContextValue = ReturnType<typeof useNotificationCenter>;

const NotificationCenterContext = createContext<NotificationCenterContextValue | null>(null);

export function NotificationCenterProvider({ children }: { children: ReactNode }) {
  const value = useNotificationCenter();
  return (
    <NotificationCenterContext.Provider value={value}>
      {children}
    </NotificationCenterContext.Provider>
  );
}

export function useNotificationCenterContext() {
  const ctx = useContext(NotificationCenterContext);
  if (!ctx) {
    throw new Error("useNotificationCenterContext must be used within NotificationCenterProvider");
  }
  return ctx;
}
