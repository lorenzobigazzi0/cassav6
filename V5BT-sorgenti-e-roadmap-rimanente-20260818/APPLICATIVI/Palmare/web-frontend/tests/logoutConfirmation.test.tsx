import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogoutConfirmDialog } from "../src/pages/home/components/LogoutConfirmDialog";

describe("LogoutConfirmDialog", () => {
  afterEach(cleanup);

  it("executes logout only after explicit confirmation", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(<LogoutConfirmDialog open onCancel={onCancel} onConfirm={onConfirm} />);

    expect(screen.getByRole("alertdialog", { name: "Conferma logout" })).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "ESCI" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps the session active when the operator cancels", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(<LogoutConfirmDialog open onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "ANNULLA" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes without logout when Escape is pressed", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(<LogoutConfirmDialog open onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
