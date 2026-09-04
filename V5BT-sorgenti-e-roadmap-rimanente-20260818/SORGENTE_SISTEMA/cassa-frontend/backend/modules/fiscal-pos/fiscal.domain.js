export const FISCAL_PROVIDER_DRY_RUN_CODE = "FISCAL_PROVIDER_DRY_RUN";

export const FISCAL_PROVIDER_DRY_RUN_MESSAGE =
  "Gateway fiscale in modalita dry-run: operazione fiscale reale bloccata.";

export function assertFiscalProviderRealMode(status) {
  if (status?.dryRun !== true) return status;
  const error = new Error(FISCAL_PROVIDER_DRY_RUN_MESSAGE);
  error.code = FISCAL_PROVIDER_DRY_RUN_CODE;
  throw error;
}
