import { describe, expect, it } from "vitest";
import {
  decideNotificationPullApplication,
  isNotificationTransportLifecycleCurrent,
} from "../src/pages/home/hooks/notificationTransportPolicy";

describe("notification transport session policy", () => {
  it("rifiuta immediatamente callback appartenenti al lifecycle precedente", () => {
    expect(isNotificationTransportLifecycleCurrent(true, "session-b", "session-a")).toBe(false);
    expect(isNotificationTransportLifecycleCurrent(false, "session-a", "session-a")).toBe(false);
    expect(isNotificationTransportLifecycleCurrent(true, "session-a", "session-a")).toBe(true);
  });

  it("scarta pull fuori ordine o appartenenti a una sessione terminata", () => {
    expect(
      decideNotificationPullApplication({
        lifecycleCurrent: true,
        requestSequence: 4,
        lastAppliedSequence: 5,
        streamRevisionAtStart: 2,
        currentStreamRevision: 2,
      })
    ).toBe("discard");
    expect(
      decideNotificationPullApplication({
        lifecycleCurrent: false,
        requestSequence: 6,
        lastAppliedSequence: 5,
        streamRevisionAtStart: 2,
        currentStreamRevision: 2,
      })
    ).toBe("discard");
  });

  it("fonde senza riconciliare una pull superata da un frame stream", () => {
    expect(
      decideNotificationPullApplication({
        lifecycleCurrent: true,
        requestSequence: 6,
        lastAppliedSequence: 5,
        streamRevisionAtStart: 2,
        currentStreamRevision: 3,
      })
    ).toBe("merge");
    expect(
      decideNotificationPullApplication({
        lifecycleCurrent: true,
        requestSequence: 6,
        lastAppliedSequence: 5,
        streamRevisionAtStart: 3,
        currentStreamRevision: 3,
      })
    ).toBe("snapshot");
  });
});
