import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileBatteryWidget } from "../src/pages/home/components/MobileBatteryWidget";

vi.mock("../src/app/runtime/BatteryStatusContext", () => ({
  useMobileBatteryStatus: () => ({
    kind: "ready",
    device: {
      level: 73,
      charging: false,
      online: true,
    },
    stale: false,
  }),
}));

afterEach(() => cleanup());

describe("mobile battery widget", () => {
  it("shows the centered battery number without the percent symbol", () => {
    const { container } = render(<MobileBatteryWidget />);

    expect(screen.getByRole("img")).toHaveAccessibleName("Batteria: 73 percento, non in carica");
    expect(container.querySelector(".mobile-battery-value")).toHaveTextContent("73");
    expect(container.querySelector(".mobile-battery-shell")).not.toHaveTextContent("%");
  });
});
