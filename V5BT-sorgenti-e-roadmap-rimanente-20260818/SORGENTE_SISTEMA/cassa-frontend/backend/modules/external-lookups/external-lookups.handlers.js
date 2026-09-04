async function parseJsonResponseSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function extractRemoteData(payload) {
  if (!payload || typeof payload !== "object") return {};
  const data = payload.data;
  if (Array.isArray(data)) {
    const first = data.find((entry) => entry && typeof entry === "object");
    return first && typeof first === "object" ? first : {};
  }
  if (data && typeof data === "object") {
    return data;
  }
  return payload;
}

export function createExternalLookupHandlers({
  citySearchApiBaseUrl,
  companyApiBaseUrl,
  companyApiToken,
  fetchWithTimeout,
  HttpError,
  ipCoordsFallbackUrl,
  ipCoordsPrimaryUrl,
  readJsonBody,
  sendJson,
}) {
  async function handleVatVerification(req, res) {
    const payload = await readJsonBody(req);
    const piva = String(payload?.piva ?? "").trim();
    if (!piva) {
      throw new HttpError(400, "Partita IVA mancante.");
    }

    if (!companyApiBaseUrl || !companyApiToken) {
      throw new HttpError(503, "Servizio verifica Partita IVA non configurato.");
    }

    const headers = {
      Authorization: `Bearer ${companyApiToken}`,
      "Content-Type": "application/json",
    };

    let responseStart;
    try {
      responseStart = await fetchWithTimeout(`${companyApiBaseUrl}/IT-start/${encodeURIComponent(piva)}`, {
        headers,
      });
    } catch {
      throw new HttpError(502, "Servizio verifica Partita IVA non disponibile.");
    }

    if (!responseStart.ok) {
      throw new HttpError(responseStart.status, `Errore API: ${responseStart.status}`);
    }

    const startPayload = await parseJsonResponseSafe(responseStart);
    const companyData = extractRemoteData(startPayload);
    const registeredOffice = companyData?.address?.registeredOffice ?? {};
    const fullAddress =
      registeredOffice.streetName ||
      `${registeredOffice.toponym || ""} ${registeredOffice.street || ""} ${registeredOffice.streetNumber || ""}`.trim();

    let pec = "Non disponibile";
    try {
      const responsePec = await fetchWithTimeout(`${companyApiBaseUrl}/IT-pec/${encodeURIComponent(piva)}`, {
        headers,
      });
      if (responsePec.ok) {
        const pecPayload = await parseJsonResponseSafe(responsePec);
        const pecData = extractRemoteData(pecPayload);
        if (typeof pecData?.pec === "string" && pecData.pec.trim()) {
          pec = pecData.pec.trim();
        }
      }
    } catch {
      // Se la PEC non e disponibile, restituisco comunque i dati principali.
    }

    sendJson(res, 200, {
      ragioneSociale: String(companyData?.companyName ?? ""),
      indirizzo: String(fullAddress ?? ""),
      cap: String(registeredOffice.zipCode ?? ""),
      citta: String(registeredOffice.town ?? ""),
      provincia: String(registeredOffice.province ?? ""),
      sdi: String(companyData?.sdiCode ?? ""),
      pec,
    });
  }

  async function handleIpCoords(_req, res) {
    try {
      const primaryResponse = await fetchWithTimeout(ipCoordsPrimaryUrl, {
        cache: "no-store",
      });
      if (primaryResponse.ok) {
        const primaryPayload = await parseJsonResponseSafe(primaryResponse);
        if (
          primaryPayload?.success === true &&
          typeof primaryPayload?.latitude === "number" &&
          typeof primaryPayload?.longitude === "number"
        ) {
          sendJson(res, 200, {
            lat: primaryPayload.latitude,
            lng: primaryPayload.longitude,
            provider: "ipwho",
          });
          return;
        }
      }
    } catch {
      // fallback secondario
    }

    let fallbackResponse;
    try {
      fallbackResponse = await fetchWithTimeout(ipCoordsFallbackUrl, {
        cache: "no-store",
      });
    } catch {
      sendJson(res, 200, {
        lat: null,
        lng: null,
        provider: "unavailable",
      });
      return;
    }

    if (!fallbackResponse.ok) {
      sendJson(res, 200, {
        lat: null,
        lng: null,
        provider: "unavailable",
      });
      return;
    }

    const fallbackPayload = await parseJsonResponseSafe(fallbackResponse);
    if (
      typeof fallbackPayload?.latitude !== "number" ||
      typeof fallbackPayload?.longitude !== "number"
    ) {
      sendJson(res, 200, {
        lat: null,
        lng: null,
        provider: "unavailable",
      });
      return;
    }

    sendJson(res, 200, {
      lat: fallbackPayload.latitude,
      lng: fallbackPayload.longitude,
      provider: "ipapi",
    });
  }

  async function handleCitySearch(_req, res, requestUrl) {
    const query = String(requestUrl.searchParams.get("q") ?? "").trim();
    if (query.length < 2) {
      sendJson(res, 200, { results: [] });
      return;
    }

    let remoteResponse;
    try {
      const remoteUrl =
        `${citySearchApiBaseUrl}/search?name=${encodeURIComponent(query)}` +
        "&count=8&language=it&format=json";
      remoteResponse = await fetchWithTimeout(remoteUrl, { cache: "no-store" });
    } catch {
      throw new HttpError(502, "Servizio ricerca citta non disponibile.");
    }

    if (!remoteResponse.ok) {
      throw new HttpError(502, "Servizio ricerca citta non disponibile.");
    }

    const remotePayload = await parseJsonResponseSafe(remoteResponse);
    const sourceList = Array.isArray(remotePayload?.results) ? remotePayload.results : [];
    const results = sourceList
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof item.name === "string" &&
          typeof item.latitude === "number" &&
          typeof item.longitude === "number"
      )
      .map((item) => {
        const region = String(item.admin1 ?? item.admin2 ?? "").trim();
        const country = String(item.country ?? "").trim();
        const labelParts = [String(item.name).trim(), region, country].filter(Boolean);
        const label = labelParts.join(", ");
        return {
          id: `${item.name}|${item.latitude}|${item.longitude}`,
          label: label || String(item.name),
          lat: item.latitude,
          lng: item.longitude,
        };
      });

    sendJson(res, 200, { results });
  }

  return {
    "vat.verify": handleVatVerification,
    "ip.coords": handleIpCoords,
    "city.search": handleCitySearch,
  };
}
