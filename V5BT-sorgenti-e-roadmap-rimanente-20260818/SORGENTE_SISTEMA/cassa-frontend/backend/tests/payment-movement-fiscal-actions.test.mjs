import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPaymentRoutes } from "../modules/payments/payments.routes.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(testDir, "..");

test("emissione fiscale manuale richiede permesso e annullamento richiede admin", () => {
  const routes = new Map(
    buildPaymentRoutes().map((route) => [
      `${route.method} ${route.path}`,
      route,
    ]),
  );
  const issue = routes.get("POST /api/reports/payment-movement/fiscal/issue");
  const verify = routes.get(
    "POST /api/reports/payment-movement/fiscal/verify",
  );
  const voidRoute = routes.get(
    "POST /api/reports/payment-movement/fiscal/void",
  );

  assert.equal(issue?.authRequired, true);
  assert.equal(issue?.permission, "fiscal_operations");
  assert.equal(issue?.mutation, true);
  assert.equal(verify?.authRequired, true);
  assert.equal(verify?.permission, "fiscal_operations");
  assert.equal(verify?.mutation, true);
  assert.equal(voidRoute?.authRequired, true);
  assert.equal(voidRoute?.admin, true);
  assert.equal(voidRoute?.mutation, true);
});

test("gli handler fiscali aggiornano lo stato solo dopo la risposta reale del gateway", () => {
  // Le tre route stanno in `payments-fiscal-model.js` dal 2026-09-04: il
  // contratto e lo stesso, cambia il file da cui si ritagliano le fette.
  const source = readFileSync(
    path.join(backendDir, "modules", "payments", "payments-fiscal-model.js"),
    "utf8",
  );
  const dispatchSource = readFileSync(
    path.join(backendDir, "modules", "payments", "payments.handlers.js"),
    "utf8",
  );
  const issueStart = source.indexOf("async function issueMovementFiscal");
  const voidStart = source.indexOf("async function voidMovementFiscal");
  const verifyStart = source.indexOf("async function verifyMovementFiscal(");
  assert.ok(issueStart >= 0 && voidStart > issueStart && verifyStart > voidStart);

  // Nessuna asserzione sull'ordine rispetto a `handlePaymentMovementReprint`:
  // quella e rimasta nei handler, quindi un ordine fra le quattro non esiste
  // piu come fatto, e non era un contratto ma solo il modo di tagliare. Le
  // asserzioni d'ordine **dentro** ogni fetta restano tutte.
  const issueSource = source.slice(issueStart, voidStart);
  const voidSource = source.slice(voidStart, verifyStart);
  const verifySource = source.slice(verifyStart);
  assert.match(issueSource, /if \(fiscalRealIoDisabled\)/);
  assert.match(issueSource, /verifyMovementFiscalOperation\(\{/);
  assert.match(
    issueSource,
    /fetchPosFiscalApiJson\(job\.fiscalDevice\.statusEndpoint/,
  );
  assert.match(
    issueSource,
    /fetchPosFiscalApiJson\(job\.fiscalDevice\.receiptEndpoint/,
  );
  assert.match(issueSource, /assertFiscalProviderRealMode\(status\)/);
  assert.match(
    issueSource,
    /responseCode: dryRun \? FISCAL_PROVIDER_DRY_RUN_CODE : "FISCAL_API_ERROR"/,
  );
  assert.match(
    issueSource,
    /code: dryRun \? FISCAL_PROVIDER_DRY_RUN_CODE : "FISCAL_ISSUE_FAILED"/,
  );
  assert.match(issueSource, /if \(response\?\.ok === false\)/);
  assert.ok(
    issueSource.indexOf("assertFiscalProviderRealMode(status)") <
      issueSource.indexOf(
        "fetchPosFiscalApiJson(job.fiscalDevice.receiptEndpoint",
      ),
  );
  assert.ok(
    issueSource.indexOf(
      "fetchPosFiscalApiJson(job.fiscalDevice.receiptEndpoint",
    ) < issueSource.indexOf('fiscalStatus: "ISSUED"'),
  );

  assert.match(voidSource, /if \(fiscalRealIoDisabled\)/);
  assert.match(voidSource, /verifyMovementFiscalOperation\(\{/);
  assert.match(
    voidSource,
    /fetchPosFiscalApiJson\(job\.fiscalDevice\.statusEndpoint/,
  );
  assert.match(
    voidSource,
    /fetchPosFiscalApiJson\(job\.fiscalDevice\.voidEndpoint/,
  );
  assert.match(voidSource, /assertFiscalProviderRealMode\(status\)/);
  assert.match(
    voidSource,
    /code: dryRun \? FISCAL_PROVIDER_DRY_RUN_CODE : "FISCAL_VOID_FAILED"/,
  );
  assert.match(voidSource, /if \(response\?\.ok === false\)/);
  assert.match(voidSource, /voidMovementId: references\.fiscalMovementId/);
  assert.match(voidSource, /voidReceiptDate: references\.fiscalReceiptDate/);
  assert.match(
    voidSource,
    /voidDocumentNumber: references\.fiscalDocumentNumber/,
  );
  assert.match(voidSource, /originalDocument:/);
  assert.match(voidSource, /voidDocument:/);
  assert.ok(
    voidSource.indexOf("assertFiscalProviderRealMode(status)") <
      voidSource.indexOf("fetchPosFiscalApiJson(job.fiscalDevice.voidEndpoint"),
  );
  assert.ok(
    voidSource.indexOf("fetchPosFiscalApiJson(job.fiscalDevice.voidEndpoint") <
      voidSource.indexOf('voidStatus: "VOIDED"'),
  );
  assert.match(voidSource, /voidStatus: "FAILED"/);
  assert.match(voidSource, /throw new HttpError\(502, message/);
  assert.match(verifySource, /verification\.supported === false/);
  assert.match(verifySource, /gatewayState: verification\.state/);
  // Il dispatch e rimasto nei handler.
  assert.match(
    dispatchSource,
    /"reports\.paymentMovementFiscalVerify": handlePaymentMovementFiscalVerify/,
  );
});
