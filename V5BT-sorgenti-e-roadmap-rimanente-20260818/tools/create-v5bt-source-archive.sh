#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export TZ=UTC
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ARCHIVE_NAME="V5BT-sorgenti-e-roadmap-rimanente-20260818"
OUTPUT="$ROOT/${ARCHIVE_NAME}.zip"
LIST_ONLY=0
FIXED_TIMESTAMP="202608180000.00"

usage() {
  cat <<'EOF'
Uso: tools/create-v5bt-source-archive.sh [--list-only] [--output FILE.zip]

Crea un archivio sorgente deterministico. Esclude dipendenze, build, APK,
cache, runtime, risultati rigenerabili, chiavi, log privati e archivi di
consegna precedenti. I dump SQL compressi sotto database/ sono dati di
provisioning e restano inclusi: il pacchetto va trattato come sensibile.
EOF
}

while (($# > 0)); do
  case "$1" in
    --list-only)
      LIST_ONLY=1
      shift
      ;;
    --output)
      (($# >= 2)) || { echo "--output richiede un percorso" >&2; exit 2; }
      OUTPUT="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Argomento non riconosciuto: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$OUTPUT" == /* ]] || OUTPUT="$PWD/$OUTPUT"
[[ "$OUTPUT" == *.zip ]] || { echo "L'output deve terminare con .zip" >&2; exit 2; }

INCLUDE_DIRECTORIES=(
  APPLICATIVI
  DOCUMENTAZIONE
  ROADMAP_BLUETOOTH
  SORGENTE_SISTEMA
  database
  deploy
  scripts
  tests
  tools
)
INCLUDE_ROOT_FILES=(
  CONTENUTO_PACCHETTO.md
  HANDOFF_V5BT_20260724.md
  LEGGIMI.md
  README_V5BT.md
  hardware.env.example
  start-v5bt.sh
  stop-v5bt.sh
)
INCLUDE_SPECIAL_FILES=(
  BASELINE_SERVER_RASPBERRY/database/sqlite/backend-relational.sqlite
  BASELINE_SERVER_RASPBERRY/database/sqlite/app-state-split.sqlite
)
PRIVATE_ARCHIVE_FILES=(
  ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.json
  ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.json
  ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/physical/V5BT_B11_MIXED_PHYSICAL_ATTESTATION_REDACTED_20260818.json
)

temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
raw_list="$temporary/raw-files.bin"
file_list="$temporary/source-files.txt"
executable_list="$temporary/executable-files.txt"
: > "$raw_list"
: > "$executable_list"

is_excluded_relative() {
  local relative="$1"
  local lower="${relative,,}"

  case "/$lower/" in
    */.git/*|*/.gradle/*|*/.idea/*|*/.print-spool/*|*/.runtime/*|*/.cache/*|*/.credentials/*|*/.dart_tool/*|*/.expo/*|*/.keys/*|*/.logs/*|*/.mypy_cache/*|*/.next/*|*/.nuxt/*|*/.parcel-cache/*|*/.private/*|*/.pytest_cache/*|*/.registry/*|*/.secrets/*|*/.svelte-kit/*|*/.turbo/*|*/.v5bt-private/*|*/.vite/*|*/__pycache__/*|*/artifacts/*|*/build/*|*/cache/*|*/caches/*|*/cert/*|*/certificates/*|*/certs/*|*/coverage/*|*/dist/*|*/keys/*|*/keystore/*|*/log/*|*/logs/*|*/node_modules/*|*/out/*|*/p4-results/*|*/private/*|*/registry/*|*/snapshots/*|*/target/*|*/temp/*|*/tmp/*)
      return 0
      ;;
  esac

  case "$lower" in
    baseline_server_raspberry/database/sqlite/backend-relational.sqlite|baseline_server_raspberry/database/sqlite/app-state-split.sqlite)
      return 1
      ;;
    applicativi/palmare/android-app/app/src/main/assets/mobile/*|applicativi/postazione/android-app/app/src/main/assets/postazione/*)
      return 0
      ;;
    database/*.sql.gz)
      return 1
      ;;
    */gradle/wrapper/gradle-wrapper.jar)
      return 1
      ;;
    */local.properties|*/hardware.env|*/.env|*/.env.*)
      case "$lower" in
        *.env.example) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    */.netrc|*/.npmrc|*/.pypirc|*/authorized_keys|*/credentials.json|*/credentials.yaml|*/credentials.yml|*/device-registry.json|*/id_dsa|*/id_ed25519|*/id_ecdsa|*/id_rsa|*/key.properties|*/keystore.properties|*/known_hosts|*/registry.json|*/secrets.json|*/secrets.yaml|*/secrets.yml|*/service-account*.json|*/tokens.json)
      return 0
      ;;
    *apk*sha256sums*|*aab*sha256sums*|*.aab|*.aab.sha256|*.aar|*.age|*.apk|*.apk.sha256|*.asc|*.bz2|*.cab|*.class|*.crt|*.cer|*.csr|*.db|*.db-*|*.deb|*.der|*.dex|*.dll|*.dmg|*.dylib|*.ear|*.exe|*.gpg|*.gz|*.img|*.ipa|*.iso|*.jar|*.jks|*.kdb|*.kdbx|*.key|*.keystore|*.last.json|*.ledger.json|*.log|*.log.*|*.lz|*.lzma|*.mobileprovision|*.o|*.obj|*.ovpn|*.p12|*.pem|*.pfx|*.pgp|*.ppk|*.private-key|*.private.json|*.private.jsonl|*.provisionprofile|*.pub|*.pyc|*.pyo|*.rar|*.registry.json|*.rpm|*.runtime.json|*.secret|*.shm|*.so|*.sqlite|*.sqlite-*|*.sqlite3|*.sqlite3-*|*.tar|*.tar.bz2|*.tar.gz|*.tar.xz|*.tbz|*.tbz2|*.tgz|*.tsbuildinfo|*.txz|*.wal|*.war|*.wasm|*.xz|*.zip|*.zip.sha256|*.zst|*.7z|*.ds_store|*/thumbs.db)
      return 0
      ;;
  esac

  return 1
}

for relative in "${INCLUDE_DIRECTORIES[@]}"; do
  [[ -d "$ROOT/$relative" ]] || { echo "Directory sorgente assente: $relative" >&2; exit 1; }
  find "$ROOT/$relative" \
    \( -type d \( \
      -name .git -o -name .gradle -o -name .idea -o -name .print-spool -o -name .runtime -o \
      -name .cache -o -name .credentials -o -name .dart_tool -o -name .expo -o \
      -name .keys -o -name .logs -o -name .mypy_cache -o \
      -name .next -o -name .nuxt -o -name .parcel-cache -o -name .pytest_cache -o \
      -name .private -o -name .registry -o -name .secrets -o -name .svelte-kit -o \
      -name .turbo -o -name .v5bt-private -o -name .vite -o -name __pycache__ -o \
      -name artifacts -o -name build -o -name cache -o -name caches -o \
      -name cert -o -name certificates -o -name certs -o -name coverage -o \
      -name dist -o -name keys -o -name keystore -o -name log -o -name logs -o \
      -name node_modules -o -name out -o -name p4-results -o -name private -o \
      -name registry -o -name snapshots -o -name target -o -name temp -o -name tmp \
    \) -prune \) -o \
    \( -type f -o -type l \) -print0 >> "$raw_list"
done

for relative in "${INCLUDE_ROOT_FILES[@]}"; do
  [[ -f "$ROOT/$relative" ]] || { echo "File sorgente assente: $relative" >&2; exit 1; }
  [[ ! -L "$ROOT/$relative" ]] || { echo "Symlink non ammesso: $relative" >&2; exit 1; }
  printf '%s\0' "$ROOT/$relative" >> "$raw_list"
done

for relative in "${INCLUDE_SPECIAL_FILES[@]}"; do
  [[ -f "$ROOT/$relative" ]] || { echo "File di provisioning assente: $relative" >&2; exit 1; }
  [[ ! -L "$ROOT/$relative" ]] || { echo "Symlink non ammesso: $relative" >&2; exit 1; }
  printf '%s\0' "$ROOT/$relative" >> "$raw_list"
done

while IFS= read -r -d '' absolute; do
  relative="${absolute#"$ROOT/"}"
  [[ "$relative" != "$absolute" ]] || { echo "Percorso esterno alla workspace" >&2; exit 1; }
  [[ "$relative" != *$'\n'* && "$relative" != *$'\r'* && "$relative" != *$'\t'* ]] || {
    echo "Carattere di controllo non ammesso nel percorso sorgente" >&2
    exit 1
  }
  is_excluded_relative "$relative" && continue
  [[ ! -L "$absolute" ]] || { echo "Symlink non ammesso: $relative" >&2; exit 1; }
  [[ -x "$absolute" ]] && printf '%s\n' "$relative" >> "$executable_list"
  printf '%s\n' "$relative"
done < "$raw_list" | LC_ALL=C sort -u > "$file_list"

LC_ALL=C sort -u -o "$executable_list" "$executable_list"

if ((LIST_ONLY)); then
  cat "$file_list"
  exit 0
fi

command -v rsync >/dev/null || { echo "rsync non disponibile" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum non disponibile" >&2; exit 1; }
command -v unzip >/dev/null || { echo "unzip non disponibile" >&2; exit 1; }
command -v zip >/dev/null || { echo "zip non disponibile" >&2; exit 1; }

stage="$temporary/$ARCHIVE_NAME"
mkdir -p -- "$stage"
rsync -a --files-from="$file_list" -- "$ROOT/" "$stage/"

find "$stage" -type d -exec chmod 0755 -- {} +
find "$stage" -type f -exec chmod 0644 -- {} +
for relative in "${PRIVATE_ARCHIVE_FILES[@]}"; do
  [[ -f "$stage/$relative" ]] || { echo "Artefatto privato assente: $relative" >&2; exit 1; }
  chmod 0600 -- "$stage/$relative"
done
while IFS= read -r relative; do
  [[ -n "$relative" ]] || continue
  chmod 0755 -- "$stage/$relative"
done < "$executable_list"

cat > "$stage/V5BT_SOURCE_ARCHIVE_INFO.txt" <<'EOF'
V5BT source handoff
Schema: 1
Snapshot date: 2026-08-18
Generated outputs: excluded
Private runtime, registry, credentials and raw logs: excluded
Packaged roadmap reports and historical public evidence: included
Compressed SQL source dumps under database/: included
Certified SQLite provisioning baselines: included
Sensitivity: contains database provisioning data; handle as private
Remaining roadmap: DOCUMENTAZIONE/ROADMAP_RIMANENTE_V5BT_20260817.md
EOF

manifest="$stage/V5BT_SOURCE_MANIFEST.tsv"
: > "$manifest"
while IFS= read -r relative; do
  [[ "$relative" != "V5BT_SOURCE_MANIFEST.tsv" ]] || continue
  size="$(stat -c '%s' "$stage/$relative")"
  digest="$(sha256sum "$stage/$relative" | cut -d' ' -f1)"
  printf '%s\t%s\t%s\n' "$digest" "$size" "$relative" >> "$manifest"
done < <(cd "$stage" && find . -type f -printf '%P\n' | LC_ALL=C sort)

find "$stage" -exec touch -h -t "$FIXED_TIMESTAMP" -- {} +
mkdir -p -- "$(dirname -- "$OUTPUT")"
rm -f -- "$OUTPUT" "$OUTPUT.sha256"
(
  cd "$temporary"
  find "$ARCHIVE_NAME" -type f -printf '%p\n' | LC_ALL=C sort | \
    zip -X -q "$OUTPUT" -@
)

archive_listing="$temporary/archive-listing.txt"
unzip -Z1 "$OUTPUT" > "$archive_listing"
expected_listing="$temporary/expected-listing.txt"
{
  sed "s#^#$ARCHIVE_NAME/#" "$file_list"
  printf '%s\n' \
    "$ARCHIVE_NAME/V5BT_SOURCE_ARCHIVE_INFO.txt" \
    "$ARCHIVE_NAME/V5BT_SOURCE_MANIFEST.tsv"
} | LC_ALL=C sort -u > "$expected_listing"
LC_ALL=C sort -u -o "$archive_listing" "$archive_listing"
cmp -s "$expected_listing" "$archive_listing" || {
  echo "L'inventario ZIP non coincide con l'allowlist sorgente" >&2
  diff -u "$expected_listing" "$archive_listing" >&2 || true
  exit 1
}

while IFS= read -r archived; do
  case "$archived" in
    "$ARCHIVE_NAME/V5BT_SOURCE_ARCHIVE_INFO.txt"|"$ARCHIVE_NAME/V5BT_SOURCE_MANIFEST.tsv")
      continue
      ;;
    "$ARCHIVE_NAME/"*)
      relative="${archived#"$ARCHIVE_NAME/"}"
      ;;
    *)
      echo "Percorso ZIP fuori dalla radice prevista: $archived" >&2
      exit 1
      ;;
  esac
  is_excluded_relative "$relative" && {
    echo "L'archivio contiene un percorso escluso: $relative" >&2
    exit 1
  }
done < "$archive_listing"

archive_digest="$(sha256sum "$OUTPUT" | cut -d' ' -f1)"
printf '%s  %s\n' "$archive_digest" "$(basename -- "$OUTPUT")" > "$OUTPUT.sha256"
printf 'Archivio: %s\n' "$OUTPUT"
printf 'File: %s\n' "$(wc -l < "$archive_listing")"
printf 'SHA-256: %s\n' "$archive_digest"
