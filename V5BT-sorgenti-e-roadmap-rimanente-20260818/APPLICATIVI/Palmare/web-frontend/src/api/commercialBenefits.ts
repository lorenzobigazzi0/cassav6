import { apiJson } from "./baseUrl";
import type { TableSessionRequest } from "../domain/tables/types";

export type CommercialBenefitType =
  | "fixed_discount"
  | "value_voucher"
  | "percentage_discount";

export type CommercialBenefitSource = "code" | "qr" | "nfc";

export type CommercialBenefitResidualPolicy =
  | "forfeit_remaining"
  | "keep_balance"
  | "no_partial_use";

export type CommercialBenefitApplication = {
  id: string;
  campaignId: string;
  couponId: string;
  title: string;
  benefitKind: CommercialBenefitType;
  residualPolicy?: CommercialBenefitResidualPolicy | null;
  acquisitionSource: CommercialBenefitSource;
  codeMasked?: string | null;
  status: "reserved" | "released" | "redeemed" | "expired";
  benefitAmountCents: number;
  benefitAmount: number;
  payableBeforeCents: number;
  payableBefore: number;
  payableAfterCents: number;
  payableAfter: number;
  balanceBeforeCents?: number;
  balanceAfterPreviewCents?: number;
  forfeitedPreviewCents?: number;
  reservationExpiresAt: string;
};

export type ValidateCommercialBenefitInput = TableSessionRequest & {
  source: CommercialBenefitSource;
  benefitToken: string;
  payableBeforeCents: number;
  tableId?: string;
  orderId?: string;
  clientApplicationId?: string;
  nativeReadId?: string;
  nativeReadAt?: number;
  readerSessionId?: string;
};

export type ValidateCommercialBenefitResult = {
  ok: true;
  idempotent?: boolean;
  application: CommercialBenefitApplication;
};

export type CreateCommercialBenefitCampaignInput = TableSessionRequest & {
  title: string;
  benefitKind: CommercialBenefitType;
  amountCents?: number;
  faceValueCents?: number;
  percentageBps?: number;
  maxDiscountCents?: number;
  residualPolicy?: CommercialBenefitResidualPolicy;
  validFrom?: string;
  validUntil?: string | null;
  quantity?: number;
  codes?: string[];
};

export type CreateCommercialBenefitCampaignResult = {
  ok: true;
  campaign: {
    id: string;
    title: string;
    benefitKind: CommercialBenefitType;
    residualPolicy?: CommercialBenefitResidualPolicy | null;
  };
  coupons: Array<{
    id: string;
    campaignId: string;
    codeMasked: string;
    status: string;
    benefitKind: CommercialBenefitType;
    residualPolicy?: CommercialBenefitResidualPolicy | null;
    balanceCents: number;
  }>;
};

const sessionHeaders = (session: TableSessionRequest): HeadersInit => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-User-Id": session.userId,
  "X-Device-Uuid": session.deviceUuid,
  "X-Client-App": "mobile-frontend",
  ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
});

const sessionPayload = (session: TableSessionRequest) => ({
  token: session.token,
  userId: session.userId,
  username: session.username,
  fullName: session.fullName,
  deviceUuid: session.deviceUuid,
  activityId: session.activityId,
  roomId: session.roomId,
  clientApp: "mobile-frontend",
});

const benefitTokenPayload = (source: CommercialBenefitSource, token: string) => {
  if (source === "nfc") return { nfcToken: token };
  if (source === "qr") return { qrPayload: token };
  return { code: token };
};

export async function validateCommercialBenefit(
  input: ValidateCommercialBenefitInput
): Promise<ValidateCommercialBenefitResult> {
  return apiJson<ValidateCommercialBenefitResult>("/api/commercial-benefits/validate", {
    method: "POST",
    headers: sessionHeaders(input),
    body: JSON.stringify({
      ...sessionPayload(input),
      source: input.source,
      ...benefitTokenPayload(input.source, input.benefitToken),
      payableBeforeCents: input.payableBeforeCents,
      tableId: input.tableId,
      orderId: input.orderId,
      clientApplicationId: input.clientApplicationId,
      nativeReadId: input.nativeReadId,
      nativeReadAt: input.nativeReadAt,
      readerSessionId: input.readerSessionId,
    }),
  });
}

export async function releaseCommercialBenefit(
  session: TableSessionRequest,
  applicationId: string
): Promise<void> {
  await apiJson<{ ok: true }>("/api/commercial-benefits/release", {
    method: "POST",
    headers: sessionHeaders(session),
    body: JSON.stringify({
      ...sessionPayload(session),
      applicationId,
    }),
  });
}

export async function createCommercialBenefitCampaign(
  input: CreateCommercialBenefitCampaignInput
): Promise<CreateCommercialBenefitCampaignResult> {
  return apiJson<CreateCommercialBenefitCampaignResult>("/api/commercial-benefits/campaigns", {
    method: "POST",
    headers: sessionHeaders(input),
    body: JSON.stringify({
      ...sessionPayload(input),
      title: input.title,
      benefitKind: input.benefitKind,
      amountCents: input.amountCents,
      faceValueCents: input.faceValueCents,
      percentageBps: input.percentageBps,
      maxDiscountCents: input.maxDiscountCents,
      residualPolicy: input.residualPolicy,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      quantity: input.quantity,
      codes: input.codes,
    }),
  });
}
