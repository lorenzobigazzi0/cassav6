#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

PACKAGE_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ROADMAP_ROOT="${PACKAGE_ROOT}/ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719"
SOURCE_UNIT="${ROADMAP_ROOT}/raspberry/systemd/cassav5bt-bluetooth-enrollment.service"
TARGET_ROOT="/opt/cassav5bt-bluetooth-node"
CONFIG_ROOT="/etc/cassav5bt"
STATE_ROOT="/var/lib/cassav5bt-bluetooth"
SERVICE_NAME="cassav5bt-bluetooth-enrollment.service"
SERVICE_USER="cassav5bt"
LAB_IP="${CASSAV5BT_LAB_IP:-192.168.0.67}"
ENDPOINT_ID="${CASSAV5BT_ENROLLMENT_ENDPOINT_ID:-raspberry-lab-v5bt}"
CERT_PATH="${CONFIG_ROOT}/bluetooth-enrollment.crt"
KEY_PATH="${CONFIG_ROOT}/bluetooth-enrollment.key"
ENV_PATH="${CONFIG_ROOT}/cassav5bt-bluetooth-enrollment.env"
REGISTRY_PATH="${STATE_ROOT}/devices.json"

if [[ ! "${LAB_IP}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "CASSAV5BT_LAB_IP must be an IPv4 address." >&2
  exit 1
fi

for required_path in \
  "${ROADMAP_ROOT}/raspberry" \
  "${ROADMAP_ROOT}/shared" \
  "${ROADMAP_ROOT}/contracts" \
  "${SOURCE_UNIT}"; do
  if [[ ! -e "${required_path}" ]]; then
    echo "Missing required V5BT source: ${required_path}" >&2
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd \
    --system \
    --home-dir "${STATE_ROOT}" \
    --shell /usr/sbin/nologin \
    "${SERVICE_USER}"
fi

install -d -o root -g root -m 0755 "${TARGET_ROOT}"
install -d -o root -g "${SERVICE_USER}" -m 0750 "${CONFIG_ROOT}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0700 "${STATE_ROOT}"

for source_dir in raspberry shared contracts configs; do
  install -d -o root -g root -m 0755 "${TARGET_ROOT}/${source_dir}"
  cp -a -- "${ROADMAP_ROOT}/${source_dir}/." "${TARGET_ROOT}/${source_dir}/"
done
chown -R root:root "${TARGET_ROOT}"

if [[ -e "${CERT_PATH}" || -e "${KEY_PATH}" ]]; then
  if [[ ! -f "${CERT_PATH}" || ! -f "${KEY_PATH}" ]]; then
    echo "TLS certificate/key pair is incomplete." >&2
    exit 1
  fi
  if ! openssl x509 -in "${CERT_PATH}" -noout -checkip "${LAB_IP}" >/dev/null; then
    echo "Existing TLS certificate does not cover ${LAB_IP}." >&2
    exit 1
  fi
else
  umask 077
  openssl req \
    -x509 \
    -newkey rsa:3072 \
    -sha256 \
    -nodes \
    -days 825 \
    -subj "/CN=${LAB_IP}" \
    -addext "subjectAltName=IP:${LAB_IP}" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" \
    -keyout "${KEY_PATH}" \
    -out "${CERT_PATH}" \
    >/dev/null 2>&1
fi

chown "${SERVICE_USER}:${SERVICE_USER}" "${KEY_PATH}" "${CERT_PATH}"
chmod 0600 "${KEY_PATH}"
chmod 0644 "${CERT_PATH}"

cat > "${ENV_PATH}" <<EOF
CASSA_BT_FEATURE_ENABLED=0
CASSA_BT_ENROLLMENT_RUNTIME_ENABLED=1
CASSA_BT_ENROLLMENT_LISTEN_HOST=0.0.0.0
CASSA_BT_ENROLLMENT_PORT=9443
CASSA_BT_ENROLLMENT_ENDPOINT_ID=${ENDPOINT_ID}
CASSA_BT_ENROLLMENT_TLS_CERT=${CERT_PATH}
CASSA_BT_ENROLLMENT_TLS_KEY=${KEY_PATH}
CASSA_BT_STATE_ROOT=${STATE_ROOT}
CASSA_BT_DEVICE_REGISTRY=${REGISTRY_PATH}
EOF
chown root:root "${ENV_PATH}"
chmod 0600 "${ENV_PATH}"

if [[ ! -f "${REGISTRY_PATH}" ]]; then
  runuser -u "${SERVICE_USER}" -- \
    node "${TARGET_ROOT}/raspberry/scripts/device-registry.mjs" init \
      --registry "${REGISTRY_PATH}" \
      >/dev/null
fi
chown "${SERVICE_USER}:${SERVICE_USER}" "${REGISTRY_PATH}"
chmod 0600 "${REGISTRY_PATH}"

install -o root -g root -m 0644 \
  "${SOURCE_UNIT}" \
  "/etc/systemd/system/${SERVICE_NAME}"
systemctl daemon-reload
systemd-analyze verify "/etc/systemd/system/${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

health_url="https://${LAB_IP}:9443/health"
for _ in $(seq 1 20); do
  if curl \
    --fail \
    --silent \
    --show-error \
    --cacert "${CERT_PATH}" \
    "${health_url}" \
    >/dev/null; then
    break
  fi
  sleep 0.25
done

curl \
  --fail \
  --silent \
  --show-error \
  --cacert "${CERT_PATH}" \
  "${health_url}" \
  >/dev/null

spki_pin="$(
  openssl x509 -in "${CERT_PATH}" -pubkey -noout |
    openssl pkey -pubin -outform DER |
    openssl dgst -sha256 -binary |
    openssl base64 -A
)"

printf 'SERVICE=%s\n' "${SERVICE_NAME}"
printf 'HEALTH_URL=%s\n' "${health_url}"
printf 'ENDPOINT_ID=%s\n' "${ENDPOINT_ID}"
printf 'SPKI_PIN=sha256/%s\n' "${spki_pin}"
