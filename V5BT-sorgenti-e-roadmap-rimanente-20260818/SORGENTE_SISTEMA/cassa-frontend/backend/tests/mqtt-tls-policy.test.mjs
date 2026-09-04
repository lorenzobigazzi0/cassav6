import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMqttTlsPolicySummary,
  formatMqttTlsPolicyMarkdown,
  parseMqttTlsPolicyCheckArgs,
} from "../../scripts/mqtt-tls-policy-check.mjs";

const validTlsConf = `
listener 8883 0.0.0.0
allow_anonymous false
password_file /etc/mosquitto/passwd
acl_file /etc/mosquitto/acl
cafile /etc/mosquitto/certs/ca.crt
certfile /etc/mosquitto/certs/server.crt
keyfile /etc/mosquitto/certs/server.key
tls_version tlsv1.2
`;

test("[BE][STEP14I] MQTT TLS policy valida configurazione Mosquitto TLS", () => {
  const parsed = parseMqttTlsPolicyCheckArgs(["--conf", "configs/mosquitto-tls.conf.example"]);
  assert.match(parsed.confPath, /mosquitto-tls\.conf\.example$/);

  const summary = buildMqttTlsPolicySummary({
    confText: validTlsConf,
    confPath: "conf",
  });
  assert.equal(summary.ok, true);
  assert.match(formatMqttTlsPolicyMarkdown(summary), /RESULT: OK/);
  assert.equal(summary.checks.find((check) => check.name === "tls listener configured")?.ok, true);
  assert.equal(summary.checks.find((check) => check.name === "certificate paths external")?.ok, true);
});

test("[BE][STEP14I] MQTT TLS policy fallisce senza certificati server", () => {
  const summary = buildMqttTlsPolicySummary({
    confText: `
listener 8883 0.0.0.0
allow_anonymous false
password_file /etc/mosquitto/passwd
acl_file /etc/mosquitto/acl
cafile /etc/mosquitto/certs/ca.crt
`,
    confPath: "conf",
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.checks.find((check) => check.name === "server certificate configured")?.ok, false);
  assert.equal(summary.checks.find((check) => check.name === "server private key configured")?.ok, false);
});

test("[BE][STEP14I] MQTT TLS policy fallisce se anonymous e abilitato", () => {
  const summary = buildMqttTlsPolicySummary({
    confText: validTlsConf.replace("allow_anonymous false", "allow_anonymous true"),
    confPath: "conf",
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.checks.find((check) => check.name === "anonymous disabled")?.ok, false);
});
