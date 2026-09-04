import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { AppRuntime } from "./app/AppRuntime";
import { ErrorBoundary } from "./shared/errors/ErrorBoundary";
import { installTableLockUnloadRelease } from "./api/tableLocks";
import { loadRuntimeConfig } from "./config/runtimeConfig";
import { bootstrapStoredTheme } from "./pages/home/hooks/themeModeCore";
import { createAppQueryClient } from "./shared/query/createAppQueryClient";
import "./styles/glass.css";
import "./styles/menu.css";
import "./styles/tables.css";
import "./styles/reservations.css";
// Restyle schermata di login: rimuovere questa riga per il rollback.
import "./styles/login-modern.css";
// Restyle schermata Home: rimuovere questa riga per il rollback.
import "./styles/home-modern.css";
// Restyle sezione Menu: rimuovere questa riga per il rollback.
import "./styles/menu-modern.css";
// Restyle schermata Tavoli: rimuovere questa riga per il rollback.
import "./styles/tables-modern.css";
// Rettifica visibile nel carrello: rimuovere questa riga per il rollback.
import "./styles/cart-adjustment.css";

async function bootstrap() {
  bootstrapStoredTheme();
  await loadRuntimeConfig();

  installTableLockUnloadRelease();

  const qc = createAppQueryClient();
  const routerBasename =
    import.meta.env.BASE_URL && import.meta.env.BASE_URL !== "/"
      ? import.meta.env.BASE_URL.replace(/\/$/, "")
      : undefined;

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary scope="app">
        <QueryClientProvider client={qc}>
          <BrowserRouter
            basename={routerBasename}
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <AppRuntime>
              <App />
            </AppRuntime>
          </BrowserRouter>
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

void bootstrap();
