import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/baseUrl";
import { formatAutomaticCashError } from "../src/utils/automaticCashErrors";

const apiError = (body: Record<string, unknown>, status = 400) =>
  new ApiError({
    status,
    code: "http_error",
    url: "/api/automatic-cash/test",
    message: "Backend error",
    body,
  });

describe("automatic cash error formatting", () => {
  it("maps exhausted config pools to the operator/admin guidance", () => {
    expect(
      formatAutomaticCashError(
        apiError({ error: "FCA_CONFIG_POOL_EXHAUSTED" }, 409)
      )
    ).toBe(
      "Configurazioni fondo cassa esaurite per questa sera. Carica un file con piu combinazioni o chiedi a un admin."
    );
  });

  it("maps locked automatic cash errors with owner context", () => {
    expect(
      formatAutomaticCashError(
        apiError({
          error: "AUTOMATIC_CASH_LOCKED",
          lock: { ownerFullName: "Mario Rossi" },
        }, 423)
      )
    ).toBe(
      "Cassa automatica occupata. Operazione in corso da parte di Mario Rossi. Riprova tra poco."
    );
  });

  it("maps missing config and unreachable gateway errors", () => {
    expect(
      formatAutomaticCashError(apiError({ error: "AUTOMATIC_CASH_NOT_CONFIGURED" }, 400))
    ).toBe(
      "Fondo cassa automatico non configurato. Apri le impostazioni e configura gateway e combinazioni."
    );
    expect(
      formatAutomaticCashError(
        apiError({ error: "AUTOMATIC_CASH_GATEWAY_UNREACHABLE" }, 503)
      )
    ).toBe("Cassa automatica non raggiungibile. Controlla rete e gateway.");
  });

  it("maps used automatic cash QR errors to the dedicated QR copy", () => {
    expect(
      formatAutomaticCashError(apiError({ error: "AUTOMATIC_CASH_QR_USED" }, 409))
    ).toBe("QR Code già utilizzato!");
    expect(
      formatAutomaticCashError(
        apiError({
          error: "AUTOMATIC_CASH_QR_INVALID",
          message: "QR already used",
        }, 400)
      )
    ).toBe("QR Code già utilizzato!");
    expect(
      formatAutomaticCashError(
        apiError({
          error: "FCA_WORKFLOW_STEP_CONFLICT",
          message: "Fondo cassa gia archiviato.",
        }, 409)
      )
    ).toBe("QR Code già utilizzato!");
  });
});
