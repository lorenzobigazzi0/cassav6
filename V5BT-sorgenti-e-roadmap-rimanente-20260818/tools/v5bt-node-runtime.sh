#!/usr/bin/env bash

resolve_v5bt_node_bin() {
  local root="$1"
  local machine_arch expected_node_arch candidate node_arch
  local -a candidates=()

  machine_arch="$(uname -m 2>/dev/null || true)"
  case "$machine_arch" in
    x86_64|amd64)
      expected_node_arch="x64"
      candidates+=("$root/.runtime/node-v22.23.1-linux-x64/bin/node")
      ;;
    aarch64|arm64)
      expected_node_arch="arm64"
      candidates+=(
        "$root/BASELINE_SERVER_RASPBERRY/runtime/node-v24.15.0-linux-arm64/bin/node"
      )
      ;;
    *)
      echo "Architettura V5BT non supportata: ${machine_arch:-sconosciuta}." >&2
      return 1
      ;;
  esac

  if [[ -n "${CASSAV5BT_NODE_BIN:-}" ]]; then
    if [[ "$CASSAV5BT_NODE_BIN" != /* ]]; then
      echo "CASSAV5BT_NODE_BIN deve essere un percorso assoluto." >&2
      return 1
    fi
    candidates=("$CASSAV5BT_NODE_BIN" "${candidates[@]}")
  fi

  candidate="$(command -v node 2>/dev/null || true)"
  [[ -z "$candidate" ]] || candidates+=("$candidate")

  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate" ]] || continue
    node_arch="$("$candidate" -p 'process.arch' 2>/dev/null || true)"
    if [[ "$node_arch" == "$expected_node_arch" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "Runtime Node V5BT compatibile non trovato per $machine_arch." >&2
  return 1
}
