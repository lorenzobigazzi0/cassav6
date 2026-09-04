export function shouldEngageIntegrationPrintCommand(payload) {
  const kind = String(payload?.kind ?? "")
    .trim()
    .toLowerCase();
  return kind === "order" || kind === "preconto";
}
