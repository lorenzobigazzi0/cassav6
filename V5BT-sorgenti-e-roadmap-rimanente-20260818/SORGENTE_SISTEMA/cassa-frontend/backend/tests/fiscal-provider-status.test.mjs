import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFiscalProviderRealMode,
  FISCAL_PROVIDER_DRY_RUN_CODE,
  FISCAL_PROVIDER_DRY_RUN_MESSAGE,
} from "../modules/fiscal-pos/fiscal.domain.js";

test("lo status fiscale reale accetta dryRun assente o disabilitato", () => {
  const ready = { ok: true, fiscalApiEnabled: true };
  const real = { ...ready, dryRun: false };

  assert.equal(assertFiscalProviderRealMode(ready), ready);
  assert.equal(assertFiscalProviderRealMode(real), real);
});

test("lo status dryRun viene rifiutato con un codice operativo stabile", () => {
  assert.throws(
    () =>
      assertFiscalProviderRealMode({
        ok: true,
        fiscalApiEnabled: true,
        dryRun: true,
      }),
    (error) => {
      assert.equal(error.code, FISCAL_PROVIDER_DRY_RUN_CODE);
      assert.equal(error.message, FISCAL_PROVIDER_DRY_RUN_MESSAGE);
      return true;
    },
  );
});

test("dryRun resta prioritario anche se il provider dichiara altri errori", () => {
  assert.throws(
    () =>
      assertFiscalProviderRealMode({
        ok: false,
        fiscalApiEnabled: false,
        dryRun: true,
      }),
    { code: FISCAL_PROVIDER_DRY_RUN_CODE },
  );
});
