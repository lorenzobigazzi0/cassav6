#!/usr/bin/env bash
set -euo pipefail
PROFILE_NAME="${1:-STANDARD}"
ENV_BASENAME="${2:-standard}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/configs/${ENV_BASENAME}.env"
ENV_EXAMPLE="${PROJECT_ROOT}/configs/${ENV_BASENAME}.env.example"

if [[ -f "${ENV_FILE}" ]]; then
  SOURCE_FILE="${ENV_FILE}"
elif [[ -f "${ENV_EXAMPLE}" ]]; then
  SOURCE_FILE="${ENV_EXAMPLE}"
  echo "[launcher] WARNING: uso ${ENV_EXAMPLE}. Copialo in ${ENV_FILE} per valori reali e segreti fuori repo."
else
  echo "[launcher] Config non trovata: ${ENV_FILE} o ${ENV_EXAMPLE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${SOURCE_FILE}"
set +a
export CASSA_RUNTIME_PROFILE="${CASSA_RUNTIME_PROFILE:-${PROFILE_NAME}}"
cd "${PROJECT_ROOT}"
node scripts/print-runtime-profile.mjs --profile "${CASSA_RUNTIME_PROFILE}" --root "${PROJECT_ROOT}"
exec npm run dev:backend
