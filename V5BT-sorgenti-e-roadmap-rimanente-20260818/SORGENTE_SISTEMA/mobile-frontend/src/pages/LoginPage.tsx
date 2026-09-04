import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { GlassCard } from "../components/GlassCard";
import { login as loginApi } from "../api/auth";
import { useAuthStore } from "../store/authStore";
import { getOrCreateDeviceUuid } from "../utils/device";
import { SystemRow } from "./home/components/SystemRow";

export function LoginPage() {
  const nav = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const deviceUuid = getOrCreateDeviceUuid();

  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");

  const canSubmit = useMemo(() => username.trim().length > 0 && pin.length >= 4, [username, pin]);

  const m = useMutation({
    mutationFn: () => loginApi({ username, pin, deviceUuid }),
    onSuccess: (res) => {
      if (!res.ok) return;
      setAuth({
        token: res.token,
        user: res.user,
        deviceUuid,
        sessionStartedAt: res.sessionStartedAt,
      });
      nav("/", { replace: true });
    },
  });

  const errorMsg = m.data && !m.data.ok ? m.data.error : m.isError ? "Errore di rete." : null;

  return (
    <div className="page home-page login-page">
      <div className="home-shell login-shell">
        <SystemRow showRadioPill={false} />
        <div className="login-layout">
          <div className="login-logo" role="img" aria-label="Logo POS">
            POS
          </div>
          <GlassCard>
            <div className="card-body">
              <h1 className="h1">Accedi</h1>

              {errorMsg && <div className="error">{errorMsg}</div>}

              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!canSubmit || m.isPending) return;
                  m.mutate();
                }}
              >
                <div>
                  <input
                    className="input"
                    autoComplete="username"
                    inputMode="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Username"
                  />
                </div>

                <div>
                  <input
                    className="input"
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    autoComplete="current-password"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    placeholder="PIN"
                  />
                </div>

                <button className="btn" disabled={!canSubmit || m.isPending} type="submit">
                  {m.isPending ? "Accesso..." : "Entra"}
                </button>
              </form>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
