import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(root, "tools", "run-v5bt-api31-enrollment-staging.sh");
const certificatePath = path.join(
  root,
  "private",
  "lab-enrollment-tls",
  "bluetooth-enrollment.crt"
);
const keyPath = path.join(
  root,
  "private",
  "lab-enrollment-tls",
  "bluetooth-enrollment.key"
);

const run = (args, environment = {}) =>
  spawnSync("bash", [helperPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });

test("the staging helper is valid Bash and validates the dedicated local TLS source", () => {
  const syntax = spawnSync("bash", ["-n", helperPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  const validation = run(["validate-source"]);
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(validation.stdout, "SOURCE_VALIDATION=PASS\n");
  assert.doesNotMatch(`${validation.stdout}${validation.stderr}`, /sha256\//i);
});

test("the helper rejects a loose or linked private TLS key before any staging mutation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "v5bt-api31-staging-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificate = path.join(directory, "certificate.pem");
  const key = path.join(directory, "key.pem");
  await copyFile(certificatePath, certificate);
  await copyFile(keyPath, key);
  await chmod(certificate, 0o644);
  await chmod(key, 0o644);

  const environment = {
    CASSAV5BT_API31_CERT_SOURCE: certificate,
    CASSAV5BT_API31_KEY_SOURCE: key
  };
  const loose = run(["validate-source"], environment);
  assert.notEqual(loose.status, 0);
  assert.match(loose.stderr, /must not be accessible by group or others/);

  await chmod(key, 0o600);
  const linkedKey = path.join(directory, "linked-key.pem");
  await symlink(key, linkedKey);
  const linked = run(["validate-source"], {
    ...environment,
    CASSAV5BT_API31_KEY_SOURCE: linkedKey
  });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /Not a regular file/);
});

test("the release and registry contracts are isolated, immutable and non-overwriting", async () => {
  const source = await readFile(helperPath, "utf8");

  assert.match(source, /STATE_ROOT="\/var\/lib\/cassav5bt-bluetooth"/);
  assert.match(source, /MAIN_REGISTRY="\$\{STATE_ROOT\}\/devices\.json"/);
  assert.match(source, /RUN_ROOT="\$\{STATE_ROOT\}\/api31-staging-\$\{run_id\}"/);
  assert.match(source, /RELEASE_BASE="\/opt\/cassav5bt-api31-enrollment-staging\/releases"/);
  assert.match(source, /CONTROL_BASE="\/var\/lib\/cassav5bt-api31-enrollment-staging-control"/);
  assert.match(source, /\[\[ ! -e "\$\{RUN_ROOT\}" && ! -L "\$\{RUN_ROOT\}" \]\]/);
  assert.match(source, /\[\[ ! -e "\$\{RELEASE_ROOT\}" && ! -L "\$\{RELEASE_ROOT\}" \]\]/);
  assert.match(source, /install -o "\$\{SERVICE_USER\}" -g "\$\{SERVICE_GROUP\}" -m 0600[\s\S]*"\$\{MAIN_REGISTRY\}" "\$\{REGISTRY_COPY\}"/);
  assert.match(source, /stat -c '%d:%i'[\s\S]*MAIN_REGISTRY[\s\S]*REGISTRY_COPY/);
  assert.match(source, /sha256sum --check --status RELEASE\.sha256/);
  assert.match(source, /stat -c '%a'[\s\S]*release_entry[\s\S]*== "444"/);
  assert.match(source, /stat -c '%a'[\s\S]*release_entry[\s\S]*== "555"/);
  assert.match(source, /RELEASE_MANIFEST_HASH_FILE="\$\{CONTROL_ROOT\}\/release-manifest\.sha256"/);
  assert.match(source, /realpath -m -- "\$\{directory\}"/);
  assert.match(source, /nearest base directory ancestor must be root-owned/i);
  assert.match(source, /base directory parent must not be group\/world writable/i);
  assert.doesNotMatch(source, /cp\s+[^\n]*devices\.json/);
});

test("only a bounded transient unit can be started or stopped", async () => {
  const source = await readFile(helperPath, "utf8");

  assert.match(source, /UNIT_PREFIX="cassav5bt-api31-enroll-"/);
  assert.match(source, /systemd-run --quiet --collect/);
  assert.match(source, /--unit="\$\{UNIT_NAME\}"/);
  assert.match(source, /--uid="\$\{SERVICE_USER\}"/);
  assert.match(source, /--property="RuntimeMaxSec=\$\{MAX_RUNTIME_SECONDS\}"/);
  assert.match(source, /systemctl stop --no-block "\$\{UNIT_NAME\}"/);
  assert.match(source, /systemctl kill --kill-whom=all --signal=KILL "\$\{UNIT_NAME\}"/);
  assert.match(source, /local deadline=\$\(\(SECONDS \+ STOP_TIMEOUT_SECONDS\)\)/);
  assert.doesNotMatch(source, /systemctl\s+(?:restart|start|stop|kill)[^\n]*(?:cassav5bt\.service|bluetooth\.service)/);
  assert.doesNotMatch(source, /deploy-v5bt-bluetooth-enrollment/);
});

test("health requires both protocol versions with v2 preferred and no sensitive logging", async () => {
  const source = await readFile(helperPath, "utf8");

  assert.match(source, /versions\[0\] !== 1/);
  assert.match(source, /versions\[1\] !== 2/);
  assert.match(source, /preferredProtocolVersion !== 2/);
  assert.match(source, /registryReady !== true/);
  assert.match(source, /curl --fail --silent --show-error --max-time 3/);
  assert.match(source, /mktemp -p "\$\{CONTROL_ROOT\}" \.health/);
  assert.doesNotMatch(source, /set -x|curl\s+(?:--verbose|-v)/);
  assert.doesNotMatch(source, /cat\s+[^\n]*(?:enrollment\.key|runtime\.env|devices\.json)/);
  assert.doesNotMatch(source, /journalctl/);
});

test("v2 token issuance is pinned to the copied registry and suppresses CLI output", async () => {
  const source = await readFile(helperPath, "utf8");

  assert.match(source, /issue-token RUN_ID LABEL/);
  assert.match(source, /--registry "\$\{REGISTRY_COPY\}"/);
  assert.match(source, /--endpoint-id "\$\{ENDPOINT_ID\}"/);
  assert.match(source, /--protocol-version 2/);
  assert.match(source, /--ttl-seconds 600/);
  assert.match(source, />"\$\{private_stdout\}" 2>"\$\{private_stderr\}"/);
  assert.match(source, /TOKEN_ISSUE=PASS/);
  assert.doesNotMatch(source, /printf[^\n]*(?:qrPayload|qr\.token|c5e2_)/);
});

test("the live registry and operational service baselines are checked throughout the lifecycle", async () => {
  const source = await readFile(helperPath, "utf8");

  assert.match(source, /live_hash_before="\$\(sha256_file "\$\{MAIN_REGISTRY\}"\)"/);
  assert.match(source, /live_hash_after="\$\(sha256_file "\$\{MAIN_REGISTRY\}"\)"/);
  assert.match(source, /assert_main_registry_unchanged/);
  assert.match(source, /snapshot_service cassav5bt\.service/);
  assert.match(source, /snapshot_service bluetooth\.service/);
  assert.match(source, /assert_operational_services_unchanged/);
  assert.match(source, /MAIN_SERVICE_BASELINE="\$\{CONTROL_ROOT\}/);
  assert.match(source, /TLS_KEY_HASH_FILE="\$\{CONTROL_ROOT\}/);
  assert.doesNotMatch(source, /(?:chmod|chown|install|mv|rm)[^\n]*"?\$\{MAIN_REGISTRY\}"?\s*(?:$|[;&])/m);
});
