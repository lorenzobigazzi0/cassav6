import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../../scripts/api-worker-read-canary.mjs", import.meta.url),
  "utf8",
);

test("api-worker read canary supporta order-worker opt-in", () => {
  assert.match(
    source,
    /CANARY_EXPECT_ORDER_MUTATION_PROXY_ROLE/,
    "il canary deve poter accettare mutazioni ordine instradate ad api-worker"
  );
  assert.match(
    source,
    /CANARY_EXPECT_DIRECT_WORKER_MUTATION_BLOCKED/,
    "il canary deve poter accettare worker diretto non bloccato quando gli order-worker sono abilitati"
  );
  assert.match(
    source,
    /mutationProxyRoleAsExpected[\s\S]+expectedOrderMutationProxyRole/,
    "il gate deve confrontare il ruolo mutation con l'aspettativa configurata"
  );
  assert.match(
    source,
    /directWorkerMutationAsExpected[\s\S]+expectDirectWorkerMutationBlocked/,
    "il gate deve confrontare il blocco worker diretto con l'aspettativa configurata"
  );
});
