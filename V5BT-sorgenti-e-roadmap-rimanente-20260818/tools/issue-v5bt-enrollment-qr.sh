#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

device_label="${1:-palmare}"
if [[ ! "${device_label}" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
  echo "Device label must use lowercase letters, digits, underscore or dash." >&2
  exit 1
fi

service_user="cassav5bt"
endpoint_id="raspberry-lab-v5bt"
state_root="/var/lib/cassav5bt-bluetooth"
registry_path="${state_root}/devices.json"
registry_cli="/opt/cassav5bt-bluetooth-node/raspberry/scripts/device-registry.mjs"
transaction_root="${state_root}/enrollment-transactions"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
transaction_path="${transaction_root}/${device_label}-${timestamp}.json"
qr_path="/home/admin/.cassav5bt-${device_label}-enrollment-qr.json"

if [[ ! -f "${registry_cli}" || ! -f "${registry_path}" ]]; then
  echo "The isolated V5BT enrollment runtime is not provisioned." >&2
  exit 1
fi
if [[ -e "${qr_path}" ]]; then
  echo "Refusing to overwrite the existing QR handoff: ${qr_path}" >&2
  exit 1
fi

install -d \
  -o "${service_user}" \
  -g "${service_user}" \
  -m 0700 \
  "${transaction_root}"

runuser -u "${service_user}" -- \
  node "${registry_cli}" issue-token \
    --registry "${registry_path}" \
    --endpoint-id "${endpoint_id}" \
    --ttl-seconds 1800 \
    --output "${transaction_path}" \
    >/dev/null

node --input-type=module -e '
  import fs from "node:fs";
  const [source, destination] = process.argv.slice(1);
  const transaction = JSON.parse(fs.readFileSync(source, "utf8"));
  const qr = transaction?.qr;
  const keys = qr && typeof qr === "object" ? Object.keys(qr).sort() : [];
  if (
    keys.join(",") !== "enrollmentEndpointId,token,version" ||
    qr.version !== 1 ||
    qr.enrollmentEndpointId !== "raspberry-lab-v5bt" ||
    typeof qr.token !== "string"
  ) {
    throw new Error("Issued enrollment QR does not match the frozen contract");
  }
  fs.writeFileSync(destination, JSON.stringify(qr), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
' "${transaction_path}" "${qr_path}"

chown admin:admin "${qr_path}"
chmod 0600 "${qr_path}"

printf 'TRANSACTION=%s\n' "${transaction_path}"
printf 'QR_HANDOFF=%s\n' "${qr_path}"
printf 'EXPIRES_IN_SECONDS=1800\n'
