export type CashFloatMode = "none" | "manual" | "auto";

export type AutomaticCashFloatMode = "fixed" | "random_file";

export type AutomaticCashCurrency = "EUR";

export type CashFloatDenominationMap = Record<string, number>;

export type CashFloatDenominationDetail = {
  valore_centesimi: number;
  quantita: number;
  totale_centesimi: number;
};

export type CashFloatCombination = {
  id: string;
  totale?: number;
  totale_euro?: string;
  totale_formattato?: string;
  totale_centesimi: number;
  totale_pezzi?: number;
  pezzi_totali?: number;
  tagli?: CashFloatDenominationMap;
  tagli_euro?: CashFloatDenominationMap;
  dettaglio_valori_centesimi?: Record<string, CashFloatDenominationDetail>;
};

export type CashFloatConfigFile = {
  nome?: string;
  name?: string;
  descrizione?: string;
  valuta: AutomaticCashCurrency;
  vincoli?: Record<string, unknown>;
  denominazioni_centesimi?: Record<string, number>;
  combinazioni: CashFloatCombination[];
};

export type NormalizedCashFloatCombination = {
  id: string;
  totalCents: number;
  piecesTotal: number;
  denominations: CashFloatDenominationMap;
};

export type CashFloatConfigSummary = {
  id: string;
  name: string;
  currency: AutomaticCashCurrency;
  combinationsCount: number;
  minTotalCents: number;
  maxTotalCents: number;
  uniquePerUserPerBusinessEvening: boolean;
};

export type CashFloatReserveConfigFile = {
  schema_version: 1;
  id: string;
  nome: string;
  valuta: AutomaticCashCurrency;
  enabled: boolean;
  missing_denomination_policy: "reject";
  denominazioni_centesimi: Record<string, number>;
  riserva_minima_pezzi: Record<string, number>;
};

export type CashFloatReserveConfigSummary = {
  id: string;
  name: string;
  currency: AutomaticCashCurrency;
  enabled: boolean;
  missingDenominationPolicy: "reject";
  denominationsCount: number;
  minimumPiecesTotal: number;
};

export type AutomaticCashSettings = {
  enabled: boolean;
  gatewayConfigured: boolean;
  feedbackEnabled: boolean;
  warningThresholdCents: number;
  dangerThresholdCents: number;
  autoCashFloatMode: AutomaticCashFloatMode;
  configSet?: CashFloatConfigSummary | null;
  configSets?: CashFloatConfigSummary[];
  reserveConfig?: CashFloatReserveConfigSummary | null;
  reserveConfigs?: CashFloatReserveConfigSummary[];
};

export type UpdateAutomaticCashSettingsRequest = {
  enabled?: boolean;
  gatewayConfigured?: boolean;
  gatewayInventory?: unknown;
  feedbackEnabled?: boolean;
  warningThresholdCents?: number;
  dangerThresholdCents?: number;
  autoCashFloatMode?: AutomaticCashFloatMode;
  configSetId?: string | null;
  reserveConfigId?: string | null;
};

export type UploadAutomaticCashConfigSetRequest = {
  config: CashFloatConfigFile;
  clientSummary?: CashFloatConfigSummary;
};

export type UploadAutomaticCashReserveConfigRequest = {
  config: CashFloatReserveConfigFile;
  clientSummary?: CashFloatReserveConfigSummary;
};

export type AutomaticCashWorkflowStep =
  | "RESERVING"
  | "WITHDRAWAL_REQUESTED"
  | "DISPENSING"
  | "WAITING_CASH_REMOVAL"
  | "CASH_REMOVED_CONFIRMED"
  | "TICKET_READY"
  | "PRINTING_TICKET"
  | "WAITING_TICKET_IN_POUCH"
  | "COMPLETED"
  | "FAILED_BEFORE_DISPENSE"
  | "INCIDENT_REVIEW"
  | "CANCELLED";

export type AutomaticCashActiveWorkflow = {
  workflowId: string;
  operationId?: string | null;
  cashFloatId: string;
  assignmentId?: string | null;
  combinationId?: string | null;
  businessEveningKey?: string | null;
  configSetId?: string | null;
  reserveConfigId?: string | null;
  activityId?: string | null;
  roomId?: string | null;
  reason?: string | null;
  pieces?: CashFloatDenominationMap;
  gatewayPieces?: CashFloatDenominationMap;
  totalCents?: number | null;
  createdAtMs?: number | null;
  qrPayload?: string | null;
  ownerUserId: string;
  ownerFullName: string;
  ownerDeviceUuid: string;
  step: AutomaticCashWorkflowStep;
  startedAtMs: number;
  updatedAtMs: number;
  resumableByCurrentUser: boolean;
  resumableByManager?: boolean;
  blockedByOperationLock?: boolean;
  operationLock?: {
    ownerUserId?: string | null;
    ownerFullName?: string | null;
    ownerDeviceUuid?: string | null;
    ownerCanManageAutomaticCash?: boolean;
    reason?: string | null;
    acquiredAtMs?: number | null;
    expiresAtMs?: number | null;
  } | null;
  ticket?: {
    printed?: boolean;
    printJobId?: string | null;
    printedAtMs?: number | null;
  } | null;
};

export type AutomaticCashPreflightBlockedDenomination = {
  denominationLabel?: string;
  denominationCents: number;
  availablePieces: number;
  minimumReservePieces: number;
  requestedPieces: number;
  remainingPieces: number;
  missingPieces: number;
  reasonCode?: string;
};

export type AutomaticCashPreflight = {
  ok: true;
  canCreate: boolean;
  reasonCode: AutomaticCashApiErrorCode | "OK" | "AUTOMATIC_CASH_DISABLED";
  message?: string;
  businessEveningKey: string;
  inventoryCheckedAtMs: number;
  configSetId?: string | null;
  reserveConfigId?: string | null;
  unusedCombinationCount: number;
  eligibleCombinationCount: number;
  blockedDenominations: AutomaticCashPreflightBlockedDenomination[];
  activeWorkflow?: AutomaticCashActiveWorkflow | null;
};

export type AutomaticCashStatusCashFloat = {
  mode: "auto";
  status: "ACTIVE";
  cashFloatId: string;
  totalCents: number;
  loadedAtMs: number;
  assignmentId?: string | null;
  combinationId?: string | null;
  businessEveningKey?: string | null;
  qrPayload?: string | null;
};

export type AutomaticCashStatus = {
  enabled: boolean;
  gatewayConfigured: boolean;
  feedbackEnabled: boolean;
  cashFloatMode: CashFloatMode;
  currentCashFloatId?: string | null;
  cashFloat?: AutomaticCashStatusCashFloat | null;
  activeOperationId?: string | null;
  activeOperationType?: AutomaticCashOperationType | null;
  activeWorkflow?: AutomaticCashActiveWorkflow | null;
  settlementAllowed?: boolean;
  lastSyncAtMs?: number | null;
};

export type AutomaticCashGatewayState = {
  configured: boolean;
  reachable: boolean;
  inventoryReady?: boolean;
  busy?: boolean;
  operationId?: string | null;
  operationType?: AutomaticCashOperationType | null;
  deviceId?: string | null;
  updatedAtMs?: number | null;
  error?: string | null;
};

export type AutomaticCashOperationType =
  | "cash_float"
  | "deposit"
  | "cash_exchange"
  | "cash_movement"
  | "cash_payment"
  | "cash_float_confirm_removed"
  | "unknown";

export type CashMovementType = "load" | "withdrawal" | "exchange";

export type CashMovementStatus =
  | "STARTING"
  | "ACTIVE"
  | "REVIEW_REQUIRED"
  | "WAITING_CASH_REMOVAL"
  | "WAITING_REPORT"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export type CashMovementRecord = {
  movementId: string;
  sourceId?: string | null;
  clientRequestId?: string;
  type: CashMovementType;
  status: CashMovementStatus | string;
  requestedAmountCents: number;
  amountCents: number;
  signedAmountCents: number;
  pieces?: CashFloatDenominationMap;
  piecesTotalCents?: number;
  justification: string;
  ownerUserId: string;
  ownerFullName: string;
  ownerDeviceUuid: string;
  ownerSessionId?: string;
  activityId?: string;
  roomId?: string;
  roomName?: string;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number | null;
  preparedAtMs?: number | null;
  physicalCompletedAtMs?: number | null;
  cashRemovedAtMs?: number | null;
  cancelledAtMs?: number | null;
  reportText?: string;
  reportPrintCount?: number;
  reportPrintJobId?: string | null;
  reportPrintRequestId?: string | null;
  reportPrintedAtMs?: number | null;
  error?: string | null;
  resumableByCurrentUser: boolean;
};

export type StartCashMovementRequest = {
  clientRequestId: string;
  type: Exclude<CashMovementType, "exchange">;
  amountCents?: number;
  pieces?: CashFloatDenominationMap;
  justification: string;
  deviceUuid?: string;
  activityId?: string;
  roomId?: string;
  roomName?: string;
};

export type CashMovementResponse = {
  ok: true;
  resumed?: boolean;
  movement: CashMovementRecord | null;
};

export type CashMovementStateResponse = CashMovementResponse & {
  gatewayReachable: boolean;
  gatewayError?: string | null;
};

export type CashMovementWithdrawalDenomination = {
  cents: number;
  availablePieces: number;
  reservedPieces: number;
};

export type CashMovementWithdrawalAvailabilityResponse = {
  ok: true;
  denominations: CashMovementWithdrawalDenomination[];
  totalAvailableCents: number;
  updatedAtMs: number;
};

export type PrintCashMovementReportRequest = {
  clientRequestId: string;
  reprint?: boolean;
};

export type PrintCashMovementReportResponse = CashMovementResponse & {
  deduplicated?: boolean;
  printJob?: {
    id: string;
    status?: string;
    printerId?: string;
    printerName?: string;
  };
};

export type ActiveCashMovementResponse = {
  ok: true;
  activeMovement: CashMovementRecord | null;
};

export type CashMovementListResponse = {
  ok: true;
  movements: CashMovementRecord[];
  count: number;
};

export type GenerateAutomaticCashFloatRequest = {
  deviceUuid?: string;
  activityId?: string;
  roomId?: string;
  reason?: string;
  preferExistingAssignmentForEvening?: boolean;
};

export type GenerateAutomaticCashFloatResponse = {
  ok?: true;
  resumed?: boolean;
  workflowId: string;
  operationId: string;
  cashFloatId: string;
  businessEveningKey: string;
  assignmentId: string;
  combinationId: string;
  configSetId: string;
  reserveConfigId?: string | null;
  pieces: CashFloatDenominationMap;
  totalCents: number;
  createdAtMs: number;
  qrPayload: string;
  step?: AutomaticCashWorkflowStep;
};

export type LockAutoCashFloatPayload = {
  id: string;
  value: number;
  qrPayload: string;
  createdAtMs: number;
  assignmentId?: string | null;
  combinationId?: string | null;
  businessEveningKey?: string | null;
};

export type ConfirmAutomaticCashFloatRemovedRequest = {
  workflowId?: string;
  operationId: string;
  cashFloatId: string;
};

export type ConfirmAutomaticCashFloatRemovedResponse = {
  ok: true;
  workflow?: AutomaticCashActiveWorkflow;
};

export type MarkAutomaticCashFloatTicketPrintedRequest = {
  workflowId: string;
  cashFloatId: string;
  printJobId?: string;
  printedAtMs?: number;
};

export type MarkAutomaticCashFloatTicketPrintedResponse = {
  ok: true;
  workflow?: AutomaticCashActiveWorkflow;
  printJobId?: string;
  printedAtMs?: number;
};

export type ConfirmAutomaticCashFloatTicketInPouchRequest = {
  workflowId: string;
  cashFloatId: string;
  confirmedAtMs?: number;
  loadAsActiveCashFloat?: boolean;
};

export type ConfirmAutomaticCashFloatTicketInPouchResponse = {
  ok: true;
  cashFloatId: string;
  totalCents: number;
  qrPayload: string;
  settlementAllowed: boolean;
  workflow?: AutomaticCashActiveWorkflow;
};

export type LoadAutomaticCashFloatFromQrRequest = {
  qrPayload: string;
  deviceUuid?: string;
};

export type LoadAutomaticCashFloatFromQrResponse = {
  cashFloatId: string;
  businessEveningKey: string;
  assignmentId: string;
  combinationId: string;
  totalCents: number;
  createdAtMs: number;
  qrPayload?: string;
  valid: boolean;
};

export type StartAutomaticCashDepositRequest = {
  deviceUuid?: string;
  cashFloatId?: string | null;
};

export type StartAutomaticCashDepositResponse = {
  operationId: string;
  startedAtMs: number;
};

export type CloseAutomaticCashDepositRequest = {
  operationId: string;
};

export type CloseAutomaticCashDepositResponse = {
  operationId: string;
  depositedTotalCents: number;
  closedAtMs: number;
};

export type CancelAutomaticCashDepositRequest = {
  operationId: string;
};

export type CancelAutomaticCashDepositResponse = {
  ok: true;
};

export type AutomaticCashGatewayCommandRequest = {
  reason?: string;
};

export type AutomaticCashGatewayCommandResponse = {
  ok: true;
  command: "restart" | "reset";
  gatewayResponse?: unknown;
  requestedAtMs?: number;
};

export type StartAutomaticCashPaymentRequest = {
  expectedTotalCents: number;
  deviceUuid?: string;
  activityId?: string;
  roomId?: string;
  note?: string;
};

export type StartAutomaticCashPaymentResponse = {
  ok: true;
  operationId: string;
  expectedTotalCents: number;
  startedAtMs: number;
};

export type AutomaticCashPaymentStateResponse = {
  ok: true;
  operationId: string;
  status?: string;
  expectedTotalCents?: number;
  depositedTotalCents: number;
  changeDueCents?: number;
  readyToComplete?: boolean;
  updatedAtMs?: number;
};

export type CancelAutomaticCashPaymentResponse = {
  ok: true;
  operationId?: string;
  status?: string;
  expectedTotalCents?: number;
  depositedTotalCents?: number;
  changeDueCents?: number;
};

export type CompleteAutomaticCashPaymentRequest = {
  operationId?: string;
  expectedTotalCents?: number;
  depositedTotalCents?: number;
  changeDueCents?: number;
};

export type CompleteAutomaticCashPaymentResponse = {
  ok: true;
  operationId?: string;
  status?: string;
  expectedTotalCents?: number;
  depositedTotalCents?: number;
  changeDueCents?: number;
  readyToComplete?: boolean;
  gatewayResponse?: unknown;
};

export type AutomaticCashApiErrorCode =
  | "BAD_REQUEST"
  | "AUTOMATIC_CASH_LOCKED"
  | "FCA_ACTIVE_WORKFLOW"
  | "FCA_INVENTORY_UNAVAILABLE"
  | "FCA_NO_FEASIBLE_CONFIGURATION"
  | "FCA_CONFIG_POOL_EXHAUSTED"
  | "FCA_RESERVE_CONFIG_INVALID"
  | "FCA_GATEWAY_UNREACHABLE"
  | "FCA_WORKFLOW_STEP_CONFLICT"
  | "AUTOMATIC_CASH_NOT_CONFIGURED"
  | "AUTOMATIC_CASH_DISABLED"
  | "AUTOMATIC_CASH_GATEWAY_UNREACHABLE"
  | "AUTOMATIC_CASH_QR_INVALID"
  | "AUTOMATIC_CASH_QR_USED"
  | "AUTOMATIC_CASH_OPERATION_NOT_FOUND"
  | "CASH_GATEWAY_LOCKED"
  | "CASH_EXCHANGE_ACTIVE"
  | "CASH_EXCHANGE_STEP_CONFLICT"
  | "CASH_EXCHANGE_INVALID_PIECES"
  | "CASH_EXCHANGE_TOTAL_MISMATCH"
  | "CASH_EXCHANGE_AMOUNT_NOT_REPRESENTABLE"
  | "CASH_EXCHANGE_INVENTORY_INSUFFICIENT"
  | "CASH_MOVEMENT_ACTIVE"
  | "CASH_MOVEMENT_STEP_CONFLICT"
  | "CASH_MOVEMENT_INVALID_AMOUNT"
  | "CASH_MOVEMENT_INVALID_PIECES"
  | "CASH_MOVEMENT_INVENTORY_UNAVAILABLE"
  | "CASH_MOVEMENT_INVENTORY_INSUFFICIENT"
  | "CASH_MOVEMENT_AMOUNT_NOT_REPRESENTABLE"
  | "CASH_MOVEMENT_JUSTIFICATION_REQUIRED"
  | "CASH_MOVEMENT_PERMISSION_DENIED"
  | "CASH_MOVEMENT_REPORT_PRINT_UNAVAILABLE"
  | "CASH_GATEWAY_UNREACHABLE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UNKNOWN";

export type AutomaticCashLockPayload = {
  ownerUserId?: string;
  ownerFullName?: string;
  ownerDeviceUuid?: string;
  ownerCanManageAutomaticCash?: boolean;
  operationType?: AutomaticCashOperationType | string;
  startedAtMs?: number;
  acquiredAtMs?: number | null;
  expiresAtMs?: number | null;
};

export type AutomaticCashApiErrorPayload = {
  error?: string;
  code?: string;
  message?: string;
  lock?: AutomaticCashLockPayload;
  businessEveningKey?: string;
  availableCombinations?: number;
  assignedCombinations?: number;
  [key: string]: unknown;
};

export type AutomaticCashApiError = Error & {
  status?: number;
  code?: AutomaticCashApiErrorCode;
  payload?: AutomaticCashApiErrorPayload | unknown;
};
