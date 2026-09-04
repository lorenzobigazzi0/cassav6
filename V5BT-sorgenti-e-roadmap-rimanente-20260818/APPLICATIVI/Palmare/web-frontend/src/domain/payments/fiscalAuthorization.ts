export function canIssueFiscalDocument(params: {
  role: string | null | undefined;
  permissions: readonly string[] | null | undefined;
}) {
  // The backend grants every known POS permission to the admin role.
  return (
    String(params.role ?? "")
      .trim()
      .toLowerCase() === "admin"
  );
}
