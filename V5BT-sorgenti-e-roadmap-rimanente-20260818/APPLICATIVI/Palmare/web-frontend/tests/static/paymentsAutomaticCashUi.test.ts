import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

const readSource = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

describe("payments automatic-cash UI phase", () => {
  it("uses cash-load actions and a choice modal instead of AUTO/MANUALE cards on the page", () => {
    const source = readSource("src/pages/PaymentsPage.tsx");
    const choiceModal = readSource("src/pages/payments/CashFloatLoadChoiceModal.tsx");
    const manualModal = readSource("src/pages/payments/ManualCashFloatModal.tsx");
    const automaticModal = readSource("src/pages/payments/AutomaticCashFloatModal.tsx");

    expect(source).toContain("payments-cash-action-grid");
    expect(source).toContain("if (hasLoadedCashFloat) return");
    expect(source).toContain("Carica");
    expect(source).toContain("GENERA FONDO CASSA");
    expect(source).toContain("<CashFloatLoadChoiceModal");
    expect(choiceModal).toContain("Automatico");
    expect(choiceModal).toContain("Manuale");
    expect(source).not.toContain("payments-method-card");
    expect(source).not.toContain("<span>AUTO</span>");
    expect(source).not.toContain("<span>MANUALE</span>");
    expect(source).not.toContain('id="cash-float-input"');
    expect(manualModal).toContain('id="cash-float-manual-input"');
    expect(automaticModal).toContain('aria-label="Fondo cassa automatico"');
  });

  it("opens manual and automatic modals without exposing automatic value copy", () => {
    const source = readSource("src/pages/PaymentsPage.tsx");
    const automaticModal = readSource("src/pages/payments/AutomaticCashFloatModal.tsx");

    expect(source).toContain("onClick={openCashLoadChoice}");
    expect(source).toContain("onAutomatic={openOperatorAutoCashModal}");
    expect(source).toContain("onManual={openManualCashModal}");
    expect(source).toContain("onClick={openAdminAutoCashModal}");
    expect(source).toContain("Fondo cassa automatico configurato");
    expect(source).not.toContain("Valore nascosto per sicurezza");
    expect(automaticModal).not.toContain("Valore nascosto per sicurezza");
    expect(source).toContain("<AutomaticCashFloatModal");
    expect(source).toContain("<ManualCashFloatModal");
  });

  it("renders settlement only when a cash float is loaded", () => {
    const source = readSource("src/pages/PaymentsPage.tsx");

    expect(source).toContain("const hasLoadedCashFloat = hasManualCashFloat || hasAutoCashFloat");
    expect(source).toContain("const showSettlementSection = hasLoadedCashFloat");
    expect(source).toContain("{showSettlementSection && (");
    expect(source).toContain("<PaymentSettlementSection");
    expect(source).toContain("onRequestNewAutoCashFloat={openOperatorAutoCashModal}");
  });

  it("keeps admin automatic cash generation gated by role or permission", () => {
    const source = readSource("src/pages/PaymentsPage.tsx");

    expect(source).toContain("canManageAutomaticCashRole(role)");
    expect(source).toContain("permissions.some(");
    expect(source).toContain("canOpenAutomaticCashFloatAction");
    expect(source).toContain("mode={autoCashModalMode}");
    expect(source).toContain('"admin-create"');
    expect(source).toContain("GENERA FONDO CASSA");
  });

  it("supports automatic cash generation, live QR loading and internal ticket printing", () => {
    const source = readSource("src/pages/PaymentsPage.tsx");
    const automaticModal = readSource("src/pages/payments/AutomaticCashFloatModal.tsx");
    const qrScanner = readSource("src/pages/payments/QrCameraScanner.tsx");
    const ticketModal = readSource("src/pages/payments/CashFloatTicketModal.tsx");
    const ticketText = readSource("src/pages/payments/cashFloatTicket.ts");
    const ticketRegistry = readSource("src/utils/automaticCashTicketRegistry.ts");
    const css = readSource("src/styles/glass.css");

    expect(automaticModal).toContain("generateAutomaticCashFloat");
    expect(automaticModal).toContain("confirmAutomaticCashFloatRemoved");
    expect(automaticModal).toContain("confirmAutomaticCashFloatTicketInPouch");
    expect(automaticModal).toContain("getAutomaticCashPreflight");
    expect(automaticModal).toContain("loadAutomaticCashFloatFromQr");
    expect(automaticModal).toContain("generatedFromActiveWorkflow");
    expect(automaticModal).toContain("resumeActiveWorkflow");
    expect(automaticModal).toContain("Riprendi");
    expect(automaticModal).toContain('mode === "operator-load"');
    expect(automaticModal).toContain('mode === "admin-create"');
    expect(automaticModal).toContain("shouldLoadGeneratedCashFloat");
    expect(automaticModal).toContain("lockAutoCashFloat");
    expect(automaticModal).toContain("saveAutomaticCashTicketRecord");
    expect(automaticModal).toContain("totalCents: response.totalCents");
    expect(automaticModal).toContain("<QrCameraScanner");
    expect(automaticModal).toContain("loadQrPayload(payload)");
    expect(automaticModal).toContain("Scansiona QR");
    expect(automaticModal).not.toContain("Carica da QR");
    expect(automaticModal).not.toContain("Inquadra il QR con la videocamera live.");
    expect(automaticModal).not.toContain("payments-qr-textarea");
    expect(automaticModal).not.toContain("Payload QR manuale");
    expect(automaticModal).not.toContain("qrDraft");
    expect(qrScanner).toContain("navigator.mediaDevices.getUserMedia");
    expect(qrScanner).toContain("BarcodeDetector");
    expect(qrScanner).not.toContain('type="file"');
    expect(qrScanner).not.toContain('capture="environment"');
    expect(qrScanner).not.toContain("createImageBitmap");
    expect(qrScanner).not.toContain("Incolla");
    expect(qrScanner).not.toContain("Scatta foto");
    expect(qrScanner).not.toContain("Avvio fotocamera");
    expect(qrScanner).not.toContain("Inquadra il QR");
    expect(qrScanner).toContain("payments-qr-frame");
    expect(source).toContain("admin_manual_generation");
    expect(automaticModal).toContain("buildAutomaticCashFloatTicketText");
    expect(ticketText).toContain("ESC_POS_RAW_BASE64");
    expect(ticketText).toContain("Valore codificato - non visibile");
    expect(ticketText).toContain("autoPrint");
    expect(ticketText).not.toContain("--- QR PAYLOAD START ---");
    expect(ticketText).not.toContain("TODO QR grafico ESC/POS");
    expect(ticketRegistry).toContain("automatic_cash_float_ticket_records_v1");
    expect(ticketRegistry).toContain("sanitizeOptionalTotalCents");
    expect(ticketRegistry).toContain("mobile:automatic-cash-ticket-records-changed");
    expect(ticketModal).toContain("SETTLEMENT_PRINT_PATH");
    expect(ticketModal).toContain("markAutomaticCashFloatTicketPrinted");
    expect(ticketModal).toContain("ticket.autoPrint === false");
    expect(ticketModal).not.toContain("payments-ticket-preview");
    expect(css).toContain(".payments-confirm-back-icon");
    expect(css).toContain(".payments-cash-action-grid");
    expect(css).toContain(".payments-cash-choice-actions");
    expect(css).toContain("filter: brightness(0) invert(1)");
    expect(css).toContain(".smallbtn.payments-confirm");
    expect(css).toContain(".smallbtn.payments-confirm-back");
    expect(css).toContain(':root[data-theme="light"] .payments-confirm-back-icon');
    expect(css).toContain(':root[data-theme="light"] .smallbtn.payments-confirm-back');
    expect(css).toContain(':root[data-theme="light"] .payments-qr-camera-placeholder');
  });

  it("routes automatic settlements through the automatic wizard and archive", () => {
    const payments = readSource("src/pages/PaymentsPage.tsx");
    const overview = readSource("src/pages/payments/PaymentOverviewProvider.tsx");
    const settlement = readSource("src/pages/payments/PaymentSettlementSection.tsx");
    const wizard = readSource("src/pages/payments/AutomaticSettlementWizard.tsx");
    const archive = readSource("src/utils/automaticCashSettlementArchive.ts");

    expect(payments).toContain("usePaymentOverviewSnapshot");
    expect(overview).toContain("reconcileAutomaticCashStatus");
    expect(overview).toContain("status.settlementAllowed === true");
    expect(overview).toContain("activeCashFloat.cashFloatId");
    expect(overview).toContain("paymentState.lockAutoCashFloat");
    expect(settlement).toContain("<AutomaticSettlementWizard");
    expect(settlement).toContain("settlementLaunchMode");
    expect(settlement).toContain("Scarico automatico");
    expect(settlement).toContain("Scarico manuale");
    expect(settlement).toContain("handleSettlementLaunchPointerDown");
    expect(settlement).toContain("triggerLongPressHaptic");
    expect(settlement).toContain("automaticSettlement: Boolean(automaticResult)");
    expect(settlement).toContain("resolveCompletedAmountToDeposit(snapshot, automaticResult)");
    expect(settlement).toContain("amountToDeposit: completedAmountToDeposit");
    expect(settlement).not.toContain("settlementModeChoiceOpen");
    expect(settlement).not.toContain('context.cashMode === "auto" && context.cashFloatLocked');
    expect(settlement).toContain("saveAutomaticCashSettlementRecord");
    expect(settlement).toContain("updateAutomaticCashTicketRecordStatus");
    expect(settlement).toContain("Ristampa ultimo automatico");
    expect(settlement).toContain("buildPrintText(snapshot, automaticResult)");
    expect(settlement).toContain("SCARICO AUTOMATICO");
    expect(settlement).toContain("RIADDEBITI POS");
    expect(settlement).toContain("posRechargeTotal");
    expect(settlement).toContain("DIFFERENZA");
    expect(wizard).toContain("startAutomaticCashDeposit");
    expect(wizard).toContain("closeAutomaticCashDeposit");
    expect(wizard).toContain("cancelAutomaticCashDeposit");
    expect(wizard).toContain("fondo cassa caricato");
    expect(wizard).not.toContain("fondo cassa automatico caricato");
    expect(wizard).toContain("onReprint");
    expect(wizard).toContain("Ristampa");
    expect(wizard).toContain("Chiudi");
    expect(wizard).toContain("WARNING_THRESHOLD_CENTS = 1000");
    expect(wizard).not.toContain("Differenza rilevata");
    expect(wizard).not.toContain("Conferma comunque");
    expect(wizard).not.toContain("Genera nuovo");
    expect(wizard).not.toContain("Piu tardi");
    expect(archive).toContain("automatic_cash_settlement_records_v1");
    expect(archive).toContain("expectedDepositTotalCents");
    expect(archive).toContain("depositedTotalCents");
    expect(archive).toContain("differenceCents");
  });

  it("exposes latest automatic settlement details and cash-float monitor history", () => {
    const settlement = readSource("src/pages/payments/PaymentSettlementSection.tsx");
    const analytics = readSource("src/pages/home/analytics/AnalyticsWorkspace.tsx");
    const cashMovements = readSource("src/pages/home/analytics/CashMovementsView.tsx");
    const home = readSource("src/pages/HomePage.tsx");
    const topBar = readSource("src/pages/home/components/TopBar.tsx");
    const css = readSource("src/styles/glass.css");
    const tablesCss = readSource("src/styles/tables.css");

    expect(settlement).toContain('aria-label="Dettaglio ultimo scarico"');
    expect(settlement).toContain("automaticDetailOpen");
    expect(settlement).toContain("latestAutomaticSettlement.printText");
    expect(settlement).toContain("Ristampa ultimo automatico");
    expect(analytics).toContain(
      'type AnalyticsViewMode = "payments" | "cash_movements" | "cash_floats"'
    );
    expect(analytics).toContain("viewMode?: AnalyticsViewMode");
    expect(analytics).toContain("<CashMovementsView search={search}");
    expect(analytics).toContain("readAutomaticCashTicketRecords");
    expect(analytics).toContain("CASH_FLOAT_AMOUNT_MASK");
    expect(analytics).toContain("CashFloatQrCode");
    expect(analytics).toContain("selectedCashFloatAmountLabel");
    expect(analytics).not.toContain('role="tablist"');
    expect(home).toContain('role === "admin"');
    expect(home).toContain("analyticsModePickerOpen");
    expect(home).toContain("MOVIMENTI");
    expect(home).toContain("FONDI CASSA");
    expect(topBar).toContain("onTitleLongPress");
    expect(tablesCss).toContain("grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(tablesCss).toContain(".analytics-mode-picker-btn.is-payments");
    expect(tablesCss).toContain(".analytics-mode-picker-btn.is-cash-movements");
    expect(tablesCss).toContain(".analytics-mode-picker-btn.is-cash-floats");
    expect(analytics).toContain("PaymentMethodIcon");
    expect(tablesCss).toContain(".analytics-kind-pill.method-cash");
    expect(tablesCss).toContain(".analytics-kind-pill.method-card");
    expect(cashMovements).toContain("getAutomaticCashMovements");
    expect(cashMovements).toContain("CAMBIO MONETE");
    expect(cashMovements).toContain("Giustificazione");
    expect(analytics).toContain("selectedCashFloatTicket.printText");
    expect(analytics).toContain("selectedCashFloatTicket.qrPayload");
    expect(analytics).toContain("mobile-analytics-cash-amount-eye");
    expect(analytics).not.toContain(
      '<pre className="mobile-analytics-detail-tx">{selectedCashFloatTicket.printText}</pre>'
    );
    expect(analytics).toContain("mobile-automatic-cash-monitor");
    expect(css).toContain(".mobile-payments-settlement-eye");
    expect(tablesCss).toContain(".mobile-analytics-cash-amount-card");
    expect(tablesCss).toContain(".mobile-analytics-cash-amount-eye");
    expect(tablesCss).toContain("justify-content: center;");
    expect(tablesCss).toContain(".mobile-analytics-detail-eye-icon");
    expect(tablesCss).toContain("display: block;");
    expect(tablesCss).toContain(".mobile-analytics-cash-qr-code");
  });

  it("keeps automatic-cash administration and POS statistics out of mobile settings", () => {
    const settingsPage = readSource("src/pages/SettingsPage.tsx");
    const paymentsPage = readSource("src/pages/PaymentsPage.tsx");
    const paymentOverview = readSource("src/pages/payments/PaymentOverviewProvider.tsx");
    const adminSectionPath = resolve(
      repoRoot,
      "src/pages/settings/components/AutomaticCashSettingsSection.tsx"
    );

    expect(existsSync(adminSectionPath)).toBe(false);
    expect(settingsPage).not.toContain("AutomaticCashSettingsSection");
    expect(settingsPage).not.toContain("Statistiche POS");
    expect(settingsPage).not.toContain("File combinazioni JSON");
    expect(settingsPage).not.toContain("File riserva minima JSON");

    expect(paymentsPage).toContain("usePaymentOverviewSnapshot");
    expect(paymentOverview).toContain("getAutomaticCashStatus");
    expect(paymentsPage).toContain("<AutomaticCashFloatModal");
    expect(paymentsPage).toContain("<PaymentSettlementSection");
  });

  it("keeps automatic-cash administration and POS statistics in central settings", () => {
    const centralSettingsPath = [
      resolve(repoRoot, "../settings-frontend/dist/assets/settings-app.js"),
      resolve(repoRoot, "../../../SORGENTE_SISTEMA/settings-frontend/dist/assets/settings-app.js"),
    ].find((candidate) => existsSync(candidate));

    expect(centralSettingsPath).toBeTruthy();
    const centralSettings = readFileSync(centralSettingsPath || "", "utf8");

    expect(centralSettings).toContain("Configurazione fondo cassa automatico");
    expect(centralSettings).toContain("File combinazioni JSON");
    expect(centralSettings).toContain("Riserva minima cassa");
    expect(centralSettings).toContain("function renderPosStatistics()");
    expect(centralSettings).toContain('postJson("/api/reports/sales", sessionPayload())');
    expect(centralSettings).toContain("Statistiche POS");
    expect(centralSettings).toContain('data-action="reload-pos-statistics"');
  });

  it("adds backend-owned cash exchange flow without direct gateway access", () => {
    const source = readSource("src/pages/PaymentsPage.tsx");
    const overview = readSource("src/pages/payments/PaymentOverviewProvider.tsx");
    const wizard = readSource("src/pages/payments/CashExchangeWizard.tsx");
    const selector = readSource("src/pages/payments/CashExchangeDenominationSelector.tsx");
    const denominations = readSource("src/pages/payments/cashExchangeDenominations.ts");
    const api = readSource("src/api/cashExchange.ts");
    const errors = readSource("src/utils/automaticCashErrors.ts");
    const css = readSource("src/styles/glass.css");

    expect(source).toContain("usePaymentOverviewSnapshot");
    expect(overview).toContain("getActiveCashExchange");
    expect(source).toContain("<CashExchangeWizard");
    expect(source).toContain("payments-cash-action-btn is-exchange");
    expect(source).toContain("RIPRENDI SCAMBIO");
    expect(source).toContain("SCAMBIO CONTANTI");
    expect(source).toContain('automaticCashStatus.activeOperationType !== "cash_exchange"');
    expect(wizard).toContain("startCashExchange");
    expect(wizard).toContain("getCashExchangeState");
    expect(wizard).toContain("confirmCashExchangeDeposit");
    expect(wizard).toContain("executeCashExchange");
    expect(wizard).toContain("confirmCashExchangeRemoved");
    expect(wizard).toContain("cancelCashExchange");
    expect(wizard).toContain("POLL_INTERVAL_MS = 1250");
    expect(wizard).toContain("<CashExchangeDenominationSelector");
    expect(wizard).toContain("allowedDenominationsCents={allowedDenominations}");
    expect(selector).toContain("allowedDenominationsCents");
    expect(selector).toContain("CASH_EXCHANGE_DENOMINATIONS.filter");
    expect(denominations).toContain("{ cents: 2000");
    expect(denominations).toContain("{ cents: 5");
    expect(api).toContain('const BASE = "/api/automatic-cash/exchange"');
    expect(api).toContain("Authorization: `Bearer ${token}`");
    expect(api).not.toContain("RealSngGateway");
    expect(api).not.toContain("cashin/start");
    expect(api).not.toContain("change/start");
    expect(errors).toContain("CASH_EXCHANGE_TOTAL_MISMATCH");
    expect(errors).toContain("CASH_EXCHANGE_INVENTORY_INSUFFICIENT");
    expect(css).toContain(".payments-cash-action-btn.is-exchange");
    expect(css).toContain(".cash-exchange-denomination-row");
    expect(css).toContain(':root[data-theme="light"] .payments-cash-action-btn.is-exchange');
  });

  it("adds persistent cash loading and withdrawal operations after cash functions", () => {
    const source = readSource("src/pages/PaymentsPage.tsx");
    const overview = readSource("src/pages/payments/PaymentOverviewProvider.tsx");
    const modal = readSource("src/pages/payments/CashMovementModal.tsx");
    const api = readSource("src/api/automaticCash.ts");
    const css = readSource("src/styles/glass.css");

    expect(source).toContain("payments-cash-movement-section");
    expect(source).toContain("CARICAMENTO");
    expect(source).toContain("PRELIEVO");
    expect(source).toContain("<CashMovementModal");
    expect(source).toContain("usePaymentOverviewSnapshot");
    expect(overview).toContain("getActiveAutomaticCashMovement");
    expect(modal).toContain("Giustificazione *");
    expect(modal).toContain("Avvicinati alla cassa automatica");
    expect(modal).toContain("SONO DAVANTI ALLA CASSA");
    expect(modal).toContain("Scegli i tagli");
    expect(modal).toContain("Disponibili {entry.availablePieces}");
    expect(modal).toContain("Conferma il prelievo");
    expect(modal).toContain("Totale inserito");
    expect(modal).toContain("Aggiornamento automatico");
    expect(modal).toContain("Controlla tagli e quantita");
    expect(modal).toContain("HO RITIRATO TUTTO");
    expect(modal).toContain("CHIUDI CARICAMENTO");
    expect(modal).toContain("TERMINA RITIRO");
    expect(modal).toContain("RISTAMPA");
    expect(modal).toContain("startAutomaticCashMovement");
    expect(modal).toContain("getCashMovementWithdrawalAvailability");
    expect(modal).toContain("getAutomaticCashMovementState");
    expect(modal).toContain("prepareAutomaticCashMovement");
    expect(modal).toContain("completeAutomaticCashMovement");
    expect(modal).toContain("printAutomaticCashMovementReport");
    expect(modal).toContain("cancelAutomaticCashMovement");
    expect(modal).toContain("awaitingReport: true");
    expect(api).toContain('"/cash-movements/start"');
    expect(api).toContain("/cash-movements/active");
    expect(api).toContain("/cash-movements/withdrawal-availability");
    expect(api).toContain("/state");
    expect(api).toContain("/prepare");
    expect(api).toContain("/print");
    expect(css).toContain(".payments-cash-action-btn.is-cash-load");
    expect(css).toContain(".payments-cash-action-btn.is-cash-withdrawal");
    expect(css).toContain(".cash-movement-progress");
    expect(css).toContain(".cash-movement-denomination-picker");
    expect(css).toContain(".cash-movement-completed-mark");
  });

  it("hardens automatic cash feedback and operator error handling", () => {
    const modal = readSource("src/pages/payments/AutomaticCashFloatModal.tsx");
    const wizard = readSource("src/pages/payments/AutomaticSettlementWizard.tsx");
    const settlement = readSource("src/pages/payments/PaymentSettlementSection.tsx");
    const errors = readSource("src/utils/automaticCashErrors.ts");
    const feedbackAssets = readSource("src/assets/feedback/index.ts");
    const css = readSource("src/styles/glass.css");

    expect(errors).toContain("FCA_CONFIG_POOL_EXHAUSTED");
    expect(errors).toContain("Configurazioni fondo cassa esaurite per questa sera");
    expect(errors).toContain("AUTOMATIC_CASH_LOCKED");
    expect(errors).toContain("ownerFullName");
    expect(errors).toContain("Operazione in corso da parte di");
    expect(errors).toContain("Cassa automatica non raggiungibile");
    expect(modal).toContain("formatAutomaticCashError");
    expect(wizard).toContain("formatAutomaticCashError");
    expect(wizard).toContain("automaticCashFeedbackAssets");
    expect(wizard).toContain("pendingResult ? automaticCashFeedbackAssets");
    expect(wizard).toContain("mobile-payments-settlement-feedback-image");
    expect(settlement).toContain("getAutomaticCashSettings");
    expect(settlement).toContain("saveAutomaticCashSettlementRecordToDb");
    expect(settlement).toContain("getLatestAutomaticCashSettlementRecord");
    expect(settlement).toContain("feedbackEnabled={automaticCashFeedbackSettings.feedbackEnabled}");
    expect(feedbackAssets).toContain("happy.png");
    expect(feedbackAssets).toContain("sad.png");
    expect(feedbackAssets).toContain("angry.png");
    expect(css).toContain(".mobile-payments-settlement-feedback-image");
  });
});
