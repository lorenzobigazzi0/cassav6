import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMenuEdgeBack } from "../src/pages/home/menu/hooks/useMenuEdgeBack";
import { useEdgeSwipeBack } from "../src/pages/hooks/useEdgeSwipeBack";

type HarnessProps = {
  onBack: () => void;
};

function EdgeSwipeHarness({ onBack }: HarnessProps) {
  const swipe = useEdgeSwipeBack(onBack);
  return (
    <div data-testid="edge-root" {...swipe.bind}>
      <span data-testid="edge-content">Contenuto</span>
    </div>
  );
}

function MenuEdgeSwipeHarness({ onBack }: HarnessProps) {
  const bind = useMenuEdgeBack(true, onBack);
  return (
    <div data-testid="menu-edge-root" {...bind}>
      <span data-testid="menu-edge-content">Menu</span>
    </div>
  );
}

function installPointerCapture(element: HTMLElement) {
  element.setPointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn(() => true);
  element.releasePointerCapture = vi.fn();
}

function fireDeliberateSwipe(element: HTMLElement, pointerId = 1) {
  fireEvent.pointerDown(element, {
    pointerId,
    pointerType: "touch",
    clientX: 10,
    clientY: 80,
  });
  fireEvent.pointerMove(element, {
    pointerId,
    pointerType: "touch",
    clientX: 48,
    clientY: 84,
  });
  fireEvent.pointerUp(element, {
    pointerId,
    pointerType: "touch",
    clientX: 132,
    clientY: 86,
  });
}

afterEach(() => cleanup());

describe("edge swipe back", () => {
  it("does not navigate after a vertical scroll that starts on the edge", () => {
    const onBack = vi.fn();
    render(<EdgeSwipeHarness onBack={onBack} />);
    const root = screen.getByTestId("edge-root");
    installPointerCapture(root);

    fireEvent.pointerDown(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 10,
      clientY: 80,
    });
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 22,
      clientY: 104,
    });
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 150,
      clientY: 110,
    });
    fireEvent.pointerUp(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 150,
      clientY: 110,
    });

    expect(onBack).not.toHaveBeenCalled();
  });

  it("navigates only after a deliberate horizontal gesture", () => {
    const onBack = vi.fn();
    render(<EdgeSwipeHarness onBack={onBack} />);
    const root = screen.getByTestId("edge-root");
    installPointerCapture(root);

    fireDeliberateSwipe(root);

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("never navigates when the browser cancels the pointer", () => {
    const onBack = vi.fn();
    render(<EdgeSwipeHarness onBack={onBack} />);
    const root = screen.getByTestId("edge-root");
    installPointerCapture(root);

    fireEvent.pointerDown(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 10,
      clientY: 80,
    });
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 48,
      clientY: 82,
    });
    fireEvent.pointerCancel(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 150,
      clientY: 84,
    });

    expect(onBack).not.toHaveBeenCalled();
  });

  it("disables the gesture while a confirmation dialog is open", () => {
    const onBack = vi.fn();
    render(
      <>
        <EdgeSwipeHarness onBack={onBack} />
        <div role="dialog" aria-modal="true">
          Conferma
        </div>
      </>
    );
    const root = screen.getByTestId("edge-root");
    installPointerCapture(root);

    fireDeliberateSwipe(root);

    expect(onBack).not.toHaveBeenCalled();
  });

  it("applies the same vertical-scroll guard inside the menu", () => {
    const onBack = vi.fn();
    render(<MenuEdgeSwipeHarness onBack={onBack} />);
    const root = screen.getByTestId("menu-edge-root");
    installPointerCapture(root);

    fireEvent.pointerDown(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 8,
      clientY: 50,
    });
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 20,
      clientY: 76,
    });
    fireEvent.pointerUp(root, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 140,
      clientY: 80,
    });

    expect(onBack).not.toHaveBeenCalled();
  });
});
