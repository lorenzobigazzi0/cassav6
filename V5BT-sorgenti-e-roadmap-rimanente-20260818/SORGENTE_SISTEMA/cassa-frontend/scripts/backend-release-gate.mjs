import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const appRoot = path.resolve(cassaRoot, "..");
const tmpRefactorDir = path.join(appRoot, ".tmp-refactor");

const commonTestArgs = ["--test", "--experimental-test-isolation=none", "--test-timeout=60000"];

async function cleanupGeneratedArtifacts() {
  await rm(tmpRefactorDir, { recursive: true, force: true });
}

function runNodeTest(label, extraArgs) {
  console.log(`\n[backend-release-gate] ${label}`);
  const result = spawnSync(process.execPath, [...commonTestArgs, ...extraArgs], {
    cwd: cassaRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || "test",
    },
  });
  if (result.status !== 0) {
    const code = result.status ?? result.signal ?? "unknown";
    throw new Error(`${label} failed with ${code}`);
  }
}

try {
  await cleanupGeneratedArtifacts();

  runNodeTest("budget righe monolite backend", ["backend/tests/architecture-line-budget.test.mjs"]);
  runNodeTest("guardrail packaging release", ["backend/tests/release-package-guardrails.test.mjs"]);
  runNodeTest("audit architettura/sicurezza route policy", ["backend/tests/route-policy-architecture.test.mjs"]);
  runNodeTest("route builders core", ["backend/tests/route-builders-core.test.mjs"]);
  runNodeTest("audit auth/read-only/security headers", ["backend/tests/security-architecture.test.mjs"]);
  runNodeTest("security helpers core", ["backend/tests/security-core.test.mjs"]);
  runNodeTest("http client core", ["backend/tests/http-client-core.test.mjs"]);
  runNodeTest("price lists core", ["backend/tests/price-lists-domain.test.mjs"]);
  runNodeTest("menu domain core", ["backend/tests/menu-domain.test.mjs"]);
  runNodeTest("print utils core", ["backend/tests/print-utils-core.test.mjs"]);
  runNodeTest("print spool fast worker manuale", ["backend/tests/print-spool-fast-worker.mysql.test.mjs"]);
  runNodeTest("audit permessi stanze/Gazebo", ["backend/tests/audit-room-permissions.test.mjs"]);
  runNodeTest("batteria mobile backend", ["backend/tests/mobile-battery.test.mjs"]);

  const paymentsFiscalPatterns = [
    "pagamento tavolo completo",
    "overpayment free split",
    "idempotency pagamento free split",
    "payload mobile FrontendV2 free-split",
    "fiscal command richiede permesso",
  ];
  for (const pattern of paymentsFiscalPatterns) {
    runNodeTest(`payments-fiscal: ${pattern}`, [
      `--test-name-pattern=${pattern}`,
      "backend/tests/payments-fiscal.e2e.test.mjs",
    ]);
  }

  runNodeTest("payment weird cases e ristampa fiscale", [
    "backend/tests/payment-weird-cases.e2e.test.mjs",
  ]);
  runNodeTest("security: custom rooms from areas", [
    "--test-name-pattern=custom rooms from areas",
    "backend/tests/security.test.mjs",
  ]);

  await cleanupGeneratedArtifacts();
  console.log("\n[backend-release-gate] OK: backend release gate completato.");
} catch (error) {
  await cleanupGeneratedArtifacts().catch(() => {});
  console.error(`\n[backend-release-gate] FAIL: ${error?.message || error}`);
  process.exit(1);
}
