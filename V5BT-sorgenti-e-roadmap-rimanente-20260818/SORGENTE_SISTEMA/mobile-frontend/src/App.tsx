import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { checkSessionStatus } from "./api/auth";
import { endCurrentSession } from "./app/session/endSession";
import { setUnauthorizedHandler } from "./shared/api/apiClient";
import { LoginPage } from "./pages/LoginPage";
import { BatteryStatusProvider } from "./app/runtime/BatteryStatusContext";
import { SystemConnectionStatusProvider } from "./app/runtime/SystemConnectionStatusContext";
import { NotificationCenterProvider } from "./pages/home/context/NotificationCenterContext";
import { RadioProvider } from "./radio/RadioProvider";
import { useAuthStore } from "./store/authStore";

const loadHomePage = () =>
  import("./pages/HomePage").then((module) => ({ default: module.HomePage }));
const loadSettingsPage = () =>
  import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage }));
const loadProfilePage = () =>
  import("./pages/ProfilePage").then((module) => ({ default: module.ProfilePage }));
const loadPaymentsPage = () =>
  import("./pages/PaymentsPage").then((module) => ({ default: module.PaymentsPage }));
const loadRadioPage = () =>
  import("./pages/RadioPage").then((module) => ({ default: module.RadioPage }));

const HomePage = lazy(loadHomePage);
const SettingsPage = lazy(loadSettingsPage);
const ProfilePage = lazy(loadProfilePage);
const PaymentsPage = lazy(loadPaymentsPage);
const RadioPage = lazy(loadRadioPage);

const SESSION_CHECK_INTERVAL_MS = 30_000;
// Oltre questa attesa l'app parte comunque: la verifica prosegue in
// background e chiude la sessione se il backend risponde che non e' valida.
const SESSION_GATE_TIMEOUT_MS = 2_000;

function preloadProtectedRouteModules() {
  void loadSettingsPage();
  void loadProfilePage();
  void loadPaymentsPage();
  void loadRadioPage();
}

function RouteFallback() {
  return (
    <div className="page home-page">
      <div className="home-shell">
        <div className="home-card workspace-card glass-card">
          <div className="card-body">
            <div className="tables-empty-state">Caricamento...</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProtectedArea() {
  const token = useAuthStore((s) => s.token);
  const userId = useAuthStore((s) => s.userId);
  const deviceUuid = useAuthStore((s) => s.deviceUuid);
  // Con una sessione gia' in memoria l'app non entra prima di sapere se e'
  // ancora valida: altrimenti mostrerebbe la schermata come se il login fosse
  // riuscito e solo dopo scaricherebbe l'utente al login. Offline si entra
  // subito, perche' la verifica non e' possibile.
  const [sessionChecked, setSessionChecked] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false
  );

  // Un 401 su un endpoint protetto significa sessione finita: si esce subito,
  // senza aspettare il giro di controllo periodico.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!useAuthStore.getState().token) return;
      endCurrentSession({ notifyBackend: false });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!token || !userId || !deviceUuid) {
      setSessionChecked(true);
      return undefined;
    }

    let disposed = false;
    let inFlight = false;
    const openGate = () => {
      if (disposed) return;
      setSessionChecked(true);
    };
    const runSessionCheck = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const result = await checkSessionStatus({
          token,
          userId,
          deviceUuid,
          clientApp: "mobile-frontend",
        });
        if (disposed) return;
        // "invalid" e' una risposta certa del backend (401/400): si esce
        // subito. "unknown" e' rete assente o errore server: si prosegue.
        if (result === "invalid") {
          endCurrentSession({ notifyBackend: false });
        }
      } finally {
        inFlight = false;
        openGate();
      }
    };

    const gateTimer = window.setTimeout(openGate, SESSION_GATE_TIMEOUT_MS);
    void runSessionCheck();
    const timer = window.setInterval(() => {
      void runSessionCheck();
    }, SESSION_CHECK_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearTimeout(gateTimer);
      window.clearInterval(timer);
    };
  }, [deviceUuid, token, userId]);

  useEffect(() => {
    if (!token) return;
    preloadProtectedRouteModules();
  }, [token]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const keyRaw = typeof event.key === "string" ? event.key : "";
      if (!keyRaw) return;
      const key = keyRaw.toLowerCase();
      const isRefreshShortcut = key === "f5" || ((event.ctrlKey || event.metaKey) && key === "r");
      if (!isRefreshShortcut) return;
      event.preventDefault();
      event.stopPropagation();
    };

    let touchStartY = 0;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      touchStartY = event.touches[0].clientY;
    };
    const findScrollableAncestor = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof HTMLElement)) return null;
      let node: HTMLElement | null = target;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY;
        const canScrollY =
          (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
          node.scrollHeight > node.clientHeight + 1;
        if (canScrollY) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const target = event.target;
      const scrollableAncestor = findScrollableAncestor(target);
      if (scrollableAncestor) {
        return;
      }
      const deltaY = event.touches[0].clientY - touchStartY;
      const pullingDown = deltaY > 14;
      const atTop = (document.scrollingElement?.scrollTop ?? window.scrollY ?? 0) <= 0;
      if (pullingDown && atTop && event.cancelable) {
        event.preventDefault();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  if (!sessionChecked) {
    return <RouteFallback />;
  }

  return (
    <SystemConnectionStatusProvider>
      <NotificationCenterProvider>
        <RadioProvider>
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </RadioProvider>
      </NotificationCenterProvider>
    </SystemConnectionStatusProvider>
  );
}

function PaymentsGuard() {
  const permissions = useAuthStore((s) => s.permissions);
  const canCollectPayments = permissions.includes("collect_payments");
  if (!canCollectPayments) {
    return <Navigate to="/" replace />;
  }
  return <PaymentsPage />;
}

export default function App() {
  const token = useAuthStore((s) => s.token);

  return (
    <BatteryStatusProvider>
      <Routes>
        <Route path="/login" element={token ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route element={<ProtectedArea />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/payments" element={<PaymentsGuard />} />
          <Route path="/radio" element={<RadioPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BatteryStatusProvider>
  );
}
