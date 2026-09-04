import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
// I due punti di chiamata della policy sono usciti da server.js con MIG-031.
const orderCreateSource = await readFile(
  new URL("../modules/integration/order-create.handlers.js", import.meta.url),
  "utf8",
);

test("Francesca usa la policy auto-pagato senza fiscale", () => {
  assert.match(serverSource, /NO_FISCAL_AUTO_PAID_USER_IDS\s*=\s*new Set\(\["u_francesca"\]\)/);
  assert.match(serverSource, /NO_FISCAL_AUTO_PAID_USERNAMES\s*=\s*new Set\(\["francesca"\]\)/);
  assert.match(serverSource, /PIZZA_IN_RIVA_ROOM_ID\s*=\s*"room_pizza_in_riva"/);
  assert.match(serverSource, /PIZZA_IN_RIVA_FULL_NAME\s*=\s*"Francesca Maria Perri"/);
  assert.match(serverSource, /ensurePizzaInRivaConfiguration\(data\)/);
  assert.match(serverSource, /giadaPermissionSource/);
  assert.match(serverSource, /permissions:\s*inheritedPermissions/);
  assert.match(serverSource, /allowedPaymentMethodIds:\s*inheritedPaymentMethodIds/);
  assert.match(orderCreateSource, /shouldApplyNoFiscalAutoPaidPolicy\(user,\s*payload\)/);
  assert.match(orderCreateSource, /applyNoFiscalAutoPaidPolicyToIntegrationOrder\(nextOrder,\s*\{\s*user,\s*payload\s*\}\)/);
});

test("la policy marca la comanda pagata e fiscalmente esclusa senza creare pagamenti", () => {
  assert.match(serverSource, /paidAmount:\s*total/);
  assert.match(serverSource, /dueAmount:\s*0/);
  assert.match(serverSource, /paymentStatus:\s*"paid"/);
  assert.match(serverSource, /fiscalExcluded:\s*true/);
  assert.match(serverSource, /fiscalPolicy:\s*NO_FISCAL_AUTO_PAID_POLICY/);
  assert.doesNotMatch(serverSource, /NO_FISCAL_AUTO_PAID_POLICY[\s\S]{0,600}handlePay/);
});
