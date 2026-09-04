#!/usr/bin/env bash
set -euo pipefail

SERIAL="${1:-}"
MODE="${2:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
APK="$DIR/Palmare-1.0.5-debug.apk"
ADB=(adb)
if [[ -n "$SERIAL" ]]; then ADB+=( -s "$SERIAL" ); fi

command -v adb >/dev/null || { echo "adb non presente nel PATH" >&2; exit 1; }
[[ -f "$APK" ]] || { echo "APK non trovato: $APK" >&2; exit 1; }

if "${ADB[@]}" install -r "$APK"; then
  echo "Installazione completata."
  exit 0
fi

if [[ "$MODE" != "--force-reinstall" ]]; then
  echo "Aggiornamento rifiutato, probabilmente per firma debug differente." >&2
  echo "Rieseguire con: $0 '$SERIAL' --force-reinstall" >&2
  echo "La reinstallazione cancella i dati locali dell'app." >&2
  exit 2
fi

"${ADB[@]}" uninstall com.sentrapa.palmare
"${ADB[@]}" install "$APK"
echo "Reinstallazione completata."
