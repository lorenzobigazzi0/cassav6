import { describe, expect, it } from "vitest";
import type { ServerNotification } from "../src/api/notifications";
import { toCallNotification } from "../src/pages/home/hooks/callNotificationDisplay";

const notification = (overrides: Partial<ServerNotification>): ServerNotification => ({
  id: "ntf_1",
  type: "waiter",
  title: "Chiamata cameriere",
  description: "",
  createdAt: 1_718_000_000_000,
  ...overrides,
});

describe("waiter call display", () => {
  it("mostra solo chiamante e postazione senza esporre il cameriere destinatario", () => {
    const item = toCallNotification(
      notification({
        title: "BAR-1",
        description: "Richiesta da Roberto - Cameriere: Waiter Test - Tavolo 4 - comanda #12",
        meta: {
          station: "BAR-1",
          requestedBy: "Roberto",
          waiter: "Waiter Test",
          targetUsername: "waiter",
          targetFullName: "Waiter Test",
        },
      })
    );

    expect(item.title).toBe("Chiamata da Roberto alla postazione BAR-1");
    expect(item.description).toBe("");
    expect(item.description).not.toContain("Waiter Test");
    expect(item.title).not.toContain("Waiter Test");
    expect(item.title).not.toContain("Tavolo");
    expect(item.title).not.toContain("comanda");
    expect(item.description).not.toContain("Cameriere:");
  });

  it("recupera la postazione dal consumer di feedback quando manca station", () => {
    const item = toCallNotification(
      notification({
        description: "Tavolo 4 chiede assistenza",
        meta: {
          requesterFullName: "Anna Verdi",
          requesterFeedbackConsumer: "postazione-waiter-call-feedback:bar_1:device_1",
          targetFullName: "Giada Rossi",
        },
      })
    );

    expect(item.title).toBe("Chiamata da Anna Verdi alla postazione BAR-1");
    expect(item.description).toBe("");
    expect(item.title).not.toContain("Giada Rossi");
    expect(item.title).not.toContain("Tavolo 4");
  });

  it("lascia inalterate le notifiche comanda pronta", () => {
    const item = toCallNotification(
      notification({
        type: "bell",
        title: "Comanda pronta",
        description: "Tavolo 2",
      })
    );

    expect(item).toMatchObject({
      type: "bell",
      title: "Comanda pronta",
      description: "Tavolo 2",
    });
  });
});
