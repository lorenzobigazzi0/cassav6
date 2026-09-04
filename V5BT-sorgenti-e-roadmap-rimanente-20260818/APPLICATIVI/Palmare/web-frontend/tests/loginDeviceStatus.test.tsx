import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/pages/LoginPage";

vi.mock("../src/api/auth", () => ({ login: vi.fn() }));
vi.mock("../src/store/authStore", () => ({
  useAuthStore: (selector: (state: { setAuth: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ setAuth: vi.fn() }),
}));
vi.mock("../src/utils/device", () => ({
  getOrCreateDeviceUuid: () => "login-status-test-device",
}));
vi.mock("../src/pages/home/hooks/useSystemTime", () => ({
  useSystemTime: () => "09:41",
}));
vi.mock("../src/pages/home/components/MobileBatteryWidget", () => ({
  MobileBatteryWidget: () => (
    <span role="img" aria-label="Batteria: 73 percento, non in carica">
      73
    </span>
  ),
}));

afterEach(() => cleanup());

describe("login device status", () => {
  it("shows the current time and local battery before authentication", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    const loginShell = container.querySelector<HTMLElement>(
      ".page.home-page.login-page > .home-shell.login-shell"
    );
    const systemRow = loginShell?.querySelector<HTMLElement>(":scope > .system-row") ?? null;
    const loginLayout = loginShell?.querySelector<HTMLElement>(":scope > .login-layout") ?? null;
    const loginCard = loginLayout?.querySelector<HTMLElement>(":scope > .glass-card") ?? null;
    const battery = screen.getByRole("img", {
      name: "Batteria: 73 percento, non in carica",
    });

    expect(loginShell).toBeInTheDocument();
    expect(systemRow).toBeInTheDocument();
    expect(loginShell?.firstElementChild).toBe(systemRow);
    expect(loginLayout).toBeInTheDocument();
    expect(loginCard).toBeInTheDocument();
    expect(loginCard).not.toContainElement(systemRow);
    expect(loginCard).not.toContainElement(battery);
    expect(screen.getByLabelText("Stato sistema")).toContainElement(battery);
    expect(screen.getByLabelText("Ora 09:41")).toHaveTextContent("09:41");
    expect(battery).toHaveTextContent("73");
    expect(systemRow?.querySelector(".system-radio-pill-slot")).toBeEmptyDOMElement();
    expect(loginCard).toContainElement(screen.getByRole("heading", { name: "Accedi" }));
    expect(container.querySelector(".login-device-status")).not.toBeInTheDocument();
  });
});
