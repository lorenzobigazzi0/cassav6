export type CashExchangeStatus =
  | "CREATED"
  | "CHANGE_STARTED"
  | "DEPOSIT_STARTED"
  | "DEPOSITING"
  | "DEPOSIT_CONFIRMED"
  | "SELECTING_DENOMINATIONS"
  | "CHANGE_REQUESTED"
  | "WAITING_CHANGE_REMOVAL"
  | "WITHDRAWAL_STARTED"
  | "WAITING_CASH_REMOVAL"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export type CashExchangeStep =
  | "approach"
  | "startingDeposit"
  | "depositing"
  | "confirmDeposit"
  | "selectDenominations"
  | "executingChange"
  | "waitingChangeRemoval"
  | "completed"
  | "cancelled"
  | "failed";

export type CashExchangePieces = Record<string, number>;

export type CashExchangeAvailableDenomination = {
  cents: number;
  label?: string;
  availablePieces: number;
  reservedPieces?: number;
};

export type CashExchangeState = {
  ok?: true;
  exchangeId: string;
  status: CashExchangeStatus;
  depositedCents: number;
  selectedPieces?: CashExchangePieces;
  selectedTotalCents?: number;
  allowedDenominationsCents?: number[];
  availableDenominations?: CashExchangeAvailableDenomination[];
  operationId?: string | null;
  updatedAtMs?: number;
};

export type ActiveCashExchange = {
  exchangeId: string;
  status: CashExchangeStatus;
  ownerFullName?: string | null;
  resumableByCurrentUser?: boolean;
  depositedCents?: number | null;
  selectedPieces?: CashExchangePieces;
  selectedTotalCents?: number | null;
  availableDenominations?: CashExchangeAvailableDenomination[];
  updatedAtMs?: number | null;
};

export type ActiveCashExchangeResponse = {
  ok: true;
  activeExchange: ActiveCashExchange | null;
};

export type StartCashExchangeRequest = {
  deviceUuid?: string;
  activityId?: string | null;
  roomId?: string | null;
};

export type StartCashExchangeResponse = CashExchangeState & {
  startedAtMs?: number;
};

export type CancelCashExchangeResponse = {
  ok: true;
};

export type ConfirmCashExchangeDepositResponse = CashExchangeState & {
  allowedDenominationsCents: number[];
};

export type ExecuteCashExchangeResponse = CashExchangeState;

export type ConfirmCashExchangeRemovedResponse = {
  ok: true;
  exchangeId: string;
  status: "COMPLETED";
};
