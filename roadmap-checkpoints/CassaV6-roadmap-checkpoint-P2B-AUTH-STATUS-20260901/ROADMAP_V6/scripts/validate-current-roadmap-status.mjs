#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_PHASES = Object.freeze([
  Object.freeze({
    id: "V6-P0",
    sequence: 0,
    name: "Baseline V6, sorgente Impostazioni e contratti",
    weightPercent: 10
  }),
  Object.freeze({
    id: "V6-P1",
    sequence: 1,
    name: "Schema relazionale e repository Commerciale V2",
    weightPercent: 12
  }),
  Object.freeze({
    id: "V6-P2",
    sequence: 2,
    name: "Compilatore e motore prezzi autorevole",
    weightPercent: 15
  }),
  Object.freeze({
    id: "V6-P3",
    sequence: 3,
    name: "Impostazioni: articoli e cataloghi",
    weightPercent: 10
  }),
  Object.freeze({
    id: "V6-P4",
    sequence: 4,
    name: "Impostazioni: listini, assegnazioni e simulatore",
    weightPercent: 12
  }),
  Object.freeze({
    id: "V6-P5",
    sequence: 5,
    name: "Impostazioni: menu e offerte composte",
    weightPercent: 10
  }),
  Object.freeze({
    id: "V6-P6",
    sequence: 6,
    name: "Integrazione runtime completa",
    weightPercent: 15
  }),
  Object.freeze({
    id: "V6-P7",
    sequence: 7,
    name: "Migrazione dati e rimozione delle eccezioni",
    weightPercent: 8
  }),
  Object.freeze({
    id: "V6-P8",
    sequence: 8,
    name: "Collaudo, canary e rilascio",
    weightPercent: 8
  })
]);

const STATUS_VALUES = new Set([
  "PENDING",
  "IN_PROGRESS",
  "CANDIDATE_IMPORTED_NOT_VERIFIED",
  "VERIFIED_COMPLETE",
  "BLOCKED"
]);

const IDENTITY_STATES = new Set([
  "LEGACY_V5BT_IDENTIFIERS_INHERITED",
  "V6_IDENTIFIERS_APPLIED_NOT_VERIFIED",
  "V6_IDENTITY_MIGRATION_IN_PROGRESS",
  "V6_IDENTITY_VERIFIED"
]);

const SOURCE_CLASSIFICATION_BY_KIND = new Map([
  ["V6_BOOTSTRAP", "BOOTSTRAP_INPUT_NOT_RELEASE_EVIDENCE"],
  ["COMMERCIAL_V2_CANDIDATE", "CANDIDATE_IMPORTED_NOT_VERIFIED"],
  ["LEGACY_V5BT", "HISTORICAL_REFERENCE_ONLY"]
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const V6_RELEASE_PATTERN = /^6\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]+$/;

function fail(message) {
  throw new Error(`Invalid Cassa V6 roadmap status: ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function assertObject(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertExactKeys(value, expectedKeys, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assert(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label} keys must be exactly: ${expected.join(", ")}`
  );
}

function assertString(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
}

function assertInteger(value, label, minimum = 0, maximum = 100) {
  assert(Number.isInteger(value) && value >= minimum && value <= maximum, `${label} must be an integer from ${minimum} to ${maximum}`);
}

function assertUniqueStringArray(value, label) {
  assert(Array.isArray(value), `${label} must be an array`);
  value.forEach((item, index) => assertString(item, `${label}[${index}]`));
  assert(new Set(value).size === value.length, `${label} must not contain duplicates`);
}

function assertPortableArtifactPath(value, label) {
  assertString(value, label);
  assert(!value.startsWith("/"), `${label} must not be absolute`);
  assert(!value.split("/").includes(".."), `${label} must not escape the package`);
}

function assertDate(value, label) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value), `${label} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  assert(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, `${label} must be a real date`);
}

function validateProgressPolicy(policy) {
  assertExactKeys(
    policy,
    [
      "formula",
      "phaseWeightsTotalPercent",
      "candidateImportedCountsTowardProgress",
      "legacyEvidenceCountsTowardProgress",
      "requiredEvidenceScope"
    ],
    "progressPolicy"
  );
  assert(policy.formula === "SUM_WEIGHTS_OF_VERIFIED_COMPLETE_PHASES", "progressPolicy.formula is unsupported");
  assert(policy.phaseWeightsTotalPercent === 100, "progressPolicy.phaseWeightsTotalPercent must be 100");
  assert(policy.candidateImportedCountsTowardProgress === false, "candidate imports must not count toward progress");
  assert(policy.legacyEvidenceCountsTowardProgress === false, "legacy evidence must not count toward progress");
  assert(policy.requiredEvidenceScope === "V6_ONLY", "progressPolicy.requiredEvidenceScope must be V6_ONLY");
}

function validateSourceBaselines(sourceBaselines) {
  assert(Array.isArray(sourceBaselines) && sourceBaselines.length >= 2, "sourceBaselines must contain at least two entries");
  const ids = new Set();
  const kinds = new Set();

  sourceBaselines.forEach((source, index) => {
    const label = `sourceBaselines[${index}]`;
    assertExactKeys(
      source,
      [
        "id",
        "kind",
        "artifact",
        "sha256",
        "classification",
        "countsTowardOfficialProgress",
        "requiresV6Reverification"
      ],
      label
    );
    assert(SOURCE_ID_PATTERN.test(source.id), `${label}.id is invalid`);
    assert(!ids.has(source.id), `${label}.id is duplicated`);
    ids.add(source.id);
    assert(SOURCE_CLASSIFICATION_BY_KIND.has(source.kind), `${label}.kind is unsupported`);
    kinds.add(source.kind);
    assertPortableArtifactPath(source.artifact, `${label}.artifact`);
    assert(SHA256_PATTERN.test(source.sha256), `${label}.sha256 must be a lowercase SHA-256`);
    assert(
      source.classification === SOURCE_CLASSIFICATION_BY_KIND.get(source.kind),
      `${label}.classification does not match kind ${source.kind}`
    );
    assert(source.countsTowardOfficialProgress === false, `${label} must not count toward official progress`);
    assert(source.requiresV6Reverification === true, `${label} must require V6 reverification`);
  });

  for (const requiredKind of ["V6_BOOTSTRAP", "COMMERCIAL_V2_CANDIDATE", "LEGACY_V5BT"]) {
    assert(kinds.has(requiredKind), `sourceBaselines must include ${requiredKind}`);
  }

  return ids;
}

function validatePhases(phases, sourceIds) {
  assert(Array.isArray(phases) && phases.length === EXPECTED_PHASES.length, "phases must contain V6-P0 through V6-P8");
  const ids = new Set();
  let totalWeight = 0;
  let computedProgressPercent = 0;
  let verifiedCompletePhaseCount = 0;

  phases.forEach((phase, index) => {
    const label = `phases[${index}]`;
    const expected = EXPECTED_PHASES[index];
    assertExactKeys(
      phase,
      [
        "id",
        "sequence",
        "name",
        "weightPercent",
        "status",
        "creditedPercent",
        "candidateSourceRefs",
        "verifiedEvidenceRefs"
      ],
      label
    );
    assert(phase.id === expected.id, `${label}.id must be ${expected.id}`);
    assert(phase.sequence === expected.sequence, `${label}.sequence must be ${expected.sequence}`);
    assert(phase.name === expected.name, `${label}.name must be ${expected.name}`);
    assert(phase.weightPercent === expected.weightPercent, `${label}.weightPercent must be ${expected.weightPercent}`);
    assert(!ids.has(phase.id), `${label}.id is duplicated`);
    ids.add(phase.id);
    assert(STATUS_VALUES.has(phase.status), `${label}.status is unsupported`);
    assertInteger(phase.creditedPercent, `${label}.creditedPercent`);
    assertUniqueStringArray(phase.candidateSourceRefs, `${label}.candidateSourceRefs`);
    assertUniqueStringArray(phase.verifiedEvidenceRefs, `${label}.verifiedEvidenceRefs`);
    phase.candidateSourceRefs.forEach((sourceRef) => {
      assert(sourceIds.has(sourceRef), `${label}.candidateSourceRefs contains unknown source ${sourceRef}`);
    });

    if (phase.status === "VERIFIED_COMPLETE") {
      assert(
        phase.verifiedEvidenceRefs.length > 0,
        `${label} cannot be VERIFIED_COMPLETE without V6 verifiedEvidenceRefs`
      );
      assert(
        phase.creditedPercent === phase.weightPercent,
        `${label}.creditedPercent must equal its weight when VERIFIED_COMPLETE`
      );
      verifiedCompletePhaseCount += 1;
    } else {
      assert(phase.creditedPercent === 0, `${label} must have zero credit until VERIFIED_COMPLETE`);
    }

    if (phase.status === "CANDIDATE_IMPORTED_NOT_VERIFIED") {
      assert(phase.candidateSourceRefs.length > 0, `${label} candidate status requires a candidate source`);
      assert(phase.verifiedEvidenceRefs.length === 0, `${label} candidate status cannot claim verified V6 evidence`);
    }

    totalWeight += phase.weightPercent;
    computedProgressPercent += phase.creditedPercent;
  });

  assert(totalWeight === 100, `phase weights must sum to 100, found ${totalWeight}`);
  return { computedProgressPercent, verifiedCompletePhaseCount };
}

function validatePromotion(promotion, phases, officialProgressPercent) {
  assertExactKeys(
    promotion,
    ["allowed", "requiresAllPhasesVerifiedComplete", "authorizationEvidenceRefs", "blockers"],
    "promotion"
  );
  assert(typeof promotion.allowed === "boolean", "promotion.allowed must be boolean");
  assert(promotion.requiresAllPhasesVerifiedComplete === true, "promotion must require every phase to be verified complete");
  assertUniqueStringArray(promotion.authorizationEvidenceRefs, "promotion.authorizationEvidenceRefs");
  assertUniqueStringArray(promotion.blockers, "promotion.blockers");

  const allPhasesComplete = phases.every((phase) => phase.status === "VERIFIED_COMPLETE");
  if (promotion.allowed) {
    assert(allPhasesComplete, "promotion cannot be allowed before every phase is VERIFIED_COMPLETE");
    assert(officialProgressPercent === 100, "promotion cannot be allowed before official progress is 100");
    assert(promotion.authorizationEvidenceRefs.length > 0, "promotion requires authorization evidence");
    assert(promotion.blockers.length === 0, "promotion cannot be allowed while blockers remain");
  } else {
    assert(promotion.blockers.length > 0, "a blocked promotion must explain at least one blocker");
  }
}

export function validateRoadmapStatus(status) {
  assertExactKeys(
    status,
    [
      "schemaVersion",
      "mode",
      "product",
      "targetReleaseVersion",
      "roadmapId",
      "roadmapRevision",
      "statusAsOf",
      "baselineIdentityState",
      "officialProgressPercent",
      "progressPolicy",
      "sourceBaselines",
      "phases",
      "promotion"
    ],
    "status"
  );
  assert(status.schemaVersion === 1, "schemaVersion must be 1");
  assert(status.mode === "CURRENT_ROADMAP_STATUS", "mode must be CURRENT_ROADMAP_STATUS");
  assert(status.product === "CASSA_V6", "product must be CASSA_V6");
  assert(V6_RELEASE_PATTERN.test(status.targetReleaseVersion), "targetReleaseVersion must be a V6 semantic version");
  assert(status.roadmapId === "CASSA_V6_ROADMAP", "roadmapId must be CASSA_V6_ROADMAP");
  assert(SEMVER_PATTERN.test(status.roadmapRevision), "roadmapRevision must be a semantic version");
  assertDate(status.statusAsOf, "statusAsOf");
  assert(IDENTITY_STATES.has(status.baselineIdentityState), "baselineIdentityState is unsupported");
  assertInteger(status.officialProgressPercent, "officialProgressPercent");
  validateProgressPolicy(status.progressPolicy);
  const sourceIds = validateSourceBaselines(status.sourceBaselines);
  const result = validatePhases(status.phases, sourceIds);
  assert(
    status.officialProgressPercent === result.computedProgressPercent,
    `officialProgressPercent must equal computed progress ${result.computedProgressPercent}`
  );
  validatePromotion(status.promotion, status.phases, status.officialProgressPercent);
  return Object.freeze(result);
}

export async function loadAndValidateRoadmapStatus(filePath) {
  const source = await readFile(filePath, "utf8");
  let status;
  try {
    status = JSON.parse(source);
  } catch (error) {
    fail(`cannot parse ${filePath}: ${error.message}`);
  }
  return { status, result: validateRoadmapStatus(status) };
}

const currentFilePath = process.argv[1] ? resolve(process.argv[1]) : null;
const thisFilePath = fileURLToPath(import.meta.url);

if (currentFilePath === thisFilePath) {
  const defaultStatusPath = fileURLToPath(new URL("../configs/current-roadmap-status.json", import.meta.url));
  const statusPath = process.argv[2] ? resolve(process.argv[2]) : defaultStatusPath;
  try {
    const { status, result } = await loadAndValidateRoadmapStatus(statusPath);
    process.stdout.write(
      `Cassa V6 roadmap status VALID: ${status.officialProgressPercent}%; ` +
        `${result.verifiedCompletePhaseCount}/${EXPECTED_PHASES.length} phases verified complete\n`
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
