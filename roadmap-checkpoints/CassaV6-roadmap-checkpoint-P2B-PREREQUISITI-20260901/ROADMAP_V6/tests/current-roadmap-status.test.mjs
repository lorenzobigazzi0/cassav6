import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_PHASES,
  loadAndValidateRoadmapStatus,
  validateRoadmapStatus
} from "../scripts/validate-current-roadmap-status.mjs";

const statusPath = fileURLToPath(new URL("../configs/current-roadmap-status.json", import.meta.url));
const schemaPath = fileURLToPath(new URL("../contracts/current-roadmap-status-v1.schema.json", import.meta.url));
const validatorPath = fileURLToPath(new URL("../scripts/validate-current-roadmap-status.mjs", import.meta.url));

async function loadStatus() {
  return JSON.parse(await readFile(statusPath, "utf8"));
}

test("the reusable JSON schema is valid JSON with the V6 contract identity", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.properties.product.const, "CASSA_V6");
  assert.equal(schema.properties.officialProgressPercent.maximum, 100);
});

test("the initial V6 status is valid and credits zero progress", async () => {
  const { status, result } = await loadAndValidateRoadmapStatus(statusPath);
  assert.equal(status.officialProgressPercent, 0);
  assert.equal(result.computedProgressPercent, 0);
  assert.equal(result.verifiedCompletePhaseCount, 0);
  assert.deepEqual(
    status.phases.map(({ id, weightPercent, status: phaseStatus }) => [id, weightPercent, phaseStatus]),
    EXPECTED_PHASES.map(({ id, weightPercent }, index) => [
      id,
      weightPercent,
      index === 0 ? "IN_PROGRESS" : index <= 6 ? "CANDIDATE_IMPORTED_NOT_VERIFIED" : "PENDING"
    ])
  );
});

test("legacy and candidate source references are never progress-bearing", async () => {
  const status = await loadStatus();
  for (const source of status.sourceBaselines) {
    assert.equal(source.countsTowardOfficialProgress, false);
    assert.equal(source.requiresV6Reverification, true);
  }

  status.sourceBaselines[1].countsTowardOfficialProgress = true;
  assert.throws(() => validateRoadmapStatus(status), /must not count toward official progress/);
});

test("candidate code cannot receive partial or full phase credit", async () => {
  const status = await loadStatus();
  status.phases[1].creditedPercent = status.phases[1].weightPercent;
  status.officialProgressPercent = status.phases[1].weightPercent;
  assert.throws(() => validateRoadmapStatus(status), /zero credit until VERIFIED_COMPLETE/);
});

test("VERIFIED_COMPLETE requires V6 evidence and exact phase credit", async () => {
  const status = await loadStatus();
  status.phases[1].status = "VERIFIED_COMPLETE";
  status.phases[1].creditedPercent = status.phases[1].weightPercent;
  status.officialProgressPercent = status.phases[1].weightPercent;
  assert.throws(() => validateRoadmapStatus(status), /without V6 verifiedEvidenceRefs/);

  status.phases[1].verifiedEvidenceRefs = ["reports/v6-p1-verification.json"];
  const result = validateRoadmapStatus(status);
  assert.equal(result.computedProgressPercent, 12);
  assert.equal(result.verifiedCompletePhaseCount, 1);
});

test("phase weights and official progress cannot drift", async () => {
  const status = await loadStatus();
  status.phases[2].weightPercent = 14;
  assert.throws(() => validateRoadmapStatus(status), /weightPercent must be 15/);

  const secondStatus = await loadStatus();
  secondStatus.officialProgressPercent = 1;
  assert.throws(() => validateRoadmapStatus(secondStatus), /must equal computed progress 0/);
});

test("promotion remains closed without complete phases and authorization evidence", async () => {
  const status = await loadStatus();
  status.promotion.allowed = true;
  assert.throws(() => validateRoadmapStatus(status), /before every phase is VERIFIED_COMPLETE/);
});

test("the validator command accepts the canonical current status", () => {
  const run = spawnSync(process.execPath, [validatorPath, statusPath], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /VALID: 0%; 0\/9 phases verified complete/);
});
