import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AvatarMenu } from "../src/pages/home/components/AvatarMenu";

describe("menu avatar senza coda Da verificare", () => {
  it("non mostra contatore o voce Azioni", () => {
    const { container } = render(
      <AvatarMenu
        open={true}
        initials="AD"
        username="admin"
        canCollectPayments={true}
        isDark={false}
        onToggle={vi.fn()}
        onThemeToggle={vi.fn()}
        onOpenProfile={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenRadio={vi.fn()}
        onOpenPayments={vi.fn()}
        showPaymentAlert={false}
        onLogout={vi.fn()}
        containerRef={createRef<HTMLDivElement>()}
      />
    );

    expect(screen.queryByRole("button", { name: "Azioni" })).not.toBeInTheDocument();
    expect(container.querySelector(".avatar-actions-count")).toBeNull();
  });
});
