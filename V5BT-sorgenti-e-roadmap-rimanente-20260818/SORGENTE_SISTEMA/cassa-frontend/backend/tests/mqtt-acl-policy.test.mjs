import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMqttAclPolicySummary,
  evaluateAclAccess,
  formatMqttAclPolicyMarkdown,
  parseMosquittoAcl,
} from "../../scripts/mqtt-acl-policy-check.mjs";

const validConf = `
listener 1883 0.0.0.0
allow_anonymous false
password_file /etc/mosquitto/passwd
acl_file /etc/mosquitto/acl
`;

const validAcl = `
user backend
topic write pos/+/events/#
topic read pos/+/devices/+/acks/#

user palmare-template
topic read pos/+/events/#
topic write pos/+/devices/%u/presence
topic write pos/+/devices/%u/acks/#

user printer-gateway-template
topic read pos/+/events/prints/#
topic write pos/+/printers/%u/status
`;

test("[BE][STEP14E] MQTT ACL consente solo backend writer events", () => {
  const summary = buildMqttAclPolicySummary({
    confText: validConf,
    aclText: validAcl,
    confPath: "conf",
    aclPath: "acl",
  });
  assert.equal(summary.ok, true);
  assert.match(formatMqttAclPolicyMarkdown(summary), /RESULT: OK/);
  const acl = parseMosquittoAcl(validAcl);
  assert.equal(
    evaluateAclAccess(acl, "backend", "write", "pos/store-1/events/orders/order-1").allowed,
    true,
  );
  assert.equal(
    evaluateAclAccess(acl, "palmare-template", "read", "pos/store-1/events/orders/order-1").allowed,
    true,
  );
  assert.equal(
    evaluateAclAccess(acl, "palmare-template", "write", "pos/store-1/events/orders/order-1").allowed,
    false,
  );
  assert.equal(
    evaluateAclAccess(acl, "palmare-template", "write", "pos/store-1/devices/palmare-template/presence").allowed,
    true,
  );
  assert.equal(
    evaluateAclAccess(acl, "palmare-template", "write", "pos/store-1/devices/other-device/presence").allowed,
    false,
  );
});

test("[BE][STEP14E] MQTT ACL fallisce se un device puo scrivere eventi", () => {
  const unsafeAcl = `${validAcl}
user palmare-bad
topic readwrite pos/+/events/#
`;
  const summary = buildMqttAclPolicySummary({
    confText: validConf,
    aclText: unsafeAcl,
    confPath: "conf",
    aclPath: "acl",
  });
  assert.equal(summary.ok, false);
  assert.equal(
    summary.checks.find((check) => check.name === "no non-backend event writers")?.ok,
    false,
  );
});

test("[BE][STEP14E] MQTT ACL fallisce senza autenticazione obbligatoria", () => {
  const summary = buildMqttAclPolicySummary({
    confText: "listener 1883 0.0.0.0\nallow_anonymous true\n",
    aclText: validAcl,
    confPath: "conf",
    aclPath: "acl",
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.checks.find((check) => check.name === "allow_anonymous false")?.ok, false);
  assert.equal(summary.checks.find((check) => check.name === "password_file configured")?.ok, false);
  assert.equal(summary.checks.find((check) => check.name === "acl_file configured")?.ok, false);
});
