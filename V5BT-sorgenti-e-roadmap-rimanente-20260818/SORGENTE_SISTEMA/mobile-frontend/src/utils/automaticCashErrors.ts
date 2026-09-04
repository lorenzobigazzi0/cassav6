import { isAutomaticCashApiError, toAutomaticCashApiError } from "../api/automaticCash";
import type {
  AutomaticCashApiErrorPayload,
  AutomaticCashLockPayload,
} from "../types/automaticCash";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const asPayload = (value: unknown): AutomaticCashApiErrorPayload | null =>
  isRecord(value) ? (value as AutomaticCashApiErrorPayload) : null;

const asLockPayload = (value: unknown): AutomaticCashLockPayload | null =>
  isRecord(value) ? (value as AutomaticCashLockPayload) : null;

const QR_USED_MESSAGE = "QR Code già utilizzato!";
const QR_INVALID_MESSAGE = "QR non valido";

const mentionsUsedQr = (value: unknown) =>
  /gia\s+utilizzato|già\s+utilizzato|utilizzat|already\s+used|used|consumed/i.test(
    JSON.stringify(value ?? "")
  );

const mentionsConsumedQr = (value: unknown) =>
  mentionsUsedQr(value) || /archiviat|archived/i.test(JSON.stringify(value ?? ""));

export function formatAutomaticCashError(error: unknown, fallback?: string) {
  const normalized = toAutomaticCashApiError(error);
  const payload = asPayload(normalized.payload);
  if (isAutomaticCashApiError(normalized)) {
    if (normalized.code === "FCA_CONFIG_POOL_EXHAUSTED") {
      return "Configurazioni fondo cassa esaurite per questa sera. Carica un file con piu combinazioni o chiedi a un admin.";
    }
    if (normalized.code === "AUTOMATIC_CASH_LOCKED" || normalized.code === "FCA_ACTIVE_WORKFLOW") {
      const lock = asLockPayload(payload?.lock);
      const ownerFullName = String(lock?.ownerFullName ?? "").trim();
      return ownerFullName
        ? `Cassa automatica occupata. Operazione in corso da parte di ${ownerFullName}. Riprova tra poco.`
        : "Cassa automatica occupata. Riprova tra poco.";
    }
    if (normalized.code === "FCA_NO_FEASIBLE_CONFIGURATION") {
      return "Nessuna combinazione fondo cassa rispetta inventario e riserva minima.";
    }
    if (normalized.code === "FCA_RESERVE_CONFIG_INVALID") {
      return "Riserva minima tagli mancante o non valida. Apri le impostazioni e carica il file riserva.";
    }
    if (normalized.code === "FCA_INVENTORY_UNAVAILABLE") {
      return "Inventario cassa automatica non disponibile. Riprova dopo la sincronizzazione.";
    }
    if (
      normalized.code === "FCA_WORKFLOW_STEP_CONFLICT" &&
      (mentionsConsumedQr(payload) || mentionsConsumedQr(normalized.message))
    ) {
      return QR_USED_MESSAGE;
    }
    if (normalized.code === "FCA_WORKFLOW_STEP_CONFLICT") {
      return "Operazione fondo cassa in uno stato non compatibile. Riapri la schermata e riprendi il flusso.";
    }
    if (normalized.code === "AUTOMATIC_CASH_QR_USED") {
      return QR_USED_MESSAGE;
    }
    if (
      normalized.code === "AUTOMATIC_CASH_QR_INVALID" &&
      (mentionsConsumedQr(payload) || mentionsConsumedQr(normalized.message))
    ) {
      return QR_USED_MESSAGE;
    }
    if (normalized.code === "AUTOMATIC_CASH_QR_INVALID") {
      if (mentionsUsedQr(payload) || mentionsUsedQr(normalized.message)) {
        return QR_USED_MESSAGE;
      }
      return QR_INVALID_MESSAGE;
    }
    if (
      normalized.code === "AUTOMATIC_CASH_NOT_CONFIGURED" ||
      normalized.code === "AUTOMATIC_CASH_DISABLED"
    ) {
      return "Fondo cassa automatico non configurato. Apri le impostazioni e configura gateway e combinazioni.";
    }
    if (
      normalized.code === "AUTOMATIC_CASH_GATEWAY_UNREACHABLE" ||
      normalized.code === "FCA_GATEWAY_UNREACHABLE"
    ) {
      return "Cassa automatica non raggiungibile. Controlla rete e gateway.";
    }
    if (normalized.code === "CASH_GATEWAY_LOCKED" || normalized.code === "CASH_EXCHANGE_ACTIVE") {
      const lock = asLockPayload(payload?.lock);
      const ownerFullName = String(lock?.ownerFullName ?? payload?.ownerFullName ?? "").trim();
      return ownerFullName
        ? `Cambio gia in corso da parte di ${ownerFullName}.`
        : "Cambio gia in corso. Attendi la chiusura dell'operazione.";
    }
    if (normalized.code === "CASH_EXCHANGE_STEP_CONFLICT") {
      return "Cambio in uno stato non compatibile. Riapri la schermata e riprendi il flusso.";
    }
    if (normalized.code === "CASH_EXCHANGE_INVALID_PIECES") {
      return "Tagli cambio non validi.";
    }
    if (normalized.code === "CASH_EXCHANGE_TOTAL_MISMATCH") {
      return "Il totale dei tagli scelti non coincide con il denaro inserito.";
    }
    if (normalized.code === "CASH_EXCHANGE_AMOUNT_NOT_REPRESENTABLE") {
      return "Importo non rappresentabile con i tagli disponibili.";
    }
    if (normalized.code === "CASH_EXCHANGE_INVENTORY_INSUFFICIENT") {
      return "Tagli non disponibili nella cassa automatica.";
    }
    if (normalized.code === "CASH_MOVEMENT_ACTIVE") {
      return "Un movimento cassa e gia in corso. Riaprilo e completalo prima di iniziarne un altro.";
    }
    if (normalized.code === "CASH_MOVEMENT_STEP_CONFLICT") {
      return "Movimento cassa in uno stato non compatibile. Aggiorna e riprendi l'operazione.";
    }
    if (normalized.code === "CASH_MOVEMENT_INVALID_AMOUNT") {
      return "Inserisci un importo di prelievo valido.";
    }
    if (normalized.code === "CASH_MOVEMENT_INVALID_PIECES") {
      return "Seleziona almeno un taglio valido.";
    }
    if (normalized.code === "CASH_MOVEMENT_INVENTORY_UNAVAILABLE") {
      return "Inventario cassa automatica non disponibile.";
    }
    if (normalized.code === "CASH_MOVEMENT_INVENTORY_INSUFFICIENT") {
      return normalized.message || "I tagli selezionati non sono disponibili.";
    }
    if (normalized.code === "CASH_MOVEMENT_AMOUNT_NOT_REPRESENTABLE") {
      return "L'importo non puo essere erogato con i tagli disponibili.";
    }
    if (normalized.code === "CASH_MOVEMENT_JUSTIFICATION_REQUIRED") {
      return "Inserisci la giustificazione del movimento.";
    }
    if (normalized.code === "CASH_MOVEMENT_PERMISSION_DENIED") {
      return "Non sei autorizzato a gestire questo movimento cassa.";
    }
    if (normalized.code === "CASH_MOVEMENT_REPORT_PRINT_UNAVAILABLE") {
      return "Report pronto, ma la stampante non e disponibile. Puoi riprovare senza ripetere il movimento.";
    }
    if (normalized.code === "CASH_GATEWAY_UNREACHABLE") {
      return "Cassa automatica non raggiungibile. Controlla rete e gateway.";
    }
  }
  const message = String(payload?.message ?? normalized.message ?? "").trim();
  return message || fallback || "Operazione fondo cassa automatico non riuscita.";
}
