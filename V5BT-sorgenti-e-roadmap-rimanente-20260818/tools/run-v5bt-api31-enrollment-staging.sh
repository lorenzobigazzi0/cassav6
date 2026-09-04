#!/usr/bin/env bash
set -euo pipefail

# Isolated API 31 enrollment staging. This helper never manages the V5BT
# application service or Bluetooth service and never writes the live registry.

PACKAGE_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ROADMAP_ROOT="${PACKAGE_ROOT}/ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719"
SERVICE_USER="cassav5bt"
SERVICE_GROUP="cassav5bt"
LAB_IP="192.168.1.79"
PORT="9443"
ENDPOINT_ID="v5bt-api31-enrollment-v2"
STATE_ROOT="/var/lib/cassav5bt-bluetooth"
MAIN_REGISTRY="${STATE_ROOT}/devices.json"
RELEASE_BASE="/opt/cassav5bt-api31-enrollment-staging/releases"
CONTROL_BASE="/var/lib/cassav5bt-api31-enrollment-staging-control"
UNIT_PREFIX="cassav5bt-api31-enroll-"
STOP_TIMEOUT_SECONDS=10
MAX_RUNTIME_SECONDS=7200

CERT_SOURCE="${CASSAV5BT_API31_CERT_SOURCE:-${PACKAGE_ROOT}/private/lab-enrollment-tls/bluetooth-enrollment.crt}"
KEY_SOURCE="${CASSAV5BT_API31_KEY_SOURCE:-${PACKAGE_ROOT}/private/lab-enrollment-tls/bluetooth-enrollment.key}"

RUNTIME_FILES=(
  "raspberry/scripts/enrollment-server.mjs"
  "raspberry/scripts/device-registry.mjs"
  "shared/provisioning/device-registry-v1.mjs"
  "shared/provisioning/device-registry-v2.mjs"
  "shared/provisioning/enrollment-transport-v1.mjs"
  "shared/provisioning/enrollment-transport-v2.mjs"
  "shared/protocol/advertisement-v1.mjs"
  "shared/protocol/rotating-alias-v1.mjs"
)

usage() {
  cat <<'EOF'
Cassa V5BT API 31 enrollment staging

Usage:
  run-v5bt-api31-enrollment-staging.sh validate-source
  run-v5bt-api31-enrollment-staging.sh prepare RUN_ID
  run-v5bt-api31-enrollment-staging.sh start RUN_ID
  run-v5bt-api31-enrollment-staging.sh health RUN_ID
  run-v5bt-api31-enrollment-staging.sh status RUN_ID
  run-v5bt-api31-enrollment-staging.sh issue-token RUN_ID LABEL
  run-v5bt-api31-enrollment-staging.sh stop RUN_ID
  CASSAV5BT_API31_PURGE=YES run-v5bt-api31-enrollment-staging.sh purge RUN_ID

The TLS input paths may be supplied through CASSAV5BT_API31_CERT_SOURCE and
CASSAV5BT_API31_KEY_SOURCE. File contents are never accepted on argv or logged.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "This command must run as root on the Raspberry."
}

validate_run_id() {
  local run_id="$1"
  [[ "${run_id}" =~ ^[a-z0-9][a-z0-9-]{0,23}$ ]] ||
    die "RUN_ID must contain 1-24 lowercase letters, digits or dashes."
}

validate_token_label() {
  local label="$1"
  [[ "${label}" =~ ^[a-z0-9][a-z0-9-]{0,23}$ ]] ||
    die "LABEL must contain 1-24 lowercase letters, digits or dashes."
}

paths_for_run() {
  local run_id="$1"
  RUN_ROOT="${STATE_ROOT}/api31-staging-${run_id}"
  RELEASE_ROOT="${RELEASE_BASE}/${run_id}"
  CONTROL_ROOT="${CONTROL_BASE}/${run_id}"
  REGISTRY_COPY="${RUN_ROOT}/devices.json"
  CERT_COPY="${RUN_ROOT}/enrollment.crt"
  KEY_COPY="${RUN_ROOT}/enrollment.key"
  ENV_FILE="${CONTROL_ROOT}/runtime.env"
  BASELINE_HASH_FILE="${CONTROL_ROOT}/main-registry.sha256"
  RELEASE_MANIFEST_HASH_FILE="${CONTROL_ROOT}/release-manifest.sha256"
  TLS_CERT_HASH_FILE="${CONTROL_ROOT}/tls-certificate.sha256"
  TLS_KEY_HASH_FILE="${CONTROL_ROOT}/tls-key.sha256"
  MAIN_SERVICE_BASELINE="${CONTROL_ROOT}/cassav5bt-service.baseline"
  BLUETOOTH_SERVICE_BASELINE="${CONTROL_ROOT}/bluetooth-service.baseline"
  PREPARED_MARKER="${CONTROL_ROOT}/prepared"
  UNIT_NAME="${UNIT_PREFIX}${run_id}.service"
  TOKEN_ROOT="${RUN_ROOT}/tokens"
}

assert_regular_single_link() {
  local file="$1"
  [[ -f "${file}" && ! -L "${file}" ]] || die "Not a regular file: ${file}"
  [[ "$(stat -c '%h' -- "${file}")" == "1" ]] || die "Hard link rejected: ${file}"
}

assert_mode() {
  local file="$1"
  local expected="$2"
  [[ "$(stat -c '%a' -- "${file}")" == "${expected}" ]] ||
    die "Unexpected permissions for ${file}; expected ${expected}."
}

assert_owner() {
  local file="$1"
  local expected="$2"
  [[ "$(stat -c '%U:%G' -- "${file}")" == "${expected}" ]] ||
    die "Unexpected owner for ${file}; expected ${expected}."
}

assert_private_service_directory() {
  local directory="$1"
  [[ -d "${directory}" && ! -L "${directory}" ]] ||
    die "Missing private service directory: ${directory}"
  assert_mode "${directory}" 700
  assert_owner "${directory}" "${SERVICE_USER}:${SERVICE_GROUP}"
  [[ "$(realpath -e -- "${directory}")" == "${directory}" ]] ||
    die "Non-canonical directory rejected: ${directory}"
}

assert_private_control_directory() {
  local directory="$1"
  [[ -d "${directory}" && ! -L "${directory}" ]] ||
    die "Missing private control directory: ${directory}"
  assert_mode "${directory}" 700
  assert_owner "${directory}" root:root
  [[ "$(realpath -e -- "${directory}")" == "${directory}" ]] ||
    die "Non-canonical control directory rejected: ${directory}"
}

ensure_root_base_directory() {
  local directory="$1"
  local mode="$2"
  [[ "$(realpath -m -- "${directory}")" == "${directory}" ]] ||
    die "Base directory path traverses a symbolic link: ${directory}"
  local existing_ancestor="${directory}"
  while [[ ! -e "${existing_ancestor}" && ! -L "${existing_ancestor}" ]]; do
    existing_ancestor="$(dirname -- "${existing_ancestor}")"
  done
  [[ -d "${existing_ancestor}" && ! -L "${existing_ancestor}" ]] ||
    die "The nearest base directory ancestor is invalid."
  [[ "$(realpath -e -- "${existing_ancestor}")" == "${existing_ancestor}" ]] ||
    die "The nearest base directory ancestor is not canonical."
  [[ "$(stat -c '%U:%G' -- "${existing_ancestor}")" == "root:root" ]] ||
    die "The nearest base directory ancestor must be root-owned."
  [[ $((8#$(stat -c '%a' -- "${existing_ancestor}") & 8#022)) -eq 0 ]] ||
    die "The nearest base directory ancestor must not be group/world writable."
  if [[ -e "${directory}" || -L "${directory}" ]]; then
    [[ -d "${directory}" && ! -L "${directory}" ]] ||
      die "Invalid base directory: ${directory}"
    assert_mode "${directory}" "${mode}"
    assert_owner "${directory}" root:root
  else
    install -d -o root -g root -m "${mode}" "${directory}"
  fi
  [[ "$(realpath -e -- "${directory}")" == "${directory}" ]] ||
    die "Non-canonical base directory rejected: ${directory}"
  local parent
  parent="$(dirname -- "${directory}")"
  [[ "$(stat -c '%U:%G' -- "${parent}")" == "root:root" ]] ||
    die "The base directory parent must be root-owned."
  [[ $((8#$(stat -c '%a' -- "${parent}") & 8#022)) -eq 0 ]] ||
    die "The base directory parent must not be group/world writable."
}

assert_live_registry() {
  assert_private_service_directory "${STATE_ROOT}"
  assert_regular_single_link "${MAIN_REGISTRY}"
  assert_mode "${MAIN_REGISTRY}" 600
  assert_owner "${MAIN_REGISTRY}" "${SERVICE_USER}:${SERVICE_GROUP}"
  [[ "$(realpath -e -- "${MAIN_REGISTRY}")" == "${MAIN_REGISTRY}" ]] ||
    die "The live registry path traverses a symbolic link."
}

sha256_file() {
  sha256sum --binary -- "$1" | awk '{print $1}'
}

resolve_node_bin() {
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    return
  fi
  local resolver="${PACKAGE_ROOT}/tools/v5bt-node-runtime.sh"
  [[ -f "${resolver}" && ! -L "${resolver}" ]] ||
    die "A compatible Node.js runtime is required."
  # shellcheck source=tools/v5bt-node-runtime.sh
  source "${resolver}"
  NODE_BIN="$(resolve_v5bt_node_bin "${PACKAGE_ROOT}")"
  [[ -x "${NODE_BIN}" ]] || die "A compatible Node.js runtime is required."
}

validate_tls_pair() {
  assert_regular_single_link "${CERT_SOURCE}"
  assert_regular_single_link "${KEY_SOURCE}"
  [[ "$(realpath -e -- "${CERT_SOURCE}")" == "${CERT_SOURCE}" ]] ||
    die "The source TLS certificate path is not canonical."
  [[ "$(realpath -e -- "${KEY_SOURCE}")" == "${KEY_SOURCE}" ]] ||
    die "The source TLS private-key path is not canonical."
  [[ $((8#$(stat -c '%a' -- "${KEY_SOURCE}") & 8#077)) -eq 0 ]] ||
    die "The source TLS key must not be accessible by group or others."
  openssl x509 -in "${CERT_SOURCE}" -noout -checkend 0 >/dev/null 2>&1 ||
    die "The TLS certificate is expired or unreadable."
  openssl x509 -in "${CERT_SOURCE}" -noout -checkip "${LAB_IP}" >/dev/null 2>&1 ||
    die "The TLS certificate does not cover the staging IP."
  openssl x509 -in "${CERT_SOURCE}" -noout -purpose 2>/dev/null |
    grep -Fqx 'SSL server : Yes' || die "The TLS certificate is not valid for a server."

  local certificate_key_hash
  local private_key_hash
  certificate_key_hash="$({ openssl x509 -in "${CERT_SOURCE}" -pubkey -noout |
    openssl pkey -pubin -outform DER; } 2>/dev/null | sha256sum --binary | awk '{print $1}')"
  private_key_hash="$(openssl pkey -in "${KEY_SOURCE}" -pubout -outform DER 2>/dev/null |
    sha256sum --binary | awk '{print $1}')"
  [[ -n "${certificate_key_hash}" && "${certificate_key_hash}" == "${private_key_hash}" ]] ||
    die "The TLS certificate and private key do not match."
}

validate_source_tree() {
  require_command openssl
  require_command sha256sum
  require_command stat
  require_command realpath
  resolve_node_bin
  validate_tls_pair
  local relative_path
  for relative_path in "${RUNTIME_FILES[@]}"; do
    local source_path="${ROADMAP_ROOT}/${relative_path}"
    assert_regular_single_link "${source_path}"
    [[ "$(realpath -e -- "${source_path}")" == "${source_path}" ]] ||
      die "A runtime source path traverses a symbolic link."
    "${NODE_BIN}" --check "${source_path}" >/dev/null
  done
}

snapshot_service() {
  local service="$1"
  local destination="$2"
  systemctl show "${service}" --no-pager \
    --property=ActiveState,SubState,MainPID,NRestarts,InvocationID,ActiveEnterTimestampMonotonic,ExecMainStartTimestampMonotonic \
    >"${destination}"
  chmod 0600 "${destination}"
  chown root:root "${destination}"
}

assert_operational_services_ready() {
  systemctl is-active --quiet cassav5bt.service || die "cassav5bt.service is not active."
  systemctl is-active --quiet bluetooth.service || die "bluetooth.service is not active."
}

assert_operational_services_unchanged() {
  local temporary
  temporary="$(mktemp -p "${CONTROL_ROOT}" .service-check.XXXXXX)"
  chmod 0600 "${temporary}"
  snapshot_service cassav5bt.service "${temporary}"
  cmp --silent "${MAIN_SERVICE_BASELINE}" "${temporary}" || {
    rm -f -- "${temporary}"
    die "cassav5bt.service changed after the staging baseline."
  }
  snapshot_service bluetooth.service "${temporary}"
  cmp --silent "${BLUETOOTH_SERVICE_BASELINE}" "${temporary}" || {
    rm -f -- "${temporary}"
    die "bluetooth.service changed after the staging baseline."
  }
  rm -f -- "${temporary}"
}

assert_main_registry_unchanged() {
  assert_live_registry
  assert_regular_single_link "${BASELINE_HASH_FILE}"
  assert_mode "${BASELINE_HASH_FILE}" 600
  assert_owner "${BASELINE_HASH_FILE}" root:root
  local expected
  expected="$(<"${BASELINE_HASH_FILE}")"
  [[ "${expected}" =~ ^[0-9a-f]{64}$ ]] || die "Invalid private registry baseline."
  [[ "$(sha256_file "${MAIN_REGISTRY}")" == "${expected}" ]] ||
    die "The live registry is not byte-identical to the staging baseline."
}

verify_release() {
  [[ -d "${RELEASE_ROOT}" && ! -L "${RELEASE_ROOT}" ]] || die "Missing release."
  [[ "$(stat -c '%U:%G' -- "${RELEASE_ROOT}")" == "root:root" ]] ||
    die "The release is not root-owned."
  [[ "$(stat -c '%a' -- "${RELEASE_ROOT}")" == "555" ]] ||
    die "The release root is not read-only."
  (
    cd "${RELEASE_ROOT}"
    sha256sum --check --status RELEASE.sha256
  ) || die "The immutable release digest does not match."
  assert_regular_single_link "${RELEASE_MANIFEST_HASH_FILE}"
  assert_mode "${RELEASE_MANIFEST_HASH_FILE}" 600
  assert_owner "${RELEASE_MANIFEST_HASH_FILE}" root:root
  [[ "$(sha256_file "${RELEASE_ROOT}/RELEASE.sha256")" == "$(<"${RELEASE_MANIFEST_HASH_FILE}")" ]] ||
    die "The immutable release manifest was replaced."
  if find "${RELEASE_ROOT}" -type l -print -quit | grep -q .; then
    die "A symbolic link was found in the release."
  fi
  local release_entry
  while IFS= read -r -d '' release_entry; do
    [[ "$(stat -c '%a' -- "${release_entry}")" == "444" ]] ||
      die "A release file is writable or has unexpected permissions."
  done < <(find "${RELEASE_ROOT}" -type f -print0)
  while IFS= read -r -d '' release_entry; do
    [[ "$(stat -c '%a' -- "${release_entry}")" == "555" ]] ||
      die "A release directory is writable or has unexpected permissions."
  done < <(find "${RELEASE_ROOT}" -type d -print0)
}

verify_prepared_run() {
  local check_main_registry="${1:-yes}"
  assert_private_service_directory "${RUN_ROOT}"
  assert_private_control_directory "${CONTROL_ROOT}"
  assert_regular_single_link "${PREPARED_MARKER}"
  assert_mode "${PREPARED_MARKER}" 600
  assert_owner "${PREPARED_MARKER}" root:root
  assert_regular_single_link "${REGISTRY_COPY}"
  assert_mode "${REGISTRY_COPY}" 600
  assert_owner "${REGISTRY_COPY}" "${SERVICE_USER}:${SERVICE_GROUP}"
  [[ "$(stat -c '%d:%i' -- "${MAIN_REGISTRY}")" != "$(stat -c '%d:%i' -- "${REGISTRY_COPY}")" ]] ||
    die "The staging registry must not be a hard link to the live registry."
  assert_regular_single_link "${CERT_COPY}"
  assert_regular_single_link "${KEY_COPY}"
  assert_mode "${CERT_COPY}" 644
  assert_mode "${KEY_COPY}" 600
  assert_owner "${CERT_COPY}" "${SERVICE_USER}:${SERVICE_GROUP}"
  assert_owner "${KEY_COPY}" "${SERVICE_USER}:${SERVICE_GROUP}"
  for hash_file in "${TLS_CERT_HASH_FILE}" "${TLS_KEY_HASH_FILE}"; do
    assert_regular_single_link "${hash_file}"
    assert_mode "${hash_file}" 600
    assert_owner "${hash_file}" root:root
  done
  [[ "$(sha256_file "${CERT_COPY}")" == "$(<"${TLS_CERT_HASH_FILE}")" ]] ||
    die "The dedicated TLS certificate copy changed."
  [[ "$(sha256_file "${KEY_COPY}")" == "$(<"${TLS_KEY_HASH_FILE}")" ]] ||
    die "The dedicated TLS private key copy changed."
  assert_regular_single_link "${ENV_FILE}"
  assert_mode "${ENV_FILE}" 600
  assert_owner "${ENV_FILE}" root:root
  verify_release
  if [[ "${check_main_registry}" == "yes" ]]; then
    assert_main_registry_unchanged
  fi
}

unit_load_state() {
  systemctl show "${UNIT_NAME}" --property=LoadState --value 2>/dev/null || true
}

unit_is_running() {
  systemctl is-active --quiet "${UNIT_NAME}"
}

assert_unit_absent() {
  local load_state
  load_state="$(unit_load_state)"
  [[ -z "${load_state}" || "${load_state}" == "not-found" ]] ||
    die "The transient staging unit already exists."
}

assert_port_free() {
  if ss -H -ltn | awk -v port=":${PORT}" '$4 ~ (port "$") { found=1 } END { exit !found }'; then
    die "TCP port ${PORT} is already in use."
  fi
}

validate_health_payload() {
  local payload="$1"
  resolve_node_bin
  "${NODE_BIN}" --input-type=module -e '
    import fs from "node:fs";
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const versions = value?.protocolVersions;
    if (
      value?.ok !== true ||
      value?.component !== "cassav5bt-bluetooth-enrollment" ||
      !Array.isArray(versions) ||
      versions.length !== 2 ||
      versions[0] !== 1 ||
      versions[1] !== 2 ||
      value?.preferredProtocolVersion !== 2 ||
      value?.registryReady !== true
    ) {
      throw new Error("staging health contract mismatch");
    }
  ' "${payload}"
}

health_check() {
  local payload
  payload="$(mktemp -p "${CONTROL_ROOT}" .health.XXXXXX)"
  chmod 0600 "${payload}"
  if ! curl --fail --silent --show-error --max-time 3 \
    --cacert "${CERT_COPY}" \
    "https://${LAB_IP}:${PORT}/health" \
    --output "${payload}"; then
    rm -f -- "${payload}"
    return 1
  fi
  if ! validate_health_payload "${payload}"; then
    rm -f -- "${payload}"
    return 1
  fi
  rm -f -- "${payload}"
}

stop_unit_bounded() {
  local load_state
  load_state="$(unit_load_state)"
  if [[ -z "${load_state}" || "${load_state}" == "not-found" ]]; then
    return 0
  fi
  systemctl stop --no-block "${UNIT_NAME}"
  local deadline=$((SECONDS + STOP_TIMEOUT_SECONDS))
  while unit_is_running && ((SECONDS < deadline)); do
    sleep 0.2
  done
  if unit_is_running; then
    systemctl kill --kill-whom=all --signal=KILL "${UNIT_NAME}"
    deadline=$((SECONDS + 2))
    while unit_is_running && ((SECONDS < deadline)); do
      sleep 0.1
    done
  fi
  unit_is_running && die "The transient staging unit did not stop within the bounded window."
}

prepare_run() {
  require_root
  validate_source_tree
  require_command cmp
  require_command install
  require_command systemctl
  id "${SERVICE_USER}" >/dev/null 2>&1 || die "Missing service user ${SERVICE_USER}."
  assert_live_registry
  assert_operational_services_ready
  assert_unit_absent
  [[ ! -e "${RUN_ROOT}" && ! -L "${RUN_ROOT}" ]] || die "Run state already exists."
  [[ ! -e "${RELEASE_ROOT}" && ! -L "${RELEASE_ROOT}" ]] || die "Release already exists."
  [[ ! -e "${CONTROL_ROOT}" && ! -L "${CONTROL_ROOT}" ]] || die "Control state already exists."

  ensure_root_base_directory "${RELEASE_BASE}" 755
  ensure_root_base_directory "${CONTROL_BASE}" 700
  local release_temporary="${RELEASE_BASE}/.${RUN_ID}.pending.$$"
  [[ ! -e "${release_temporary}" ]] || die "Pending release path already exists."
  local cleanup_required=1
  cleanup_failed_prepare() {
    local status=$?
    if [[ "${cleanup_required}" == "1" ]]; then
      rm -rf --one-file-system -- \
        "${release_temporary}" "${RELEASE_ROOT}" "${RUN_ROOT}" "${CONTROL_ROOT}"
    fi
    return "${status}"
  }
  trap cleanup_failed_prepare EXIT

  install -d -o root -g root -m 0755 "${release_temporary}"
  local relative_path
  for relative_path in "${RUNTIME_FILES[@]}"; do
    install -D -o root -g root -m 0444 \
      "${ROADMAP_ROOT}/${relative_path}" \
      "${release_temporary}/${relative_path}"
  done
  (
    cd "${release_temporary}"
    sha256sum --binary "${RUNTIME_FILES[@]}" >RELEASE.sha256
  )
  chown root:root "${release_temporary}/RELEASE.sha256"
  chmod 0444 "${release_temporary}/RELEASE.sha256"
  find "${release_temporary}" -type d -exec chown root:root {} + -exec chmod 0555 {} +
  mv -T -- "${release_temporary}" "${RELEASE_ROOT}"

  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 "${RUN_ROOT}"
  install -d -o root -g root -m 0700 "${CONTROL_ROOT}"
  local live_hash_before
  local live_hash_after
  live_hash_before="$(sha256_file "${MAIN_REGISTRY}")"
  install -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0600 \
    "${MAIN_REGISTRY}" "${REGISTRY_COPY}"
  live_hash_after="$(sha256_file "${MAIN_REGISTRY}")"
  [[ "${live_hash_before}" == "${live_hash_after}" ]] ||
    die "The live registry changed while its snapshot was being copied."
  [[ "$(sha256_file "${REGISTRY_COPY}")" == "${live_hash_before}" ]] ||
    die "The staging registry copy is not byte-identical."
  [[ "$(stat -c '%d:%i' -- "${MAIN_REGISTRY}")" != "$(stat -c '%d:%i' -- "${REGISTRY_COPY}")" ]] ||
    die "The staging registry copy unexpectedly shares the live inode."

  install -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0644 "${CERT_SOURCE}" "${CERT_COPY}"
  install -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0600 "${KEY_SOURCE}" "${KEY_COPY}"
  printf '%s\n' "${live_hash_before}" >"${BASELINE_HASH_FILE}"
  chown root:root "${BASELINE_HASH_FILE}"
  chmod 0600 "${BASELINE_HASH_FILE}"
  sha256_file "${RELEASE_ROOT}/RELEASE.sha256" >"${RELEASE_MANIFEST_HASH_FILE}"
  sha256_file "${CERT_COPY}" >"${TLS_CERT_HASH_FILE}"
  sha256_file "${KEY_COPY}" >"${TLS_KEY_HASH_FILE}"
  chown root:root \
    "${RELEASE_MANIFEST_HASH_FILE}" "${TLS_CERT_HASH_FILE}" "${TLS_KEY_HASH_FILE}"
  chmod 0600 \
    "${RELEASE_MANIFEST_HASH_FILE}" "${TLS_CERT_HASH_FILE}" "${TLS_KEY_HASH_FILE}"
  snapshot_service cassav5bt.service "${MAIN_SERVICE_BASELINE}"
  snapshot_service bluetooth.service "${BLUETOOTH_SERVICE_BASELINE}"

  {
    printf 'CASSA_BT_FEATURE_ENABLED=0\n'
    printf 'CASSA_BT_ENROLLMENT_RUNTIME_ENABLED=1\n'
    printf 'CASSA_BT_ENROLLMENT_LISTEN_HOST=0.0.0.0\n'
    printf 'CASSA_BT_ENROLLMENT_PORT=%s\n' "${PORT}"
    printf 'CASSA_BT_ENROLLMENT_ENDPOINT_ID=%s\n' "${ENDPOINT_ID}"
    printf 'CASSA_BT_ENROLLMENT_TLS_CERT=%s\n' "${CERT_COPY}"
    printf 'CASSA_BT_ENROLLMENT_TLS_KEY=%s\n' "${KEY_COPY}"
    printf 'CASSA_BT_STATE_ROOT=%s\n' "${STATE_ROOT}"
    printf 'CASSA_BT_DEVICE_REGISTRY=%s\n' "${REGISTRY_COPY}"
  } >"${ENV_FILE}"
  chown root:root "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  printf 'prepared\n' >"${PREPARED_MARKER}"
  chown root:root "${PREPARED_MARKER}"
  chmod 0600 "${PREPARED_MARKER}"

  verify_prepared_run
  assert_operational_services_unchanged
  cleanup_required=0
  trap - EXIT
  printf 'PREPARE=PASS\nRUN_ID=%s\n' "${RUN_ID}"
}

start_run() {
  require_root
  require_command curl
  require_command ss
  require_command systemd-run
  require_command systemctl
  verify_prepared_run
  assert_operational_services_ready
  assert_operational_services_unchanged
  assert_unit_absent
  assert_port_free

  systemd-run --quiet --collect \
    --unit="${UNIT_NAME}" \
    --service-type=simple \
    --uid="${SERVICE_USER}" \
    --gid="${SERVICE_GROUP}" \
    --working-directory="${RELEASE_ROOT}" \
    --property=UMask=0077 \
    --property="EnvironmentFile=${ENV_FILE}" \
    --property=Restart=no \
    --property="RuntimeMaxSec=${MAX_RUNTIME_SECONDS}" \
    --property="TimeoutStopSec=${STOP_TIMEOUT_SECONDS}s" \
    --property=KillMode=mixed \
    --property=NoNewPrivileges=yes \
    --property=ProtectSystem=strict \
    --property=ProtectHome=yes \
    --property=PrivateTmp=yes \
    --property=PrivateDevices=yes \
    --property=ProtectControlGroups=yes \
    --property=ProtectKernelModules=yes \
    --property=ProtectKernelTunables=yes \
    --property=RestrictSUIDSGID=yes \
    --property=LockPersonality=yes \
    --property=RestrictRealtime=yes \
    --property='RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
    --property="ReadWritePaths=${RUN_ROOT}" \
    --property="ReadOnlyPaths=${RELEASE_ROOT} ${CERT_COPY} ${KEY_COPY} ${ENV_FILE}" \
    --property=MemoryMax=128M \
    --property=CPUQuota=50% \
    --property=TasksMax=64 \
    --property=LimitNOFILE=256 \
    --property=StandardOutput=journal \
    --property=StandardError=journal \
    --property=SyslogIdentifier=cassav5bt-api31-enrollment-staging \
    /usr/bin/env node "${RELEASE_ROOT}/raspberry/scripts/enrollment-server.mjs"

  local ready=0
  local attempt
  for attempt in $(seq 1 30); do
    if unit_is_running && health_check; then
      ready=1
      break
    fi
    sleep 0.2
  done
  if [[ "${ready}" != "1" ]]; then
    stop_unit_bounded
    die "The isolated enrollment endpoint did not become healthy."
  fi
  assert_main_registry_unchanged
  assert_operational_services_unchanged
  printf 'START=PASS\nHEALTH=PASS\nRUN_ID=%s\n' "${RUN_ID}"
}

health_run() {
  require_root
  require_command curl
  verify_prepared_run
  unit_is_running || die "The transient staging unit is not active."
  health_check || die "The isolated endpoint health contract failed."
  assert_main_registry_unchanged
  assert_operational_services_unchanged
  printf 'HEALTH=PASS\nRUN_ID=%s\n' "${RUN_ID}"
}

status_run() {
  require_root
  verify_prepared_run no
  local unit_status="INACTIVE"
  local health_status="NOT_CHECKED"
  if unit_is_running; then
    unit_status="ACTIVE"
    if health_check; then
      health_status="PASS"
    else
      health_status="FAIL"
    fi
  fi
  local registry_status="UNCHANGED"
  local expected_registry_hash
  expected_registry_hash="$(<"${BASELINE_HASH_FILE}")"
  if [[ "$(sha256_file "${MAIN_REGISTRY}")" != "${expected_registry_hash}" ]]; then
    registry_status="MISMATCH"
  fi
  printf 'RUN_ID=%s\nUNIT=%s\nHEALTH=%s\nMAIN_REGISTRY=%s\n' \
    "${RUN_ID}" "${unit_status}" "${health_status}" "${registry_status}"
  [[ "${registry_status}" == "UNCHANGED" ]] || return 1
}

issue_token_run() {
  require_root
  require_command runuser
  verify_prepared_run
  unit_is_running || die "The transient staging unit is not active."
  health_check || die "The isolated endpoint health contract failed."
  assert_operational_services_unchanged

  if [[ -e "${TOKEN_ROOT}" || -L "${TOKEN_ROOT}" ]]; then
    assert_private_service_directory "${TOKEN_ROOT}"
  else
    install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 "${TOKEN_ROOT}"
  fi
  local token_file="${TOKEN_ROOT}/${TOKEN_LABEL}.json"
  [[ ! -e "${token_file}" && ! -L "${token_file}" ]] ||
    die "A token handoff with this label already exists."
  [[ ! -e "${token_file}.pending" && ! -L "${token_file}.pending" ]] ||
    die "A pending token handoff with this label already exists."

  resolve_node_bin
  local private_stdout
  local private_stderr
  private_stdout="$(mktemp -p "${CONTROL_ROOT}" .issue-token-out.XXXXXX)"
  private_stderr="$(mktemp -p "${CONTROL_ROOT}" .issue-token-err.XXXXXX)"
  chmod 0600 "${private_stdout}" "${private_stderr}"
  if ! runuser -u "${SERVICE_USER}" -- \
    "${NODE_BIN}" "${RELEASE_ROOT}/raspberry/scripts/device-registry.mjs" issue-token \
      --registry "${REGISTRY_COPY}" \
      --endpoint-id "${ENDPOINT_ID}" \
      --protocol-version 2 \
      --ttl-seconds 600 \
      --output "${token_file}" \
      >"${private_stdout}" 2>"${private_stderr}"; then
    rm -f -- "${private_stdout}" "${private_stderr}"
    die "The private v2 enrollment token could not be issued."
  fi
  rm -f -- "${private_stdout}" "${private_stderr}"

  assert_regular_single_link "${token_file}"
  assert_mode "${token_file}" 600
  assert_owner "${token_file}" "${SERVICE_USER}:${SERVICE_GROUP}"
  "${NODE_BIN}" --input-type=module -e '
    import fs from "node:fs";
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const qr = value?.qr;
    if (
      qr?.version !== 2 ||
      qr?.enrollmentEndpointId !== "v5bt-api31-enrollment-v2" ||
      typeof qr?.token !== "string" ||
      !qr.token.startsWith("c5e2_") ||
      value?.qrPayload !== JSON.stringify(qr)
    ) {
      throw new Error("private v2 token contract mismatch");
    }
  ' "${token_file}" >/dev/null
  assert_main_registry_unchanged
  assert_operational_services_unchanged
  printf 'TOKEN_ISSUE=PASS\nPROTOCOL_VERSION=2\nTTL_SECONDS=600\nLABEL=%s\n' \
    "${TOKEN_LABEL}"
}

stop_run() {
  require_root
  require_command systemctl
  verify_prepared_run
  stop_unit_bounded
  assert_main_registry_unchanged
  assert_operational_services_unchanged
  printf 'STOP=PASS\nEVIDENCE_RETAINED=YES\nRUN_ID=%s\n' "${RUN_ID}"
}

purge_run() {
  require_root
  [[ "${CASSAV5BT_API31_PURGE:-}" == "YES" ]] ||
    die "Set CASSAV5BT_API31_PURGE=YES to remove retained staging evidence."
  verify_prepared_run
  stop_unit_bounded
  assert_main_registry_unchanged
  assert_operational_services_unchanged
  if findmnt --mountpoint "${RUN_ROOT}" >/dev/null 2>&1 ||
    findmnt --mountpoint "${RELEASE_ROOT}" >/dev/null 2>&1 ||
    findmnt --mountpoint "${CONTROL_ROOT}" >/dev/null 2>&1; then
    die "Refusing to purge a mounted staging path."
  fi
  rm -rf --one-file-system -- "${RUN_ROOT}" "${RELEASE_ROOT}" "${CONTROL_ROOT}"
  printf 'PURGE=PASS\nRUN_ID=%s\n' "${RUN_ID}"
}

COMMAND="${1:-}"
case "${COMMAND}" in
  validate-source)
    [[ "$#" -eq 1 ]] || die "validate-source does not accept a RUN_ID."
    validate_source_tree
    printf 'SOURCE_VALIDATION=PASS\n'
    ;;
  prepare|start|health|status|stop|purge)
    [[ "$#" -eq 2 ]] || die "${COMMAND} requires exactly one RUN_ID."
    RUN_ID="$2"
    validate_run_id "${RUN_ID}"
    paths_for_run "${RUN_ID}"
    case "${COMMAND}" in
      prepare) prepare_run ;;
      start) start_run ;;
      health) health_run ;;
      status) status_run ;;
      stop) stop_run ;;
      purge) purge_run ;;
    esac
    ;;
  issue-token)
    [[ "$#" -eq 3 ]] || die "issue-token requires RUN_ID and LABEL."
    RUN_ID="$2"
    TOKEN_LABEL="$3"
    validate_run_id "${RUN_ID}"
    validate_token_label "${TOKEN_LABEL}"
    paths_for_run "${RUN_ID}"
    issue_token_run
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
