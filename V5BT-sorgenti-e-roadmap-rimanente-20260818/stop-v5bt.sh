#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$ROOT/SORGENTE_SISTEMA"
RUNTIME_DIR="${CASSAV5BT_RUNTIME_DIR:-$ROOT/.runtime/cassav5bt}"
APP_LOG_DIR="$RUNTIME_DIR/server-logs"
source "$ROOT/tools/v5bt-node-runtime.sh"
NODE_BIN="$(resolve_v5bt_node_bin "$ROOT")"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"

if [[ "${CASSAV5BT_LOCK_HELD:-0}" != "1" ]]; then
  if ! command -v flock >/dev/null 2>&1; then
    echo "Comando richiesto non trovato: flock" >&2
    exit 1
  fi
  exec 9>"$RUNTIME_DIR/lifecycle.lock"
  if ! flock -n 9; then
    echo "Un'altra operazione di avvio/arresto V5BT e in corso." >&2
    exit 1
  fi
fi

process_identity() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/stat" ]] || return 1
  awk '{ print $22 }' "/proc/$pid/stat" 2>/dev/null
}

is_v5bt_process() {
  local pid="$1"
  local process_cwd process_exe expected_exe
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  process_cwd="$(readlink -e "/proc/$pid/cwd" 2>/dev/null || true)"
  process_exe="$(readlink -e "/proc/$pid/exe" 2>/dev/null || true)"
  expected_exe="$(readlink -e "$NODE_BIN" 2>/dev/null || true)"
  [[ -n "$process_cwd" && -n "$process_exe" && -n "$expected_exe" ]] &&
    [[ "$process_cwd" == "$APP_ROOT" || "$process_cwd" == "$APP_ROOT/"* ]] &&
    [[ "$process_exe" == "$expected_exe" ]]
}

stop_pid_file() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 0

  local pid start_identity current_identity
  pid="$(<"$pid_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    if ! is_v5bt_process "$pid"; then
      echo "PID file V5BT obsoleto ignorato: $pid_file ($pid)." >&2
      rm -f "$pid_file"
      return 0
    fi
    start_identity="$(process_identity "$pid" 2>/dev/null || true)"
    current_identity="$(process_identity "$pid" 2>/dev/null || true)"
    if [[ -z "$start_identity" || "$current_identity" != "$start_identity" ]] ||
       ! is_v5bt_process "$pid"; then
      echo "PID V5BT cambiato durante la verifica, segnale non inviato: $pid." >&2
      rm -f "$pid_file"
      return 0
    fi
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null &&
       [[ "$(process_identity "$pid" 2>/dev/null || true)" == "$start_identity" ]] &&
       is_v5bt_process "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
    if kill -0 "$pid" 2>/dev/null &&
       [[ "$(process_identity "$pid" 2>/dev/null || true)" == "$start_identity" ]]; then
      echo "Processo V5BT non arrestato: $pid ($pid_file)." >&2
      return 1
    fi
  fi
  rm -f "$pid_file"
}

STOP_FAILURE=0
stop_or_record_failure() {
  if ! stop_pid_file "$1"; then
    STOP_FAILURE=1
  fi
}

stop_or_record_failure "$APP_LOG_DIR/backend-linux-current.pid"
stop_or_record_failure "$APP_LOG_DIR/backend-realtime-current.pid"
stop_or_record_failure "$APP_LOG_DIR/backend-api-worker-current.pid"
stop_or_record_failure "$APP_LOG_DIR/frontends-linux-current.pid"

for pid_file in "$APP_LOG_DIR"/backend-api-worker-*.pid; do
  [[ -e "$pid_file" ]] && stop_or_record_failure "$pid_file"
done

for service in battery fiscal automatic-cash; do
  stop_or_record_failure "$RUNTIME_DIR/${service}.pid"
done

if [[ "$STOP_FAILURE" == "1" ]]; then
  echo "Arresto V5BT incompleto: almeno un processo registrato e ancora attivo." >&2
  exit 1
fi

echo "Servizi Cassa V5BT registrati arrestati."
