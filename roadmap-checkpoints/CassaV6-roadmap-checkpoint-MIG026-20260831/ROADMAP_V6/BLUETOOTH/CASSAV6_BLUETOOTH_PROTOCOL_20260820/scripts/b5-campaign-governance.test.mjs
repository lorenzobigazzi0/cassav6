import assert from "node:assert/strict";
import test from "node:test";

import {
  B5CampaignGovernanceError,
  campaignIdCommitment,
  parseB5CampaignAuthorization,
  parseB5ReviewAttestation,
  validB5CampaignAuthorizationFixture,
  validB5ReviewAttestationFixture
} from "./b5-campaign-governance.mjs";

const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";

function assertCode(code) {
  return (error) =>
    error instanceof B5CampaignGovernanceError && error.code === code;
}

test("B5 campaign authorization binds B0-B4 and the exact campaign", () => {
  const authorization = validB5CampaignAuthorizationFixture({
    campaignId: CAMPAIGN_ID
  });
  const parsed = parseB5CampaignAuthorization(authorization, {
    campaignId: CAMPAIGN_ID,
    certificationMatrixSha256: authorization.certificationMatrixSha256
  });
  assert.equal(parsed.value.prerequisites.b4, "PASS");
  assert.equal(
    authorization.campaignIdCommitmentSha256,
    campaignIdCommitment(CAMPAIGN_ID)
  );

  assert.throws(
    () =>
      parseB5CampaignAuthorization(authorization, {
        campaignId: "00000000-0000-4000-8000-000000000002",
        certificationMatrixSha256: authorization.certificationMatrixSha256
      }),
    assertCode("CAMPAIGN_AUTHORIZATION_BINDING_INVALID")
  );
});

test("B5 authorization rejects missing gates, false constraints and extra fields", () => {
  for (const mutate of [
    (value) => { value.prerequisites.b3 = "PENDING"; },
    (value) => { value.constraints.independentReviewRequired = false; },
    (value) => { value.unexpected = true; }
  ]) {
    const value = structuredClone(validB5CampaignAuthorizationFixture());
    mutate(value);
    assert.throws(
      () => parseB5CampaignAuthorization(value),
      assertCode("CAMPAIGN_AUTHORIZATION_INVALID")
    );
  }
});

test("B5 independent review binds the technical aggregate and distinct reviewer", () => {
  const review = validB5ReviewAttestationFixture();
  const parsed = parseB5ReviewAttestation(review, {
    technicalAggregateSha256: review.technicalAggregateSha256,
    prerequisiteEvidenceBundleSha256:
      review.prerequisiteEvidenceBundleSha256,
    operatorCommitmentSha256: review.operatorCommitmentSha256,
    technicalGeneratedAtMs: Date.parse("2026-07-22T00:00:00.000Z")
  });
  assert.equal(parsed.value.decision, "PASS");

  const samePerson = structuredClone(review);
  samePerson.reviewerCommitmentSha256 = samePerson.operatorCommitmentSha256;
  assert.throws(
    () => parseB5ReviewAttestation(samePerson),
    assertCode("REVIEW_NOT_INDEPENDENT")
  );
});

test("B5 review rejects mismatch, predated review and private fields", () => {
  const review = validB5ReviewAttestationFixture();
  assert.throws(
    () =>
      parseB5ReviewAttestation(review, {
        technicalAggregateSha256: "a".repeat(64)
      }),
    assertCode("REVIEW_BINDING_INVALID")
  );
  assert.throws(
    () =>
      parseB5ReviewAttestation(review, {
        technicalGeneratedAtMs: Date.parse("2026-07-22T00:02:00.000Z")
      }),
    assertCode("REVIEW_BINDING_INVALID")
  );
  const privateReview = structuredClone(review);
  privateReview.privacy.identifiersIncluded = true;
  assert.throws(
    () => parseB5ReviewAttestation(privateReview),
    assertCode("REVIEW_ATTESTATION_INVALID")
  );
});
