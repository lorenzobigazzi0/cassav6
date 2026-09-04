import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { MenuCatalog, MenuProduct } from "../../../../api/menu";
import type { TableLockConflictDetail } from "../../../../api/tableLocks";
import type { DiningTable, DiningTableOrder, TableSessionRequest } from "../../../../api/tables";
import {
  cancelOrder,
  defaultOrderCorrectionDrafts,
  hasOrderCorrectionChanges,
  lineKeyForOrderService,
  submitOrderCorrection,
  submitOrderReplacement,
  type OrderCorrectionLineDraft,
} from "../../../../api/orderServiceRecovery";
import { formatCurrency } from "../utils";
import { GlassDropdown } from "./GlassDropdown";
import {
  ServiceRecoveryAlertDialog,
  ServiceRecoveryCancelConfirmDialog,
  ServiceRecoveryChoicePanel,
} from "./TableServiceRecoveryChoice";
import {
  buildServiceRecoveryProductIndex,
  clampQuantity,
  correctionPayloadForOrder,
  defaultReplacementSelections,
  hasCorrectionDetails,
  lineTotalLabel,
  normalize,
  productForLine,
  replacementAvailableQuantity,
  replacementLineDetails,
  selectedReplacementEntriesForLines,
  variantOptionsForLine,
  withModifier,
  type ReplacementSelectionState,
} from "./TableServiceRecoveryModel";
import {
  normalizeServiceRecoverySupplement,
  resolveServiceRecoveryUnitPrice,
  serviceRecoveryNoteWithSupplement,
  serviceRecoverySupplementOptions,
  serviceRecoverySupplementValue,
  withServiceRecoverySupplement,
} from "./TableServiceRecoverySupplements";
import type { ServiceRecoveryAction } from "./TableDetailPanel";
import { triggerLongPressHaptic } from "../../../../utils/haptics";
type TableServiceRecoveryDialogProps = {
  action: ServiceRecoveryAction;
  order: DiningTableOrder;
  table: DiningTable;
  session: TableSessionRequest & { roomName?: string };
  menuCatalog?: MenuCatalog | null;
  busy?: boolean;
  onClose: () => void;
  onDone: (result?: {
    action: ServiceRecoveryAction;
    sendReplacement?: boolean;
  }) => Promise<void> | void;
  onLockConflict?: (detail: TableLockConflictDetail) => void;
};
type ReplacementSubmitIntent = "refund" | "swap" | null;
type ReplacementReasonValidationState = "idle" | "alert" | "invalid";
const REPLACEMENT_DETAILS_LONG_PRESS_MS = 560;
const REPLACEMENT_REASON_REQUIRED_MESSAGE = "Inserisci il motivo del reso.";
export function TableServiceRecoveryDialog({
  action,
  order,
  table,
  session,
  menuCatalog,
  busy = false,
  onClose,
  onDone,
  onLockConflict,
}: TableServiceRecoveryDialogProps) {
  const [lineDrafts, setLineDrafts] = useState<OrderCorrectionLineDraft[]>(() =>
    defaultOrderCorrectionDrafts(order)
  );
  const [replacementSelections, setReplacementSelections] = useState<ReplacementSelectionState>(
    () => defaultReplacementSelections(order)
  );
  const [correctionMode, setCorrectionMode] = useState<"choice" | "form">(
    action === "correction" ? "choice" : "form"
  );
  const [openCorrectionLineKey, setOpenCorrectionLineKey] = useState<string | null>(null);
  const [openReplacementLineKey, setOpenReplacementLineKey] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [replacementReasonValidation, setReplacementReasonValidation] =
    useState<ReplacementReasonValidationState>("idle");
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelReasonError, setCancelReasonError] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [replacementSubmitIntent, setReplacementSubmitIntent] =
    useState<ReplacementSubmitIntent>(null);
  const [error, setError] = useState<string | null>(null);
  const replacementLongPressTimerRef = useRef<number | null>(null);
  const replacementLongPressTargetRef = useRef<string | null>(null);
  const replacementLongPressTriggeredRef = useRef(false);
  useEffect(() => {
    if (replacementLongPressTimerRef.current !== null) {
      window.clearTimeout(replacementLongPressTimerRef.current);
      replacementLongPressTimerRef.current = null;
    }
    replacementLongPressTargetRef.current = null;
    replacementLongPressTriggeredRef.current = false;
    setLineDrafts(defaultOrderCorrectionDrafts(order));
    setReplacementSelections(defaultReplacementSelections(order));
    setCorrectionMode(action === "correction" ? "choice" : "form");
    setOpenCorrectionLineKey(null);
    setOpenReplacementLineKey(null);
    setReason("");
    setReplacementReasonValidation("idle");
    setCancelConfirmOpen(false);
    setCancelReason("");
    setCancelReasonError(null);
    setReplacementSubmitIntent(null);
    setError(null);
  }, [action, order]);
  useEffect(
    () => () => {
      if (replacementLongPressTimerRef.current !== null) {
        window.clearTimeout(replacementLongPressTimerRef.current);
      }
    },
    []
  );
  const disabled = busy || localBusy;
  const context = useMemo(() => ({ order, table, session }), [order, session, table]);
  const title =
    action === "replacement"
      ? "Reso"
      : correctionMode === "choice"
        ? "Gestisci comanda"
        : "Modifica comanda";
  const orderNumberLabel = `#${order.id}`;
  const tableLabel =
    normalize(table.mobileComplexLabel || table.tableLabel || table.logicalTableLabel) ||
    String(table.number);
  const roomLabel = normalize(session.roomName) || normalize(session.roomId) || "Sala";
  const subtitle = `Comanda ${orderNumberLabel} - Tavolo ${tableLabel} - Sala ${roomLabel}`;
  const replacementLines = useMemo(
    () => order.lines.filter((line) => replacementAvailableQuantity(line) > 0),
    [order.lines]
  );
  const productIndex = useMemo(
    () => buildServiceRecoveryProductIndex(menuCatalog?.products ?? []),
    [menuCatalog?.products]
  );
  const selectedReplacementEntries = useMemo(
    () => selectedReplacementEntriesForLines(replacementLines, replacementSelections),
    [replacementLines, replacementSelections]
  );
  const correctionPayload = useMemo(
    () => correctionPayloadForOrder(lineDrafts, order.orderNote, order.orderComment, reason),
    [lineDrafts, order.orderComment, order.orderNote, reason]
  );
  const hasCorrectionDiff = hasOrderCorrectionChanges(correctionPayload, order);
  const run = async (
    operation: () => Promise<unknown>,
    result?: { action: ServiceRecoveryAction; sendReplacement?: boolean }
  ) => {
    setError(null);
    setLocalBusy(true);
    setReplacementSubmitIntent(
      result?.action === "replacement" ? (result.sendReplacement ? "swap" : "refund") : null
    );
    try {
      await operation();
      await onDone(result);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recupero comanda non riuscito.");
    } finally {
      setLocalBusy(false);
      setReplacementSubmitIntent(null);
    }
  };
  const updateDraft = (lineKey: string, patch: Partial<OrderCorrectionLineDraft>) => {
    setLineDrafts((current) =>
      current.map((line) => (line.lineKey === lineKey ? { ...line, ...patch } : line))
    );
  };
  const updateLineSupplement = (lineKey: string, value: string, product: MenuProduct | null) => {
    setLineDrafts((current) =>
      current.map((line) => {
        if (line.lineKey !== lineKey) return line;
        const supplement = normalizeServiceRecoverySupplement(value);
        return {
          ...line,
          nextModifiers: withServiceRecoverySupplement(line.nextModifiers, supplement),
          nextNotes: serviceRecoveryNoteWithSupplement(line, product, line.nextVariant, supplement),
          nextUnitPrice: resolveServiceRecoveryUnitPrice(
            line,
            product,
            line.nextVariant,
            supplement
          ),
        };
      })
    );
  };
  const updateReplacementSelection = (
    lineKey: string,
    patch: Partial<ReplacementSelectionState[string]>
  ) => {
    setReplacementSelections((current) => ({
      ...current,
      [lineKey]: {
        selected: current[lineKey]?.selected ?? false,
        quantity: current[lineKey]?.quantity ?? 1,
        ...patch,
      },
    }));
  };
  const clearReplacementDetailsLongPress = () => {
    if (replacementLongPressTimerRef.current !== null) {
      window.clearTimeout(replacementLongPressTimerRef.current);
      replacementLongPressTimerRef.current = null;
    }
  };
  const cancelReplacementDetailsLongPress = () => {
    clearReplacementDetailsLongPress();
    replacementLongPressTargetRef.current = null;
    replacementLongPressTriggeredRef.current = false;
  };
  const startReplacementDetailsLongPress = (
    event: ReactPointerEvent<HTMLButtonElement>,
    lineKey: string,
    hasDetails: boolean
  ) => {
    if (!hasDetails || disabled || event.button !== 0) return;
    clearReplacementDetailsLongPress();
    replacementLongPressTargetRef.current = lineKey;
    replacementLongPressTriggeredRef.current = false;
    replacementLongPressTimerRef.current = window.setTimeout(() => {
      replacementLongPressTimerRef.current = null;
      replacementLongPressTriggeredRef.current = true;
      triggerLongPressHaptic();
      setOpenReplacementLineKey((current) => (current === lineKey ? null : lineKey));
    }, REPLACEMENT_DETAILS_LONG_PRESS_MS);
  };
  const consumeReplacementDetailsLongPress = (lineKey: string) => {
    const wasTriggered =
      replacementLongPressTriggeredRef.current && replacementLongPressTargetRef.current === lineKey;
    replacementLongPressTargetRef.current = null;
    replacementLongPressTriggeredRef.current = false;
    return wasTriggered;
  };
  const submitCorrection = () =>
    run(() => submitOrderCorrection(context, correctionPayload, onLockConflict), { action });
  const submitCancel = () => {
    const safeReason = normalize(cancelReason);
    if (safeReason.length < 3) {
      setCancelReasonError("Inserisci il motivo dell'annullamento.");
      return;
    }
    setCancelReasonError(null);
    void run(() => cancelOrder(context, safeReason, onLockConflict), { action });
  };
  const submitReplacement = (sendReplacement: boolean) => {
    const safeReason = normalize(reason);
    if (safeReason.length < 3) {
      setReplacementReasonValidation("alert");
      return;
    }
    setReplacementReasonValidation("idle");
    void run(
      () =>
        submitOrderReplacement(
          context,
          {
            selections: selectedReplacementEntries,
            reason: safeReason,
            sendReplacement,
          },
          onLockConflict
        ),
      { action, sendReplacement }
    );
  };
  const isRecoveryForm =
    action === "replacement" || (action === "correction" && correctionMode === "form");
  const reasonLabel = action === "replacement" ? "Motivo reso" : "Motivo";
  const reasonPlaceholder = action === "replacement" ? "Motivo operativo" : "Motivo modifica";
  const reasonFieldClass =
    action === "correction"
      ? "msr-field msr-field-wide msr-correction-reason-inline"
      : "msr-field msr-field-wide msr-replacement-reason-inline";
  return (
    <div
      className={`msr-backdrop table-order-composer-backdrop ${
        isRecoveryForm ? "is-recovery-form-backdrop" : ""
      } ${action === "correction" && correctionMode === "form" ? "is-correction-form-backdrop" : ""}`}
      onClick={onClose}
    >
      <section
        className={`msr-composer-modal table-order-composer-modal ${
          action === "correction" && correctionMode === "choice"
            ? "is-choice-mode"
            : action === "replacement"
              ? "is-replacement-form"
              : "is-correction-form"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="msr-head">
          <div>
            <strong>{title}</strong>
            <span>{subtitle}</span>
          </div>
          <button
            type="button"
            className="smallbtn table-detail-close msr-close"
            onClick={onClose}
            aria-label="Chiudi"
          >
            <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </header>
        <div className="msr-body">
          {action === "correction" && correctionMode === "choice" ? (
            <ServiceRecoveryChoicePanel
              disabled={disabled}
              onCancelOrder={() => setCancelConfirmOpen(true)}
              onModifyOrder={() => setCorrectionMode("form")}
            />
          ) : action === "correction" ? (
            <section className="msr-correction-form" aria-label="Modifica comanda">
              <div className="msr-correction-list table-order-cart table-order-cart-drawer">
                {lineDrafts.map((line) => {
                  const product = productForLine(line, productIndex);
                  const isOpen = openCorrectionLineKey === line.lineKey;
                  const hasDetails = hasCorrectionDetails(line);
                  const variantOptions = variantOptionsForLine(line, product);
                  const supplementOptions = serviceRecoverySupplementOptions(line, product);
                  const unitPrice = line.nextUnitPrice;
                  return (
                    <section
                      key={line.lineKey}
                      className={`msr-correction-row table-order-item ${isOpen ? "is-open" : ""}`}
                    >
                      <div className="table-order-item-main">
                        <button
                          type="button"
                          className="table-order-item-toggle"
                          aria-label={
                            isOpen ? "Riduci dettaglio articolo" : "Espandi dettaglio articolo"
                          }
                          onClick={() =>
                            setOpenCorrectionLineKey((current) =>
                              current === line.lineKey ? null : line.lineKey
                            )
                          }
                          disabled={disabled}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            className={`table-order-item-chevron ${isOpen ? "is-open" : ""}`}
                            aria-hidden="true"
                          >
                            <path d="M7 10l5 5 5-5" />
                          </svg>
                        </button>
                        <div className="table-order-item-info">
                          <strong>
                            {line.productName}
                            {hasDetails ? " *" : ""}
                          </strong>
                        </div>
                        <div className="table-order-item-qty">
                          <button
                            type="button"
                            className="table-order-qty-btn is-minus"
                            onClick={() =>
                              updateDraft(line.lineKey, {
                                nextQuantity: clampQuantity(line.nextQuantity - 1, 0, 99, 0),
                              })
                            }
                            disabled={disabled}
                            aria-label="Riduci quantita"
                          >
                            -
                          </button>
                          <input
                            className="msr-line-qty"
                            type="number"
                            min="0"
                            max="99"
                            value={line.nextQuantity}
                            onChange={(event) =>
                              updateDraft(line.lineKey, {
                                nextQuantity: clampQuantity(
                                  event.target.value,
                                  0,
                                  99,
                                  line.nextQuantity
                                ),
                              })
                            }
                            disabled={disabled}
                          />
                          <button
                            type="button"
                            className="table-order-qty-btn is-plus"
                            onClick={() =>
                              updateDraft(line.lineKey, {
                                nextQuantity: clampQuantity(line.nextQuantity + 1, 0, 99, 1),
                              })
                            }
                            disabled={disabled}
                            aria-label="Aumenta quantita"
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div className="table-order-item-total">
                        {unitPrice > 0
                          ? line.nextQuantity > 1
                            ? `${formatCurrency(unitPrice)} cad. - Tot. ${formatCurrency(
                                unitPrice * line.nextQuantity
                              )}`
                            : formatCurrency(unitPrice * line.nextQuantity)
                          : ""}
                      </div>
                      <div className="table-order-item-details">
                        <div className="table-order-item-row msr-line-edit-grid">
                          <label className="msr-field table-order-variant-field">
                            <span>
                              {product?.variantRequired || product?.requiresVariant
                                ? "Variante obbligatoria"
                                : "Variante"}
                            </span>
                            <GlassDropdown
                              className="msr-custom-dropdown"
                              value={line.nextVariant}
                              options={variantOptions}
                              placeholder={
                                product?.variantRequired || product?.requiresVariant
                                  ? "Scegli variante"
                                  : "Nessuna variante"
                              }
                              ariaLabel={`Variante ${line.productName}`}
                              disabled={disabled}
                              onChange={(value) =>
                                updateDraft(line.lineKey, {
                                  nextVariant: value,
                                  nextModifiers: withModifier(
                                    line.nextModifiers,
                                    "Variante",
                                    value
                                  ),
                                  nextNotes: serviceRecoveryNoteWithSupplement(
                                    line,
                                    product,
                                    value,
                                    serviceRecoverySupplementValue(line)
                                  ),
                                  nextUnitPrice: resolveServiceRecoveryUnitPrice(
                                    line,
                                    product,
                                    value,
                                    serviceRecoverySupplementValue(line)
                                  ),
                                })
                              }
                            />
                          </label>
                          <label className="msr-field table-order-variant-field">
                            <span>Supplemento</span>
                            <GlassDropdown
                              className="msr-custom-dropdown"
                              value={serviceRecoverySupplementValue(line)}
                              options={supplementOptions}
                              placeholder="Nessun supplemento"
                              ariaLabel={`Supplemento ${line.productName}`}
                              disabled={disabled}
                              onChange={(value) =>
                                updateLineSupplement(line.lineKey, value, product)
                              }
                            />
                          </label>
                          <label className="msr-field msr-field-wide">
                            <span>Note articolo</span>
                            <textarea
                              className="msr-input msr-line-note"
                              value={line.nextNotes}
                              maxLength={180}
                              onChange={(event) =>
                                updateDraft(line.lineKey, { nextNotes: event.target.value })
                              }
                              disabled={disabled}
                              placeholder="Note articolo"
                            />
                          </label>
                        </div>
                      </div>
                    </section>
                  );
                })}
              </div>
            </section>
          ) : (
            <section className="msr-replacement-section">
              <div className="msr-replacement-context" aria-label="Dettaglio reso">
                <span>
                  <b>Comanda</b>
                  <strong>{orderNumberLabel}</strong>
                </span>
                <span>
                  <b>Tavolo</b>
                  <strong>{tableLabel}</strong>
                </span>
                <span>
                  <b>Sala</b>
                  <strong>{roomLabel}</strong>
                </span>
              </div>
              <div className="msr-replacement-cart table-order-cart table-order-cart-drawer">
                {replacementLines.map((line, index) => {
                  const lineKey = lineKeyForOrderService(line, index);
                  const maxQty = clampQuantity(replacementAvailableQuantity(line), 1, 99, 1);
                  const selection = replacementSelections[lineKey] ?? {
                    selected: false,
                    quantity: maxQty,
                  };
                  const details = replacementLineDetails(line);
                  const hasDetails = Boolean(
                    details.variant || details.additions.length > 0 || details.note
                  );
                  const isDetailsOpen = openReplacementLineKey === lineKey;
                  return (
                    <section
                      key={lineKey}
                      className={`msr-replacement-row table-order-item ${
                        selection.selected ? "is-selected" : ""
                      } ${hasDetails ? "has-details" : ""} ${
                        isDetailsOpen ? "is-details-open" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="msr-replacement-check"
                        aria-label={
                          selection.selected ? "Deseleziona articolo" : "Seleziona articolo"
                        }
                        onClick={() =>
                          updateReplacementSelection(lineKey, { selected: !selection.selected })
                        }
                        disabled={disabled}
                      >
                        <span />
                      </button>
                      <button
                        type="button"
                        className="table-order-item-main msr-replacement-main"
                        onPointerDown={(event) =>
                          startReplacementDetailsLongPress(event, lineKey, hasDetails)
                        }
                        onPointerUp={clearReplacementDetailsLongPress}
                        onPointerLeave={clearReplacementDetailsLongPress}
                        onPointerCancel={cancelReplacementDetailsLongPress}
                        onContextMenu={(event) => event.preventDefault()}
                        onClick={() => {
                          if (consumeReplacementDetailsLongPress(lineKey)) return;
                          updateReplacementSelection(lineKey, { selected: !selection.selected });
                        }}
                        disabled={disabled}
                        aria-expanded={hasDetails ? isDetailsOpen : undefined}
                        aria-label={`${selection.selected ? "Deseleziona" : "Seleziona"} ${
                          line.name
                        }${hasDetails ? "; tieni premuto per i dettagli" : ""}`}
                      >
                        <div className="table-order-item-info">
                          <strong>
                            {line.name}
                            {hasDetails ? " *" : ""}
                          </strong>
                        </div>
                      </button>
                      {isDetailsOpen ? (
                        <div
                          className="msr-replacement-details"
                          aria-label={`Dettagli ${line.name}`}
                        >
                          {details.variant ? (
                            <span>
                              <b>Variante</b>
                              <strong>{details.variant}</strong>
                            </span>
                          ) : null}
                          {details.additions.length > 0 ? (
                            <span>
                              <b>Aggiunte</b>
                              <strong>{details.additions.join(", ")}</strong>
                            </span>
                          ) : null}
                          {details.note ? (
                            <span>
                              <b>Note</b>
                              <strong>{details.note}</strong>
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="msr-replacement-action-row">
                        {maxQty > 1 ? (
                          <div className="msr-replacement-qty">
                            <span>Quantita</span>
                            <div className="msr-replacement-qty-controls">
                              <button
                                type="button"
                                className="table-order-qty-btn is-minus"
                                onClick={() =>
                                  updateReplacementSelection(lineKey, {
                                    quantity: clampQuantity(selection.quantity - 1, 1, maxQty, 1),
                                  })
                                }
                                disabled={disabled || !selection.selected}
                                aria-label="Riduci quantita"
                              >
                                -
                              </button>
                              <input
                                className="msr-replacement-qty-input"
                                type="number"
                                min="1"
                                max={maxQty}
                                value={selection.quantity}
                                onChange={(event) =>
                                  updateReplacementSelection(lineKey, {
                                    quantity: clampQuantity(
                                      event.target.value,
                                      1,
                                      maxQty,
                                      selection.quantity
                                    ),
                                  })
                                }
                                disabled={disabled || !selection.selected}
                              />
                              <button
                                type="button"
                                className="table-order-qty-btn is-plus"
                                onClick={() =>
                                  updateReplacementSelection(lineKey, {
                                    quantity: clampQuantity(
                                      selection.quantity + 1,
                                      1,
                                      maxQty,
                                      maxQty
                                    ),
                                  })
                                }
                                disabled={disabled || !selection.selected}
                                aria-label="Aumenta quantita"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <div className="msr-replacement-total table-order-item-total">
                          {lineTotalLabel(line, selection.quantity)}
                        </div>
                      </div>
                    </section>
                  );
                })}
              </div>
            </section>
          )}
        </div>
        {isRecoveryForm ? (
          <div className="msr-reason-dock">
            <label
              className={`${reasonFieldClass} ${
                replacementReasonValidation !== "idle" ? "is-invalid" : ""
              }`}
            >
              <span>{reasonLabel}</span>
              <textarea
                className={`msr-input msr-textarea ${
                  replacementReasonValidation !== "idle" ? "is-invalid" : ""
                }`}
                value={reason}
                maxLength={action === "replacement" ? 240 : 300}
                onChange={(event) => {
                  const nextReason = event.target.value;
                  setReason(nextReason);
                  if (replacementReasonValidation !== "idle" && normalize(nextReason).length >= 3) {
                    setReplacementReasonValidation("idle");
                  }
                }}
                disabled={disabled}
                placeholder={reasonPlaceholder}
                aria-invalid={replacementReasonValidation !== "idle"}
              />
            </label>
          </div>
        ) : null}
        {action === "correction" && correctionMode === "choice" ? null : (
          <footer
            className={`msr-foot ${
              action === "replacement" ? "msr-foot-replacement" : "msr-foot-correction"
            }`}
          >
            {action === "correction" ? (
              <button
                type="button"
                className="smallbtn table-order-submit msr-primary"
                onClick={submitCorrection}
                disabled={disabled || !hasCorrectionDiff}
                aria-busy={localBusy}
              >
                {localBusy ? (
                  <span className="msr-submit-spinner" aria-hidden="true" />
                ) : (
                  <svg className="table-order-submit-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 11.5l17-8-4.2 17-2.9-6.6L3 11.5z" />
                    <path d="M12.9 13.4l6.1-9.9" />
                  </svg>
                )}
                <span>{localBusy ? "Invio..." : "Invia modifica"}</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={`smallbtn msr-replacement-submit msr-replacement-submit-refund ${
                    replacementSubmitIntent === "refund" ? "is-loading" : ""
                  }`}
                  onClick={() => submitReplacement(false)}
                  disabled={disabled || selectedReplacementEntries.length === 0}
                  aria-busy={replacementSubmitIntent === "refund"}
                >
                  {replacementSubmitIntent === "refund" ? (
                    <span className="msr-submit-spinner" aria-hidden="true" />
                  ) : null}
                  <span>{replacementSubmitIntent === "refund" ? "Reso..." : "RESO"}</span>
                </button>
                <button
                  type="button"
                  className={`smallbtn msr-replacement-submit msr-replacement-submit-swap ${
                    replacementSubmitIntent === "swap" ? "is-loading" : ""
                  }`}
                  onClick={() => submitReplacement(true)}
                  disabled={disabled || selectedReplacementEntries.length === 0}
                  aria-busy={replacementSubmitIntent === "swap"}
                >
                  {replacementSubmitIntent === "swap" ? (
                    <span className="msr-submit-spinner" aria-hidden="true" />
                  ) : null}
                  <span>
                    {replacementSubmitIntent === "swap" ? "Sostituzione..." : "SOSTITUZIONE"}
                  </span>
                </button>
              </>
            )}
          </footer>
        )}
      </section>
      {cancelConfirmOpen ? (
        <ServiceRecoveryCancelConfirmDialog
          busy={disabled}
          reason={cancelReason}
          error={cancelReasonError}
          onReasonChange={(value) => {
            setCancelReason(value);
            if (cancelReasonError) setCancelReasonError(null);
          }}
          onBack={() => {
            setCancelConfirmOpen(false);
            setCancelReasonError(null);
          }}
          onConfirm={submitCancel}
        />
      ) : null}
      {replacementReasonValidation === "alert" ? (
        <ServiceRecoveryAlertDialog
          message={REPLACEMENT_REASON_REQUIRED_MESSAGE}
          onClose={() => setReplacementReasonValidation("invalid")}
        />
      ) : error ? (
        <ServiceRecoveryAlertDialog message={error} onClose={() => setError(null)} />
      ) : null}
    </div>
  );
}
