export function buildOperatorReceiptName(input: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  username?: string | null;
}): string {
  const clean = (value?: string | null) => String(value ?? "").trim().replace(/\s+/g, " ");
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);

  if (firstName && lastName) {
    return `${firstName} ${lastName[0]?.toUpperCase() ?? ""}.`.trim();
  }

  const fullName = clean(input.fullName);
  if (fullName) {
    const parts = fullName.split(" ").filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      return `${first} ${last[0]?.toUpperCase() ?? ""}.`.trim();
    }
    return parts[0];
  }

  return clean(input.username) || "Operatore";
}
