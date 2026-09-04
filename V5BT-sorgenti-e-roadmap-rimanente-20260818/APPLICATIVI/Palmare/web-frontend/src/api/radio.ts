import { apiJson } from "./baseUrl";
import { normalizeRadioSlots } from "../radio/radioProtocol";
import type { RadioAuthContext, RadioConfigResponse, RadioSlots } from "../radio/radioTypes";

function buildRadioAuthPayload(auth: RadioAuthContext) {
  return {
    token: auth.token,
    userId: auth.userId,
    deviceUuid: auth.deviceUuid,
    clientApp: auth.clientApp || "mobile-frontend",
  };
}

function normalizeRadioConfigResponse(payload: RadioConfigResponse): RadioConfigResponse {
  const preference = payload.preference ?? {
    id: "",
    userId: "",
    deviceUuid: "",
    slots: [null, null, null] as RadioSlots,
    updatedAt: "",
  };
  return {
    ...payload,
    channels: Array.isArray(payload.channels) ? payload.channels : [],
    slots: normalizeRadioSlots(payload.slots),
    preference: {
      ...preference,
      slots: normalizeRadioSlots(preference.slots),
    },
  };
}

export async function fetchRadioConfig(auth: RadioAuthContext): Promise<RadioConfigResponse> {
  const payload = await apiJson<RadioConfigResponse>("/api/mobile/radio/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(buildRadioAuthPayload(auth)),
  });
  return normalizeRadioConfigResponse(payload);
}

export async function saveRadioSlots(
  auth: RadioAuthContext,
  slots: RadioSlots
): Promise<RadioConfigResponse> {
  const payload = await apiJson<RadioConfigResponse>("/api/mobile/radio/config/save", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      ...buildRadioAuthPayload(auth),
      slots,
    }),
  });
  return normalizeRadioConfigResponse(payload);
}
